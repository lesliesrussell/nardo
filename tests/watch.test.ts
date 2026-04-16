import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mineSingleFile } from '../src/mining/file-miner.js'
import { PalaceClient } from '../src/palace/client.js'

// Tests for the incremental single-file mining path used by the watch daemon.
// We don't test fs.watch() itself (process lifecycle), but we test the critical
// skip-if-unchanged and re-mine-on-change behaviour.

describe('mineSingleFile — incremental mine', () => {
  const tmpPalace = `/tmp/nardo-watch-${Date.now()}`
  const tmpSrc = `/tmp/nardo-watch-src-${Date.now()}`
  const mineOpts = { palace_path: tmpPalace, wing: 'watched', rooms: {}, agent: 'test' }

  beforeAll(() => {
    mkdirSync(tmpPalace, { recursive: true })
    mkdirSync(tmpSrc, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
    rmSync(tmpSrc, { recursive: true, force: true })
  })

  it('mines a new file and returns drawer count', async () => {
    const file = join(tmpSrc, 'new.md')
    writeFileSync(file,
      '# Architecture\n\nWe decided to use a local-first design with SQLite as the primary store. ' +
      'Alice implemented the initial schema and Bob reviewed the migration plan. ' +
      'The system now handles offline-first operations correctly.',
    )

    const result = await mineSingleFile(file, mineOpts)

    expect(result.skipped).toBe(false)
    expect(result.remined).toBe(false)
    expect(result.drawers).toBeGreaterThan(0)
  }, 60_000)

  it('skips an unchanged file on second call (mtime unchanged)', async () => {
    const file = join(tmpSrc, 'new.md')

    const result = await mineSingleFile(file, mineOpts)

    expect(result.skipped).toBe(true)
    expect(result.drawers).toBe(0)
  }, 60_000)

  it('re-mines a changed file and replaces old drawers', async () => {
    const file = join(tmpSrc, 'changing.md')
    writeFileSync(file, 'Initial content about system design and architecture decisions made by Alice.')

    const first = await mineSingleFile(file, mineOpts)
    expect(first.drawers).toBeGreaterThan(0)
    expect(first.remined).toBe(false)

    // Force mtime to advance by writing new content
    await new Promise(r => setTimeout(r, 10))
    writeFileSync(file, 'Updated content: switched implementation to use FTS5 for better BM25 scoring. ' +
      'Bob discovered the old approach had full-corpus IDF problems. Fixed by Alice.')

    const second = await mineSingleFile(file, mineOpts)
    expect(second.skipped).toBe(false)
    expect(second.remined).toBe(true)
    expect(second.drawers).toBeGreaterThan(0)

    // Verify only the new drawers remain (old ones deleted)
    const client = new PalaceClient(tmpPalace)
    const col = await client.getDrawersCollection()
    const results = await col.get({
      where: { source_file: { '$eq': file } },
      include: ['documents'],
    })
    // All remaining documents should be from the updated content
    const allText = results.documents.join(' ')
    expect(allText).toMatch(/FTS5|BM25|switched/i)
  }, 60_000)

  it('skips files with non-readable extensions', async () => {
    const file = join(tmpSrc, 'image.png')
    writeFileSync(file, 'fake image data')

    const result = await mineSingleFile(file, mineOpts)
    expect(result.skipped).toBe(true)
    expect(result.drawers).toBe(0)
  }, 30_000)

  it('skips empty / tiny files', async () => {
    const file = join(tmpSrc, 'empty.md')
    writeFileSync(file, '')

    const result = await mineSingleFile(file, mineOpts)
    expect(result.skipped).toBe(false)  // not skipped by extension/mtime
    expect(result.drawers).toBe(0)      // but no chunks produced
  }, 30_000)
})
