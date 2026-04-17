import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import { EmbeddingPipeline } from '../embeddings/pipeline.js'
import { sanitizeQuery } from './sanitizer.js'
import { expandQuery } from './expander.js'
import { mmrRerank } from './mmr.js'

export interface SearchOptions {
  query: string
  n_results?: number
  wing?: string
  room?: string
  max_distance?: number
  /** MMR diversity trade-off: 1.0 = pure relevance, 0.0 = pure diversity (default: 0.7) */
  mmr_lambda?: number
  /** Importance decay half-life in days (default: 90). Set to 0 to disable decay. */
  decay_halflife?: number
  /** How much each retrieval counteracts age decay (default 0.3) */
  retrieval_weight?: number
  /** Expand query with synonyms before embedding (default: true). Improves recall for terse queries. */
  expand?: boolean
  /** Search all wings regardless of wing filter (default: false). Results are tagged with their origin wing. */
  federated?: boolean
}

export interface SearchResult {
  text: string
  wing: string
  room: string
  source_file: string
  similarity: number
  distance: number
  effective_distance: number
  closet_boost: number
  matched_via: 'drawer' | 'drawer+closet'
  closet_preview?: string
  drawer_index: number
  total_drawers: number
  filed_at?: string
  importance?: number
}

export interface SearchResponse {
  query: string
  filters: { wing?: string; room?: string }
  total_before_filter: number
  results: SearchResult[]
  /** Terms added by query expansion (absent when expansion is disabled or no synonyms found) */
  expanded_terms?: string[]
  /** True when wing filter was suppressed for cross-wing federation */
  federated?: boolean
}

const RANK_BOOSTS = [0.40, 0.25, 0.15, 0.08, 0.04]
// Closets are whole-file summaries — their distances are ~0.15 higher than
// drawer distances for the same query. Use a separate, looser threshold so
// closet boosts fire consistently regardless of the caller's max_distance.
const CLOSET_MAX_DISTANCE = 1.2

function buildWhereFilter(wing?: string, room?: string): Record<string, unknown> | undefined {
  if (room && wing) {
    return { '$and': [{ wing: { '$eq': wing } }, { room: { '$eq': room } }] }
  }
  if (room) {
    return { room: { '$eq': room } }
  }
  if (wing) {
    return { wing: { '$eq': wing } }
  }
  return undefined
}

type QueryType = 'keyword' | 'semantic' | 'default'

function detectQueryType(query: string): QueryType {
  const words = query.trim().split(/\s+/)
  const hasQuote = /["']/.test(query)
  const hasCamelOrSnake = /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]/.test(query)
  const hasQuestionWord = /\b(how|why|what|when|where|which|who|explain|describe)\b/i.test(query)
  if (hasQuote || hasCamelOrSnake || words.length <= 3) return 'keyword'
  if (hasQuestionWord || words.length >= 6) return 'semantic'
  return 'default'
}

export class HybridSearcher {
  private palace_client: PalaceClient
  private embedder: EmbeddingPipeline

  constructor(palace_client: PalaceClient, embedder: EmbeddingPipeline) {
    this.palace_client = palace_client
    this.embedder = embedder
  }

