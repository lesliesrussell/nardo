// diary command — quick journal entry with timestamped room, no chunking
//
// Usage:
//   nardo diary "Today I learned X"
//   echo "long text..." | nardo diary --stdin
//   nardo diary "meeting notes" --wing work --room meetings
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { computeImportance } from '../../mining/importance.js'
import { loadConfig } from '../../config.js'
import * as wal from '../../wal.js'

export function registerDiary(program: Command): void {
  program
    .command('diary [content]')
    .description(
      'Store a quick journal entry in the palace with today\'s date as the room.\n\n' +
      'Each entry is stored as a single drawer in the "diary" wing (no chunking).\n' +
      'Room defaults to the current date (YYYY-MM-DD) so entries are naturally\n' +
      'grouped by day. Use this for freeform notes, observations, or session logs.\n\n' +
      'Examples:\n' +
      '  nardo diary "Today I learned that X causes Y"\n' +
      '  echo "long meeting notes..." | nardo diary --stdin\n' +
      '  nardo diary "stand-up notes" --wing work --room meetings'
    )
    .option('--stdin', 'Read content from stdin rather than the positional argument (for piping)')
    .option('--wing <name>', 'Wing to file the entry under (default: diary)', 'diary')
    .option('--room <name>', 'Room within the wing (default: today\'s date YYYY-MM-DD)')
    .option('--importance <number>', 'Relevance score 0–2 used to surface this entry in wake-up context (default: auto-computed)')
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(
      async (
        contentArg: string | undefined,
        opts: {
          stdin?: boolean
          wing: string
          room?: string
          importance?: string
          palace?: string
        },
      ) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path

        // Read content: positional arg, --stdin, or interactive hint
        let content: string
        if (opts.stdin) {
          const chunks: string[] = []
          for await (const chunk of Bun.stdin.stream()) {
            chunks.push(new TextDecoder().decode(chunk))
          }
          content = chunks.join('').trim()
        } else if (contentArg) {
          content = contentArg.trim()
        } else {
          console.error('Error: provide content as an argument or use --stdin')
          console.error('  nardo diary "today I learned..."')
          console.error('  echo "text" | nardo diary --stdin')
          process.exit(1)
        }

        if (content.length < 1) {
          console.error('Error: content cannot be empty')
          process.exit(1)
        }

        // Default room = today's date
        const today = new Date().toISOString().slice(0, 10)
        const room = opts.room ?? today

        const importance = opts.importance !== undefined
          ? parseFloat(opts.importance)
          : computeImportance(content)

        try {
          const client = new PalaceClient(palace_path)
          const embedder = getEmbeddingPipeline()
          const embeddings = await embedder.embed([content])
          const embedding = embeddings[0]
          if (!embedding) {
            console.error('Error: embedding failed')
            process.exit(1)
          }

          const now = new Date().toISOString()
          const metadata = {
            wing: opts.wing,
            room,
            source_file: `diary:${room}`,
            source_mtime: Date.now(),
            chunk_index: 0,
            normalize_version: 2,
            added_by: 'cli:diary',
            filed_at: now,
            ingest_mode: 'diary' as const,
            importance,
            chunk_size: content.length,
          }

          const drawer_id = await addDrawer(client, embedding, content, metadata, wal)
          console.log(JSON.stringify({ drawer_id, wing: opts.wing, room, filed_at: now }, null, 2))
        } catch (err) {
          console.error(`Error: ${String(err)}`)
          process.exit(1)
        }
      },
    )
}
