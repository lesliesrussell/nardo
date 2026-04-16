// Maintenance tools
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PalaceClient } from '../../palace/client.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'

export function registerMaintenanceTools(server: McpServer, palace_path: string): void {
  // nardo_reconnect
  server.tool('nardo_reconnect', 'Reconnect palace handles and clear cached clients', {}, async () => {
    const client = new PalaceClient(palace_path)
    client.invalidateCache()

    const result = { reconnected: true, palace_path }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
  })

  // nardo_check_duplicate
  server.tool(
    'nardo_check_duplicate',
    'Check whether content is a near-duplicate of an existing drawer',
    {
      content: z.string().describe('Content to check for duplicates'),
      wing: z.string().optional().describe('Limit search to this wing'),
      threshold: z.number().optional().describe('Distance threshold (default 0.15)'),
    },
    async (input: { content: string; wing?: string; threshold?: number }) => {
      const threshold = input.threshold ?? 0.15

      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const embeddings = await embedder.embed([input.content])
      const embedding = embeddings[0]
      if (!embedding) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'embedding failed' }),
            },
          ],
        }
      }

      const collection = await client.getDrawersCollection()

      const queryArgs: {
        queryEmbeddings: number[][]
        nResults: number
        include: string[]
        where?: Record<string, unknown>
      } = {
        queryEmbeddings: [embedding],
        nResults: 1,
        include: ['documents', 'metadatas', 'distances'],
      }

      if (input.wing) {
        queryArgs.where = { wing: { $eq: input.wing } }
      }

      const results = await collection.query(queryArgs)

      const distances = results.distances[0] ?? []
      const docs = results.documents[0] ?? []
      const metas = results.metadatas[0] ?? []
      const ids = results.ids[0] ?? []

      if (distances.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ is_duplicate: false }) },
          ],
        }
      }

      const closest_distance = distances[0] ?? 2
      const is_duplicate = closest_distance <= threshold

      const result: Record<string, unknown> = { is_duplicate }
      if (is_duplicate) {
        result.closest_match = {
          drawer_id: ids[0],
          distance: closest_distance,
          preview: (docs[0] ?? '').slice(0, 200),
          wing: metas[0]?.['wing'],
          room: metas[0]?.['room'],
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )
}