  async search(opts: SearchOptions): Promise<SearchResponse> {
    const n_results = opts.n_results ?? 5

    // Step 1: Sanitize query
    const sanitized = sanitizeQuery(opts.query)
    const clean_query = sanitized.clean_query

    // Step 2: Optionally expand query with synonyms before embedding
    const doExpand = opts.expand !== false
    const expansion = doExpand ? expandQuery(clean_query) : { expanded: clean_query, added_terms: [] }
    const embed_query = expansion.expanded

    // Step 3: Embed (expanded) query; BM25 uses original clean_query for precision
    const embeddings = await this.embedder.embed([embed_query])
    const queryEmbedding = embeddings[0]

    const whereFilter = buildWhereFilter(opts.federated ? undefined : opts.wing, opts.room)

    const drawersCol = await this.palace_client.getDrawersCollection()
    const closetsCol = await this.palace_client.getClosetsCollection()

    // Step 3: Over-fetch drawers
    const drawerResults = await (drawersCol as Collection).query({
      queryEmbeddings: [queryEmbedding],
      nResults: n_results * 3,
      include: ['documents', 'metadatas', 'distances'],
      ...(whereFilter ? { where: whereFilter } : {}),
    })

    // Step 4: Over-fetch closets
    const closetResults = await (closetsCol as Collection).query({
      queryEmbeddings: [queryEmbedding],
      nResults: n_results * 2,
      include: ['documents', 'metadatas', 'distances'],
      ...(whereFilter ? { where: whereFilter } : {}),
    })

    // Step 5: Build closet hits map: source_file → { rank, distance, preview }
    const closetHits = new Map<string, { rank: number; distance: number; preview: string }>()
    const closetDocs = closetResults.documents[0] ?? []
    const closetMetas = closetResults.metadatas[0] ?? []
    const closetDists = closetResults.distances[0] ?? []

    for (let i = 0; i < closetDocs.length; i++) {
      const dist = closetDists[i] ?? 2
      if (dist >= CLOSET_MAX_DISTANCE) continue
      const meta = closetMetas[i] ?? {}
      const source_file = (meta.source_file as string) ?? ''
      if (source_file && !closetHits.has(source_file)) {
        closetHits.set(source_file, {
          rank: i,
          distance: dist,
          preview: (closetDocs[i] ?? '').slice(0, 200),
        })
      }
    }

    // Step 6 & 7: Build drawer records with effective_distance
    const drawerIds = drawerResults.ids[0] ?? []
    const drawerDocs = drawerResults.documents[0] ?? []
    const drawerMetas = drawerResults.metadatas[0] ?? []
    const drawerDists = drawerResults.distances[0] ?? []

    const total_before_filter = drawerIds.length

    // BM25 scores via SQLite FTS5 — persisted index, unicode-aware, phrase-capable
    const normBm25Scores = await (drawersCol as Collection).fts5Score(drawerIds, clean_query)

    const resultToDrawerId = new Map<SearchResult, string>()
    const scored: Array<{ result: SearchResult; final_score: number }> = []

    for (let i = 0; i < drawerIds.length; i++) {
      const id = drawerIds[i]
      const text = drawerDocs[i] ?? ''
      const meta = drawerMetas[i] ?? {}
      const distance = drawerDists[i] ?? 2

      const wing = (meta.wing as string) ?? ''
      const room = (meta.room as string) ?? ''
      const source_file = (meta.source_file as string) ?? ''

      const vec_sim = Math.max(0, 1 - distance)

      let effective_distance = distance
      let closet_boost = 0
      let matched_via: 'drawer' | 'drawer+closet' = 'drawer'
      let closet_preview: string | undefined

      const closetHit = closetHits.get(source_file)
      if (closetHit) {
        const rank = Math.min(closetHit.rank, RANK_BOOSTS.length - 1)
        closet_boost = RANK_BOOSTS[rank] * (1 - closetHit.distance)
        effective_distance = distance - closet_boost
        matched_via = 'drawer+closet'
        closet_preview = closetHit.preview
      }

      const bm25_norm = normBm25Scores.get(id) ?? 0
      const effective_vec_sim = Math.max(0, 1 - effective_distance)

      // Importance with optional recency decay: importance * 1/(1 + effective_age/halflife)
      // retrieval_count counteracts age decay proportionally
      const importance = (meta.importance as number) ?? 0.5
      const retrieval_count = (meta.retrieval_count as number) ?? 0
      const halflife = opts.decay_halflife ?? 90
      let decayed_importance = importance
      if (halflife > 0 && meta.filed_at) {
        const daysOld = (Date.now() - new Date(meta.filed_at as string).getTime()) / 86_400_000
        const k = opts.retrieval_weight ?? 0.3
        const effective_age = daysOld / (1 + retrieval_count * k)
        decayed_importance = importance * (1 / (1 + effective_age / halflife))
      }

      // Query-adaptive weights: keyword → BM25-heavy, semantic → vec-heavy, default → balanced
      const qt = detectQueryType(clean_query)
      const [wVec, wBm25, wImp] = qt === 'keyword' ? [0.35, 0.55, 0.10]
        : qt === 'semantic' ? [0.65, 0.25, 0.10]
        : [0.55, 0.35, 0.10]
      const final_score = wVec * effective_vec_sim + wBm25 * bm25_norm + wImp * decayed_importance

      const result: SearchResult = {
        text,
        wing,
        room,
        source_file,
        similarity: vec_sim,
        distance,
        effective_distance,
        closet_boost,
        matched_via,
        closet_preview,
        drawer_index: (meta.drawer_index as number) ?? i,
        total_drawers: (meta.total_drawers as number) ?? total_before_filter,
        filed_at: meta.filed_at as string | undefined,
        importance: meta.importance as number | undefined,
      }

      resultToDrawerId.set(result, id!)
      scored.push({ result, final_score })
    }

    // Step 8: Sort by final_score desc
    scored.sort((a, b) => b.final_score - a.final_score)

    // Build sorted candidates + reverse map for MMR
    const resultById = new Map<string, SearchResult>()
    for (const [result, drawerId] of resultToDrawerId) {
      resultById.set(drawerId, result)
    }
    const sortedCandidates = scored.map(s => ({
      id: resultToDrawerId.get(s.result)!,
      score: s.final_score,
    }))

    // Step 9: MMR reranking for diversity (skip if lambda≥1 or only 1 result)
    const lambda = opts.mmr_lambda ?? 0.7
    let results: SearchResult[]

    if (lambda < 1.0 && sortedCandidates.length > 1) {
      const embeddings = await (drawersCol as Collection).getEmbeddings(drawerIds)
      const selected = mmrRerank(sortedCandidates, embeddings, n_results, lambda)
      results = selected.map(id => resultById.get(id)).filter((r): r is SearchResult => r != null)
    } else {
      results = scored.slice(0, n_results).map(s => s.result)
    }

    // Fire-and-forget retrieval tracking — never blocks the response
    const resultIds = results.map(r => resultToDrawerId.get(r)).filter((id): id is string => id != null)
    void (drawersCol as Collection).incrementRetrievalCount(resultIds).catch(() => {})

    return {
      query: clean_query,
      filters: { wing: opts.wing, room: opts.room },
      total_before_filter,
      results,
      ...(expansion.added_terms.length > 0 ? { expanded_terms: expansion.added_terms } : {}),
      ...(opts.federated ? { federated: true } : {}),
    }
  }
}
