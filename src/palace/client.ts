// PalaceClient — vector store using hnswlib-node with sqlite or Dolt SQL backing
import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { HierarchicalNSW } from 'hnswlib-node'
import { join } from 'path'
import { getIndexedEmbeddingDimension, loadConfig } from '../config.js'
import {
  DOLT_DDL,
  interpolateSql,
  runDolt,
  runDoltJson,
  type SQLBindings,
  type SQLValue,
} from './dolt.js'

export interface CollectionQueryResult {
  ids: string[][]
  documents: (string | null)[][]
  metadatas: (Record<string, unknown> | null)[][]
  distances: number[][]
}

export interface CollectionGetResult {
  ids: string[]
  documents: (string | null)[]
  metadatas: (Record<string, unknown> | null)[]
}

export type WhereClause =
  | { [field: string]: { '$eq': unknown } | { '$prefix': string } }
  | { '$and': WhereClause[] }

export type PalaceBackend = 'sqlite' | 'dolt'

export interface Collection {
  name: string
  add(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void>
  upsert(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void>
  query(args: {
    queryEmbeddings: number[][]
    nResults: number
    where?: WhereClause | Record<string, unknown>
    include?: string[]
  }): Promise<CollectionQueryResult>
  get(args: {
    ids?: string[]
    where?: WhereClause | Record<string, unknown>
    include?: string[]
    limit?: number
  }): Promise<CollectionGetResult>
  delete(args: { ids?: string[]; where?: WhereClause | Record<string, unknown> }): Promise<void>
  count(): Promise<number>
  fts5Score(ids: string[], query: string): Promise<Map<string, number>>
  getEmbeddings(ids: string[]): Promise<Map<string, number[]>>
}

const MAX_ELEMENTS = 10000
const HNSW_M = 16
const HNSW_EF = 200
const HNSW_SEED = 100

const SQLITE_DDL = `
PRAGMA journal_mode=WAL;

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
);

CREATE TABLE IF NOT EXISTS closets (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  label INTEGER UNIQUE,
  source_file TEXT NOT NULL,
  wing TEXT NOT NULL,
  room TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label_seq (
  collection TEXT PRIMARY KEY,
  next_label INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
  id UNINDEXED,
  document,
  content='drawers',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS drawers_fts_ai AFTER INSERT ON drawers BEGIN
  INSERT INTO drawers_fts(rowid, id, document) VALUES (new.rowid, new.id, new.document);
END;

CREATE TRIGGER IF NOT EXISTS drawers_fts_ad AFTER DELETE ON drawers BEGIN
  INSERT INTO drawers_fts(drawers_fts, rowid, id, document) VALUES('delete', old.rowid, old.id, old.document);
END;

CREATE TRIGGER IF NOT EXISTS drawers_fts_au AFTER UPDATE OF document ON drawers BEGIN
  INSERT INTO drawers_fts(drawers_fts, rowid, id, document) VALUES('delete', old.rowid, old.id, old.document);
  INSERT INTO drawers_fts(rowid, id, document) VALUES (new.rowid, new.id, new.document);
END;
`

export interface PalaceDB {
  kind: PalaceBackend
  exec(sql: string): Promise<void>
  run(sql: string, params?: SQLBindings): Promise<void>
  all<T>(sql: string, params?: SQLBindings): Promise<T[]>
  get<T>(sql: string, params?: SQLBindings): Promise<T | undefined>
  close(): Promise<void>
}

class SqlitePalaceDB implements PalaceDB {
  kind: 'sqlite' = 'sqlite'
  private db: Database

  constructor(filename: string) {
    this.db = new Database(filename, { create: true })
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async run(sql: string, params: SQLBindings = []): Promise<void> {
    this.db.run(sql, params)
  }

  async all<T>(sql: string, params: SQLBindings = []): Promise<T[]> {
    return this.db.query<T, SQLBindings>(sql).all(...params)
  }

  async get<T>(sql: string, params: SQLBindings = []): Promise<T | undefined> {
    return this.db.query<T, SQLBindings>(sql).get(...params) ?? undefined
  }

  async close(): Promise<void> {
    this.db.close()
  }
}

class DoltPalaceDB implements PalaceDB {
  kind: 'dolt' = 'dolt'
  private repoPath: string

  constructor(repoPath: string) {
    this.repoPath = repoPath
  }

  async exec(sql: string): Promise<void> {
    runDolt(this.repoPath, ['sql', '-q', sql])
  }

  async run(sql: string, params: SQLBindings = []): Promise<void> {
    runDolt(this.repoPath, ['sql', '-q', interpolateSql(sql, params)])
  }

  async all<T>(sql: string, params: SQLBindings = []): Promise<T[]> {
    return runDoltJson<T>(this.repoPath, sql, params)
  }

  async get<T>(sql: string, params: SQLBindings = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params)
    return rows[0]
  }

  async close(): Promise<void> {}
}

interface SqlWhere {
  sql: string
  params: SQLBindings
}

function whereToSql(where: Record<string, unknown>): SqlWhere {
  const parts: string[] = []
  const params: SQLBindings = []

  if ('$and' in where && Array.isArray(where['$and'])) {
    for (const clause of where['$and'] as Record<string, unknown>[]) {
      const sub = whereToSql(clause)
      parts.push(`(${sub.sql})`)
      params.push(...sub.params)
    }
    return { sql: parts.join(' AND '), params }
  }

  const ALLOWED_FIELDS = new Set(['wing', 'room', 'source_file', 'ingest_mode', 'added_by'])

  for (const [field, condition] of Object.entries(where)) {
    if (field === '$and') continue
    if (condition !== null && typeof condition === 'object' && '$eq' in (condition as object)) {
      if (!ALLOWED_FIELDS.has(field)) throw new Error(`Invalid filter field: ${field}`)
      parts.push(`${field} = ?`)
      params.push((condition as { '$eq': SQLValue })['$eq'])
    } else if (condition !== null && typeof condition === 'object' && '$prefix' in (condition as object)) {
      if (!ALLOWED_FIELDS.has(field)) throw new Error(`Invalid filter field: ${field}`)
      parts.push(`${field} LIKE ?`)
      params.push((condition as { '$prefix': string })['$prefix'] + '%')
    }
  }

  return { sql: parts.join(' AND '), params }
}

async function nextLabel(db: PalaceDB, collection: string): Promise<number> {
  const existing = await db.get<{ next_label: number }>(
    `SELECT next_label FROM label_seq WHERE collection = ?`,
    [collection],
  )
  const label = existing?.next_label ?? 0
  if (!existing) {
    await db.run(`INSERT INTO label_seq (collection, next_label) VALUES (?, ?)`, [collection, 1])
  } else {
    await db.run(`REPLACE INTO label_seq (collection, next_label) VALUES (?, ?)`, [collection, label + 1])
  }
  return label
}

export async function openPalaceDB(
  palacePath: string,
  backend: PalaceBackend = loadConfig().palace.backend,
): Promise<PalaceDB> {
  mkdirSync(palacePath, { recursive: true })

  if (backend === 'dolt') {
    if (!existsSync(join(palacePath, '.dolt'))) {
      throw new Error(`Dolt backend selected but no .dolt repo found at ${palacePath}; run nardo dolt-init first`)
    }
    const db = new DoltPalaceDB(palacePath)
    await db.exec(DOLT_DDL)
    return db
  }

  const db = new SqlitePalaceDB(join(palacePath, 'palace.sqlite3'))
  await db.exec(SQLITE_DDL)

  const ftsRow = await db.get<{ n: number }>('SELECT count(*) as n FROM drawers_fts')
  const drawerRow = await db.get<{ n: number }>('SELECT count(*) as n FROM drawers')
  if ((ftsRow?.n ?? 0) === 0 && (drawerRow?.n ?? 0) > 0) {
    await db.run(`INSERT INTO drawers_fts(drawers_fts) VALUES('rebuild')`)
  }

  return db
}

function loadOrInitIndex(indexPath: string, dimension: number): HierarchicalNSW {
  const index = new HierarchicalNSW('cosine', dimension)
  if (existsSync(indexPath)) {
    index.readIndexSync(indexPath, true)
  } else {
    index.initIndex(MAX_ELEMENTS, HNSW_M, HNSW_EF, HNSW_SEED, true)
  }
  return index
}

function ensureCapacity(index: HierarchicalNSW): void {
  if (index.getCurrentCount() >= index.getMaxElements()) {
    index.resizeIndex(index.getMaxElements() * 2)
  }
}

async function lexicalScore(db: PalaceDB, table: 'drawers' | 'closets', ids: string[], query: string): Promise<Map<string, number>> {
  if (ids.length === 0 || !query.trim()) return new Map()
  const tokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  if (tokens.length === 0) return new Map()
  const ph = ids.map(() => '?').join(', ')
  const rows = await db.all<{ id: string; document: string }>(
    `SELECT id, document FROM ${table} WHERE id IN (${ph})`,
    ids,
  )
  const scores = new Map<string, number>()
  let max = 0

  for (const row of rows) {
    const text = row.document.toLowerCase()
    const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0)
    scores.set(row.id, score)
    if (score > max) max = score
  }

  if (max === 0) return new Map()
  for (const [id, score] of scores) {
    scores.set(id, score / max)
  }
  return scores
}

class DrawersCollection implements Collection {
  readonly name = 'drawers'
  private db: PalaceDB
  private index: HierarchicalNSW
  private indexPath: string

