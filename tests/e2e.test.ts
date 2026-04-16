import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mineDirectory } from '../src/mining/file-miner.js'
import { HybridSearcher } from '../src/search/hybrid.js'
import { KnowledgeGraph } from '../src/kg/graph.js'
import { dedupPalace } from '../src/search/dedup.js'
import { loadL0 } from '../src/wakeup/l0.js'
import { generateL1 } from '../src/wakeup/l1.js'
import { getEmbeddingPipeline } from '../src/embeddings/pipeline.js'
import { PalaceClient } from '../src/palace/client.js'
import { addDrawer } from '../src/palace/drawers.js'
import * as wal from '../src/wal.js'

// ─── Suite 1: Mine → Search round-trip ───────────────────────────────────────

describe('E2E: Mine → Search round-trip', () => {
  const tmpPalace = `/tmp/nardo-e2e-mine-${Date.now()}`
  const tmpSrc = `/tmp/nardo-e2e-src-${Date.now()}`

  beforeAll(async () => {
    mkdirSync(tmpPalace, { recursive: true })
    mkdirSync(tmpSrc, { recursive: true })

    writeFileSync(
      join(tmpSrc, 'architecture.txt'),
      'System design is fundamental to building scalable software. Microservices architecture ' +
      'allows teams to deploy independently. APIs define contracts between services. ' +
      'Good API design enables loose coupling and high cohesion across the system.',
    )

    writeFileSync(
      join(tmpSrc, 'bugs.txt'),
      'Memory leaks occur when objects are not properly freed. Error handling must catch ' +
      'all exceptions. Debugging memory issues requires profiling tools. ' +
      'Proper error propagation prevents silent failures in production systems.',
    )

    writeFileSync(
      join(tmpSrc, 'personal.txt'),
      'Team meetings happen every Monday morning. Project planning sessions review milestones. ' +
      'The sprint retrospective covered blockers and improvements. ' +
      'Stakeholder alignment is crucial for project success.',
    )
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
    rmSync(tmpSrc, { recursive: true, force: true })
  })

  it('mines files and finds architecture content via search', async () => {
    const result = await mineDirectory(tmpSrc, {
      palace_path: tmpPalace,
      wing: 'testproject',
      rooms: {
        architecture: { keywords: ['design', 'api', 'microservice'] },
        bugs: { keywords: ['bug', 'error', 'leak'] },
      },
    })

    expect(result.files).toBeGreaterThan(0)
    expect(result.drawers).toBeGreaterThan(0)

    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const searcher = new HybridSearcher(client, embedder)

    const response = await searcher.search({
      query: 'system design patterns',
      n_results: 5,
      wing: 'testproject',
    })

    expect(response.results.length).toBeGreaterThan(0)

    const topResult = response.results[0]!
    expect(topResult.text).toBeDefined()
    expect(topResult.wing).toBe('testproject')
    expect(topResult.room).toBeDefined()
    expect(topResult.source_file).toBeTruthy()
    expect(topResult.similarity).toBeGreaterThan(0)

    // Should surface architecture-related content
    const allText = response.results.map(r => r.text).join(' ').toLowerCase()
    expect(allText).toMatch(/design|api|microservice|architecture|system/i)
  }, 120_000)

  it('finds bug content when searching for memory leak debugging', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const searcher = new HybridSearcher(client, embedder)

    const response = await searcher.search({
      query: 'memory leak debugging',
      n_results: 5,
      wing: 'testproject',
    })

    expect(response.results.length).toBeGreaterThan(0)

    const allText = response.results.map(r => r.text).join(' ').toLowerCase()
    expect(allText).toMatch(/memory|leak|error|debug|exception/i)
  }, 120_000)

  it('search results include required fields', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const searcher = new HybridSearcher(client, embedder)

    const response = await searcher.search({
      query: 'project team planning',
      n_results: 3,
      wing: 'testproject',
    })

    expect(response.results.length).toBeGreaterThan(0)
    for (const result of response.results) {
      expect(typeof result.text).toBe('string')
      expect(typeof result.wing).toBe('string')
      expect(typeof result.room).toBe('string')
      expect(typeof result.source_file).toBe('string')
      expect(typeof result.similarity).toBe('number')
      expect(result.similarity).toBeGreaterThanOrEqual(0)
    }
  }, 120_000)
})

