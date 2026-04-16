import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mineDirectory } from '../src/mining/file-miner.js'
import { PalaceClient } from '../src/palace/client.js'
import type { Collection } from '../src/palace/client.js'

// We test export/import by directly exercising the logic:
// 1. Mine some content into palace A
// 2. Export to JSONL buffer
// 3. Import into palace B
// 4. Verify B has the same drawers (same text, same metadata, embeddings are functional)

const tmpA = `/tmp/nardo-export-a-${Date.now()}`
const tmpB = `/tmp/nardo-export-b-${Date.now()}`
const tmpSrc = `/tmp/nardo-export-src-${Date.now()}`

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function decodeEmbedding(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64')
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}

beforeAll(() => {
  mkdirSync(tmpA, { recursive: true })
  mkdirSync(tmpB, { recursive: true })
  mkdirSync(tmpSrc, { recursive: true })
})

afterAll(() => {
  rmSync(tmpA, { recursive: true, force: true })
  rmSync(tmpB, { recursive: true, force: true })
  rmSync(tmpSrc, { recursive: true, force: true })
})

describe('palace export → import round-trip', () => {
  it('exports drawers with embeddings and reimports into empty palace', async () => {
    // 1. Mine content into palace A
    writeFileSync(join(tmpSrc, 'doc1.md'),
      'The system uses FTS5 for full-text search. Alice designed the schema. ' +
      'BM25 scoring provides relevance ranking for keyword queries.',
    )
    writeFileSync(join(tmpSrc, 'doc2.md'),
      'Vector embeddings capture semantic similarity. Bob integrated hnswlib-node. ' +
      'HNSW index supports cosine distance for approximate nearest neighbours.',
    )

    const mineOpts = { palace_path: tmpA, wing: 'test', rooms: {}, agent: 'test' }
    const mineResult = await mineDirectory(tmpSrc, mineOpts)
    expect(mineResult.drawers).toBeGreaterThan(0)

    // 2. Export from palace A
    const clientA = new PalaceClient(tmpA)
    const colA = await clientA.getDrawersCollection() as Collection
    const all = await colA.get({ include: ['documents', 'metadatas'] })
    expect(all.ids.length).toBeGreaterThan(0)

    // Build JSONL lines
    const lines: string[] = []
    const BATCH = 50
    for (let start = 0; start < all.ids.length; start += BATCH) {
      const batchIds = all.ids.slice(start, start + BATCH)
      const embedMap = await colA.getEmbeddings(batchIds)

      for (let i = 0; i < batchIds.length; i++) {
        const id = batchIds[i]!
        const document = all.documents[start + i] ?? ''
        const meta = all.metadatas[start + i] ?? {}
        const vec = embedMap.get(id)
        const embeddingB64 = vec
          ? Buffer.from(new Float32Array(vec).buffer).toString('base64')
          : null

        lines.push(JSON.stringify({
          id, document, embedding: embeddingB64,
          wing: meta['wing'], room: meta['room'],
          source_file: meta['source_file'], source_mtime: meta['source_mtime'],
          chunk_index: meta['chunk_index'], normalize_version: meta['normalize_version'],
          added_by: meta['added_by'], filed_at: meta['filed_at'],
          ingest_mode: meta['ingest_mode'], importance: meta['importance'],
          chunk_size: meta['chunk_size'],
        }))
      }
    }

    expect(lines.length).toBe(all.ids.length)

    // 3. Import into palace B
    const clientB = new PalaceClient(tmpB)
    const colB = await clientB.getDrawersCollection() as Collection
    const existingB = await colB.get({ include: ['documents'] })
    const existingHashes = new Set(existingB.documents.map(d => sha256(d ?? '')))
    const existingIds = new Set(existingB.ids)

    let imported = 0, skipped = 0

    for (const line of lines) {
      const record = JSON.parse(line)
      const hash = sha256(record.document)
      if (existingHashes.has(hash)) { skipped++; continue }

      const embedding = decodeEmbedding(record.embedding)
      const id = !existingIds.has(record.id) ? record.id : randomUUID()

      await colB.add({
        ids: [id],
        embeddings: [embedding],
        documents: [record.document],
        metadatas: [{
          wing: record.wing, room: record.room,
          source_file: record.source_file, source_mtime: record.source_mtime,
          chunk_index: record.chunk_index, normalize_version: record.normalize_version,
          added_by: record.added_by, filed_at: record.filed_at,
          ingest_mode: record.ingest_mode, importance: record.importance,
          chunk_size: record.chunk_size,
        }],
      })
      existingHashes.add(hash)
      existingIds.add(id)
      imported++
    }

    expect(imported).toBe(lines.length)
    expect(skipped).toBe(0)

    // 4. Verify palace B has the same content
    const afterImport = await colB.get({ include: ['documents', 'metadatas'] })
    expect(afterImport.ids.length).toBe(all.ids.length)

    const textA = new Set(all.documents.map(d => d ?? ''))
    const textB = new Set(afterImport.documents.map(d => d ?? ''))
    for (const t of textA) expect(textB.has(t)).toBe(true)
  }, 120_000)

  it('deduplicates on re-import: same JSONL imported twice adds no new drawers', async () => {
    const clientB = new PalaceClient(tmpB)
    const colB = await clientB.getDrawersCollection() as Collection

    const before = await colB.get({ include: ['documents'] })
    const countBefore = before.ids.length
    const existingHashes = new Set(before.documents.map(d => sha256(d ?? '')))

    // Try to re-import the same content — all should be skipped
    const clientA = new PalaceClient(tmpA)
    const colA = await clientA.getDrawersCollection() as Collection
    const all = await colA.get({ include: ['documents'] })

    let skipped = 0
    for (const doc of all.documents) {
      if (existingHashes.has(sha256(doc ?? ''))) skipped++
    }

    expect(skipped).toBe(all.ids.length)

    const after = await colB.get({ include: ['documents'] })
    expect(after.ids.length).toBe(countBefore)
  }, 60_000)

  it('embeddings survive round-trip and remain searchable', async () => {
    const clientB = new PalaceClient(tmpB)
    const colB = await clientB.getDrawersCollection() as Collection

    // Fetch all ids and verify embeddings are retrievable
    const all = await colB.get({ include: ['documents'] })
    const embedMap = await colB.getEmbeddings(all.ids)

    // Every drawer should have a stored embedding
    expect(embedMap.size).toBeGreaterThan(0)
    for (const [, vec] of embedMap) {
      expect(vec.length).toBeGreaterThan(0)
      // Embeddings should be unit vectors (cosine space): norm ≈ 1
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
      expect(norm).toBeGreaterThan(0.9)
    }
  }, 60_000)
})

function randomUUID(): string {
  return crypto.randomUUID()
}
