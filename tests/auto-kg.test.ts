import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mineDirectory } from '../src/mining/file-miner.js'
import { KnowledgeGraph } from '../src/kg/graph.js'

describe('mineDirectory auto KG population', () => {
  const tmpPalace = `/tmp/nardo-auto-kg-${Date.now()}`
  const tmpSrc = `/tmp/nardo-auto-kg-src-${Date.now()}`

  beforeAll(() => {
    mkdirSync(tmpPalace, { recursive: true })
    mkdirSync(tmpSrc, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpPalace, { recursive: true, force: true })
    rmSync(tmpSrc, { recursive: true, force: true })
  })

  it('populates kg.db with detected entities and co-occurrence triples', async () => {
    writeFileSync(
      join(tmpSrc, 'team.md'),
      [
        '# Team Notes',
        '',
        'Alice said the design was ready. Alice smiled when Bob replied.',
        'Bob asked about the migration plan. Bob nodded when Alice replied.',
      ].join('\n'),
    )

    const result = await mineDirectory(tmpSrc, {
      palace_path: tmpPalace,
      wing: 'kgtest',
      rooms: {},
      agent: 'test',
    })

    expect(result.drawers).toBeGreaterThan(0)

    const kg = new KnowledgeGraph(join(tmpPalace, 'kg.db'))
    try {
      expect(kg.getEntity('Alice')?.type).toBe('person')
      expect(kg.getEntity('Bob')?.type).toBe('person')

      const aliceRelations = kg.queryEntity('Alice')
      expect(aliceRelations.some(
        triple => triple.predicate === 'co-occurs-with' && triple.object === 'bob',
      )).toBe(true)
    } finally {
      kg.close()
    }
  }, 120_000)
})
