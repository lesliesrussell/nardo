// PalaceClient — embedded vector store using hnswlib-node + bun:sqlite
import { Database } from 'bun:sqlite'
import { HierarchicalNSW } from 'hnswlib-node'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'

// ─── Public interfaces ────────────────────────────────────────────────────────

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
  | { [field: string]: { '$eq': unknown } }
  | { '$and': WhereClause[] }

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
  /** BM25 scores via SQLite FTS5 for a candidate set of drawer IDs. Returns normalized [0,1] map. */
  fts5Score(ids: string[], query: string): Promise<Map<string, number>>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DIMS = 384          // all-MiniLM-L6-v2
const MAX_ELEMENTS = 10000
const HNSW_M = 16
const HNSW_EF = 200
const HNSW_SEED = 100

type SQLBindings = (string | number | boolean | null | bigint | Uint8Array)[]

// ─── SQL DDL ──────────────────────────────────────────────────────────────────

const DDL = `
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

// ─── WHERE clause → SQL translation ──────────────────────────────────────────

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
      parts.push(`"${field}" = ?`)
      params.push((condition as { '$eq': string | number | boolean | null | bigint | Uint8Array })['$eq'])
    }
  }

  return { sql: parts.join(' AND '), params }
}

// ─── Next label ───────────────────────────────────────────────────────────────

function nextLabel(db: Database, collection: string): number {
  db.run(
    `INSERT INTO label_seq (collection, next_label) VALUES (?, 0)
     ON CONFLICT(collection) DO NOTHING`,
    [collection],
  )
  const row = db.query<{ next_label: number }, [string]>(
    `SELECT next_label FROM label_seq WHERE collection = ?`,
  ).get(collection)
  const label = row?.next_label ?? 0
  db.run(`UPDATE label_seq SET next_label = ? WHERE collection = ?`, [label + 1, collection])
  return label
}

// ─── HNSW index loader/initializer ───────────────────────────────────────────

function loadOrInitIndex(indexPath: string): HierarchicalNSW {
  const index = new HierarchicalNSW('cosine', DIMS)
  if (existsSync(indexPath)) {
    // readIndex is async in the types but works synchronously via sync variant
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

// ─── DrawersCollection implementation ────────────────────────────────────────

class DrawersCollection implements Collection {
  readonly name = 'drawers'
  private db: Database
  private index: HierarchicalNSW
  private indexPath: string

  constructor(db: Database, index: HierarchicalNSW, indexPath: string) {
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
    const insert = this.db.prepare<void, SQLBindings>(
      `INSERT OR REPLACE INTO drawers
       (id, document, label, wing, room, source_file, source_mtime, chunk_index,
        normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const doc = args.documents[i]!
      const meta = args.metadatas[i]!
      const embedding = args.embeddings?.[i]

      ensureCapacity(this.index)
      const label = nextLabel(this.db, 'drawers')

      insert.run(
        id, doc, label,
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
      )

      if (embedding) {
        this.index.addPoint(embedding, label)
      }
    }

    this.index.writeIndexSync(this.indexPath)
  }

  async upsert(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    // Delete existing labels from index before re-inserting
    const getLabel = this.db.prepare<{ label: number | null }, [string]>(
      `SELECT label FROM drawers WHERE id = ?`,
    )

    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const existing = getLabel.get(id)
      if (existing?.label != null) {
        try { this.index.markDelete(existing.label) } catch { /* already deleted */ }
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
    const result: CollectionQueryResult = {
      ids: [],
      documents: [],
      metadatas: [],
      distances: [],
    }

    for (const qEmbed of args.queryEmbeddings) {
      const currentCount = this.index.getCurrentCount()
      if (currentCount === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      // Over-fetch to account for deleted + WHERE filter
      const fetchK = Math.min(args.nResults * 3, currentCount)
      const knnResult = this.index.searchKnn(qEmbed, fetchK)

      // Map labels → rows
      const labels = knnResult.neighbors
      const distances = knnResult.distances

      if (labels.length === 0) {
        result.ids.push([])
        result.documents.push([])
        result.metadatas.push([])
        result.distances.push([])
        continue
      }

      // Build SQL to fetch by labels
      const placeholders = labels.map(() => '?').join(', ')
      let sql = `SELECT id, document, label, wing, room, source_file, source_mtime,
                        chunk_index, normalize_version, added_by, filed_at, ingest_mode,
                        importance, chunk_size
                 FROM drawers WHERE label IN (${placeholders})`
      const sqlParams: SQLBindings =[...labels]

      if (args.where) {
        const w = whereToSql(args.where)
        if (w.sql) {
          sql += ` AND (${w.sql})`
          sqlParams.push(...w.params)
        }
      }

      const rows = this.db.query<{
        id: string; document: string; label: number; wing: string; room: string
        source_file: string; source_mtime: number; chunk_index: number
        normalize_version: number; added_by: string; filed_at: string
        ingest_mode: string; importance: number; chunk_size: number
      }, SQLBindings>(sql).all(...sqlParams)

      // Build label→distance map and label→row map
      const distMap = new Map<number, number>()
      for (let i = 0; i < labels.length; i++) {
        distMap.set(labels[i]!, distances[i]!)
      }

      // Sort rows by distance (preserving knn order)
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
      const ph = args.ids.map(() => '?').join(', ')
      conditions.push(`id IN (${ph})`)
      params.push(...args.ids)
    }

    if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        conditions.push(`(${w.sql})`)
        params.push(...w.params)
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    if (args.limit) {
      sql += ` LIMIT ?`
      params.push(args.limit)
    }

    const rows = this.db.query<{
      id: string; document: string; label: number; wing: string; room: string
      source_file: string; source_mtime: number; chunk_index: number
      normalize_version: number; added_by: string; filed_at: string
      ingest_mode: string; importance: number; chunk_size: number
    }, SQLBindings>(sql).all(...params)

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
        const rows = this.db.query<{ id: string }, SQLBindings>(
          `SELECT id FROM drawers WHERE ${w.sql}`,
        ).all(...w.params)
        ids = rows.map(r => r.id)
      }
    }

    if (ids.length === 0) return

    // Get labels to mark deleted in index
    const ph = ids.map(() => '?').join(', ')
    const rows = this.db.query<{ label: number | null }, SQLBindings>(
      `SELECT label FROM drawers WHERE id IN (${ph})`,
    ).all(...ids)

    for (const row of rows) {
      if (row.label != null) {
        try { this.index.markDelete(row.label) } catch { /* already deleted */ }
      }
    }

    this.db.run(`DELETE FROM drawers WHERE id IN (${ph})`, ids)
    this.index.writeIndexSync(this.indexPath)
  }

  async count(): Promise<number> {
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM drawers`).get()
    return row?.n ?? 0
  }

  async fts5Score(ids: string[], query: string): Promise<Map<string, number>> {
    if (ids.length === 0 || !query.trim()) return new Map()

    // Convert query to FTS5 OR-of-terms: each token wrapped in quotes for exact match
    const tokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
    if (tokens.length === 0) return new Map()
    const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ')

    const ph = ids.map(() => '?').join(', ')
    let rows: Array<{ id: string; bm25: number }> = []
    try {
      rows = this.db.query<{ id: string; bm25: number }, SQLBindings>(
        `SELECT id, bm25(drawers_fts) AS bm25
         FROM drawers_fts
         WHERE drawers_fts MATCH ? AND id IN (${ph})`,
      ).all(ftsQuery, ...ids)
    } catch {
      // FTS5 may throw on malformed query — fall back to zero scores
      return new Map()
    }

    if (rows.length === 0) return new Map()

    // FTS5 bm25() returns negative values — more negative = more relevant
    // Normalize: best (most negative) → 1.0, worst (least negative) → 0.0
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
}

// ─── ClosetsCollection implementation ────────────────────────────────────────

class ClosetsCollection implements Collection {
  readonly name = 'closets'
  private db: Database
  private index: HierarchicalNSW
  private indexPath: string

  constructor(db: Database, index: HierarchicalNSW, indexPath: string) {
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
    const insert = this.db.prepare<void, SQLBindings>(
      `INSERT OR REPLACE INTO closets (id, document, label, source_file, wing, room)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )

    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const doc = args.documents[i]!
      const meta = args.metadatas[i]!
      const embedding = args.embeddings?.[i]

      ensureCapacity(this.index)
      const label = nextLabel(this.db, 'closets')
      insert.run(
        id, doc, label,
        meta['source_file'] as string ?? '',
        meta['wing'] as string ?? '',
        meta['room'] as string ?? '',
      )

      if (embedding) {
        this.index.addPoint(embedding, label)
      }
    }

    if (args.embeddings) {
      this.index.writeIndexSync(this.indexPath)
    }
  }

  async upsert(args: {
    ids: string[]
    embeddings?: number[][]
    documents: string[]
    metadatas: Record<string, unknown>[]
  }): Promise<void> {
    const getLabel = this.db.prepare<{ label: number | null }, [string]>(
      `SELECT label FROM closets WHERE id = ?`,
    )

    for (let i = 0; i < args.ids.length; i++) {
      const id = args.ids[i]!
      const existing = getLabel.get(id)
      if (existing?.label != null && args.embeddings?.[i]) {
        try { this.index.markDelete(existing.label) } catch { /* already deleted */ }
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
    const result: CollectionQueryResult = {
      ids: [],
      documents: [],
      metadatas: [],
      distances: [],
    }

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
      const sqlParams: SQLBindings =[...labels]

      if (args.where) {
        const w = whereToSql(args.where)
        if (w.sql) {
          sql += ` AND (${w.sql})`
          sqlParams.push(...w.params)
        }
      }

      const rows = this.db.query<{
        id: string; document: string; label: number
        source_file: string; wing: string; room: string
      }, SQLBindings>(sql).all(...sqlParams)

      const distMap = new Map<number, number>()
      for (let i = 0; i < labels.length; i++) {
        distMap.set(labels[i]!, distances[i]!)
      }

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
      const ph = args.ids.map(() => '?').join(', ')
      conditions.push(`id IN (${ph})`)
      params.push(...args.ids)
    }

    if (args.where) {
      const w = whereToSql(args.where)
      if (w.sql) {
        conditions.push(`(${w.sql})`)
        params.push(...w.params)
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    if (args.limit) {
      sql += ` LIMIT ?`
      params.push(args.limit)
    }

    const rows = this.db.query<{
      id: string; document: string; label: number
      source_file: string; wing: string; room: string
    }, SQLBindings>(sql).all(...params)

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
        const rows = this.db.query<{ id: string }, SQLBindings>(
          `SELECT id FROM closets WHERE ${w.sql}`,
        ).all(...w.params)
        ids = rows.map(r => r.id)
      }
    }

    if (ids.length === 0) return

    const ph = ids.map(() => '?').join(', ')
    const rows = this.db.query<{ label: number | null }, SQLBindings>(
      `SELECT label FROM closets WHERE id IN (${ph})`,
    ).all(...ids)

    for (const row of rows) {
      if (row.label != null) {
        try { this.index.markDelete(row.label) } catch { /* already deleted */ }
      }
    }

    this.db.run(`DELETE FROM closets WHERE id IN (${ph})`, ids)
    this.index.writeIndexSync(this.indexPath)
  }

  async count(): Promise<number> {
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM closets`).get()
    return row?.n ?? 0
  }

  // Closets are not full-text indexed — BM25 scoring not applicable
  async fts5Score(_ids: string[], _query: string): Promise<Map<string, number>> {
    return new Map()
  }
}

// ─── PalaceClient ─────────────────────────────────────────────────────────────

export class PalaceClient {
  private palace_path: string
  private db: Database | null = null
  private drawersIndex: HierarchicalNSW | null = null
  private closetsIndex: HierarchicalNSW | null = null
  private drawersCol: DrawersCollection | null = null
  private closetsCol: ClosetsCollection | null = null

  constructor(palace_path: string) {
    this.palace_path = palace_path
  }

  private ensureInit(): void {
    if (this.db) return

    mkdirSync(this.palace_path, { recursive: true })

    const dbPath = join(this.palace_path, 'palace.sqlite3')
    this.db = new Database(dbPath, { create: true })
    this.db.exec(DDL)

    // Populate FTS index for any pre-existing rows (migration for palaces created before FTS5 was added)
    const ftsRow = this.db.query<{ n: number }, []>('SELECT count(*) as n FROM drawers_fts').get()
    const drawerRow = this.db.query<{ n: number }, []>('SELECT count(*) as n FROM drawers').get()
    if ((ftsRow?.n ?? 0) === 0 && (drawerRow?.n ?? 0) > 0) {
      this.db.run(`INSERT INTO drawers_fts(drawers_fts) VALUES('rebuild')`)
    }

    const drawersIndexPath = join(this.palace_path, 'drawers.hnsw')
    const closetsIndexPath = join(this.palace_path, 'closets.hnsw')

    this.drawersIndex = loadOrInitIndex(drawersIndexPath)
    this.closetsIndex = loadOrInitIndex(closetsIndexPath)

    this.drawersCol = new DrawersCollection(this.db, this.drawersIndex, drawersIndexPath)
    this.closetsCol = new ClosetsCollection(this.db, this.closetsIndex, closetsIndexPath)
  }

  async getDrawersCollection(): Promise<Collection> {
    this.ensureInit()
    return this.drawersCol!
  }

  async getClosetsCollection(): Promise<Collection> {
    this.ensureInit()
    return this.closetsCol!
  }

  invalidateCache(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.drawersIndex = null
    this.closetsIndex = null
    this.drawersCol = null
    this.closetsCol = null
  }
}
