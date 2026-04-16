export interface BM25Document {
  id: string
  text: string
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(t => t.length > 0)
}

export class BM25Scorer {
  private k1: number
  private b: number
  private docs: Map<string, string[]>        // doc_id → tokens
  private idf: Map<string, number>           // term → IDF
  private avgDocLen: number
  private N: number

  constructor(docs: BM25Document[], k1 = 1.5, b = 0.75) {
    this.k1 = k1
    this.b = b
    this.N = docs.length
    this.docs = new Map()
    this.idf = new Map()
    this.avgDocLen = 0

    if (this.N === 0) return

    // Tokenize all docs and build df counts
    const df = new Map<string, number>()
    let totalLen = 0

    for (const doc of docs) {
      const tokens = tokenize(doc.text)
      this.docs.set(doc.id, tokens)
      totalLen += tokens.length

      // Count document frequency (unique terms per doc)
      const seen = new Set<string>()
      for (const t of tokens) {
        if (!seen.has(t)) {
          df.set(t, (df.get(t) ?? 0) + 1)
          seen.add(t)
        }
      }
    }

    this.avgDocLen = totalLen / this.N

    // Compute IDF for each term
    for (const [term, docFreq] of df) {
      const idfVal = Math.log((this.N - docFreq + 0.5) / (docFreq + 0.5) + 1)
      this.idf.set(term, idfVal)
    }
  }

  score(query: string, doc_id: string): number {
    const queryTerms = tokenize(query)
    const docTokens = this.docs.get(doc_id)
    if (!docTokens || queryTerms.length === 0) return 0

    const docLen = docTokens.length

    // Build term frequency map for this doc
    const tf = new Map<string, number>()
    for (const t of docTokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }

    let totalScore = 0
    for (const term of queryTerms) {
      const freq = tf.get(term) ?? 0
      if (freq === 0) continue
      const idfVal = this.idf.get(term) ?? 0
      const numerator = freq * (this.k1 + 1)
      const denominator = freq + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen))
      totalScore += idfVal * (numerator / denominator)
    }

    return totalScore
  }

  scoreAll(query: string): Map<string, number> {
    const result = new Map<string, number>()
    for (const doc_id of this.docs.keys()) {
      result.set(doc_id, this.score(query, doc_id))
    }
    return result
  }

  normalize(scores: Map<string, number>): Map<string, number> {
    if (scores.size === 0) return new Map()

    const values = Array.from(scores.values())
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min

    return new Map(Array.from(scores.entries()).map(([id, score]) => [
      id,
      range === 0 ? (max > 0 ? 1.0 : 0.0) : (score - min) / range,
    ]))
  }
}
