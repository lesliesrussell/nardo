import { copyFileSync, existsSync, renameSync } from 'fs'
import { unlinkSync } from 'node:fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { HierarchicalNSW } from 'hnswlib-node'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'
import {
  getIndexedEmbeddingDimension,
  getProviderEmbeddingDimension,
  loadConfig,
  saveConfig,
} from '../config.js'

const SQLITE_FILE = 'palace.sqlite3'
const SQLITE_BACKUP = 'palace.sqlite3.backup'
const HNSW_M = 16
const HNSW_EF = 200
const HNSW_SEED = 100

type TableName = 'drawers' | 'closets'

interface BaseRow {
  id: string
  document: string
  label: number | null
  wing: string
}

interface DrawerRow extends BaseRow {
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
}

interface ClosetRow extends BaseRow {
  room: string
  source_file: string
}

export interface ReembedOptions {
  palace_path: string
  wing?: string
  batch_size?: number
  dry_run?: boolean
  onProgress?: (info: {
    collection: TableName
    completed: number
    total: number
    percent: number
  }) => void
}

export interface ReembedResult {
  previous_dimension: number
  target_dimension: number
  full_rebuild: boolean
  dry_run: boolean
  drawers_total: number
  closets_total: number
  drawers_reembedded: number
  closets_reembedded: number
  backup_created: boolean
  config_updated: boolean
}

function writeEmptyIndex(indexPath: string, dimension: number): void {
  const index = new HierarchicalNSW('cosine', dimension)
  index.initIndex(1000, HNSW_M, HNSW_EF, HNSW_SEED, true)
  const tmpPath = indexPath + '.reembed'
  index.writeIndexSync(tmpPath)
  renameSync(tmpPath, indexPath)
}

function loadExistingIndex(indexPath: string, dimension: number): HierarchicalNSW {
  const index = new HierarchicalNSW('cosine', dimension)
  index.readIndexSync(indexPath, true)
  return index
}

async function rebuildCollection<T extends BaseRow>(
  db: Database,
  table: TableName,
  rows: T[],
  indexPath: string,
  previousDimension: number,
  targetDimension: number,
  batchSize: number,
  fullRebuild: boolean,
  selectedWing?: string,
  onProgress?: ReembedOptions['onProgress'],
): Promise<number> {
  if (rows.length === 0) {
    writeEmptyIndex(indexPath, targetDimension)
    db.run(
      `INSERT INTO label_seq (collection, next_label) VALUES (?, 0)
       ON CONFLICT(collection) DO UPDATE SET next_label = excluded.next_label`,
      [table],
    )
    return 0
  }

  const oldIndex = !fullRebuild ? loadExistingIndex(indexPath, previousDimension) : null
  const newIndex = new HierarchicalNSW('cosine', targetDimension)
  newIndex.initIndex(Math.max(rows.length + 100, 1000), HNSW_M, HNSW_EF, HNSW_SEED, true)
  const updateLabel = db.prepare<void, [number, string]>(`UPDATE ${table} SET label = ? WHERE id = ?`)
  const pipeline = getEmbeddingPipeline()

  let newLabel = 0
  let reembedded = 0

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const selected = batch.filter(row => fullRebuild || row.wing === selectedWing)
    const texts = selected.map(row => row.document)
    const embeddings = texts.length > 0 ? await pipeline.embed(texts) : []
    const embeddedById = new Map<string, number[]>()

    for (let i = 0; i < selected.length; i++) {
      const embedding = embeddings[i]
      if (embedding) {
        embeddedById.set(selected[i]!.id, embedding)
      }
    }

    for (const row of batch) {
      let vector = embeddedById.get(row.id)

      if (!vector) {
        if (!oldIndex || row.label == null) {
          throw new Error(`Cannot preserve existing ${table} vector for ${row.id}`)
        }
        vector = Array.from(oldIndex.getPoint(row.label))
      } else {
        reembedded++
      }

      newIndex.addPoint(vector, newLabel)
      updateLabel.run(newLabel, row.id)
      newLabel++
    }

    if (onProgress) {
      const completed = Math.min(start + batch.length, rows.length)
      onProgress({
        collection: table,
        completed,
        total: rows.length,
        percent: Math.round((completed / rows.length) * 100),
      })
    }
  }

  db.run(
    `INSERT INTO label_seq (collection, next_label) VALUES (?, ?)
     ON CONFLICT(collection) DO UPDATE SET next_label = excluded.next_label`,
    [table, newLabel],
  )

  const tmpPath = indexPath + '.reembed'
  newIndex.writeIndexSync(tmpPath)
  renameSync(tmpPath, indexPath)

  return reembedded
}

