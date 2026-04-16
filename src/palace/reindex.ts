import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { HierarchicalNSW } from 'hnswlib-node'
import {
  getIndexedEmbeddingDimension,
  getProviderEmbeddingDimension,
  loadConfig,
} from '../config.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'
import { openPalaceDB, type PalaceDB } from './client.js'

const HNSW_M = 16
const HNSW_EF = 200
const HNSW_SEED = 100

type TableName = 'drawers' | 'closets'

interface ReindexOptions {
  palace_path: string
  quiet?: boolean
  onProgress?: (info: {
    collection: TableName
    completed: number
    total: number
    percent: number
  }) => void
}

interface PalaceRow {
  id: string
  document: string
}

export interface ReindexResult {
  dimension: number
  drawers: number
  closets: number
}

async function reindexCollection(
  db: PalaceDB,
  table: TableName,
  indexPath: string,
  dimension: number,
  onProgress?: ReindexOptions['onProgress'],
): Promise<number> {
  const rows = await db.all<PalaceRow>(
    `SELECT id, document FROM ${table} ORDER BY COALESCE(label, 0), id`,
  )

  const index = new HierarchicalNSW('cosine', dimension)
  index.initIndex(Math.max(rows.length + 100, 1000), HNSW_M, HNSW_EF, HNSW_SEED, true)

  if (rows.length === 0) {
    await db.run(`REPLACE INTO label_seq (collection, next_label) VALUES (?, 0)`, [table])
    const tmpPath = indexPath + '.reindex'
    index.writeIndexSync(tmpPath)
    renameSync(tmpPath, indexPath)
    return 0
  }

  const pipeline = getEmbeddingPipeline()
  const batchSize = 32
  let nextLabel = 0

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const embeddings = await pipeline.embed(batch.map(row => row.document))
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!
      const embedding = embeddings[i]
      if (!embedding) throw new Error(`Missing embedding for ${table} row ${row.id}`)
      index.addPoint(embedding, nextLabel)
      await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, [nextLabel, row.id])
      nextLabel++
    }

    onProgress?.({
      collection: table,
      completed: Math.min(start + batch.length, rows.length),
      total: rows.length,
      percent: Math.round((Math.min(start + batch.length, rows.length) / rows.length) * 100),
    })
  }

  await db.run(`REPLACE INTO label_seq (collection, next_label) VALUES (?, ?)`, [table, nextLabel])

  const tmpPath = indexPath + '.reindex'
  index.writeIndexSync(tmpPath)
  renameSync(tmpPath, indexPath)
  return rows.length
}

export async function rebuildPalaceIndexes(opts: ReindexOptions): Promise<ReindexResult> {
  const config = loadConfig()
  const indexedDimension = getIndexedEmbeddingDimension(config.embedding)
  const providerDimension = getProviderEmbeddingDimension(config.embedding)

  if (indexedDimension !== providerDimension) {
    throw new Error(
      `Cannot rebuild indexes while indexed dimension (${indexedDimension}) differs from provider dimension (${providerDimension}); run nardo reembed first`,
    )
  }

  if (!opts.quiet) {
    console.log(`Rebuilding HNSW sidecars at ${opts.palace_path} (${indexedDimension} dims)`)
  }

  const db = await openPalaceDB(opts.palace_path, config.palace.backend)
  try {
    const drawers = await reindexCollection(
      db,
      'drawers',
      join(opts.palace_path, 'drawers.hnsw'),
      indexedDimension,
      opts.onProgress,
    )
    const closets = await reindexCollection(
      db,
      'closets',
      join(opts.palace_path, 'closets.hnsw'),
      indexedDimension,
      opts.onProgress,
    )

    return {
      dimension: indexedDimension,
      drawers,
      closets,
    }
  } finally {
    await db.close()
  }
}

export function palaceHasHnswSidecars(palacePath: string): boolean {
  return existsSync(join(palacePath, 'drawers.hnsw')) || existsSync(join(palacePath, 'closets.hnsw'))
}
