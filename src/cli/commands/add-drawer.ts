// add-drawer command — direct CLI access to addDrawer(), used by hooks
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { loadConfig } from '../../config.js'
import { computeImportance } from '../../mining/importance.js'
import * as wal from '../../wal.js'

export function registerAddDrawer(program: Command): void {
  program
    .command('add-drawer')
    .description(
      'Store a single text snippet directly into the palace as a drawer.\n\n' +
      'Embeds the content, assigns metadata, and writes the drawer to the\n' +
      'palace database. Primarily called by Claude Code hooks to persist\n' +
      'session context automatically, but also useful for scripted ingestion.\n\n' +
      'Examples:\n' +
      '  nardo add-drawer --content "learned X today" --wing sessions\n' +
      '  echo "long note..." | nardo add-drawer --content-stdin --wing notes --room 2025-01'
    )
    .option('--wing <wing>', 'Wing (namespace) to file the drawer under (default: sessions)', 'sessions')
    .option('--room <room>', 'Room within the wing — groups related drawers (default: today\'s date YYYY-MM-DD)')
    .option('--content <content>', 'Text content to store as the drawer body')
    .option('--content-stdin', 'Read content from stdin instead of --content (for piping long text)')
    .option('--source <source>', 'Source label recorded in metadata for provenance tracking (default: cli:add-drawer)', 'cli:add-drawer')
    .option('--importance <number>', 'Relevance score 0–2; higher = surfaces more in wake-up context (default: auto-computed from content)')
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(
      async (opts: {
        wing: string
        room?: string
        content?: string
        contentStdin?: boolean
        source: string
        importance?: string
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
            importance: opts.importance !== undefined ? parseFloat(opts.importance) : computeImportance(content),
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
