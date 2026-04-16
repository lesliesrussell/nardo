// mine-beads command — ingest beads issues into the palace
//
// Reads issues via `bd list --all --json`, builds a document from each
// issue's fields, and mines them as drawers. Wing=beads, room=issue_type.
// source_file='beads:<id>' so forget/re-mine targets individual issues cleanly.
// Dedup: updated_at treated as source_mtime — skip if unchanged.
//
// Modes:
//   nardo mine-beads                   # mine all issues
//   nardo mine-beads --id nardo-abc    # mine/re-mine one issue
//   nardo mine-beads --watch           # poll for changes every --interval seconds
import type { Command } from 'commander'
import { execSync } from 'node:child_process'
import { loadConfig } from '../../config.js'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer, fileAlreadyMined, deleteDrawersBySource } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { computeImportance } from '../../mining/importance.js'
import * as wal from '../../wal.js'

const DEFAULT_WATCH_INTERVAL = 60  // seconds

export interface BeadsIssue {
  id: string
  title: string
  description?: string
  status: string
  priority: number
  issue_type: string
  assignee?: string
  created_by?: string
  created_at: string
  updated_at: string
  reason?: string
  design?: string
  notes?: string
  acceptance?: string
}

export function buildDocument(issue: BeadsIssue): string {
  const parts: string[] = []

  parts.push(`[${issue.id}] ${issue.title}`)
  parts.push(`Type: ${issue.issue_type} | Status: ${issue.status} | Priority: P${issue.priority}`)

  if (issue.assignee) parts.push(`Assignee: ${issue.assignee}`)
  parts.push(`Created: ${issue.created_at.slice(0, 10)} | Updated: ${issue.updated_at.slice(0, 10)}`)

  if (issue.description?.trim()) {
    parts.push('')
    parts.push(issue.description.trim())
  }

  if (issue.design?.trim()) {
    parts.push('')
    parts.push(`Design: ${issue.design.trim()}`)
  }

  if (issue.notes?.trim()) {
    parts.push('')
    parts.push(`Notes: ${issue.notes.trim()}`)
  }

  if (issue.acceptance?.trim()) {
    parts.push('')
    parts.push(`Acceptance: ${issue.acceptance.trim()}`)
  }

  if (issue.reason?.trim()) {
    parts.push('')
    parts.push(`Reason: ${issue.reason.trim()}`)
  }

  return parts.join('\n')
}

function fetchIssues(idFilter?: string, statusFilter = 'all'): BeadsIssue[] {
  let flags = statusFilter === 'all' ? '--all' : statusFilter === 'closed' ? '--all' : ''
  if (idFilter) flags += ` --id ${idFilter}`
  const raw = execSync(`bd list --json ${flags}`, { encoding: 'utf-8' })
  return JSON.parse(raw) as BeadsIssue[]
}

async function mineIssues(
  issues: BeadsIssue[],
  client: PalaceClient,
  wing: string,
  quiet: boolean,
): Promise<{ mined: number; remined: number; skipped: number }> {
  const embedder = getEmbeddingPipeline()
  let mined = 0, skipped = 0, remined = 0

  for (const issue of issues) {
    const source_file = `beads:${issue.id}`
    const mtime = new Date(issue.updated_at).getTime()

    const { mined: alreadyMined, mtime: storedMtime } = await fileAlreadyMined(client, source_file)
    if (alreadyMined && storedMtime !== undefined && storedMtime >= mtime) {
      skipped++
      continue
    }

    if (alreadyMined) {
      await deleteDrawersBySource(client, source_file)
      remined++
    }

    const document = buildDocument(issue)
    const room = issue.issue_type

    const embeddings = await embedder.embed([document])
    const embedding = embeddings[0]
    if (!embedding) continue

    const metadata = {
      wing,
      room,
      source_file,
      source_mtime: mtime,
      chunk_index: 0,
      normalize_version: 2,
      added_by: 'mine-beads',
      filed_at: new Date().toISOString(),
      ingest_mode: 'project' as const,
      importance: computeImportance(document),
      chunk_size: document.length,
    }

    await addDrawer(client, embedding, document, metadata, wal)
    mined++

    if (!quiet) {
      const tag = alreadyMined ? '[~]' : '[+]'
      console.log(`${tag} ${issue.id} (${issue.issue_type}) — ${issue.title}`)
    }
  }

  return { mined, remined, skipped }
}

export function registerMineBeads(program: Command): void {
  program
    .command('mine-beads')
    .description('Mine beads issues into the palace (wing=beads, room=issue_type)')
    .option('--palace <path>', 'Palace path override')
    .option('--wing <name>', 'Wing name (default: beads)')
    .option('--id <id>', 'Mine/re-mine a single issue by ID')
    .option('--status <filter>', 'Status filter: all, open, closed (default: all)')
    .option('--watch', 'Poll for changes continuously')
    .option('--interval <seconds>', `Watch poll interval in seconds (default: ${DEFAULT_WATCH_INTERVAL})`)
    .option('--dry-run', 'Show what would be mined without writing')
    .option('--quiet', 'Suppress per-issue output')
    .action(async (opts: {
      palace?: string
      wing?: string
      id?: string
      status?: string
      watch?: boolean
      interval?: string
      dryRun?: boolean
      quiet?: boolean
    }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const wing = opts.wing ?? 'beads'
      const dry_run = opts.dryRun ?? false
      const quiet = opts.quiet ?? false
      const statusFilter = opts.status ?? 'all'
      const watchMode = opts.watch ?? false
      const intervalMs = (opts.interval ? parseInt(opts.interval, 10) : DEFAULT_WATCH_INTERVAL) * 1000

      // Dry-run: just list what would be processed
      if (dry_run) {
        const issues = fetchIssues(opts.id, statusFilter)
        console.log(`Found ${issues.length} issues`)
        for (const issue of issues) {
          console.log(`[dry] ${issue.id} ${issue.issue_type} — ${issue.title}`)
        }
        return
      }

      const client = new PalaceClient(palace_path)

      if (watchMode) {
        if (!quiet) {
          console.log(`Watching beads for changes (interval: ${intervalMs / 1000}s)`)
          console.log('Press Ctrl+C to stop.\n')
        }

        process.on('SIGINT', () => {
          if (!quiet) console.log('\nWatch stopped.')
          process.exit(0)
        })

        while (true) {
          try {
            const issues = fetchIssues(opts.id, statusFilter)
            const stats = await mineIssues(issues, client, wing, quiet)
            if (!quiet && (stats.mined > 0 || stats.remined > 0)) {
              const now = new Date().toLocaleTimeString()
              console.log(`[${now}] ${stats.mined} new, ${stats.remined} updated, ${stats.skipped} unchanged`)
            }
          } catch (err) {
            if (!quiet) console.error(`[!] Poll error: ${String(err)}`)
          }
          await new Promise(r => setTimeout(r, intervalMs))
        }
      } else {
        // One-shot
        let issues: BeadsIssue[]
        try {
          issues = fetchIssues(opts.id, statusFilter)
        } catch (err) {
          console.error(`Failed to run bd list: ${String(err)}`)
          process.exit(1)
        }

        if (!quiet) console.log(`Found ${issues.length} issues`)

        const stats = await mineIssues(issues, client, wing, quiet)

        if (!quiet) {
          console.log(`\nDone: ${stats.mined} mined, ${stats.remined} remined, ${stats.skipped} skipped (unchanged)`)
        }
      }
    })
}
