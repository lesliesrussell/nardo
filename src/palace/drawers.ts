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
