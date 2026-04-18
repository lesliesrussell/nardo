// mine command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { mineDirectory } from '../../mining/file-miner.js'
import { mineConversation } from '../../mining/convo-miner.js'
import { readNardoYaml } from '../../mining/yaml-reader.js'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { chunkText } from '../../mining/chunker.js'
import { computeImportance } from '../../mining/importance.js'
import * as wal from '../../wal.js'

export function registerMine(program: Command): void {
  program
    .command('mine <path>')
    .description('Chunk, embed, and index files or conversation exports into the palace')
    .addHelpText('after', `
Details:
  In "project" mode (default), recursively reads source files in <path>,
  splits them into overlapping chunks, and stores them as drawers. Wing is
  read from nardo.yaml if present, otherwise derived from the directory name.
  In "convos" mode, reads .json/.md/.txt conversation exports and indexes
  each file as a conversation. Pass "-" as path to read plain text from stdin.

Examples:
  nardo mine . --wing myproject
  nardo mine ~/exports --mode convos --wing conversations
  echo "meeting notes" | nardo mine - --wing notes --room standups
`)
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .option('--wing <wing>', 'Wing to file drawers under (default: from nardo.yaml or directory name)')
    .option('--mode <mode>', 'Ingest mode: "project" or "convos" (default: project)', 'project')
    .option('--agent <name>', 'Agent label recorded in drawer metadata (default: cli)', 'cli')
    .option('--limit <n>', 'Stop after indexing the first N files (useful for testing)')
    .option('--dry-run', 'Show what would be indexed without writing any drawers')
    .option('--no-gitignore', 'Disable .gitignore filtering and index all files')
    .option('--include-ignored <paths>', 'Force-include specific comma-separated paths even if gitignored')
    .option('--source <id>', 'Source identifier recorded in metadata when reading from stdin')
    .option('--room <room>', 'Room name when reading from stdin (default: stdin)')
    .action(
      async (
        targetPath: string,
        opts: {
          palace?: string
          wing?: string
          mode: string
          agent: string
          limit?: string
          dryRun?: boolean
          gitignore: boolean
          includeIgnored?: string
          source?: string
          room?: string
        },
      ) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path

        // ── Stdin mode ────────────────────────────────────────────────────────
        if (targetPath === '-') {
          const wing = opts.wing ?? 'stdin'
          const room = opts.room ?? 'stdin'
          const source_file = opts.source ?? `stdin:${new Date().toISOString()}`
          const dry_run = opts.dryRun ?? false

          // Read all stdin
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
          const content = Buffer.concat(chunks).toString('utf-8').trim()

          if (!content) {
            console.error('No input received on stdin')
            process.exit(1)
          }

          console.log(`Mining stdin → ${wing}/${room} (${content.length} chars)`)

          const textChunks = chunkText(content)
          if (textChunks.length === 0 || dry_run) {
            console.log(`${dry_run ? '[dry] ' : ''}${textChunks.length} chunks`)
            return
          }

          const client = new PalaceClient(palace_path)
          const embedder = getEmbeddingPipeline()
          const texts = textChunks.map(c => c.text)
          const embeddings = await embedder.embed(texts)
          const mtime = Date.now()

          let filed = 0
          for (let i = 0; i < textChunks.length; i++) {
            const embedding = embeddings[i]
            if (!embedding) continue
            await addDrawer(client, embedding, textChunks[i]!.text, {
              wing, room, source_file, source_mtime: mtime,
              chunk_index: textChunks[i]!.index,
              normalize_version: 2, added_by: opts.agent,
              filed_at: new Date().toISOString(),
              ingest_mode: 'project',
              importance: computeImportance(textChunks[i]!.text),
              chunk_size: textChunks[i]!.text.length,
            }, wal)
            filed++
          }

          console.log(`Filed: ${filed} drawers`)
          return
        }
        const dry_run = opts.dryRun ?? false
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined
        const include_ignored = opts.includeIgnored
          ? opts.includeIgnored.split(',').map(s => s.trim())
          : []

        console.log(`Mining: ${targetPath}`)
        console.log(`Palace: ${palace_path}`)
        console.log(`Mode: ${opts.mode}`)

        if (opts.mode === 'convos') {
          // Mine conversation files
          const wing = opts.wing ?? 'conversations'
          console.log(`Wing: ${wing}`)
          console.log()

          let files: string[] = []
          try {
            const stat = statSync(targetPath)
            if (stat.isDirectory()) {
              const entries = readdirSync(targetPath)
              files = entries
                .filter(e => e.endsWith('.json') || e.endsWith('.md') || e.endsWith('.txt'))
                .map(e => join(targetPath, e))
            } else {
              files = [targetPath]
            }
          } catch (err) {
            console.error('Error reading path:', err)
            process.exit(1)
          }

          if (limit !== undefined) files = files.slice(0, limit)

          let totalDrawers = 0
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i]
            const filename = filePath.split('/').pop() ?? filePath
            const result = await mineConversation(filePath, {
              palace_path,
              wing,
              room: 'conversations',
              agent: opts.agent,
              dry_run,
            })
            console.log(
              `  [${String(i + 1).padStart(3, ' ')}/${files.length}] ${filename.padEnd(30)} → ${result.drawers} drawers`,
            )
            totalDrawers += result.drawers
          }

          console.log()
          console.log(`Filed: ${totalDrawers} drawers`)
        } else {
          // Project mode
          let nardoYaml = null
          try {
            nardoYaml = await readNardoYaml(targetPath)
          } catch {
            // no yaml
          }

          const wing = opts.wing ?? nardoYaml?.wing ?? targetPath.split('/').pop() ?? 'project'
          const rooms = nardoYaml?.rooms ?? {}

          console.log(`Wing: ${wing}`)
          if (dry_run) console.log('(dry run)')
          if (nardoYaml) console.log('Reading nardo.yaml...')
          console.log()

          const result = await mineDirectory(targetPath, {
            palace_path,
            wing,
            rooms,
            agent: opts.agent,
            limit,
            dry_run,
            include_ignored,
          })

          console.log()
          console.log(`Filed: ${result.drawers} drawers`)
          console.log(`Files: ${result.files}`)
        }
      },
    )
}
