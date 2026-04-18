// compact command — rebuild HNSW indexes dropping marked-deleted entries
import type { Command } from 'commander'
import { statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HierarchicalNSW } from 'hnswlib-node'
import { getIndexedEmbeddingDimension, loadConfig } from '../../config.js'
import { openPalaceDB, type PalaceDB } from '../../palace/client.js'

const HNSW_M = 16
const HNSW_EF = 200
const HNSW_SEED = 100

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function compactCollection(
  db: PalaceDB,
  table: 'drawers' | 'closets',
  indexPath: string,
  dimension: number,
  quiet: boolean,
): Promise<{ before: number; after: number; reclaimed: number }> {
  const sizeBefore = fileSize(indexPath)

  if (!existsSync(indexPath)) {
    if (!quiet) console.log(`  ${table}: no index file found, skipping`)
    return { before: 0, after: 0, reclaimed: 0 }
  }

  const oldIndex = new HierarchicalNSW('cosine', dimension)
  oldIndex.readIndexSync(indexPath, true)
  const oldCount = oldIndex.getCurrentCount()

  const rows = await db.all<{ id: string; label: number }>(
    `SELECT id, label FROM ${table} WHERE label IS NOT NULL ORDER BY label ASC`,
  )

  if (rows.length === 0) {
    if (!quiet) console.log(`  ${table}: 0 live entries, skipping`)
    return { before: sizeBefore, after: sizeBefore, reclaimed: 0 }
  }

  const newIndex = new HierarchicalNSW('cosine', dimension)
  newIndex.initIndex(Math.max(rows.length + 100, 1000), HNSW_M, HNSW_EF, HNSW_SEED, true)

  let newLabel = 0
  let skipped = 0

  for (const row of rows) {
    let vec: Float32Array | number[]
    try {
      vec = oldIndex.getPoint(row.label)
    } catch {
      skipped++
      continue
    }

    newIndex.addPoint(Array.from(vec), newLabel)
    await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, [newLabel, row.id])
    newLabel++
  }

  await db.run(`REPLACE INTO label_seq (collection, next_label) VALUES (?, ?)`, [table, newLabel])

  const tmpPath = indexPath + '.compact'
  newIndex.writeIndexSync(tmpPath)
  renameSync(tmpPath, indexPath)

  const sizeAfter = fileSize(indexPath)
  const reclaimed = Math.max(0, sizeBefore - sizeAfter)

  if (!quiet) {
    console.log(`  ${table}: ${oldCount} → ${newLabel} entries (${skipped} tombstones removed), ${fmtBytes(sizeBefore)} → ${fmtBytes(sizeAfter)} (saved ${fmtBytes(reclaimed)})`)
  }

  return { before: sizeBefore, after: sizeAfter, reclaimed }
}

export function registerCompact(program: Command): void {
  program
    .command('compact')
    .description('Reclaim disk space by rebuilding HNSW and FTS5 indexes')
    .addHelpText('after', `
Details:
  When drawers are deleted (via "forget" or "dedup") their slots in the HNSW
  index are marked as tombstones but not removed. Over time this wastes disk
  and slows queries. Compact rewrites both drawers.hnsw and closets.hnsw from
  scratch, renumbers labels, and (on SQLite) rebuilds the FTS5 table. Run this
  after bulk deletions.

Examples:
  nardo compact
  nardo compact --quiet   # exits 0 on success, no output
`)
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .option('--quiet', 'Suppress all progress output (useful in scripts)')
    .action(async (opts: { palace?: string; quiet?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const dimension = getIndexedEmbeddingDimension(config.embedding)
      const quiet = opts.quiet ?? false

      if (!quiet) console.log(`Compacting palace: ${palace_path}\n`)

      const db = await openPalaceDB(palace_path, config.palace.backend)
      try {
        const drawersStats = await compactCollection(
          db,
          'drawers',
          join(palace_path, 'drawers.hnsw'),
          dimension,
          quiet,
        )
        const closetsStats = await compactCollection(
          db,
          'closets',
          join(palace_path, 'closets.hnsw'),
          dimension,
          quiet,
        )

        if (db.kind === 'sqlite') {
          const ftsBefore = (await db.get<{ n: number }>('SELECT COUNT(*) as n FROM drawers_fts'))?.n ?? 0
          try {
            await db.run(`INSERT INTO drawers_fts(drawers_fts) VALUES('rebuild')`)
            const ftsAfter = (await db.get<{ n: number }>('SELECT COUNT(*) as n FROM drawers_fts'))?.n ?? 0
            if (!quiet) console.log(`  fts5:    rebuilt (${ftsBefore} → ${ftsAfter} rows)`)
          } catch (err) {
            if (!quiet) console.log(`  fts5:    rebuild failed: ${String(err)}`)
          }
        }

        const totalReclaimed = drawersStats.reclaimed + closetsStats.reclaimed
        if (!quiet) {
          console.log(`\nTotal disk reclaimed: ${fmtBytes(totalReclaimed)}`)
        }
      } finally {
        await db.close()
      }
    })
}
