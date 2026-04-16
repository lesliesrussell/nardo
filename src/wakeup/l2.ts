// L2 on-demand retrieval
import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'

export interface L2Options {
  palace_path: string
  wing: string
  room?: string
  n_results?: number    // default 10
  max_chars?: number    // default 2000
}

function buildWhereFilter(wing: string, room?: string): Record<string, unknown> {
  if (room) {
    return { '$and': [{ wing: { '$eq': wing } }, { room: { '$eq': room } }] }
  }
  return { wing: { '$eq': wing } }
}

export async function retrieveL2(opts: L2Options): Promise<string> {
  const n_results = opts.n_results ?? 10
  const max_chars = opts.max_chars ?? 2000

  const client = new PalaceClient(opts.palace_path)
  const collection = await client.getDrawersCollection()

  const whereFilter = buildWhereFilter(opts.wing, opts.room)

  // Use get() with where filter (no query embedding needed — filtered metadata scan)
  const results = await (collection as Collection).get({
    where: whereFilter,
    limit: n_results,
    include: ['documents', 'metadatas'],
  })

  const lines: string[] = []
  for (let i = 0; i < results.ids.length; i++) {
    const doc = results.documents[i]
    const meta = results.metadatas[i]
    if (!doc || !meta) continue

    const wing = (meta['wing'] as string) ?? opts.wing
    const room = (meta['room'] as string) ?? (opts.room ?? 'general')
    const source_file = (meta['source_file'] as string) ?? ''
    const source = source_file.split('/').pop() ?? source_file
    const snippet = doc.slice(0, 200).replace(/\n/g, ' ')
    lines.push(`[${wing}/${room}] ${snippet} (${source})`)
  }

  let output = lines.join('\n')
  if (output.length > max_chars) {
    output = output.slice(0, max_chars)
    const lastNl = output.lastIndexOf('\n')
    if (lastNl > 0) output = output.slice(0, lastNl)
  }

  return output
}
