// Read tools
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PalaceClient } from '../../palace/client.js'
import { getAllDrawerMetadata } from '../../palace/drawers.js'
import { HybridSearcher } from '../../search/hybrid.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'

export function registerReadTools(server: McpServer, palace_path: string): void {
  // nardo_status
  server.tool('nardo_status', 'Show high-level palace status', {}, async () => {
    const client = new PalaceClient(palace_path)
    const all = await getAllDrawerMetadata(client)

    const wings: Record<string, number> = {}
    const rooms: Record<string, number> = {}

    for (const m of all) {
      const w = m.wing ?? 'unknown'
      const r = m.room ?? 'unknown'
      wings[w] = (wings[w] ?? 0) + 1
      rooms[r] = (rooms[r] ?? 0) + 1
    }

    const result = {
      total_drawers: all.length,
      wings,
      rooms,
      palace_path,
      protocol:
        'nardo Memory Protocol: (1) Call nardo_search to retrieve memories before answering questions about past context. ' +
        '(2) Results are scoped by wing (topic) and room (subdirectory). Use nardo_list_rooms to discover available rooms, ' +
        'then pass room= to nardo_search to get focused results. ' +
        '(3) If search results look weak or off-topic, call nardo_suggest_room with your query to find the best room, then re-search with room= set.',
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  })

  // nardo_list_wings
  server.tool('nardo_list_wings', 'List wings and their drawer counts', {}, async () => {
    const client = new PalaceClient(palace_path)
    const all = await getAllDrawerMetadata(client)

    const wings: Record<string, number> = {}
    for (const m of all) {
      const w = m.wing ?? 'unknown'
      wings[w] = (wings[w] ?? 0) + 1
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ wings }, null, 2) }] }
  })

  // nardo_list_rooms
  server.tool(
    'nardo_list_rooms',
    'List rooms, optionally filtered by wing',
    {
      wing: z.string().optional().describe('Filter to this wing (optional)'),
    },
    async (input: { wing?: string }) => {
      const client = new PalaceClient(palace_path)
      let all = await getAllDrawerMetadata(client)

      if (input.wing) {
        all = all.filter(m => m.wing === input.wing)
      }

      const rooms: Record<string, number> = {}
      for (const m of all) {
        const r = m.room ?? 'unknown'
        rooms[r] = (rooms[r] ?? 0) + 1
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ wing: input.wing, rooms }, null, 2),
          },
        ],
      }
    },
  )

  // nardo_get_taxonomy
  server.tool('nardo_get_taxonomy', 'Show wing and room taxonomy counts', {}, async () => {
    const client = new PalaceClient(palace_path)
    const all = await getAllDrawerMetadata(client)

    const taxonomy: Record<string, Record<string, number>> = {}
    for (const m of all) {
      const w = m.wing ?? 'unknown'
      const r = m.room ?? 'unknown'
      if (!taxonomy[w]) taxonomy[w] = {}
      taxonomy[w][r] = (taxonomy[w][r] ?? 0) + 1
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ taxonomy }, null, 2) }] }
  })

  // nardo_search
  server.tool(
    'nardo_search',
    'Semantic + keyword hybrid search. Use room= to focus results (call nardo_list_rooms to see available rooms). If results are weak, call nardo_suggest_room first.',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default 5)'),
      wing: z.string().optional().describe('Filter to this wing'),
      room: z.string().optional().describe('Filter to this room'),
      max_distance: z.number().optional().describe('Max cosine distance threshold'),
      mmr_lambda: z.number().min(0).max(1).optional().describe('MMR diversity trade-off: 1.0=pure relevance, 0.0=pure diversity (default 0.7)'),
      decay_halflife: z.number().min(0).optional().describe('Importance decay half-life in days (default 90). Set 0 to disable.'),
      federated: z.boolean().optional().describe('Search all wings regardless of wing filter. Results tagged with origin wing (default false).'),
      mode: z.enum(['full', 'pointer']).optional().describe('Response mode: "pointer" returns metadata only (no text body), "full" returns complete results (default "full")'),
    },
    async (input: { query: string; limit?: number; wing?: string; room?: string; max_distance?: number; mmr_lambda?: number; decay_halflife?: number; federated?: boolean; mode?: 'full' | 'pointer' }) => {
      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const searcher = new HybridSearcher(client, embedder)

      const response = await searcher.search({
        query: input.query,
        n_results: input.limit,
        wing: input.wing,
        room: input.room,
        max_distance: input.max_distance,
        mmr_lambda: input.mmr_lambda,
        decay_halflife: input.decay_halflife,
        federated: input.federated,
      })

      // Weak result hint: if best similarity is low, suggest room filtering
      const bestSim = Math.max(0, ...response.results.map(r => r.similarity))
      const isWeak = bestSim < 0.52 && !input.room

      const results = input.mode === 'pointer'
        ? response.results.map(r => ({
            id: r.drawer_index,
            wing: r.wing,
            room: r.room,
            source_file: r.source_file,
            similarity: r.similarity,
            importance: r.importance,
            filed_at: r.filed_at,
          }))
        : response.results

      const payload = { ...response, results }

      if (isWeak) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, room_hint: 'Results may be weak. Try: (1) call nardo_suggest_room with your query to find the best room, then re-run nardo_search with room= set; (2) call nardo_list_rooms to browse available rooms.' }, null, 2) }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
    },
  )

  // nardo_summarize
  server.tool(
    'nardo_summarize',
    'Summarize retrieved passages for a query',
    {
      query: z.string().describe('Topic or question to summarize'),
      limit: z.number().optional().describe('Number of passages to synthesize (default 8)'),
      wing: z.string().optional().describe('Filter to this wing'),
      room: z.string().optional().describe('Filter to this room'),
      max_distance: z.number().optional().describe('Max cosine distance threshold'),
    },
    async (input: { query: string; limit?: number; wing?: string; room?: string; max_distance?: number }) => {
      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const searcher = new HybridSearcher(client, embedder)

      const response = await searcher.search({
        query: input.query,
        n_results: input.limit ?? 8,
        wing: input.wing,
        room: input.room,
        max_distance: input.max_distance,
        mmr_lambda: 0.6,  // slightly more diverse than default for broader coverage
      })

      if (response.results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No relevant passages found for: "${input.query}"` }] }
      }

      // Build prose summary: passages ordered by relevance with source citations
      const lines: string[] = []
      lines.push(`## What I know about: "${response.query}"`)
      lines.push('')
      lines.push(`*${response.results.length} relevant passages from ${new Set(response.results.map(r => r.source_file)).size} sources*`)
      lines.push('')

      for (const result of response.results) {
        const source = result.source_file
          ? result.source_file.replace(/^.*\//, '')  // basename only
          : 'unknown'
        const loc = result.room ? `${source} / ${result.room}` : source
        lines.push(result.text.trim())
        lines.push(`  — *${loc}*`)
        lines.push('')
      }

      // Unique sources footer
      const sources = [...new Set(response.results.map(r => r.source_file).filter(Boolean))]
      if (sources.length > 0) {
        lines.push('---')
        lines.push(`**Sources:** ${sources.map(s => s.replace(/^.*\//, '')).join(', ')}`)
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    },
  )

  // nardo_search_batch
  server.tool(
    'nardo_search_batch',
    'Run and merge multiple semantic searches',
    {
      queries: z.array(z.string()).min(1).max(10).describe('Array of search queries (max 10)'),
      limit: z.number().optional().describe('Max results per query before merge (default 5)'),
      wing: z.string().optional().describe('Filter to this wing'),
      room: z.string().optional().describe('Filter to this room'),
      max_distance: z.number().optional().describe('Max cosine distance threshold'),
      mmr_lambda: z.number().min(0).max(1).optional().describe('MMR diversity trade-off (default 0.7)'),
    },
    async (input: { queries: string[]; limit?: number; wing?: string; room?: string; max_distance?: number; mmr_lambda?: number }) => {
      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const searcher = new HybridSearcher(client, embedder)

      // Run all queries in parallel
      const allResponses = await Promise.all(
        input.queries.map(q => searcher.search({
          query: q,
          n_results: input.limit ?? 5,
          wing: input.wing,
          room: input.room,
          max_distance: input.max_distance,
          mmr_lambda: input.mmr_lambda,
        }))
      )

      // Merge: deduplicate by source_file+chunk_index, keep best similarity
      const seen = new Map<string, { result: typeof allResponses[0]['results'][0]; score: number; matched_queries: string[] }>()

      for (let qi = 0; qi < allResponses.length; qi++) {
        const response = allResponses[qi]!
        const query = input.queries[qi]!
        for (const result of response.results) {
          const key = `${result.source_file}::${result.drawer_index}`
          const existing = seen.get(key)
          if (!existing || result.similarity > existing.score) {
            seen.set(key, {
              result,
              score: result.similarity,
              matched_queries: existing ? [...existing.matched_queries, query] : [query],
            })
          } else {
            existing.matched_queries.push(query)
          }
        }
      }

      const merged = [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ result, matched_queries }) => ({ ...result, matched_queries }))

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            queries: input.queries,
            filters: { wing: input.wing, room: input.room },
            total_results: merged.length,
            results: merged,
          }, null, 2),
        }],
      }
    },
  )

  // nardo_suggest_room
  server.tool(
    'nardo_suggest_room',
    'Suggest matching rooms for a text snippet within a wing',
    {
      text: z.string().describe('Text snippet to find the best room for'),
      wing: z.string().describe('Wing to search within'),
      limit: z.number().optional().describe('Number of room suggestions to return (default 3)'),
    },
    async (input: { text: string; wing: string; limit?: number }) => {
      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const searcher = new HybridSearcher(client, embedder)

      const k = input.limit ?? 3
      const response = await searcher.search({
        query: input.text,
        n_results: k * 3,  // over-fetch to get variety across rooms
        wing: input.wing,
        mmr_lambda: 0.3,   // diversity-leaning to surface different rooms
      })

      if (response.results.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ suggestions: [], wing: input.wing }) }] }
      }

      // Rank rooms by best similarity score among their results
      const roomScores = new Map<string, number>()
      for (const result of response.results) {
        const existing = roomScores.get(result.room) ?? 0
        if (result.similarity > existing) roomScores.set(result.room, result.similarity)
      }

      const suggestions = [...roomScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, k)
        .map(([room, score]) => ({ room, score: Math.round(score * 1000) / 1000 }))

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ wing: input.wing, suggestions }, null, 2),
        }],
      }
    },
  )
}
