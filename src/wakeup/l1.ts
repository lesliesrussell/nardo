// L1 essential story
import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import { getAllDrawerMetadata } from '../palace/drawers.js'
import type { DrawerMetadata } from '../palace/drawers.js'

export interface L1Options {
  palace_path: string
  wing?: string
  scan_limit?: number   // default 2000
  top_n?: number        // default 15
  max_chars?: number    // default 3200
}

export async function generateL1(opts: L1Options): Promise<string> {
  const scan_limit = opts.scan_limit ?? 2000
  const top_n = opts.top_n ?? 15
  const max_chars = opts.max_chars ?? 3200

  const client = new PalaceClient(opts.palace_path)
  let allMeta = await getAllDrawerMetadata(client)

  // Filter by wing if specified
  if (opts.wing) {
    allMeta = allMeta.filter(m => m.wing === opts.wing)
  }

  // Apply scan_limit
  allMeta = allMeta.slice(0, scan_limit)

  // Sort by importance desc (default 1.0)
  allMeta.sort((a, b) => (b.importance ?? 1.0) - (a.importance ?? 1.0))

  // Take top_n
  const top = allMeta.slice(0, top_n)

  // Group by room
  const byRoom = new Map<string, DrawerMetadata[]>()
  for (const m of top) {
    const room = m.room ?? 'general'
    const existing = byRoom.get(room) ?? []
    existing.push(m)
    byRoom.set(room, existing)
  }

  // We need drawer content (documents) — re-query for documents of these top entries
  // Since getAllDrawerMetadata doesn't return documents, we build lines from metadata only
  // The spec says: snippet = first 200 chars of each
  // We'll fetch the collection to get documents
  const collection = await client.getDrawersCollection()
  const allResults = await (collection as Collection).get({ include: ['documents', 'metadatas'] })

  // Build id→document map for fast lookup
  const docMap = new Map<string, string>()
  for (let i = 0; i < allResults.ids.length; i++) {
    const id = allResults.ids[i]
    const doc = allResults.documents[i]
    if (id && doc) docMap.set(id, doc)
  }

  // Build id→metadata map to correlate
  // We already have allMeta sorted; need to match by source_file+chunk_index
  // Actually let's rebuild from the raw results
  const metaWithDocs: Array<{ meta: DrawerMetadata; doc: string; id: string }> = []
  for (let i = 0; i < allResults.ids.length; i++) {
    const id = allResults.ids[i]
    const doc = allResults.documents[i]
    const raw = allResults.metadatas[i]
    if (!id || !doc || !raw) continue
    if (opts.wing && raw['wing'] !== opts.wing) continue
    metaWithDocs.push({
      id,
      doc,
      meta: raw as unknown as DrawerMetadata,
    })
  }

  // Sort by importance desc
  metaWithDocs.sort((a, b) => (b.meta.importance ?? 1.0) - (a.meta.importance ?? 1.0))
  const topWithDocs = metaWithDocs.slice(0, Math.min(top_n, scan_limit))

  // Group by room
  const byRoomWithDocs = new Map<string, Array<{ meta: DrawerMetadata; doc: string }>>()
  for (const item of topWithDocs) {
    const room = item.meta.room ?? 'general'
    const existing = byRoomWithDocs.get(room) ?? []
    existing.push({ meta: item.meta, doc: item.doc })
    byRoomWithDocs.set(room, existing)
  }

  // Format lines
  const lines: string[] = []
  for (const [room, items] of byRoomWithDocs) {
    for (const { meta, doc } of items) {
      const snippet = doc.slice(0, 200).replace(/\n/g, ' ')
      const source = meta.source_file ? meta.source_file.split('/').pop() ?? meta.source_file : ''
      lines.push(`[${room}] ${snippet} (${source})`)
    }
  }

  // Cap at max_chars
  let output = lines.join('\n')
  if (output.length > max_chars - 20) {
    output = output.slice(0, max_chars - 20)
    // Trim to last newline
    const lastNl = output.lastIndexOf('\n')
    if (lastNl > 0) output = output.slice(0, lastNl)
  }

  output += '\n[more in L3 search]'
  return output
}
