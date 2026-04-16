import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import { EmbeddingPipeline } from '../embeddings/pipeline.js'
import { sanitizeQuery } from './sanitizer.js'

export interface SearchOptions {
  query: string
  n_results?: number
  wing?: string
  room?: string
  max_distance?: number
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
}

const RANK_BOOSTS = [0.40, 0.25, 0.15, 0.08, 0.04]

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

export class HybridSearcher {
  private palace_client: PalaceClient
  private embedder: EmbeddingPipeline

  constructor(palace_client: PalaceClient, embedder: EmbeddingPipeline) {
    this.palace_client = palace_client
    this.embedder = embedder
  }

  async search(opts: SearchOptions): Promise<SearchResponse> {
    const n_results = opts.n_results ?? 5
    const max_distance = opts.max_distance ?? 1.5

    // Step 1: Sanitize query
    const sanitized = sanitizeQuery(opts.query)
    const clean_query = sanitized.clean_query

    // Step 2: Embed clean query
    const embeddings = await this.embedder.embed([clean_query])
    const queryEmbedding = embeddings[0]

    const whereFilter = buildWhereFilter(opts.wing, opts.room)

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
      if (dist >= max_distance) continue
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
        closet_boost = RANK_BOOSTS[rank]
        effective_distance = distance - closet_boost
        matched_via = 'drawer+closet'
        closet_preview = closetHit.preview
      }

      const bm25_norm = normBm25Scores.get(id) ?? 0
      const effective_vec_sim = Math.max(0, 1 - effective_distance)
      const final_score = 0.6 * effective_vec_sim + 0.4 * bm25_norm

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

      scored.push({ result, final_score })
    }

    // Step 8: Sort by final_score desc, return top n_results
    scored.sort((a, b) => b.final_score - a.final_score)
    const results = scored.slice(0, n_results).map(s => s.result)

    return {
      query: clean_query,
      filters: { wing: opts.wing, room: opts.room },
      total_before_filter,
      results,
    }
  }
}
