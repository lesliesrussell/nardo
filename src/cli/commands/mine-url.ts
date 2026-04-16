// mine-url command — fetch a webpage and mine it into the palace
//
// Fetches the URL, strips HTML to plain text, chunks, embeds, and files.
// Wing defaults to the URL's hostname. source_file = url for dedup.
// Re-fetches on each call (no mtime — use source_file dedup to skip unchanged).
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { PalaceClient } from '../../palace/client.js'
import { addDrawer, fileAlreadyMined, deleteDrawersBySource } from '../../palace/drawers.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { chunkText } from '../../mining/chunker.js'
import { computeImportance } from '../../mining/importance.js'
import * as wal from '../../wal.js'

const MAX_CONTENT_SIZE = 10 * 1024 * 1024  // 10MB

function stripHtml(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Convert block elements to newlines
    .replace(/<\/?(p|div|h[1-6]|li|tr|br|article|section|header|footer|main|nav|aside)[^>]*>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function registerMineUrl(program: Command): void {
  program
    .command('mine-url <url>')
    .description('Fetch a webpage and mine it into the palace')
    .option('--palace <path>', 'Palace path override')
    .option('--wing <name>', 'Wing name (default: URL hostname)')
    .option('--room <name>', 'Room name (default: web)')
    .option('--force', 'Re-mine even if URL was already mined')
    .option('--dry-run', 'Show chunks without writing')
    .option('--quiet', 'Suppress output')
    .action(async (url: string, opts: {
      palace?: string
      wing?: string
      room?: string
      force?: boolean
      dryRun?: boolean
      quiet?: boolean
    }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const dry_run = opts.dryRun ?? false
      const quiet = opts.quiet ?? false
      const force = opts.force ?? false

      // Derive wing from hostname
      let hostname: string
      try {
        hostname = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        console.error(`Invalid URL: ${url}`)
        process.exit(1)
      }

      const wing = opts.wing ?? hostname
      const room = opts.room ?? 'web'
      const source_file = url

      const client = new PalaceClient(palace_path)

      // Dedup check (unless --force)
      if (!force && !dry_run) {
        const { mined } = await fileAlreadyMined(client, source_file)
        if (mined) {
          if (!quiet) console.log(`Already mined: ${url} (use --force to re-mine)`)
          return
        }
      }

      // Fetch
      if (!quiet) console.log(`Fetching: ${url}`)
      let html: string
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'nardo/1.0 (memory indexer)' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (buf.byteLength > MAX_CONTENT_SIZE) throw new Error(`Response too large (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB)`)
        html = new TextDecoder().decode(buf)
      } catch (err) {
        console.error(`Fetch failed: ${String(err)}`)
        process.exit(1)
      }

      const text = stripHtml(html)
      if (!quiet) console.log(`Extracted: ${text.length} chars`)

      const chunks = chunkText(text)
      if (chunks.length === 0) {
        if (!quiet) console.log('No content to mine.')
        return
      }

      if (dry_run) {
        if (!quiet) {
          console.log(`Would mine ${chunks.length} chunks into ${wing}/${room}`)
          for (const c of chunks.slice(0, 3)) console.log(`  [${c.index}] ${c.text.slice(0, 80)}…`)
        }
        return
      }

      // Delete old if re-mining
      if (force) {
        const { mined } = await fileAlreadyMined(client, source_file)
        if (mined) await deleteDrawersBySource(client, source_file)
      }

      const embedder = getEmbeddingPipeline()
      const texts = chunks.map(c => c.text)
      const embeddings = await embedder.embed(texts)
      const mtime = Date.now()

      let filed = 0
      for (let i = 0; i < chunks.length; i++) {
        const embedding = embeddings[i]
        if (!embedding) continue
        await addDrawer(client, embedding, chunks[i]!.text, {
          wing, room, source_file,
          source_mtime: mtime,
          chunk_index: chunks[i]!.index,
          normalize_version: 2,
          added_by: 'mine-url',
          filed_at: new Date().toISOString(),
          ingest_mode: 'project',
          importance: computeImportance(chunks[i]!.text),
          chunk_size: chunks[i]!.text.length,
        }, wal)
        filed++
      }

      if (!quiet) console.log(`Filed: ${filed} drawers → ${wing}/${room}`)
    })
}
