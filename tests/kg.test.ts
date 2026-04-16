import { describe, it, expect, afterEach } from 'bun:test'
import { KnowledgeGraph } from '../src/kg/graph.ts'
import { unlinkSync, existsSync } from 'fs'

function tmpDb(): string {
  return `/tmp/nardo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`
}

describe('KnowledgeGraph', () => {
  const dbs: string[] = []

  function makeKg(): { kg: KnowledgeGraph; path: string } {
    const path = tmpDb()
    dbs.push(path)
    return { kg: new KnowledgeGraph(path), path }
  }

  afterEach(() => {
    for (const p of dbs.splice(0)) {
      if (existsSync(p)) {
        try { unlinkSync(p) } catch {}
        try { unlinkSync(p + '-wal') } catch {}
        try { unlinkSync(p + '-shm') } catch {}
      }
    }
  })

  it('addEntity and getEntity round-trip', () => {
    const { kg } = makeKg()
    const id = kg.addEntity('Alice Smith', { type: 'person', properties: { age: 30 } })
    expect(id).toBe('alice_smith')
    const entity = kg.getEntity('Alice Smith')
    expect(entity).not.toBeNull()
    expect(entity!.id).toBe('alice_smith')
    expect(entity!.name).toBe('Alice Smith')
    expect(entity!.type).toBe('person')
    expect(entity!.properties).toEqual({ age: 30 })
    kg.close()
  })

  it('getEntity returns null for unknown entity', () => {
    const { kg } = makeKg()
    expect(kg.getEntity('Nobody')).toBeNull()
    kg.close()
  })

  it('addTriple and queryEntity returns it', () => {
    const { kg } = makeKg()
    kg.addEntity('Alice')
    kg.addEntity('Bob')
    const tripleId = kg.addTriple('alice', 'knows', 'bob')
    expect(tripleId).toMatch(/^t_alice_knows_bob_/)

    const results = kg.queryEntity('Alice')
    expect(results.length).toBe(1)
    expect(results[0].subject).toBe('alice')
    expect(results[0].predicate).toBe('knows')
    expect(results[0].object).toBe('bob')
    expect(results[0].current).toBe(true)
    kg.close()
  })

  it('invalidate sets valid_to', () => {
    const { kg } = makeKg()
    kg.addEntity('Alice')
    kg.addEntity('Bob')
    kg.addTriple('alice', 'knows', 'bob')

    const found = kg.invalidate('alice', 'knows', 'bob', '2025-01-01')
    expect(found).toBe(true)

    const results = kg.queryEntity('Alice')
    expect(results[0].valid_to).toBe('2025-01-01')
    expect(results[0].current).toBe(false)
    kg.close()
  })

  it('invalidate returns false when no match', () => {
    const { kg } = makeKg()
    const found = kg.invalidate('nobody', 'knows', 'nobody')
    expect(found).toBe(false)
    kg.close()
  })

  it('time-aware query: as_of before valid_from returns nothing', () => {
    const { kg } = makeKg()
    kg.addEntity('Alice')
    kg.addEntity('Bob')
    kg.addTriple('alice', 'knows', 'bob', { valid_from: '2025-06-01' })

    const results = kg.queryEntity('Alice', { as_of: '2025-01-01' })
    expect(results.length).toBe(0)
    kg.close()
  })

  it('time-aware query: as_of after valid_from returns the triple', () => {
    const { kg } = makeKg()
    kg.addEntity('Alice')
    kg.addEntity('Bob')
    kg.addTriple('alice', 'knows', 'bob', { valid_from: '2025-01-01' })

    const results = kg.queryEntity('Alice', { as_of: '2026-01-01' })
    expect(results.length).toBe(1)
    kg.close()
  })

  it('direction filter: outgoing only returns subject triples', () => {
    const { kg } = makeKg()
    kg.addEntity('Alice')
    kg.addEntity('Bob')
    kg.addTriple('alice', 'knows', 'bob')
    kg.addTriple('bob', 'likes', 'alice')

    const outgoing = kg.queryEntity('Alice', { direction: 'outgoing' })
    expect(outgoing.every(t => t.subject === 'alice')).toBe(true)

    const incoming = kg.queryEntity('Alice', { direction: 'incoming' })
    expect(incoming.every(t => t.object === 'alice')).toBe(true)
    kg.close()
  })
})
