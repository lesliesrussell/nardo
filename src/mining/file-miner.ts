import { statSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'
import { PalaceClient } from '../palace/client.ts'
import { addDrawer, fileAlreadyMined, deleteDrawersBySource } from '../palace/drawers.ts'
import { buildClosetLines, addClosets, deleteClosetsBySource } from '../palace/closets.ts'
import { getEmbeddingPipeline } from '../embeddings/pipeline.ts'
import { chunkText } from './chunker.ts'
import { detectRoom } from './room-detector.ts'
import { computeImportance } from './importance.ts'
import * as wal from '../wal.ts'

export const READABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.jsx', '.tsx',
  '.json', '.yaml', '.yml', '.html', '.css', '.java',
  '.go', '.rs', '.rb', '.sh', '.csv', '.sql', '.toml',
])

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage', '.nardo', '.ruff_cache',
  '.mypy_cache', '.pytest_cache', '.cache', '.tox', '.nox',
  '.idea', '.vscode', '.ipynb_checkpoints', '.eggs', 'htmlcov', 'target',
])

export interface MineOptions {
  palace_path: string
  wing: string
  rooms: Record<string, { keywords: string[] }>
  agent?: string
  limit?: number
  dry_run?: boolean
  include_ignored?: string[]
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

function loadGitignorePatterns(dir: string): string[] {
  const gitignorePath = join(dir, '.gitignore')
  if (!existsSync(gitignorePath)) return []
  try {
    return readFileSync(gitignorePath, 'utf-8')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

function matchesGitignore(patterns: string[], relPath: string): boolean {
  const segments = relPath.split(/[/\\]/)
  for (const pattern of patterns) {
    const p = pattern.startsWith('/') ? pattern.slice(1) : pattern
    // Simple segment match: check if any path segment matches the pattern
    if (segments.some(seg => seg === p)) return true
    // Glob: if pattern contains *, do simple wildcard match on last segment
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
      if (segments.some(seg => regex.test(seg))) return true
    }
  }
  return false
}

async function walkDir(
  dir: string,
  rootDir: string,
  patterns: string[],
  includeIgnored: string[],
): Promise<string[]> {
  const results: string[] = []
  let entries: import('fs').Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as import('fs').Dirent<string>[]
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relative(rootDir, fullPath)

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      const sub = await walkDir(fullPath, rootDir, patterns, includeIgnored)
      results.push(...sub)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (!READABLE_EXTENSIONS.has(ext)) continue

      // Check size
      try {
        const stat = statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) continue
      } catch {
        continue
      }

      // Check gitignore (skip if matched unless in includeIgnored)
      if (patterns.length > 0 && matchesGitignore(patterns, relPath)) {
        if (!includeIgnored.includes(fullPath) && !includeIgnored.includes(relPath)) {
          continue
        }
      }

      results.push(fullPath)
    }
  }

  return results
}

export async function mineDirectory(
  dir: string,
  opts: MineOptions,
): Promise<{ files: number; drawers: number }> {
  const agent = opts.agent ?? 'cli'
  const limit = opts.limit ?? Infinity
  const dry_run = opts.dry_run ?? false
  const includeIgnored = opts.include_ignored ?? []

  const gitignorePatterns = loadGitignorePatterns(dir)
  const allFiles = await walkDir(dir, dir, gitignorePatterns, includeIgnored)

  const client = new PalaceClient(opts.palace_path)
  const embedder = getEmbeddingPipeline()

  let fileCount = 0
  let drawerCount = 0

  for (const filePath of allFiles) {
    if (fileCount >= limit) break

    // Check if already mined and unchanged
    if (!dry_run) {
      const stat = statSync(filePath)
      const mtime = stat.mtimeMs
      const { mined, mtime: storedMtime } = await fileAlreadyMined(client, filePath)
      if (mined && storedMtime !== undefined && storedMtime >= mtime) {
        continue
      }

      // Delete existing drawers for this file before re-mining
      if (mined) {
        await deleteDrawersBySource(client, filePath)
        await deleteClosetsBySource(client, filePath)
      }
    }

    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const room = detectRoom(filePath, content, opts.rooms)
    const chunks = chunkText(content)
    if (chunks.length === 0) continue

    if (dry_run) {
      fileCount++
      drawerCount += chunks.length
      continue
    }

    const stat = statSync(filePath)
    const mtime = stat.mtimeMs

    // Embed all chunks in batch
    const texts = chunks.map(c => c.text)
    const embeddings = await embedder.embed(texts)

    const drawer_ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const embedding = embeddings[i]
      if (!embedding) continue

      const metadata = {
        wing: opts.wing,
        room,
        source_file: filePath,
        source_mtime: mtime,
        chunk_index: chunk.index,
        normalize_version: 2,
        added_by: agent,
        filed_at: new Date().toISOString(),
        ingest_mode: 'project' as const,
        importance: computeImportance(chunk.text),
        chunk_size: chunk.text.length,
      }

      const drawer_id = await addDrawer(client, embedding, chunk.text, metadata, wal)
      drawer_ids.push(drawer_id)
      drawerCount++
    }

    // Build and add closets
    const closetLines = buildClosetLines(content, drawer_ids, opts.wing, room)
    await addClosets(client, filePath, closetLines, opts.wing, room)

    fileCount++
  }

  return { files: fileCount, drawers: drawerCount }
}
