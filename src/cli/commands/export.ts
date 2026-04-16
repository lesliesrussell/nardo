// export command — dump all drawers to JSONL on stdout
//
// Each line is a JSON object with all drawer metadata + base64-encoded embedding.
// Format is stable across palace versions: import reads the same fields.
//
// Usage: nardo export > backup.jsonl
//        nardo export --wing project > project.jsonl
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { PalaceClient } from '../../palace/client.js'
import type { Collection } from '../../palace/client.js'

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Export all drawers to JSONL (stdout)')
    .option('--palace <path>', 'Palace path override')
    .option('--wing <name>', 'Export only this wing')
    .option('--quiet', 'Suppress progress output to stderr')
    .action(async (opts: { palace?: string; wing?: string; quiet?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const quiet = opts.quiet ?? false

      const client = new PalaceClient(palace_path)
      const col = await client.getDrawersCollection() as Collection

      // Fetch all drawer records (metadata + documents)
      const whereFilter = opts.wing ? { wing: { '$eq': opts.wing } } : undefined
      const all = await col.get({
        ...(whereFilter ? { where: whereFilter } : {}),
        include: ['documents', 'metadatas'],
      })

      const ids = all.ids
      if (ids.length === 0) {
        if (!quiet) process.stderr.write('No drawers found.\n')
        return
      }

      if (!quiet) process.stderr.write(`Exporting ${ids.length} drawers...\n`)

      // Fetch embeddings in batches to avoid large memory spikes
      const BATCH = 200
      let exported = 0

      for (let start = 0; start < ids.length; start += BATCH) {
        const batchIds = ids.slice(start, start + BATCH)
        const embedMap = await col.getEmbeddings(batchIds)

        for (let i = 0; i < batchIds.length; i++) {
          const id = batchIds[i]!
          const document = all.documents[start + i] ?? ''
          const meta = all.metadatas[start + i] ?? {}
          const vec = embedMap.get(id)

          const embeddingB64 = vec
            ? Buffer.from(new Float32Array(vec).buffer).toString('base64')
            : null

          const record = {
            id,
            document,
            embedding: embeddingB64,
            wing: meta['wing'] ?? '',
            room: meta['room'] ?? '',
            source_file: meta['source_file'] ?? '',
            source_mtime: meta['source_mtime'] ?? 0,
            chunk_index: meta['chunk_index'] ?? 0,
            normalize_version: meta['normalize_version'] ?? 2,
            added_by: meta['added_by'] ?? '',
            filed_at: meta['filed_at'] ?? '',
            ingest_mode: meta['ingest_mode'] ?? 'project',
            importance: meta['importance'] ?? 0.5,
            chunk_size: meta['chunk_size'] ?? 0,
          }

          process.stdout.write(JSON.stringify(record) + '\n')
          exported++
        }
      }

      if (!quiet) process.stderr.write(`Exported ${exported} drawers.\n`)
    })
}
