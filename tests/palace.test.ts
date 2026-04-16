import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PalaceClient } from '../src/palace/client.ts'
import { addDrawer, deleteDrawer, fileAlreadyMined, deleteDrawersBySource } from '../src/palace/drawers.ts'
import * as wal from '../src/wal.ts'

function fakeEmbedding(value: number, dims = 384): number[] {
  const v = new Array(dims).fill(value) as number[]
  // Normalize so cosine distance is meaningful
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / norm)
}

const TEST_DIR = join(import.meta.dir, '__palace_test_tmp__')

function makeClient(): PalaceClient {
  return new PalaceClient(TEST_DIR)
}

function makeMetadata(overrides: Partial<{
  wing: string; room: string; source_file: string; source_mtime: number
}> = {}) {
  return {
    wing: overrides.wing ?? 'test-wing',
    room: overrides.room ?? 'test-room',
    source_file: overrides.source_file ?? '/tmp/test.md',
    source_mtime: overrides.source_mtime ?? 1000,
    chunk_index: 0,
    normalize_version: 2,
    added_by: 'test',
    filed_at: new Date().toISOString(),
    ingest_mode: 'project' as const,
    importance: 1.0,
    chunk_size: 50,
  }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('PalaceClient — drawers collection', () => {
  it('adds a drawer and retrieves it by id', async () => {
    const client = makeClient()
    const embed = fakeEmbedding(0.5)
    const id = await addDrawer(client, embed, 'Hello world content here', makeMetadata(), wal)

    const col = await client.getDrawersCollection()
    const result = await col.get({ ids: [id] })

    expect(result.ids).toContain(id)
    expect(result.documents[0]).toBe('Hello world content here')
    expect(result.metadatas[0]?.['wing']).toBe('test-wing')
    expect(result.metadatas[0]?.['room']).toBe('test-room')
  })

  it('query returns the added drawer', async () => {
    const client = makeClient()
    const embed = fakeEmbedding(1.0)
    await addDrawer(client, embed, 'Query target document', makeMetadata(), wal)

    const col = await client.getDrawersCollection()
    const result = await col.query({
      queryEmbeddings: [embed],
      nResults: 1,
    })

    expect(result.ids[0]?.length).toBeGreaterThan(0)
    expect(result.documents[0]?.[0]).toBe('Query target document')
    expect(result.distances[0]?.[0]).toBeDefined()
  })

  it('query with WHERE wing filter returns only matching wing', async () => {
    const client = makeClient()
    const embedA = fakeEmbedding(0.8)
    const embedB = fakeEmbedding(0.2)

    await addDrawer(client, embedA, 'Wing A content', makeMetadata({ wing: 'wing-a' }), wal)
    await addDrawer(client, embedB, 'Wing B content', makeMetadata({ wing: 'wing-b' }), wal)

    const col = await client.getDrawersCollection()
    const result = await col.query({
      queryEmbeddings: [embedA],
      nResults: 5,
      where: { wing: { '$eq': 'wing-a' } },
    })

    const wings = result.metadatas[0]?.map(m => m?.['wing']) ?? []
    expect(wings.every(w => w === 'wing-a')).toBe(true)
  })

  it('query with WHERE $and filter works for wing+room', async () => {
    const client = makeClient()
    const e1 = fakeEmbedding(0.9)
    const e2 = fakeEmbedding(0.1)

    await addDrawer(client, e1, 'Alpha beta content', makeMetadata({ wing: 'w1', room: 'r1' }), wal)
    await addDrawer(client, e2, 'Gamma delta content', makeMetadata({ wing: 'w1', room: 'r2' }), wal)

    const col = await client.getDrawersCollection()
    const result = await col.query({
      queryEmbeddings: [e1],
      nResults: 5,
      where: { '$and': [{ wing: { '$eq': 'w1' } }, { room: { '$eq': 'r1' } }] },
    })

    const rooms = result.metadatas[0]?.map(m => m?.['room']) ?? []
    expect(rooms.length).toBeGreaterThan(0)
    expect(rooms.every(r => r === 'r1')).toBe(true)
  })

  it('delete removes drawer from query results', async () => {
    const client = makeClient()
    const embed = fakeEmbedding(0.5)
    const id = await addDrawer(client, embed, 'To be deleted', makeMetadata(), wal)

    await deleteDrawer(client, id, wal)

    const col = await client.getDrawersCollection()
    const result = await col.get({ ids: [id] })
    expect(result.ids).not.toContain(id)
  })

  it('delete removes drawer from vector search results', async () => {
    const client = makeClient()
    const embed = fakeEmbedding(0.5)
    const id = await addDrawer(client, embed, 'Deleted from vector', makeMetadata(), wal)

    await deleteDrawer(client, id, wal)

    const col = await client.getDrawersCollection()
    const result = await col.query({ queryEmbeddings: [embed], nResults: 5 })
    expect(result.ids[0]).not.toContain(id)
  })

  it('fileAlreadyMined returns false for unknown file', async () => {
    const client = makeClient()
    const result = await fileAlreadyMined(client, '/unknown/file.md')
    expect(result.mined).toBe(false)
  })

  it('fileAlreadyMined detects existing source', async () => {
    const client = makeClient()
    const embed = fakeEmbedding(0.5)
    const sourceFile = '/tmp/existing.md'
    await addDrawer(client, embed, 'Existing source content', makeMetadata({
      source_file: sourceFile,
      source_mtime: 9999,
    }), wal)

    const result = await fileAlreadyMined(client, sourceFile)
    expect(result.mined).toBe(true)
    expect(result.mtime).toBe(9999)
  })

  it('deleteDrawersBySource removes all drawers for a file', async () => {
    const client = makeClient()
    const sourceFile = '/tmp/multi.md'
    const e1 = fakeEmbedding(0.3)
    const e2 = fakeEmbedding(0.7)

    await addDrawer(client, e1, 'Chunk one content here', makeMetadata({ source_file: sourceFile }), wal)
    await addDrawer(client, e2, 'Chunk two content here', makeMetadata({ source_file: sourceFile }), wal)

    const removed = await deleteDrawersBySource(client, sourceFile)
    expect(removed).toBe(2)

    const check = await fileAlreadyMined(client, sourceFile)
    expect(check.mined).toBe(false)
  })

  it('count returns correct number', async () => {
    const client = makeClient()
    const col = await client.getDrawersCollection()
    expect(await col.count()).toBe(0)

    await addDrawer(client, fakeEmbedding(0.1), 'One content string here', makeMetadata(), wal)
    expect(await col.count()).toBe(1)

    await addDrawer(client, fakeEmbedding(0.2), 'Two content string here', makeMetadata(), wal)
    expect(await col.count()).toBe(2)
  })
})

describe('PalaceClient — closets collection', () => {
  it('upsert and get work for closets', async () => {
    const client = makeClient()
    const col = await client.getClosetsCollection()

    await col.upsert({
      ids: ['c1'],
      documents: ['topic|entity|→id1,id2'],
      metadatas: [{ source_file: '/tmp/f.md', wing: 'w', room: 'r' }],
    })

    const result = await col.get({ ids: ['c1'] })
    expect(result.ids).toContain('c1')
    expect(result.documents[0]).toBe('topic|entity|→id1,id2')
  })

  it('delete by WHERE source_file works for closets', async () => {
    const client = makeClient()
    const col = await client.getClosetsCollection()
    const sourceFile = '/tmp/closet-src.md'

    await col.upsert({
      ids: ['c2', 'c3'],
      documents: ['line1', 'line2'],
      metadatas: [
        { source_file: sourceFile, wing: 'w', room: 'r' },
        { source_file: sourceFile, wing: 'w', room: 'r' },
      ],
    })

    await col.delete({ where: { source_file: { '$eq': sourceFile } } })

    const result = await col.get({ ids: ['c2', 'c3'] })
    expect(result.ids.length).toBe(0)
  })

  it('invalidateCache allows re-init', async () => {
    const client = makeClient()
    await client.getDrawersCollection()
    client.invalidateCache()
    // Should re-init without error
    const col = await client.getDrawersCollection()
    expect(await col.count()).toBe(0)
  })

  it('supports a custom embedding dimension for HNSW indexes', async () => {
    const client = new PalaceClient(TEST_DIR, 768)
    const col = await client.getDrawersCollection()

    await col.upsert({
      ids: ['c768'],
      documents: ['custom dimension document'],
      metadatas: [{ source_file: '/tmp/f.md', wing: 'w', room: 'r' }],
      embeddings: [fakeEmbedding(0.25, 768)],
    })

    const result = await col.query({
      queryEmbeddings: [fakeEmbedding(0.25, 768)],
      nResults: 1,
    })

    expect(result.ids[0]).toContain('c768')
  })
})
