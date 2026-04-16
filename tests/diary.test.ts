import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { PalaceClient } from '../src/palace/client.js'
import { addDrawer } from '../src/palace/drawers.js'
import { getEmbeddingPipeline } from '../src/embeddings/pipeline.js'
import * as wal from '../src/wal.js'

// Test the diary ingest pipeline directly (ingest_mode='diary', no chunking, date-keyed rooms)
describe('Diary ingest mode', () => {
  const tmpPalace = `/tmp/nardo-diary-${Date.now()}`

  beforeAll(() => {
    mkdirSync(tmpPalace, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
  })

  it('stores a diary entry with ingest_mode=diary', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)

    const content = 'Today I learned that FTS5 BM25 scores are negative — more negative means more relevant.'
    const today = new Date().toISOString().slice(0, 10)
    const [embedding] = await embedder.embed([content])

    const drawer_id = await addDrawer(client, embedding!, content, {
      wing: 'diary',
      room: today,
      source_file: `diary:${today}`,
      source_mtime: Date.now(),
      chunk_index: 0,
      normalize_version: 2,
      added_by: 'cli:diary',
      filed_at: new Date().toISOString(),
      ingest_mode: 'diary',
      importance: 0.7,
      chunk_size: content.length,
    }, wal)

    expect(typeof drawer_id).toBe('string')
    expect(drawer_id.length).toBeGreaterThan(0)

    // Verify it stored with correct metadata
    const col = await client.getDrawersCollection()
    const results = await col.get({
      where: { '$and': [{ wing: { '$eq': 'diary' } }, { room: { '$eq': today } }] },
      include: ['documents', 'metadatas'],
    })

    expect(results.ids.length).toBeGreaterThan(0)
    const meta = results.metadatas[0] as Record<string, unknown>
    expect(meta['ingest_mode']).toBe('diary')
    expect(meta['room']).toBe(today)
    expect(meta['wing']).toBe('diary')
    expect(results.documents[0]).toBe(content)
  }, 60_000)

  it('diary entries are searchable after storing', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const { HybridSearcher } = await import('../src/search/hybrid.js')

    const searcher = new HybridSearcher(client, embedder)
    const response = await searcher.search({
      query: 'FTS5 BM25 scoring negative values',
      wing: 'diary',
      n_results: 5,
    })

    expect(response.results.length).toBeGreaterThan(0)
    const allText = response.results.map(r => r.text).join(' ')
    expect(allText).toMatch(/FTS5|BM25|negative/i)
  }, 60_000)

  it('stores multiple diary entries on same day in same room', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const today = new Date().toISOString().slice(0, 10)

    const entries = [
      'Morning standup: discussed sprint goals and blockers',
      'Afternoon deep work: implemented the importance auto-scorer',
      'Evening reflection: good progress on nardo enhancements',
    ]

    for (const entry of entries) {
      const [emb] = await embedder.embed([entry])
      await addDrawer(client, emb!, entry, {
        wing: 'diary',
        room: today,
        source_file: `diary:${today}`,
        source_mtime: Date.now(),
        chunk_index: 0,
        normalize_version: 2,
        added_by: 'test',
        filed_at: new Date().toISOString(),
        ingest_mode: 'diary',
        importance: 0.6,
        chunk_size: entry.length,
      }, wal)
    }

    const col = await client.getDrawersCollection()
    const results = await col.get({
      where: { '$and': [{ wing: { '$eq': 'diary' } }, { room: { '$eq': today } }] },
    })

    // Should have original 1 + 3 new entries = 4
    expect(results.ids.length).toBe(4)
  }, 60_000)

  it('diary entries from different days land in different rooms', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)

    const days = ['2025-01-01', '2025-06-15', '2025-12-31']
    for (const day of days) {
      const entry = `Journal entry for ${day}`
      const [emb] = await embedder.embed([entry])
      await addDrawer(client, emb!, entry, {
        wing: 'diary',
        room: day,
        source_file: `diary:${day}`,
        source_mtime: Date.now(),
        chunk_index: 0,
        normalize_version: 2,
        added_by: 'test',
        filed_at: `${day}T12:00:00.000Z`,
        ingest_mode: 'diary',
        importance: 0.5,
        chunk_size: entry.length,
      }, wal)
    }

    const col = await client.getDrawersCollection()
    for (const day of days) {
      const results = await col.get({
        where: { '$and': [{ wing: { '$eq': 'diary' } }, { room: { '$eq': day } }] },
      })
      expect(results.ids.length).toBe(1)
    }
  }, 60_000)
})
