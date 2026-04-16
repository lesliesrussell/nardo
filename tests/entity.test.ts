import { describe, it, expect } from 'bun:test'
import { detectEntities } from '../src/entity/detector.ts'
import { EntityRegistry } from '../src/entity/registry.ts'

describe('detectEntities', () => {
  it('returns known people names from content', () => {
    const content = `
      Alice walked into the room. Alice smiled at everyone.
      Bob asked a question. Bob nodded when Alice replied.
    `
    const results = detectEntities(content)
    const names = results.map(e => e.name)
    expect(names).toContain('Alice')
    expect(names).toContain('Bob')
  })

  it('filters out stopwords', () => {
    const content = `
      The quick brown fox. This is a test. That was interesting.
      When will it end? The fox jumped. This fox ran away.
    `
    const results = detectEntities(content)
    const names = results.map(e => e.name)
    expect(names).not.toContain('The')
    expect(names).not.toContain('This')
    expect(names).not.toContain('That')
    expect(names).not.toContain('When')
  })

  it('requires 2+ occurrences', () => {
    const content = `
      Alice walked down the street. Someone else was there.
    `
    const results = detectEntities(content)
    // Alice only appears once — should not be returned
    expect(results.find(e => e.name === 'Alice')).toBeUndefined()
  })

  it('classifies project verbs as project type', () => {
    const content = `
      Falcon was deployed last week. The team built Falcon from scratch.
      Falcon was launched after Falcon was released successfully.
    `
    const results = detectEntities(content)
    const falcon = results.find(e => e.name === 'Falcon')
    expect(falcon).toBeDefined()
    expect(falcon!.type).toBe('project')
  })

  it('classifies person verbs as person type', () => {
    const content = `
      Sarah said hello to everyone. Sarah laughed and walked away.
      Sarah smiled when she heard the news. Sarah nodded in agreement.
    `
    const results = detectEntities(content)
    const sarah = results.find(e => e.name === 'Sarah')
    expect(sarah).toBeDefined()
    expect(sarah!.type).toBe('person')
  })

  it('sorts by occurrences descending', () => {
    const content = `
      Alice said hello. Alice walked away. Alice smiled. Alice nodded.
      Bob asked once. Bob replied once.
    `
    const results = detectEntities(content)
    expect(results.length).toBeGreaterThan(0)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].occurrences).toBeGreaterThanOrEqual(results[i].occurrences)
    }
  })
})

describe('EntityRegistry', () => {
  it('set and get round-trip (in memory)', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Alice', { type: 'person', confidence: 0.9, source: 'onboarding' })
    const result = registry.get('Alice')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('person')
    expect(result!.confidence).toBe(0.9)
    expect(result!.source).toBe('onboarding')
  })

  it('get is case-insensitive (lowercases key)', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Alice', { type: 'person', confidence: 0.9, source: 'onboarding' })
    expect(registry.get('alice')).not.toBeNull()
    expect(registry.get('ALICE')).not.toBeNull()
  })

  it('list returns all entries', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Alice', { type: 'person', confidence: 0.9, source: 'onboarding' })
    registry.set('Falcon', { type: 'project', confidence: 0.8, source: 'learned' })
    const entries = registry.list()
    expect(entries.length).toBe(2)
    expect(entries.map(e => e.name)).toContain('alice')
    expect(entries.map(e => e.name)).toContain('falcon')
  })

  it('merge: onboarding beats learned', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Alice', { type: 'person', confidence: 0.9, source: 'onboarding' })
    // Try to overwrite with lower-precedence source
    registry.merge('Alice', { type: 'concept', confidence: 0.5, source: 'learned' })
    const result = registry.get('Alice')
    expect(result!.source).toBe('onboarding')
    expect(result!.type).toBe('person')
  })

  it('merge: learned beats researched', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Bob', { type: 'person', confidence: 0.7, source: 'learned' })
    registry.merge('Bob', { type: 'concept', confidence: 0.6, source: 'researched' })
    const result = registry.get('Bob')
    expect(result!.source).toBe('learned')
  })

  it('merge: higher precedence replaces lower', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.set('Eve', { type: 'concept', confidence: 0.5, source: 'researched' })
    registry.merge('Eve', { type: 'person', confidence: 0.9, source: 'onboarding' })
    const result = registry.get('Eve')
    expect(result!.source).toBe('onboarding')
    expect(result!.type).toBe('person')
  })

  it('merge: inserting new entity when not present', () => {
    const registry = new EntityRegistry('/tmp/nardo-test-registry.json')
    registry.merge('NewEntity', { type: 'project', confidence: 0.8, source: 'learned' })
    const result = registry.get('NewEntity')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('project')
  })
})
