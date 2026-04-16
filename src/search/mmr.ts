// Maximal Marginal Relevance (MMR) reranking
//
// MMR balances relevance and diversity by iteratively selecting the candidate
// that maximises: λ * relevance(c, query) - (1-λ) * max_sim(c, selected)
//
// λ = 1.0 → pure relevance (equivalent to no MMR)
// λ = 0.0 → pure diversity
// λ = 0.7 → recommended default: leans toward relevance while reducing redundancy

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export interface MMRCandidate {
  id: string
  score: number  // relevance score (higher = more relevant)
}

/**
 * Rerank candidates using MMR.
 *
 * @param candidates - items with id and relevance score, already sorted desc by score
 * @param embeddings - map from id to embedding vector
 * @param k          - number of results to select
 * @param lambda     - trade-off parameter [0,1]; default 0.7
 * @returns selected ids in MMR order
 */
export function mmrRerank(
  candidates: MMRCandidate[],
  embeddings: Map<string, number[]>,
  k: number,
  lambda = 0.7,
): string[] {
  if (candidates.length === 0) return []
  if (lambda >= 1.0) {
    // Pure relevance — no reranking needed
    return candidates.slice(0, k).map(c => c.id)
  }

  // Separate candidates that have embeddings from those that don't.
  // Items without embeddings fall back to original relevance order.
  const withVecs = candidates.filter(c => embeddings.has(c.id))
  const withoutVecs = candidates.filter(c => !embeddings.has(c.id))

  const selected: string[] = []
  const remaining = [...withVecs]

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!
      const candVec = embeddings.get(cand.id)!

      // Max similarity to already-selected items
      let maxSim = 0
      for (const selId of selected) {
        const selVec = embeddings.get(selId)
        if (selVec) {
          const sim = cosineSimilarity(candVec, selVec)
          if (sim > maxSim) maxSim = sim
        }
      }

      const mmrScore = lambda * cand.score - (1 - lambda) * maxSim
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    if (bestIdx === -1) break
    selected.push(remaining[bestIdx]!.id)
    remaining.splice(bestIdx, 1)
  }

  // Append any items without embeddings to fill remaining slots
  for (const c of withoutVecs) {
    if (selected.length >= k) break
    selected.push(c.id)
  }

  return selected
}
