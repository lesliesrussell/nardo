// L3 deep search
import { PalaceClient } from '../palace/client.js'
import { HybridSearcher } from '../search/hybrid.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'

export interface L3Options {
  palace_path: string
  query: string
  wing?: string
  room?: string
  n_results?: number    // default 5
}

export async function searchL3(opts: L3Options): Promise<string> {
  const n_results = opts.n_results ?? 5

  const client = new PalaceClient(opts.palace_path)
  const embedder = getEmbeddingPipeline()
  const searcher = new HybridSearcher(client, embedder)

  const response = await searcher.search({
    query: opts.query,
    n_results,
    wing: opts.wing,
    room: opts.room,
  })

  const lines: string[] = []
  for (const result of response.results) {
    const wing = result.wing ?? ''
    const room = result.room ?? ''
    const source = result.source_file ? result.source_file.split('/').pop() ?? result.source_file : ''
    const snippet = result.text.slice(0, 300).replace(/\n/g, ' ')
    const score = result.similarity.toFixed(2)
    lines.push(`[${wing}/${room}] ${snippet}\nSource: ${source} | Score: ${score}\n`)
  }

  return lines.join('\n')
}