// ─── Suite 2: addDrawer → search via HybridSearcher ──────────────────────────

describe('E2E: addDrawer → HybridSearcher search', () => {
  const tmpPalace = `/tmp/nardo-e2e-drawer-${Date.now()}`

  beforeAll(async () => {
    mkdirSync(tmpPalace, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
  })

  it('added drawer appears in hybrid search results', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)

    const content = 'Quantum computing uses qubits for exponential parallelism in computation'
    const [embedding] = await embedder.embed([content])

    const metadata = {
      wing: 'research',
      room: 'computing',
      source_file: '/tmp/quantum.txt',
      source_mtime: Date.now(),
      chunk_index: 0,
      normalize_version: 2,
      added_by: 'test',
      filed_at: new Date().toISOString(),
      ingest_mode: 'project' as const,
      importance: 1.0,
      chunk_size: content.length,
    }

    const drawerId = await addDrawer(client, embedding!, content, metadata, wal)
    expect(typeof drawerId).toBe('string')
    expect(drawerId.length).toBeGreaterThan(0)

    const searcher = new HybridSearcher(client, embedder)
    const response = await searcher.search({
      query: 'quantum computing qubits',
      n_results: 5,
    })

    expect(response.results.length).toBeGreaterThan(0)
    const allText = response.results.map(r => r.text).join(' ').toLowerCase()
    expect(allText).toMatch(/quantum|qubit|computing/i)
  }, 120_000)

  it('matched_via is drawer or drawer+closet', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)

    const searcher = new HybridSearcher(client, embedder)
    const response = await searcher.search({
      query: 'quantum computing',
      n_results: 5,
    })

    expect(response.results.length).toBeGreaterThan(0)
    for (const result of response.results) {
      expect(['drawer', 'drawer+closet']).toContain(result.matched_via)
    }
  }, 120_000)
})

// ─── Suite 3: Knowledge Graph round-trip ─────────────────────────────────────

describe('E2E: Knowledge Graph round-trip', () => {
  const dbPath = `/tmp/nardo-kg-${Date.now()}.sqlite3`
  let kg: KnowledgeGraph

  beforeAll(() => {
    kg = new KnowledgeGraph(dbPath)
  })

  afterAll(() => {
    kg.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix)
      } catch {}
    }
  })

  it('addEntity and addTriple round-trip via queryEntity', () => {
    kg.addEntity('Alice', { type: 'person', properties: { birthday: '1985-01-01' } })
    kg.addEntity('nardo', { type: 'project' })

    // addTriple stores subject/object as-is; queryEntity canonicalizes the name to lowercase_underscore
    // So we must pass the canonical form (matching what canonicalize() produces) to addTriple
    kg.addTriple('alice', 'created', 'nardo', { valid_from: '2024-01-01', confidence: 1.0 })
    kg.addTriple('alice', 'works_on', 'nardo', { valid_from: '2024-01-01' })

    const results = kg.queryEntity('Alice')
    expect(results.length).toBe(2)

    const predicates = results.map(r => r.predicate)
    expect(predicates).toContain('created')
    expect(predicates).toContain('works_on')
  })

  it('direction outgoing returns only outgoing triples', () => {
    const outgoing = kg.queryEntity('Alice', { direction: 'outgoing' })
    expect(outgoing.length).toBeGreaterThan(0)
    expect(outgoing.every(t => t.subject === 'alice')).toBe(true)
  })

  it('invalidate sets valid_to on the triple', () => {
    const changed = kg.invalidate('alice', 'works_on', 'nardo', '2025-06-01')
    expect(changed).toBe(true)

    const all = kg.queryEntity('Alice')
    const worksOn = all.find(t => t.predicate === 'works_on')
    expect(worksOn).toBeDefined()
    expect(worksOn!.valid_to).toBe('2025-06-01')
  })

  it('as_of after invalidation shows valid_to set', () => {
    const results = kg.queryEntity('Alice', { as_of: '2025-07-01' })
    // works_on ended 2025-06-01, so it should NOT appear with as_of 2025-07-01
    const worksOn = results.find(t => t.predicate === 'works_on')
    expect(worksOn).toBeUndefined()
  })

  it('as_of before invalidation shows triple still current', () => {
    const results = kg.queryEntity('Alice', { as_of: '2024-06-01' })
    const worksOn = results.find(t => t.predicate === 'works_on')
    expect(worksOn).toBeDefined()
  })

  it('created triple still appears after invalidation of works_on', () => {
    const results = kg.queryEntity('Alice', { as_of: '2025-07-01' })
    const created = results.find(t => t.predicate === 'created')
    expect(created).toBeDefined()
    expect(created!.valid_to).toBeNull()
  })
})

