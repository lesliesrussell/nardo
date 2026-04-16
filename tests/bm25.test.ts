import { describe, it, expect } from 'bun:test'
import { BM25Scorer } from '../src/search/bm25.ts'

describe('BM25Scorer', () => {
  const docs = [
    { id: 'doc1', text: 'the quick brown fox jumps over the lazy dog' },
    { id: 'doc2', text: 'a fast red fox ran across the field' },
    { id: 'doc3', text: 'completely unrelated content about cooking recipes' },
  ]

  it('score returns higher value for doc containing query term', () => {
    const scorer = new BM25Scorer(docs)
    const score1 = scorer.score('fox', 'doc1')
    const score3 = scorer.score('fox', 'doc3')
    expect(score1).toBeGreaterThan(0)
    expect(score3).toBe(0)
  })

  it('score returns 0 for doc with no query terms', () => {
    const scorer = new BM25Scorer(docs)
    const score = scorer.score('zzzzunknownterm', 'doc1')
    expect(score).toBe(0)
  })

  it('normalize: highest score maps to 1.0, lowest to 0.0', () => {
    const scorer = new BM25Scorer(docs)
    const scores = scorer.scoreAll('fox')
    const normalized = scorer.normalize(scores)

    const values = Array.from(normalized.values())
    const max = Math.max(...values)
    const min = Math.min(...values)

    expect(max).toBeCloseTo(1.0, 5)
    expect(min).toBeCloseTo(0.0, 5)
  })

  it('IDF: rare term scores higher than common term', () => {
    // 'the' appears in 2 of 3 docs (high df) → lower IDF
    // 'cooking' appears in 1 of 3 docs (low df) → higher IDF
    const scorer = new BM25Scorer(docs)
    // Score doc3 (which has 'cooking') against rare vs common term
    const rareScore = scorer.score('cooking', 'doc3')
    const commonScore = scorer.score('the', 'doc3')
    // 'the' is not in doc3, so commonScore=0; but let's check doc1 where 'the' appears twice
    const rareInDoc1 = scorer.score('fox', 'doc1')    // fox in 2 docs
    const commonInDoc1 = scorer.score('the', 'doc1')  // 'the' in 2 docs too

    // Use a term that is truly rare: 'cooking' in 1 doc vs 'the' in 2 docs
    // Score doc3 for 'cooking' (1 doc freq) vs doc1 for 'the' (2 doc freq)
    // Rare term should yield higher IDF score, holding freq constant
    expect(rareScore).toBeGreaterThan(0)

    // More direct test: build scorer where term A is in 1 doc, term B is in all docs
    const docs2 = [
      { id: 'a', text: 'unique rare specialized word' },
      { id: 'b', text: 'common word present here' },
      { id: 'c', text: 'common word also present' },
    ]
    const scorer2 = new BM25Scorer(docs2)
    const rareTermScore = scorer2.score('unique', 'a')   // df=1
    const commonTermScore = scorer2.score('common', 'b') // df=2
    // 'unique' has df=1 → higher IDF; 'common' has df=2 → lower IDF
    expect(rareTermScore).toBeGreaterThan(commonTermScore)
  })
})
