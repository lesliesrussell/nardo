// Drawer CRUD on top of PalaceClient
import { randomUUID } from 'crypto'
import type { PalaceClient } from './client.ts'
import { logWrite } from '../wal.ts'

export interface DrawerMetadata {
  wing: string
  room: string
  source_file: string
  source_mtime: number
  chunk_index: number
  normalize_version: number
  added_by: string
  filed_at: string
  ingest_mode: 'project' | 'convo' | 'diary' | 'registry'
  importance: number
  chunk_size: number
}

export interface DrawerResult {
  id: string
  text: string
  metadata: DrawerMetadata
  distance?: number
}

export async function addDrawer(
  client: PalaceClient,
  embedding: number[],
  content: string,
  metadata: DrawerMetadata,
  wal: typeof import('../wal.ts'),
): Promise<string> {
  const drawer_id = randomUUID()
  const collection = await client.getDrawersCollection()

  await collection.add({
    ids: [drawer_id],
    embeddings: [embedding],
    documents: [content],
    metadatas: [metadata as unknown as Record<string, string | number | boolean>],
  })

  await wal.logWrite('add_drawer', { drawer_id, ...metadata }, { drawer_id })

  return drawer_id
}

export async function deleteDrawer(
  client: PalaceClient,
  drawer_id: string,
  wal: typeof import('../wal.ts'),
): Promise<void> {
  const collection = await client.getDrawersCollection()
  await collection.delete({ ids: [drawer_id] })
  await wal.logWrite('delete_drawer', { drawer_id }, { drawer_id })
}

export async function fileAlreadyMined(
  client: PalaceClient,
  source_file: string,
): Promise<{ mined: boolean; mtime?: number }> {
  const collection = await client.getDrawersCollection()

  const results = await collection.get({
    where: { source_file: { $eq: source_file } },
    include: ['metadatas'],
  })

  if (!results.metadatas || results.metadatas.length === 0) {
    return { mined: false }
  }

  let maxMtime = 0
  for (const meta of results.metadatas) {
    if (meta && typeof meta['source_mtime'] === 'number') {
      if (meta['source_mtime'] > maxMtime) {
        maxMtime = meta['source_mtime']
      }
    }
  }

  return { mined: true, mtime: maxMtime }
}

export async function deleteDrawersBySource(
  client: PalaceClient,
  source_file: string,
): Promise<number> {
  const collection = await client.getDrawersCollection()

  const results = await collection.get({
    where: { source_file: { $eq: source_file } },
    include: ['metadatas'],
  })

  const ids = results.ids
  if (ids.length === 0) return 0

  await collection.delete({ ids })
  return ids.length
}

export async function getAllDrawerMetadata(
  client: PalaceClient,
): Promise<DrawerMetadata[]> {
  const collection = await client.getDrawersCollection()

  const results = await collection.get({ include: ['metadatas'] })

  return (results.metadatas ?? []).filter(Boolean).map(
    (m) => m as unknown as DrawerMetadata,
  )
}

export interface ForgetOptions {
  source_file?: string
  source_prefix?: string
  wing?: string
  room?: string
  /** ISO date string — delete drawers filed before this date */
  before?: string
  /** Specific drawer ID to delete */
  id?: string
  dry_run?: boolean
}

/**
 * Delete drawers matching the given criteria.
 * Returns the number of drawers deleted (or that would be deleted in dry_run mode).
 */
export async function forgetDrawers(
  client: PalaceClient,
  opts: ForgetOptions,
  wal: typeof import('../wal.ts'),
): Promise<number> {
  const collection = await client.getDrawersCollection()

  // Single-ID fast path
  if (opts.id) {
    if (!opts.dry_run) {
      await collection.delete({ ids: [opts.id] })
      await wal.logWrite('forget_drawer', { drawer_id: opts.id }, { drawer_id: opts.id })
    }
    return 1
  }

  // Build where clause for the collection query
  let where: Record<string, unknown> | undefined

  if (opts.source_file) {
    where = { source_file: { '$eq': opts.source_file } }
  } else if (opts.source_prefix) {
    where = { source_file: { '$prefix': opts.source_prefix } }
  } else if (opts.wing && opts.room) {
    where = { '$and': [{ wing: { '$eq': opts.wing } }, { room: { '$eq': opts.room } }] }
  } else if (opts.wing) {
    where = { wing: { '$eq': opts.wing } }
  }

  // Fetch candidate IDs (with or without where filter)
  const results = await collection.get({
    ...(where ? { where } : {}),
    include: ['metadatas'],
  })

  let ids = results.ids

  // Apply --before date filter in JS (ISO string comparison)
  if (opts.before) {
    ids = ids.filter((_id, i) => {
      const meta = results.metadatas[i]
      const filed = meta?.['filed_at'] as string | undefined
      return filed !== undefined && filed < opts.before!
    })
  }

  if (ids.length === 0) return 0
  if (opts.dry_run) return ids.length

  await collection.delete({ ids })
  await wal.logWrite('forget_drawers', { count: ids.length, ...opts }, { count: ids.length })
  return ids.length
}
