import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { PalaceClient } from '../src/palace/client.js'
import { addDrawer, forgetDrawers } from '../src/palace/drawers.js'
import * as wal from '../src/wal.js'

const tmpPalace = `/tmp/nardo-forget-${Date.now()}`

function fakeEmbedding(): number[] {
  const arr = Array.from({ length: 384 }, () => Math.random())
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0))
  return arr.map(x => x / norm)
}

async function addFake(
  client: PalaceClient,
  opts: { wing: string; room: string; source: string; filed_at?: string },
): Promise<string> {
  const text = `Content for ${opts.source} wing=${opts.wing} room=${opts.room}`
  return addDrawer(client, fakeEmbedding(), text, {
    wing: opts.wing,
    room: opts.room,
    source_file: opts.source,
    source_mtime: Date.now(),
    chunk_index: 0,
    normalize_version: 2,
    added_by: 'test',
    filed_at: opts.filed_at ?? new Date().toISOString(),
    ingest_mode: 'project',
    importance: 0.5,
    chunk_size: text.length,
  }, wal)
}

describe('forgetDrawers', () => {
  let client: PalaceClient

  beforeAll(() => {
    mkdirSync(tmpPalace, { recursive: true })
    client = new PalaceClient(tmpPalace)
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
  })

  it('dry_run returns count without deleting', async () => {
    await addFake(client, { wing: 'alpha', room: 'general', source: '/tmp/dry.txt' })
    await addFake(client, { wing: 'alpha', room: 'general', source: '/tmp/dry.txt' })

    const count = await forgetDrawers(client, {
      source_file: '/tmp/dry.txt',
      dry_run: true,
    }, wal)

    expect(count).toBe(2)

    // Verify nothing was actually deleted
    const col = await client.getDrawersCollection()
    const results = await col.get({ where: { source_file: { '$eq': '/tmp/dry.txt' } } })
    expect(results.ids.length).toBe(2)
  }, 30_000)

  it('forget by source_file deletes all matching drawers', async () => {
    await addFake(client, { wing: 'beta', room: 'src', source: '/tmp/target.txt' })
    await addFake(client, { wing: 'beta', room: 'src', source: '/tmp/target.txt' })
    await addFake(client, { wing: 'beta', room: 'src', source: '/tmp/keep.txt' })

    const deleted = await forgetDrawers(client, { source_file: '/tmp/target.txt' }, wal)
    expect(deleted).toBe(2)

    const col = await client.getDrawersCollection()
    const gone = await col.get({ where: { source_file: { '$eq': '/tmp/target.txt' } } })
    expect(gone.ids.length).toBe(0)

    const kept = await col.get({ where: { source_file: { '$eq': '/tmp/keep.txt' } } })
    expect(kept.ids.length).toBe(1)
  }, 30_000)

  it('forget by wing deletes only that wing', async () => {
    await addFake(client, { wing: 'gamma', room: 'bugs', source: '/tmp/g1.txt' })
    await addFake(client, { wing: 'gamma', room: 'bugs', source: '/tmp/g2.txt' })
    await addFake(client, { wing: 'delta', room: 'bugs', source: '/tmp/d1.txt' })

    const deleted = await forgetDrawers(client, { wing: 'gamma' }, wal)
    expect(deleted).toBe(2)

    const col = await client.getDrawersCollection()
    const delta = await col.get({ where: { wing: { '$eq': 'delta' } } })
    expect(delta.ids.length).toBeGreaterThan(0)
  }, 30_000)

  it('forget by wing+room deletes only that room', async () => {
    await addFake(client, { wing: 'epsilon', room: 'arch', source: '/tmp/e1.txt' })
    await addFake(client, { wing: 'epsilon', room: 'arch', source: '/tmp/e2.txt' })
    await addFake(client, { wing: 'epsilon', room: 'bugs', source: '/tmp/e3.txt' })

    const deleted = await forgetDrawers(client, { wing: 'epsilon', room: 'arch' }, wal)
    expect(deleted).toBe(2)

    const col = await client.getDrawersCollection()
    const bugs = await col.get({
      where: { '$and': [{ wing: { '$eq': 'epsilon' } }, { room: { '$eq': 'bugs' } }] },
    })
    expect(bugs.ids.length).toBe(1)
  }, 30_000)

  it('forget by --before date deletes only old drawers', async () => {
    const old = '2023-01-01T00:00:00.000Z'
    const recent = '2025-06-01T00:00:00.000Z'

    await addFake(client, { wing: 'zeta', room: 'gen', source: '/tmp/z1.txt', filed_at: old })
    await addFake(client, { wing: 'zeta', room: 'gen', source: '/tmp/z2.txt', filed_at: old })
    await addFake(client, { wing: 'zeta', room: 'gen', source: '/tmp/z3.txt', filed_at: recent })

    const deleted = await forgetDrawers(client, {
      wing: 'zeta',
      before: '2024-01-01T00:00:00.000Z',
    }, wal)
    expect(deleted).toBe(2)

    const col = await client.getDrawersCollection()
    const remaining = await col.get({ where: { wing: { '$eq': 'zeta' } } })
    expect(remaining.ids.length).toBe(1)
  }, 30_000)

  it('forget by id deletes exactly one drawer', async () => {
    const id = await addFake(client, { wing: 'eta', room: 'gen', source: '/tmp/eta.txt' })
    await addFake(client, { wing: 'eta', room: 'gen', source: '/tmp/eta.txt' })

    const deleted = await forgetDrawers(client, { id }, wal)
    expect(deleted).toBe(1)

    const col = await client.getDrawersCollection()
    const remaining = await col.get({ where: { wing: { '$eq': 'eta' } } })
    expect(remaining.ids.length).toBe(1)
  }, 30_000)

  it('returns 0 when nothing matches', async () => {
    const count = await forgetDrawers(client, { source_file: '/tmp/nonexistent-xyz.txt' }, wal)
    expect(count).toBe(0)
  }, 30_000)
})
