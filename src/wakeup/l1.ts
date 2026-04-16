// L1 essential story
import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import type { DrawerMetadata } from '../palace/drawers.js'

export interface L1Options {
  palace_path: string
  wing?: string
  scan_limit?: number   // default 2000
  top_n?: number        // default 15
  token_budget?: number // default 800; stops adding items at budget, no mid-item cuts
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export async function generateL1(opts: L1Options): Promise<string> {
  const scan_limit = opts.scan_limit ?? 2000
  const top_n = opts.top_n ?? 15
  const token_budget = opts.token_budget ?? 800

  const client = new PalaceClient(opts.palace_path)
  const collection = await client.getDrawersCollection()
  const allResults = await (collection as Collection).get({ include: ['documents', 'metadatas'] })

  // Build sorted list of drawers with documents
  const metaWithDocs: Array<{ meta: DrawerMetadata; doc: string }> = []
  for (let i = 0; i < allResults.ids.length; i++) {
    const doc = allResults.documents[i]
    const raw = allResults.metadatas[i]
    if (!doc || !raw) continue
    if (opts.wing && raw['wing'] !== opts.wing) continue
    metaWithDocs.push({ doc, meta: raw as unknown as DrawerMetadata })
  }

  metaWithDocs.sort((a, b) => (b.meta.importance ?? 1.0) - (a.meta.importance ?? 1.0))
  const candidates = metaWithDocs.slice(0, Math.min(top_n, scan_limit))

  // Build output lines within token budget — no mid-item cuts
  const lines: string[] = []
  let tokens_used = 0

  for (const { meta, doc } of candidates) {
    const snippet = doc.slice(0, 200).replace(/\n/g, ' ')
    const source = meta.source_file ? meta.source_file.split('/').pop() ?? meta.source_file : ''
    const room = meta.room ?? 'general'
    const line = `[${room}] ${snippet} (${source})`
    const line_tokens = estimateTokens(line)
    if (tokens_used + line_tokens > token_budget) break
    lines.push(line)
    tokens_used += line_tokens
  }

  return lines.join('\n') + '\n[more in L3 search]'
}