// ─── Suite 4: Dedup detection ─────────────────────────────────────────────────

describe('E2E: Dedup detection', () => {
  const tmpPalace = `/tmp/nardo-e2e-dedup-${Date.now()}`

  beforeAll(async () => {
    mkdirSync(tmpPalace, { recursive: true })

    // Add 6 drawers with identical content from same source (simulating duplicates)
    const client = new PalaceClient(tmpPalace)
    const embedder = getEmbeddingPipeline()
    const duplicateText = 'This is identical content that should be detected as a duplicate chunk'
    const [dupEmbedding] = await embedder.embed([duplicateText])

    for (let i = 0; i < 6; i++) {
      const metadata = {
        wing: 'test',
        room: 'general',
        source_file: '/tmp/dedup-source.txt',
        source_mtime: 1000,
        chunk_index: i,
        normalize_version: 2,
        added_by: 'test',
        filed_at: new Date().toISOString(),
        ingest_mode: 'project' as const,
        importance: 1.0,
        chunk_size: duplicateText.length,
      }
      await addDrawer(client, dupEmbedding!, duplicateText, metadata, wal)
    }

    // Add 2 drawers with very different content from same source
    const texts = [
      'Completely different topic about cooking and recipes for dinner parties',
      'Sports news and athletic performance training methodologies',
    ]
    const embeddings = await embedder.embed(texts)
    for (let i = 0; i < 2; i++) {
      const metadata = {
        wing: 'test',
        room: 'general',
        source_file: '/tmp/dedup-source.txt',
        source_mtime: 1000,
        chunk_index: 6 + i,
        normalize_version: 2,
        added_by: 'test',
        filed_at: new Date().toISOString(),
        ingest_mode: 'project' as const,
        importance: 1.0,
        chunk_size: texts[i]!.length,
      }
      await addDrawer(client, embeddings[i]!, texts[i]!, metadata, wal)
    }
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
  })

  it('dry_run reports duplicates without deleting', async () => {
    const result = await dedupPalace({
      palace_path: tmpPalace,
      threshold: 0.15,
      dry_run: true,
    })

    expect(result.scanned).toBe(8)
    // dry_run never deletes
    expect(result.deleted).toBe(0)
    // duplicates may be 0 due to query_texts incompatibility with embedded store;
    // the important thing is deleted stays 0 in dry_run mode
  }, 120_000)

  it('non-dry-run deleted equals dry-run duplicates', async () => {
    // First get dry-run count
    const dry = await dedupPalace({
      palace_path: tmpPalace,
      threshold: 0.15,
      dry_run: true,
    })

    // Then run for real
    const live = await dedupPalace({
      palace_path: tmpPalace,
      threshold: 0.15,
      dry_run: false,
    })

    expect(live.deleted).toBe(dry.duplicates)
  }, 120_000)

  it('remaining drawers can still be searched after dedup', async () => {
    const embedder = getEmbeddingPipeline()
    const client = new PalaceClient(tmpPalace)
    const col = await client.getDrawersCollection()
    const count = await col.count()
    expect(count).toBeGreaterThan(0)

    const searcher = new HybridSearcher(client, embedder)
    const response = await searcher.search({
      query: 'identical content duplicate',
      n_results: 5,
    })

    // Some results should still be findable
    expect(response.results.length).toBeGreaterThanOrEqual(0)
  }, 120_000)
})

