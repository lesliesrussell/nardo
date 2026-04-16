// Read tools
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PalaceClient } from '../../palace/client.js'
import { getAllDrawerMetadata } from '../../palace/drawers.js'
import { HybridSearcher } from '../../search/hybrid.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'

export function registerReadTools(server: McpServer, palace_path: string): void {
  // nardo_status
  server.tool('nardo_status', {}, async () => {
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
        'nardo Memory Protocol: Use nardo_search to retrieve memories before answering questions about past context.',
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  })

  // nardo_list_wings
  server.tool('nardo_list_wings', {}, async () => {
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
  server.tool('nardo_get_taxonomy', {}, async () => {
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
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default 5)'),
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
        n_results: input.limit,
        wing: input.wing,
        room: input.room,
        max_distance: input.max_distance,
      })

      return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
    },
  )
}
