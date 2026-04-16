// KG tools
import { z } from 'zod'
import { join } from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { KnowledgeGraph } from '../../kg/graph.js'

function getKgPath(palace_path: string): string {
  return join(palace_path, 'kg.db')
}

export function registerKgTools(server: McpServer, palace_path: string): void {
  // nardo_kg_query
  server.tool(
    'nardo_kg_query',
    {
      entity_name: z.string().describe('Entity name to query'),
      as_of: z.string().optional().describe('ISO timestamp for temporal query'),
      direction: z
        .enum(['incoming', 'outgoing', 'both'])
        .optional()
        .describe('Relationship direction'),
    },
    async (input: { entity_name: string; as_of?: string; direction?: 'incoming' | 'outgoing' | 'both' }) => {
      const kg = new KnowledgeGraph(getKgPath(palace_path))
      try {
        const entity = kg.getEntity(input.entity_name)
        const relationships = kg.queryEntity(input.entity_name, {
          as_of: input.as_of,
          direction: input.direction,
        })

        const result = { entity, relationships }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } finally {
        kg.close()
      }
    },
  )

  // nardo_kg_add
  server.tool(
    'nardo_kg_add',
    {
      subject: z.string().describe('Subject entity'),
      predicate: z.string().describe('Relationship predicate'),
      object: z.string().describe('Object entity'),
      valid_from: z.string().optional().describe('ISO timestamp valid from'),
      valid_to: z.string().optional().describe('ISO timestamp valid to'),
      confidence: z.number().optional().describe('Confidence 0-1 (default 1.0)'),
    },
    async (input: {
      subject: string
      predicate: string
      object: string
      valid_from?: string
      valid_to?: string
      confidence?: number
    }) => {
      const kg = new KnowledgeGraph(getKgPath(palace_path))
      try {
        // Ensure entities exist
        kg.addEntity(input.subject)
        kg.addEntity(input.object)

        const triple_id = kg.addTriple(input.subject, input.predicate, input.object, {
          valid_from: input.valid_from,
          valid_to: input.valid_to,
          confidence: input.confidence,
        })

        const result = { triple_id, created: new Date().toISOString() }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } finally {
        kg.close()
      }
    },
  )

  // nardo_kg_invalidate
  server.tool(
    'nardo_kg_invalidate',
    {
      subject: z.string().describe('Subject entity'),
      predicate: z.string().describe('Relationship predicate'),
      object: z.string().describe('Object entity'),
      ended: z.string().optional().describe('ISO timestamp when relationship ended'),
    },
    async (input: { subject: string; predicate: string; object: string; ended?: string }) => {
      const kg = new KnowledgeGraph(getKgPath(palace_path))
      try {
        const valid_to = input.ended ?? new Date().toISOString()
        const invalidated = kg.invalidate(input.subject, input.predicate, input.object, valid_to)

        const result = { invalidated, valid_to }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } finally {
        kg.close()
      }
    },
  )
}
