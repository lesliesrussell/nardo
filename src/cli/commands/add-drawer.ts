// add-drawer command — direct CLI access to addDrawer(), used by hooks
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { loadConfig } from '../../config.js'
import * as wal from '../../wal.js'

export function registerAddDrawer(program: Command): void {
  program
    .command('add-drawer')
    .description('File a drawer directly into the palace (used by hooks)')
    .option('--wing <wing>', 'Wing name', 'sessions')
    .option('--room <room>', 'Room name')
    .option('--content <content>', 'Content to store')
    .option('--content-stdin', 'Read content from stdin instead of --content')
    .option('--source <source>', 'Source identifier', 'cli:add-drawer')
    .option('--importance <number>', 'Importance score (0-2)', '1.0')
    .option('--palace <path>', 'Palace path override')
    .action(
      async (opts: {
        wing: string
        room?: string
        content?: string
        contentStdin?: boolean
        source: string
        importance: string
        palace?: string
      }) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path

        let content: string
        if (opts.contentStdin) {
          const chunks: string[] = []
          for await (const chunk of Bun.stdin.stream()) {
            chunks.push(new TextDecoder().decode(chunk))
          }
          content = chunks.join('')
        } else {
          content = opts.content ?? ''
        }
        if (!content || content.length < 1) {
          console.error(JSON.stringify({ error: 'content is required' }))
          process.exit(1)
        }

        const room = opts.room ?? new Date().toISOString().slice(0, 10)

        try {
          const client = new PalaceClient(palace_path)
          const embedder = getEmbeddingPipeline()
          const embeddings = await embedder.embed([content])
          const embedding = embeddings[0]
          if (!embedding) {
            console.error(JSON.stringify({ error: 'embedding failed' }))
            process.exit(1)
          }

          const now = new Date().toISOString()
          const metadata = {
            wing: opts.wing,
            room,
            source_file: opts.source,
            source_mtime: Date.now(),
            chunk_index: 0,
            normalize_version: 2,
            added_by: 'cli:add-drawer',
            filed_at: now,
            ingest_mode: 'diary' as const,
            importance: parseFloat(opts.importance),
            chunk_size: content.length,
          }

          const drawer_id = await addDrawer(client, embedding, content, metadata, wal)
          console.log(JSON.stringify({ drawer_id, filed_at: now }))
        } catch (err) {
          console.error(JSON.stringify({ error: String(err) }))
          process.exit(1)
        }
      },
    )
}
