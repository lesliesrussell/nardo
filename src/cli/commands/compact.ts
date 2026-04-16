// compact command — rebuild HNSW indexes dropping marked-deleted entries
//
// hnswlib-node marks deleted entries but never removes them from the index file.
// Over time, repeated mine/re-mine cycles leave tombstones that slow knn search
// and waste disk space. This command rebuilds both indexes from scratch.
//
// Steps:
//   1. Read all live drawers/closets from SQLite
//   2. Fetch their embeddings from the current HNSW index via getPoint()
//   3. Build a fresh index with sequential labels starting at 0
//   4. Update label column in DB + reset label_seq
//   5. Rebuild FTS5 content table
//   6. Atomically replace old index files
import type { Command } from 'commander'
import { statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { HierarchicalNSW } from 'hnswlib-node'
import { getIndexedEmbeddingDimension, loadConfig } from '../../config.js'

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
  db: Database,
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

  // Load existing index
  const oldIndex = new HierarchicalNSW('cosine', dimension)
  oldIndex.readIndexSync(indexPath, true)
  const oldCount = oldIndex.getCurrentCount()

  // Get all live rows
  const rows = db.query<{ id: string; label: number }, []>(
    `SELECT id, label FROM ${table} WHERE label IS NOT NULL ORDER BY rowid`,
  ).all()

  if (rows.length === 0) {
    if (!quiet) console.log(`  ${table}: 0 live entries, skipping`)
    return { before: sizeBefore, after: sizeBefore, reclaimed: 0 }
  }

  // Build new index
  const newIndex = new HierarchicalNSW('cosine', dimension)
  newIndex.initIndex(Math.max(rows.length + 100, 1000), HNSW_M, HNSW_EF, HNSW_SEED, true)

  const updateLabel = db.prepare<void, [number, string]>(
    `UPDATE ${table} SET label = ? WHERE id = ?`,
  )

  let newLabel = 0
  let skipped = 0

  for (const row of rows) {
    let vec: Float32Array | number[]
    try {
      vec = oldIndex.getPoint(row.label)
    } catch {
      // Point was marked deleted or label invalid — skip
      skipped++
      continue
    }

    newIndex.addPoint(Array.from(vec), newLabel)
    updateLabel.run(newLabel, row.id)
    newLabel++
  }

  // Reset label_seq for this collection
  db.run(
    `INSERT INTO label_seq (collection, next_label) VALUES (?, ?)
     ON CONFLICT(collection) DO UPDATE SET next_label = excluded.next_label`,
    [table, newLabel],
  )

  // Write new index to temp file, then atomically rename
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
    .description('Rebuild HNSW indexes dropping deleted entries, rebuild FTS5 index')
    .option('--palace <path>', 'Palace path override')
    .option('--quiet', 'Suppress output')
    .action(async (opts: { palace?: string; quiet?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const dimension = getIndexedEmbeddingDimension(config.embedding)
      const quiet = opts.quiet ?? false

      const dbPath = join(palace_path, 'palace.sqlite3')
      if (!existsSync(dbPath)) {
        console.error(`No palace found at: ${palace_path}`)
        process.exit(1)
      }

      if (!quiet) console.log(`Compacting palace: ${palace_path}\n`)

      const db = new Database(dbPath)

      // Compact drawers index
      const drawersStats = await compactCollection(
        db,
        'drawers',
        join(palace_path, 'drawers.hnsw'),
        dimension,
        quiet,
      )

      // Compact closets index
      const closetsStats = await compactCollection(
        db,
        'closets',
        join(palace_path, 'closets.hnsw'),
        dimension,
        quiet,
      )

      // Rebuild FTS5
      const ftsBefore = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM drawers_fts').get()?.n ?? 0
      try {
        db.run(`INSERT INTO drawers_fts(drawers_fts) VALUES('rebuild')`)
        const ftsAfter = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM drawers_fts').get()?.n ?? 0
        if (!quiet) console.log(`  fts5:    rebuilt (${ftsBefore} → ${ftsAfter} rows)`)
      } catch (err) {
        if (!quiet) console.log(`  fts5:    rebuild failed: ${String(err)}`)
      }

      db.close()

      const totalReclaimed = drawersStats.reclaimed + closetsStats.reclaimed
      if (!quiet) {
        console.log(`\nTotal disk reclaimed: ${fmtBytes(totalReclaimed)}`)
      }
    })
}