  constructor(db: PalaceDB, index: HierarchicalNSW, indexPath: string) {
    this.db = db
    this.index = index
    this.indexPath = indexPath
  }

  async add(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const doc = args.documents[i]!
      const meta = args.metadatas[i]!
      const embedding = args.embeddings?.[i]

      ensureCapacity(this.index)
      const label = await nextLabel(this.db, 'drawers')

      await this.db.run(
        `REPLACE INTO drawers
         (id, document, label, wing, room, source_file, source_mtime, chunk_index,
          normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          doc,
          label,
          meta['wing'] as string ?? '',
          meta['room'] as string ?? '',
          meta['source_file'] as string ?? '',
          meta['source_mtime'] as number ?? 0,
          meta['chunk_index'] as number ?? 0,
          meta['normalize_version'] as number ?? 2,
          meta['added_by'] as string ?? 'cli',
          meta['filed_at'] as string ?? new Date().toISOString(),
          meta['ingest_mode'] as string ?? 'project',
          meta['importance'] as number ?? 1.0,
          meta['chunk_size'] as number ?? doc.length,
        ],
      )

      if (embedding) this.index.addPoint(embedding, label)
    }

    this.index.writeIndexSync(this.indexPath)
  }

  async upsert(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const existing = await this.db.get<{ label: number | null }>(
        `SELECT label FROM drawers WHERE id = ?`,
        [id],
      )
      if (existing?.label != null) {
        try { this.index.markDelete(existing.label) } catch {}
      }
    }

    await this.add(args)
  }

  async query(args: {
    queryEmbeddings: number[][]
    nResults: number
    where?: Record<string, unknown>
    include?: string[]
  }): Promise<CollectionQueryResult> {
    const result: CollectionQueryResult = { ids: [], documents: [], metadatas: [], distances: [] }

    for (const qEmbed of args.queryEmbeddings) {
      const currentCount = this.index.getCurrentCount()
      if (currentCount === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      const fetchK = Math.min(args.nResults * 3, currentCount)
      const knnResult = this.index.searchKnn(qEmbed, fetchK)
      const labels = knnResult.neighbors
      const distances = knnResult.distances
      if (labels.length === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      const placeholders = labels.map(() => '?').join(', ')
      let sql = `SELECT id, document, label, wing, room, source_file, source_mtime,
                        chunk_index, normalize_version, added_by, filed_at, ingest_mode,
                        importance, chunk_size
                 FROM drawers WHERE label IN (${placeholders})`
      const sqlParams: SQLBindings = [...labels]

      if (args.where) {
        const w = whereToSql(args.where)
        if (w.sql) {
          sql += ` AND (${w.sql})`
          sqlParams.push(...w.params)
        }
      }

      const rows = await this.db.all<{
        id: string; document: string; label: number; wing: string; room: string
        source_file: string; source_mtime: number; chunk_index: number
        normalize_version: number; added_by: string; filed_at: string
        ingest_mode: string; importance: number; chunk_size: number
      }>(sql, sqlParams)

      const distMap = new Map<number, number>()
      for (let i = 0; i < labels.length; i++) distMap.set(labels[i]!, distances[i]!)
      rows.sort((a, b) => (distMap.get(a.label) ?? 2) - (distMap.get(b.label) ?? 2))
      const topRows = rows.slice(0, args.nResults)

      result.ids.push(topRows.map(r => r.id))
      result.documents.push(topRows.map(r => r.document))
      result.distances.push(topRows.map(r => distMap.get(r.label) ?? 2))
      result.metadatas.push(topRows.map(r => ({
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
      })))
    }

    return result
  }

  async get(args: {
    ids?: string[]
    where?: Record<string, unknown>
    include?: string[]
    limit?: number
  }): Promise<CollectionGetResult> {
    let sql = `SELECT id, document, label, wing, room, source_file, source_mtime,
                      chunk_index, normalize_version, added_by, filed_at, ingest_mode,
                      importance, chunk_size
               FROM drawers`
    const params: SQLBindings = []
    const conditions: string[] = []

    if (args.ids && args.ids.length > 0) {
      conditions.push(`id IN (${args.ids.map(() => '?').join(', ')})`)
      params.push(...args.ids)
    }
    if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        conditions.push(`(${w.sql})`)
        params.push(...w.params)
      }
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    if (args.limit) {
      sql += ` LIMIT ?`
      params.push(args.limit)
    }

    const rows = await this.db.all<{
      id: string; document: string; label: number; wing: string; room: string
      source_file: string; source_mtime: number; chunk_index: number
      normalize_version: number; added_by: string; filed_at: string
      ingest_mode: string; importance: number; chunk_size: number
    }>(sql, params)

    return {
      ids: rows.map(r => r.id),
      documents: rows.map(r => r.document),
      metadatas: rows.map(r => ({
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
      })),
    }
  }

  async delete(args: { ids?: string[]; where?: Record<string, unknown> }): Promise<void> {
    let ids: string[] = []
    if (args.ids && args.ids.length > 0) {
      ids = args.ids
    } else if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        const rows = await this.db.all<{ id: string }>(`SELECT id FROM drawers WHERE ${w.sql}`, w.params)
        ids = rows.map(r => r.id)
      }
    }
    if (ids.length === 0) return

    const ph = ids.map(() => '?').join(', ')
    const rows = await this.db.all<{ label: number | null }>(
      `SELECT label FROM drawers WHERE id IN (${ph})`,
      ids,
    )
    for (const row of rows) {
      if (row.label != null) {
        try { this.index.markDelete(row.label) } catch {}
      }
    }

    await this.db.run(`DELETE FROM drawers WHERE id IN (${ph})`, ids)
    this.index.writeIndexSync(this.indexPath)
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(`SELECT COUNT(*) as n FROM drawers`)
    return row?.n ?? 0
  }

  async fts5Score(ids: string[], query: string): Promise<Map<string, number>> {
    if (ids.length === 0 || !query.trim()) return new Map()
    if (this.db.kind === 'dolt') {
      return lexicalScore(this.db, 'drawers', ids, query)
    }

    const tokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
    if (tokens.length === 0) return new Map()
    const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ')
    const ph = ids.map(() => '?').join(', ')
    let rows: Array<{ id: string; bm25: number }> = []
    try {
      rows = await this.db.all<{ id: string; bm25: number }>(
        `SELECT id, bm25(drawers_fts) AS bm25
         FROM drawers_fts
         WHERE drawers_fts MATCH ? AND id IN (${ph})`,
        [ftsQuery, ...ids],
      )
    } catch {
      return new Map()
    }
    if (rows.length === 0) return new Map()

    const rawValues = rows.map(r => r.bm25)
    const min = Math.min(...rawValues)
    const max = Math.max(...rawValues)
    const range = max - min

    const result = new Map<string, number>()
    for (const row of rows) {
      result.set(row.id, range === 0 ? 1.0 : (max - row.bm25) / range)
    }
    return result
  }

  async getEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map()
    const ph = ids.map(() => '?').join(', ')
    const rows = await this.db.all<{ id: string; label: number }>(
      `SELECT id, label FROM drawers WHERE id IN (${ph})`,
      ids,
    )
    const result = new Map<string, number[]>()
    for (const row of rows) {
      if (row.label == null) continue
      try {
        const vec = this.index.getPoint(row.label)
        if (vec) result.set(row.id, Array.from(vec))
      } catch {}
    }
    return result
  }
}

class ClosetsCollection implements Collection {
  readonly name = 'closets'
  private db: PalaceDB
  private index: HierarchicalNSW
  private indexPath: string

  constructor(db: PalaceDB, index: HierarchicalNSW, indexPath: string) {
    this.db = db
    this.index = index
    this.indexPath = indexPath
  }

  async add(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const doc = args.documents[i]!
      const meta = args.metadatas[i]!
      const embedding = args.embeddings?.[i]

      ensureCapacity(this.index)
      const label = await nextLabel(this.db, 'closets')
      await this.db.run(
        `REPLACE INTO closets (id, document, label, source_file, wing, room)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          doc,
          label,
          meta['source_file'] as string ?? '',
          meta['wing'] as string ?? '',
          meta['room'] as string ?? '',
        ],
      )