export async function reembedPalace(opts: ReembedOptions): Promise<ReembedResult> {
  const config = loadConfig()
  const previousDimension = getIndexedEmbeddingDimension(config.embedding)
  const targetDimension = getProviderEmbeddingDimension(config.embedding)
  const fullRebuild = !opts.wing
  const batchSize = opts.batch_size ?? 16
  const sqlitePath = join(opts.palace_path, SQLITE_FILE)
  const backupPath = join(opts.palace_path, SQLITE_BACKUP)
  const dryRun = opts.dry_run ?? false

  if (!fullRebuild && previousDimension !== targetDimension) {
    throw new Error(
      `--wing reembed is only valid when index dimension (${previousDimension}) already matches target dimension (${targetDimension}); run full nardo reembed first`,
    )
  }

  if (!existsSync(sqlitePath)) {
    throw new Error(`No palace found at: ${opts.palace_path}`)
  }

  const db = new Database(sqlitePath)
  const drawersTotal = opts.wing
    ? db.query<DrawerRow, [string]>(
      `SELECT id, document, label, wing, room, source_file, source_mtime, chunk_index,
              normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size
       FROM drawers WHERE wing = ? ORDER BY rowid`,
    ).all(opts.wing)
    : db.query<DrawerRow, []>(
      `SELECT id, document, label, wing, room, source_file, source_mtime, chunk_index,
              normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size
       FROM drawers ORDER BY rowid`,
    ).all()

  const closetsTotal = opts.wing
    ? db.query<ClosetRow, [string]>(
      `SELECT id, document, label, wing, room, source_file
       FROM closets WHERE wing = ? ORDER BY rowid`,
    ).all(opts.wing)
    : db.query<ClosetRow, []>(
      `SELECT id, document, label, wing, room, source_file
       FROM closets ORDER BY rowid`,
    ).all()

  if (dryRun) {
    db.close()
    return {
      previous_dimension: previousDimension,
      target_dimension: targetDimension,
      full_rebuild: fullRebuild,
      dry_run: true,
      drawers_total: drawersTotal.length,
      closets_total: closetsTotal.length,
      drawers_reembedded: drawersTotal.length,
      closets_reembedded: closetsTotal.length,
      backup_created: false,
      config_updated: false,
    }
  }

  let backupCreated = false
  if (fullRebuild && existsSync(sqlitePath)) {
    copyFileSync(sqlitePath, backupPath)
    backupCreated = true
  }

  if (fullRebuild) {
    try { unlinkSync(join(opts.palace_path, 'drawers.hnsw')) } catch {}
    try { unlinkSync(join(opts.palace_path, 'closets.hnsw')) } catch {}
  }

  const allDrawers = db.query<DrawerRow, []>(
    `SELECT id, document, label, wing, room, source_file, source_mtime, chunk_index,
            normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size
     FROM drawers ORDER BY rowid`,
  ).all()
  const allClosets = db.query<ClosetRow, []>(
    `SELECT id, document, label, wing, room, source_file
     FROM closets ORDER BY rowid`,
  ).all()

  const drawersRows = fullRebuild ? allDrawers : allDrawers.map(row => (
    row.wing === opts.wing ? row : { ...row, wing: `__preserve__${row.wing}` }
  ))
  const closetsRows = fullRebuild ? allClosets : allClosets.map(row => (
    row.wing === opts.wing ? row : { ...row, wing: `__preserve__${row.wing}` }
  ))

  const drawersReembedded = await rebuildCollection(
    db,
    'drawers',
    drawersRows,
    join(opts.palace_path, 'drawers.hnsw'),
    previousDimension,
    targetDimension,
    batchSize,
    fullRebuild,
    opts.wing,
    opts.onProgress,
  )

  const closetsReembedded = await rebuildCollection(
    db,
    'closets',
    closetsRows,
    join(opts.palace_path, 'closets.hnsw'),
    previousDimension,
    targetDimension,
    batchSize,
    fullRebuild,
    opts.wing,
    opts.onProgress,
  )

  db.close()

  let configUpdated = false
  if (fullRebuild && previousDimension !== targetDimension) {
    saveConfig({
      ...config,
      embedding: {
        ...config.embedding,
        dimension: targetDimension,
      },
    })
    configUpdated = true
  }

  return {
    previous_dimension: previousDimension,
    target_dimension: targetDimension,
    full_rebuild: fullRebuild,
    dry_run: false,
    drawers_total: drawersTotal.length,
    closets_total: closetsTotal.length,
    drawers_reembedded: drawersReembedded,
    closets_reembedded: closetsReembedded,
    backup_created: backupCreated,
    config_updated: configUpdated,
  }
}
