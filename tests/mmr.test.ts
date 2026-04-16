import { describe, it, expect } from 'bun:test'
import { cosineSimilarity, mmrRerank } from '../src/search/mmr.js'
import type { MMRCandidate } from '../src/search/mmr.js'

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
  })

  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('opposite vectors → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('empty vectors → 0', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('zero vector → 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('mmrRerank', () => {
  // Three candidates: A and B are very similar (redundant), C is diverse
  // All have the same relevance score
  const vecA = [1, 0, 0]
  const vecB = [0.99, 0.14, 0]   // nearly identical to A
  const vecC = [0, 1, 0]          // orthogonal to A/B

  const candidates: MMRCandidate[] = [
    { id: 'a', score: 0.9 },
    { id: 'b', score: 0.85 },
    { id: 'c', score: 0.80 },
  ]

  const embeddings = new Map([
    ['a', vecA],
    ['b', vecB],
    ['c', vecC],
  ])

  it('lambda=1 (pure relevance) preserves original order', () => {
    const result = mmrRerank(candidates, embeddings, 3, 1.0)
    expect(result).toEqual(['a', 'b', 'c'])
  })

  it('lambda=0 (pure diversity) picks A then C (orthogonal), skipping redundant B', () => {
    const result = mmrRerank(candidates, embeddings, 2, 0.0)
    expect(result[0]).toBe('a')    // highest relevance still wins first
    expect(result[1]).toBe('c')    // C is more diverse than B
  })

  it('lambda=0.7 (default) selects A first, then prefers C over B for diversity', () => {
    const result = mmrRerank(candidates, embeddings, 3, 0.7)
    expect(result[0]).toBe('a')
    // B and C are close in relevance; C wins because it's diverse
    expect(result[1]).toBe('c')
    expect(result[2]).toBe('b')
  })

  it('returns k items when k < candidates length', () => {
    const result = mmrRerank(candidates, embeddings, 2, 0.7)
    expect(result.length).toBe(2)
  })

  it('handles k > candidates length gracefully', () => {
    const result = mmrRerank(candidates, embeddings, 10, 0.7)
    expect(result.length).toBe(3)
  })

  it('handles empty candidates', () => {
    expect(mmrRerank([], embeddings, 5, 0.7)).toEqual([])
  })

  it('candidates without embeddings fall through to result', () => {
    const noVecCandidates: MMRCandidate[] = [{ id: 'x', score: 0.9 }]
    const result = mmrRerank(noVecCandidates, new Map(), 1, 0.7)
    expect(result).toEqual(['x'])
  })
})