      if (embedding) this.index.addPoint(embedding, label)
    }

    if (args.embeddings) this.index.writeIndexSync(this.indexPath)
  }

  async upsert(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    for (let i = 0; i < args.ids.length; i++) {
      const existing = await this.db.get<{ label: number | null }>(
        `SELECT label FROM closets WHERE id = ?`,
        [args.ids[i]!],
      )
      if (existing?.label != null && args.embeddings?.[i]) {
        try { this.index.markDelete(existing.label) } catch {}
      }
    }
    await this.add(args)
  }

  async query(args: {
    queryEmbeddings: number[][]
    nResults: number
    where?: Record<string, unknown>
    include?: string[]
  }): Promise<CollectionQueryResult> {
    const result: CollectionQueryResult = { ids: [], documents: [], metadatas: [], distances: [] }

    for (const qEmbed of args.queryEmbeddings) {
      const currentCount = this.index.getCurrentCount()
      if (currentCount === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      const fetchK = Math.min(args.nResults * 3, currentCount)
      const knnResult = this.index.searchKnn(qEmbed, fetchK)
      const labels = knnResult.neighbors
      const distances = knnResult.distances
      if (labels.length === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      const placeholders = labels.map(() => '?').join(', ')
      let sql = `SELECT id, document, label, source_file, wing, room
                 FROM closets WHERE label IN (${placeholders})`
      const params: SQLBindings = [...labels]

      if (args.where) {
        const w = whereToSql(args.where)
        if (w.sql) {
          sql += ` AND (${w.sql})`
          params.push(...w.params)
        }
      }

      const rows = await this.db.all<{
        id: string; document: string; label: number
        source_file: string; wing: string; room: string
      }>(sql, params)

      const distMap = new Map<number, number>()
      for (let i = 0; i < labels.length; i++) distMap.set(labels[i]!, distances[i]!)
      rows.sort((a, b) => (distMap.get(a.label) ?? 2) - (distMap.get(b.label) ?? 2))
      const topRows = rows.slice(0, args.nResults)

      result.ids.push(topRows.map(r => r.id))
      result.documents.push(topRows.map(r => r.document))
      result.distances.push(topRows.map(r => distMap.get(r.label) ?? 2))
      result.metadatas.push(topRows.map(r => ({
        source_file: r.source_file,
        wing: r.wing,
        room: r.room,
      })))
    }

    return result
  }

  async get(args: {
    ids?: string[]
    where?: Record<string, unknown>
    include?: string[]
    limit?: number
  }): Promise<CollectionGetResult> {
    let sql = `SELECT id, document, label, source_file, wing, room FROM closets`
    const params: SQLBindings = []
    const conditions: string[] = []

    if (args.ids && args.ids.length > 0) {
      conditions.push(`id IN (${args.ids.map(() => '?').join(', ')})`)
      params.push(...args.ids)
    }
    if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        conditions.push(`(${w.sql})`)
        params.push(...w.params)
      }
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    if (args.limit) {
      sql += ` LIMIT ?`
      params.push(args.limit)
    }

    const rows = await this.db.all<{
      id: string; document: string; label: number
      source_file: string; wing: string; room: string
    }>(sql, params)

    return {
      ids: rows.map(r => r.id),
      documents: rows.map(r => r.document),
      metadatas: rows.map(r => ({
        source_file: r.source_file,
        wing: r.wing,
        room: r.room,
      })),
    }
  }

  async delete(args: { ids?: string[]; where?: Record<string, unknown> }): Promise<void> {
    let ids: string[] = []
    if (args.ids && args.ids.length > 0) {
      ids = args.ids
    } else if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        const rows = await this.db.all<{ id: string }>(`SELECT id FROM closets WHERE ${w.sql}`, w.params)
        ids = rows.map(r => r.id)
      }
    }
    if (ids.length === 0) return

    const ph = ids.map(() => '?').join(', ')
    const rows = await this.db.all<{ label: number | null }>(
      `SELECT label FROM closets WHERE id IN (${ph})`,
      ids,
    )
    for (const row of rows) {
      if (row.label != null) {
        try { this.index.markDelete(row.label) } catch {}
      }
    }
    await this.db.run(`DELETE FROM closets WHERE id IN (${ph})`, ids)
    this.index.writeIndexSync(this.indexPath)
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(`SELECT COUNT(*) as n FROM closets`)
    return row?.n ?? 0
  }

  async fts5Score(ids: string[], query: string): Promise<Map<string, number>> {
    return lexicalScore(this.db, 'closets', ids, query)
  }

  async getEmbeddings(_ids: string[]): Promise<Map<string, number[]>> {
    return new Map()
  }
}

