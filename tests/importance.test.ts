import { describe, it, expect } from 'bun:test'
import { computeImportance } from '../src/mining/importance.ts'

describe('computeImportance', () => {
  it('returns minimum 0.1 for very short text', () => {
    expect(computeImportance('hi')).toBe(0.1)
    expect(computeImportance('')).toBe(0.1)
  })

  it('returns value in [0.1, 1.0] for all inputs', () => {
    const texts = [
      'short',
      'a'.repeat(50),
      'a'.repeat(500),
      'a'.repeat(5000),
      'We decided to switch databases after Alice identified the bottleneck.',
      '# Header\n```\ncode block\n```\n1. item one\n2. item two',
    ]
    for (const t of texts) {
      const score = computeImportance(t)
      expect(score).toBeGreaterThanOrEqual(0.1)
      expect(score).toBeLessThanOrEqual(1.0)
    }
  })

  it('scores decision-verb-rich text higher than filler text', () => {
    const decision = 'We decided to switch from PostgreSQL to SQLite. Alice identified the bottleneck ' +
      'and resolved the connection pool issue. The team realized we needed a local-first design.'
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
      'incididunt ut labore et dolore magna aliqua ut enim ad minim veniam'
    expect(computeImportance(decision)).toBeGreaterThan(computeImportance(filler))
  })

  it('scores structured text higher than unstructured text of same length', () => {
    const base = 'Some content about the system design and architecture decisions.\n'
    const unstructured = base.repeat(5)
    const structured = '# Architecture\n```typescript\nconst x = 1\n```\n1. First step\n' + base.repeat(4)
    expect(computeImportance(structured)).toBeGreaterThan(computeImportance(unstructured))
  })

  it('sweet-spot length (200-800 chars) scores higher than very short text', () => {
    const short = 'brief note'
    const medium = 'We implemented a new caching layer that reduced latency by 40%. ' +
      'The system now handles 10k requests per second. Redis was chosen for its ' +
      'persistence and pub/sub capabilities. Performance tests confirm the improvement.'
    expect(computeImportance(medium)).toBeGreaterThan(computeImportance(short))
  })

  it('entity-dense text scores higher than entity-free text of same length', () => {
    const withEntities = 'Alice and Bob implemented the nardo system. Alice designed the ' +
      'architecture while Bob handled the deployment. nardo now runs on the production server.'
    const noEntities = 'the function returns a value that represents the current state of ' +
      'the system and provides information about the running process and its components.'
    expect(computeImportance(withEntities)).toBeGreaterThan(computeImportance(noEntities))
  })
})
