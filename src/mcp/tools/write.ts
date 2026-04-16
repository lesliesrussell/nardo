// Write tools
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PalaceClient } from '../../palace/client.js'
import type { Collection } from '../../palace/client.js'
import { addDrawer, deleteDrawer } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import * as wal from '../../wal.js'

// Validation: alphanumeric + spaces + dots + apostrophes + hyphens, no path traversal
const SAFE_NAME_RE = /^[a-zA-Z0-9 .'_-]+$/

function validateName(value: string, field: string): string | null {
  if (value.length > 128) return `${field} exceeds 128 characters`
  if (value.includes('../') || value.includes('\\') || value.includes('\0')) {
    return `${field} contains invalid characters`
  }
  if (!SAFE_NAME_RE.test(value)) return `${field} contains invalid characters`
  return null
}

export function registerWriteTools(server: McpServer, palace_path: string): void {
  // nardo_add_drawer
  server.tool(
    'nardo_add_drawer',
    {
      wing: z.string().describe('Wing name'),
      room: z.string().describe('Room name'),
      content: z.string().describe('Drawer content (50-100000 chars)'),
      source: z.string().optional().describe('Source file or identifier'),
      importance: z.number().optional().describe('Importance score 0-1 (default 0.5)'),
    },
    async (input: {
      wing: string
      room: string
      content: string
      source?: string
      importance?: number
    }) => {
      // Validate wing and room
      const wingErr = validateName(input.wing, 'wing')
      if (wingErr) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: wingErr }) }] }
      }
      const roomErr = validateName(input.room, 'room')
      if (roomErr) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: roomErr }) }] }
      }
      // Validate content length
      if (input.content.length < 50 || input.content.length > 100000) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'content must be 50-100000 characters' }),
            },
          ],
        }
      }

      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const embeddings = await embedder.embed([input.content])
      const embedding = embeddings[0]
      if (!embedding) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'embedding failed' }) }],
        }
      }

      const now = new Date().toISOString()
      const metadata = {
        wing: input.wing,
        room: input.room,
        source_file: input.source ?? '',
        source_mtime: Date.now(),
        chunk_index: 0,
        normalize_version: 2,
        added_by: 'mcp',
        filed_at: now,
        ingest_mode: 'diary' as const,
        importance: input.importance ?? 0.5,
        chunk_size: input.content.length,
      }

      const drawer_id = await addDrawer(client, embedding, input.content, metadata, wal)

      const result = {
        drawer_id,
        wing: input.wing,
        room: input.room,
        content_preview: input.content.slice(0, 100),
        filed_at: now,
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // nardo_delete_drawer
  server.tool(
    'nardo_delete_drawer',
    {
      drawer_id: z.string().describe('Drawer ID to delete'),
    },
    async (input: { drawer_id: string }) => {
      const client = new PalaceClient(palace_path)

      // Get the drawer before deleting to know which collection it was in
      const collection = await client.getDrawersCollection()
      const existing = await (collection as Collection).get({ ids: [input.drawer_id], include: ['metadatas'] })

      const found = existing.ids.length > 0
      const removed_from =
        found && existing.metadatas[0]
          ? `${existing.metadatas[0]['wing']}/${existing.metadatas[0]['room']}`
          : null

      if (found) {
        await deleteDrawer(client, input.drawer_id, wal)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { deleted: found, drawer_id: input.drawer_id, removed_from },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
