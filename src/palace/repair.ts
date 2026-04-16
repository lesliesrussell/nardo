// Repair — scan, prune, and rebuild the palace collection
import { copyFileSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { PalaceClient } from './client.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'

export interface ScanResult {
  good: string[]
  bad: string[]
}

export interface RepairResult {
  extracted: number
  backed_up: boolean
  rebuilt: boolean
  upserted: number
}

const CORRUPT_IDS_FILE = 'corrupt_ids.txt'
const SQLITE_FILE = 'palace.sqlite3'
const SQLITE_BACKUP = 'palace.sqlite3.backup'
const BATCH_SIZE = 50

// Scan: check each drawer's label against the HNSW index count
export async function scanForCorrupt(palace_path: string, wing?: string): Promise<ScanResult> {
  const client = new PalaceClient(palace_path)
  const collection = await client.getDrawersCollection()

  const getOpts: { where?: Record<string, unknown>; include: string[] } = {
    include: ['metadatas'],
  }
  if (wing) {
    getOpts.where = { wing: { $eq: wing } }
  }

  const all = await collection.get(getOpts)
  const allIds = all.ids

  // Read labels from SQLite directly to check against HNSW index
  const dbPath = join(palace_path, SQLITE_FILE)
  const db = new Database(dbPath, { readonly: true })

  const good: string[] = []
  const bad: string[] = []

  const ph = allIds.length > 0 ? allIds.map(() => '?').join(', ') : null

  if (!ph) {
    db.close()
    const corruptPath = join(palace_path, CORRUPT_IDS_FILE)
    writeFileSync(corruptPath, '', 'utf-8')
    return { good, bad }
  }

  const rows = db.query<{ id: string; label: number | null }, (string | number | boolean | null | bigint | Uint8Array)[]>(
    `SELECT id, label FROM drawers WHERE id IN (${ph})`,
  ).all(...allIds)

  // Get current HNSW count from label_seq
  const seqRow = db.query<{ next_label: number }, [string]>(
    `SELECT next_label FROM label_seq WHERE collection = ?`,
  ).get('drawers')
  const maxLabel = seqRow?.next_label ?? 0

  db.close()

  for (const row of rows) {
    // A drawer is BAD if its label is null or >= maxLabel (not yet assigned in index)
    if (row.label == null || row.label >= maxLabel) {
      bad.push(row.id)
    } else {
      good.push(row.id)
    }
  }

  const corruptPath = join(palace_path, CORRUPT_IDS_FILE)
  writeFileSync(corruptPath, bad.join('\n') + (bad.length > 0 ? '\n' : ''), 'utf-8')

  return { good, bad }
}

// Prune: delete bad IDs from SQLite and mark deleted in HNSW
export async function pruneCorrupt(palace_path: string, confirm?: boolean): Promise<number> {
  const corruptPath = join(palace_path, CORRUPT_IDS_FILE)

  if (!existsSync(corruptPath)) {
    return 0
  }

  const raw = readFileSync(corruptPath, 'utf-8').trim()
  const ids = raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : []

  if (!confirm) {
    return ids.length
  }

  if (ids.length === 0) return 0

  const client = new PalaceClient(palace_path)
  const collection = await client.getDrawersCollection()

  // Delete in batches
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    await collection.delete({ ids: batch })
  }

  return ids.length
}

// Rebuild: extract all rows, backup, drop+recreate tables, re-embed, re-insert
export async function rebuildPalace(palace_path: string): Promise<RepairResult> {
  const sqlitePath = join(palace_path, SQLITE_FILE)
  const backupPath = join(palace_path, SQLITE_BACKUP)

  // 1. Extract all rows from drawers table via SQLite directly
  const db = new Database(sqlitePath, { readonly: true })
  const rows = db.query<{
    id: string
    document: string
    wing: string
    room: string
    source_file: string
    source_mtime: number
    chunk_index: number
    normalize_version: number
    added_by: string
    filed_at: string
    ingest_mode: string
    importance: number
    chunk_size: number
  }, []>(`SELECT id, document, wing, room, source_file, source_mtime, chunk_index,
                normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size
         FROM drawers`).all()
  db.close()

  const extracted = rows.length

  // 2. Backup palace.sqlite3
  let backed_up = false
  if (existsSync(sqlitePath)) {
    copyFileSync(sqlitePath, backupPath)
    backed_up = true
  }

  // 3. Drop and recreate via a fresh client (invalidate wipes the in-memory state)
  //    We directly manipulate SQLite to drop/recreate tables and reset label_seq
  const dbWrite = new Database(sqlitePath)
  dbWrite.exec('PRAGMA journal_mode=WAL')
  dbWrite.exec('DROP TABLE IF EXISTS drawers')
  dbWrite.exec('DROP TABLE IF EXISTS closets')
  dbWrite.exec('DELETE FROM label_seq WHERE collection IN (\'drawers\', \'closets\')')
  dbWrite.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      label INTEGER UNIQUE,
      wing TEXT NOT NULL,
      room TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_mtime REAL NOT NULL,
      chunk_index INTEGER NOT NULL,
      normalize_version INTEGER DEFAULT 2,
      added_by TEXT DEFAULT 'cli',
      filed_at TEXT NOT NULL,
      ingest_mode TEXT DEFAULT 'project',
      importance REAL DEFAULT 1.0,
      chunk_size INTEGER NOT NULL
    )
  `)
  dbWrite.exec(`
    CREATE TABLE IF NOT EXISTS closets (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      label INTEGER UNIQUE,
      source_file TEXT NOT NULL,
      wing TEXT NOT NULL,
      room TEXT NOT NULL
    )
  `)
  dbWrite.close()

  // Also remove HNSW index files so they get re-initialized
  const drawersHnsw = join(palace_path, 'drawers.hnsw')
  const closetsHnsw = join(palace_path, 'closets.hnsw')
  try { (await import('fs')).unlinkSync(drawersHnsw) } catch { /* ok */ }
  try { (await import('fs')).unlinkSync(closetsHnsw) } catch { /* ok */ }

  // 4. Re-embed all documents and re-insert via PalaceClient
  const client = new PalaceClient(palace_path)
  const collection = await client.getDrawersCollection()
  const pipeline = getEmbeddingPipeline()

  let upserted = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const texts = batch.map(r => r.document)
    const embeddings = await pipeline.embed(texts)

    const ids = batch.map(r => r.id)
    const documents = batch.map(r => r.document)
    const metadatas = batch.map(r => ({
      wing: r.wing,
      room: r.room,
      source_file: r.source_file,
      source_mtime: r.source_mtime,
      chunk_index: r.chunk_index,
      normalize_version: r.normalize_version,
      added_by: r.added_by,
      filed_at: r.filed_at,
      ingest_mode: r.ingest_mode,
      importance: r.importance,
      chunk_size: r.chunk_size,
    }))

    await collection.upsert({ ids, documents, embeddings, metadatas })
    upserted += batch.length
  }

  return {
    extracted,
    backed_up,
    rebuilt: true,
    upserted,
  }
}