export class PalaceClient {
  private palace_path: string
  private embeddingDimension: number
  private backend: PalaceBackend
  private db: PalaceDB | null = null
  private drawersIndex: HierarchicalNSW | null = null
  private closetsIndex: HierarchicalNSW | null = null
  private drawersCol: DrawersCollection | null = null
  private closetsCol: ClosetsCollection | null = null

  constructor(palace_path: string, embeddingDimension?: number) {
    const config = loadConfig()
    this.palace_path = palace_path
    this.embeddingDimension = embeddingDimension ?? getIndexedEmbeddingDimension(config.embedding)
    this.backend = config.palace.backend
  }

  private async ensureInit(): Promise<void> {
    if (this.db) return

    this.db = await openPalaceDB(this.palace_path, this.backend)

    const drawersIndexPath = join(this.palace_path, 'drawers.hnsw')
    const closetsIndexPath = join(this.palace_path, 'closets.hnsw')
    this.drawersIndex = loadOrInitIndex(drawersIndexPath, this.embeddingDimension)
    this.closetsIndex = loadOrInitIndex(closetsIndexPath, this.embeddingDimension)
    this.drawersCol = new DrawersCollection(this.db, this.drawersIndex, drawersIndexPath)
    this.closetsCol = new ClosetsCollection(this.db, this.closetsIndex, closetsIndexPath)
  }

  async getDrawersCollection(): Promise<Collection> {
    await this.ensureInit()
    return this.drawersCol!
  }

  async getClosetsCollection(): Promise<Collection> {
    await this.ensureInit()
    return this.closetsCol!
  }

  invalidateCache(): void {
    if (this.db) {
      void this.db.close()
      this.db = null
    }
    this.drawersIndex = null
    this.closetsIndex = null
    this.drawersCol = null
    this.closetsCol = null
  }
}
