// mine-git command — ingest git commit history into the palace
//
// Reads commit log via `git log`, builds one drawer per commit.
// source_file='git:<sha>' for clean dedup/forget.
// Re-run is safe: existing commits are skipped (sha never changes).
//
// Usage:
//   nardo mine-git .                          # mine current repo
//   nardo mine-git ~/myproject --with-diffs   # include changed-files summary
//   nardo mine-git . --since 2025-01-01       # limit by date
import type { Command } from 'commander'
import { execSync } from 'node:child_process'
import { loadConfig } from '../../config.js'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer, fileAlreadyMined } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { computeImportance } from '../../mining/importance.js'
import * as wal from '../../wal.js'

interface Commit {
  sha: string
  author: string
  email: string
  date: string   // ISO 8601
  subject: string
  body: string
  diffStat?: string
}

function parseGitLog(raw: string): Commit[] {
  const commits: Commit[] = []
  // Records delimited by null byte
  const records = raw.split('\x00').filter(r => r.trim())

  for (const record of records) {
    const lines = record.trim().split('\n')
    if (lines.length < 4) continue

    const sha = lines[0]?.trim() ?? ''
    const author = lines[1]?.trim() ?? ''
    const email = lines[2]?.trim() ?? ''
    const date = lines[3]?.trim() ?? ''
    const subject = lines[4]?.trim() ?? ''
    const body = lines.slice(5).join('\n').trim()

    if (!sha || !subject) continue
    commits.push({ sha, author, email, date, subject, body })
  }
  return commits
}

function buildDocument(commit: Commit): string {
  const parts: string[] = []

  parts.push(`commit ${commit.sha.slice(0, 12)}`)
  parts.push(`Author: ${commit.author} <${commit.email}>`)
  parts.push(`Date: ${commit.date.slice(0, 10)}`)
  parts.push('')
  parts.push(commit.subject)

  if (commit.body) {
    parts.push('')
    parts.push(commit.body)
  }

  if (commit.diffStat) {
    parts.push('')
    parts.push('Changes:')
    parts.push(commit.diffStat)
  }

  return parts.join('\n')
}

export function registerMineGit(program: Command): void {
  program
    .command('mine-git [repo]')
    .description(
      'Index a git repository\'s commit history into the palace.\n\n' +
      'Reads commits via "git log", builds one drawer per commit containing the\n' +
      'SHA, author, date, subject, and body. Re-running is safe: commits are\n' +
      'identified by their SHA so already-indexed commits are skipped. The repo\n' +
      'argument defaults to the current directory.\n\n' +
      'Examples:\n' +
      '  nardo mine-git .                          # index current repo\n' +
      '  nardo mine-git ~/myproject --with-diffs   # include changed-files summary\n' +
      '  nardo mine-git . --since 2025-01-01       # only commits since a date'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--wing <name>', 'Wing to file commits under (default: git)')
    .option('--room <name>', 'Room within the wing (default: repository directory name)')
    .option('--since <date>', 'Only index commits after this date in YYYY-MM-DD format')
    .option('--limit <n>', 'Maximum number of commits to index (most recent first)')
    .option('--with-diffs', 'Append a "git show --stat" changed-files summary to each commit document')
    .option('--dry-run', 'Print the first 5 commits that would be indexed without writing anything')
    .option('--quiet', 'Suppress per-commit log lines; print only the final summary')
    .action(async (repo: string | undefined, opts: {
      palace?: string
      wing?: string
      room?: string
      since?: string
      limit?: string
      withDiffs?: boolean
      dryRun?: boolean
      quiet?: boolean
    }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const repoPath = repo ?? '.'
      const dry_run = opts.dryRun ?? false
      const quiet = opts.quiet ?? false
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined

      // Derive room from repo directory name
      const repoName = repoPath === '.' ? process.cwd().split('/').pop() ?? 'repo' : repoPath.split('/').pop() ?? 'repo'
      const wing = opts.wing ?? 'git'
      const room = opts.room ?? repoName

      // Build git log command
      // Format: sha\nauthor\nemail\ndate\nsubject\nbody\x00 (null-delimited records)
      const formatStr = '%H%n%an%n%ae%n%aI%n%s%n%b%x00'
      let logCmd = `git -C "${repoPath}" log --no-merges --format="${formatStr}"`
      if (opts.since) logCmd += ` --since="${opts.since}"`
      if (limit) logCmd += ` -n ${limit}`

      let raw: string
      try {
        raw = execSync(logCmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
      } catch (err) {
        console.error(`git log failed: ${String(err)}`)
        process.exit(1)
      }

      const commits = parseGitLog(raw)
      if (!quiet) console.log(`Found ${commits.length} commits in ${repoName}`)

      if (commits.length === 0) return

      // Fetch diff stats if requested
      if (opts.withDiffs) {
        for (const commit of commits) {
          try {
            commit.diffStat = execSync(
              `git -C "${repoPath}" show --stat --format="" ${commit.sha}`,
              { encoding: 'utf-8', maxBuffer: 1024 * 1024 },
            ).trim()
          } catch { /* skip */ }
        }
      }

      if (dry_run) {
        for (const c of commits.slice(0, 5)) {
          console.log(`[dry] ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} — ${c.subject}`)
        }
        if (commits.length > 5) console.log(`  ... and ${commits.length - 5} more`)
        return
      }

      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()

      let mined = 0, skipped = 0

      for (const commit of commits) {
        const source_file = `git:${commit.sha}`
        const mtime = new Date(commit.date).getTime()

        const { mined: alreadyMined, mtime: storedMtime } = await fileAlreadyMined(client, source_file)
        if (alreadyMined && storedMtime !== undefined && storedMtime >= mtime) {
          skipped++
          continue
        }

        const document = buildDocument(commit)
        const embeddings = await embedder.embed([document])
        const embedding = embeddings[0]
        if (!embedding) continue

        await addDrawer(client, embedding, document, {
          wing, room, source_file,
          source_mtime: mtime,
          chunk_index: 0,
          normalize_version: 2,
          added_by: 'mine-git',
          filed_at: new Date().toISOString(),
          ingest_mode: 'project',
          importance: computeImportance(document),
          chunk_size: document.length,
        }, wal)

        mined++
        if (!quiet) console.log(`[+] ${commit.sha.slice(0, 8)} ${commit.date.slice(0, 10)} — ${commit.subject}`)
      }

      if (!quiet) console.log(`\nDone: ${mined} mined, ${skipped} skipped (already indexed)`)
    })
}