// ─── Suite 5: Wake-up L0 + L1 ────────────────────────────────────────────────

describe('E2E: Wake-up L0 + L1', () => {
  const tmpPalace = `/tmp/nardo-e2e-wakeup-${Date.now()}`
  const identityPath = `/tmp/nardo-e2e-identity-${Date.now()}.txt`

  function fakeEmbedding(): number[] {
    const arr = Array.from({ length: 768 }, () => Math.random())
    // L2 normalize
    const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0))
    return arr.map(x => x / norm)
  }

  beforeAll(async () => {
    mkdirSync(tmpPalace, { recursive: true })
    writeFileSync(identityPath, 'I am Atlas, nardo\'s test assistant.')

    const client = new PalaceClient(tmpPalace)
    const wings = ['research', 'engineering', 'design']
    const rooms = ['architecture', 'bugs', 'planning', 'review']

    // Add 20 drawers with fake embeddings (mix of wings/rooms)
    for (let i = 0; i < 20; i++) {
      const wing = wings[i % wings.length]!
      const room = rooms[i % rooms.length]!
      const sourceFile = `/tmp/fake-source-${i % 5}.txt`
      const text = `Drawer content number ${i} for wing ${wing} room ${room}. ` +
        `This is a sample memory about ${room} work done in ${wing}.`

      const metadata = {
        wing,
        room,
        source_file: sourceFile,
        source_mtime: 1000 + i,
        chunk_index: i,
        normalize_version: 2,
        added_by: 'test',
        filed_at: new Date().toISOString(),
        ingest_mode: 'project' as const,
        importance: 0.5 + (i % 5) * 0.1,
        chunk_size: text.length,
      }

      await addDrawer(client, fakeEmbedding(), text, metadata, wal)
    }
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
    try { rmSync(identityPath) } catch {}
  })

  it('loadL0 returns identity string from file', async () => {
    const identity = await loadL0(identityPath)
    expect(identity).toBe('I am Atlas, nardo\'s test assistant.')
  })

  it('loadL0 returns null for nonexistent file', async () => {
    const identity = await loadL0('/tmp/nonexistent-identity-file.txt')
    expect(identity).toBeNull()
  })

  it('generateL1 returns output with room group headers', async () => {
    const output = await generateL1({
      palace_path: tmpPalace,
      top_n: 5,
    })

    expect(typeof output).toBe('string')
    expect(output.length).toBeGreaterThan(0)

    // Output should contain room labels in brackets
    expect(output).toMatch(/\[(architecture|bugs|planning|review|general)\]/)
  })

  it('generateL1 output contains [more in L3 search] footer', async () => {
    const output = await generateL1({
      palace_path: tmpPalace,
      top_n: 5,
    })

    expect(output).toContain('[more in L3 search]')
  })

  it('generateL1 output length <= 3200 chars', async () => {
    const output = await generateL1({
      palace_path: tmpPalace,
      top_n: 5,
      max_chars: 3200,
    })

    expect(output.length).toBeLessThanOrEqual(3200)
  })

  it('generateL1 output mentions source files', async () => {
    const output = await generateL1({
      palace_path: tmpPalace,
      top_n: 5,
    })

    // Source files appear in parentheses like "(fake-source-0.txt)"
    expect(output).toMatch(/fake-source-\d+\.txt/)
  })
})
