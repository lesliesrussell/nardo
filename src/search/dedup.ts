// Deduplication — greedy source-level dedup using cosine distance
import { PalaceClient } from '../palace/client.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'

export interface DedupOptions {
  palace_path: string
  threshold?: number   // cosine distance, default 0.15
  wing?: string        // scope to one wing
  source?: string      // filter by source_file pattern
  dry_run?: boolean
}

export interface DedupResult {
  scanned: number
  duplicates: number
  deleted: number
  groups: Array<{ kept: string; removed: string[] }>
}

type RawCollection = {
  get: (opts: Record<string, unknown>) => Promise<{
    ids: string[]
    documents: (string | null)[]
    metadatas: (Record<string, unknown> | null)[]
  }>
  query: (opts: {
    queryEmbeddings: number[][]
    n_results: number
    include: string[]
    where?: Record<string, unknown>
  }) => Promise<{
    ids: string[][]
    distances: number[][]
  }>
  delete: (opts: { ids: string[] }) => Promise<void>
}

export async function dedupPalace(opts: DedupOptions): Promise<DedupResult> {
  const threshold = opts.threshold ?? 0.15
  const dry_run = opts.dry_run ?? false

  const client = new PalaceClient(opts.palace_path)
  const collection = await client.getDrawersCollection() as unknown as RawCollection

  // Fetch all drawers with documents and metadata
  const getOpts: Record<string, unknown> = {
    include: ['documents', 'metadatas'],
  }
  if (opts.wing) {
    getOpts.where = { wing: { $eq: opts.wing } }
  }

  const all = await collection.get(getOpts)

  const ids = all.ids
  const documents = all.documents
  const metadatas = all.metadatas

  // Group by source_file, applying source pattern filter if given
  const bySource = new Map<string, Array<{ id: string; text: string; chunk_size: number }>>()

  for (let i = 0; i < ids.length; i++) {
    const meta = metadatas[i]
    if (!meta) continue
    const source_file = (meta['source_file'] as string) ?? ''
    if (opts.source && !source_file.includes(opts.source)) continue

    const text = documents[i] ?? ''
    const chunk_size = typeof meta['chunk_size'] === 'number'
      ? (meta['chunk_size'] as number)
      : text.length

    const entry = { id: ids[i], text, chunk_size }
    const group = bySource.get(source_file)
    if (group) {
      group.push(entry)
    } else {
      bySource.set(source_file, [entry])
    }
  }

  const result: DedupResult = {
    scanned: ids.length,
    duplicates: 0,
    deleted: 0,
    groups: [],
  }

  const pipeline = getEmbeddingPipeline()

  for (const [_source_file, group] of bySource) {
    // Only process groups with 5+ drawers per spec
    if (group.length < 5) continue

    // Sort by chunk_size desc (longest first)
    group.sort((a, b) => b.chunk_size - a.chunk_size)

    const kept: Array<{ id: string; text: string }> = []
    const toDelete: string[] = []

    for (const drawer of group) {
      if (kept.length === 0) {
        kept.push({ id: drawer.id, text: drawer.text })
        continue
      }

      // Query the collection with this drawer's text, n_results = len(kept)
      // Check if any result that matches a kept ID has distance < threshold
      let isDuplicate = false
      try {
        const [emb] = await pipeline.embed([drawer.text])
        const queryResult = await collection.query({
          queryEmbeddings: [emb!],
          n_results: kept.length,
          include: ['distances'],
        })

        const returnedIds = queryResult.ids[0] ?? []
        const distances = queryResult.distances[0] ?? []
        const keptIds = new Set(kept.map(k => k.id))

        for (let i = 0; i < returnedIds.length; i++) {
          if (keptIds.has(returnedIds[i]) && (distances[i] ?? 2) < threshold) {
            isDuplicate = true
            break
          }
        }
      } catch {
        // Be conservative on query failure — keep the drawer
        kept.push({ id: drawer.id, text: drawer.text })
        continue
      }

      if (isDuplicate) {
        toDelete.push(drawer.id)
        result.duplicates++
      } else {
        kept.push({ id: drawer.id, text: drawer.text })
      }
    }

    if (toDelete.length > 0) {
      result.groups.push({ kept: kept[0].id, removed: toDelete })

      if (!dry_run) {
        await collection.delete({ ids: toDelete })
        result.deleted += toDelete.length
      }
    }
  }

  return result
}
