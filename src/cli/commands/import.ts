// import command — load drawers from a JSONL backup file
//
// Deduplicates by SHA-256 of document text: if identical content already exists
// in the palace, the record is skipped. Original IDs are preserved when possible;
// if a different drawer already uses the same ID, a new UUID is generated.
//
// Usage: nardo import backup.jsonl
//        nardo import backup.jsonl --dry-run
import type { Command } from 'commander'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { loadConfig } from '../../config.js'
import { PalaceClient } from '../../palace/client.js'
import type { Collection } from '../../palace/client.js'
import * as wal from '../../wal.js'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function decodeEmbedding(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64')
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return Array.from(floats)
}

export function registerImport(program: Command): void {
  program
    .command('import <file>')
    .description('Load drawers from a JSONL backup file into the palace')
    .addHelpText('after', `
Details:
  Reads each line of a file produced by "nardo export", deduplicates by SHA-256
  of the document text (identical content already in the palace is skipped),
  preserves original drawer IDs when possible, and re-uses stored embeddings so
  no re-embedding is needed. Pass "-" as the file argument to read from stdin.

Examples:
  nardo import backup.jsonl
  nardo import backup.jsonl --dry-run   # preview without writing
  cat backup.jsonl | nardo import -
`)
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .option('--dry-run', 'Count how many drawers would be imported without writing any')
    .option('--quiet', 'Suppress per-line progress; print a single JSON summary line instead')
    .action(async (file: string, opts: { palace?: string; dryRun?: boolean; quiet?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const dry_run = opts.dryRun ?? false
      const quiet = opts.quiet ?? false

      const client = new PalaceClient(palace_path)
      const col = await client.getDrawersCollection() as Collection

      // Build set of existing content hashes for dedup
      if (!quiet) process.stderr.write('Loading existing drawers for dedup check...\n')
      const existing = await col.get({ include: ['documents'] })
      const existingHashes = new Set(existing.documents.map(d => sha256(d ?? '')))
      const existingIds = new Set(existing.ids)

      let imported = 0, skipped = 0, errors = 0
      let lineNum = 0

      const stream = file === '-'
        ? process.stdin
        : createReadStream(file, { encoding: 'utf-8' })

      const rl = createInterface({ input: stream, crlfDelay: Infinity })

      for await (const line of rl) {
        lineNum++
        const trimmed = line.trim()
        if (!trimmed) continue

        let record: Record<string, unknown>
        try {
          record = JSON.parse(trimmed)
        } catch {
          if (!quiet) process.stderr.write(`[!] Line ${lineNum}: invalid JSON, skipping\n`)
          errors++
          continue
        }

        const document = (record['document'] as string) ?? ''
        if (!document) { skipped++; continue }

        // Content-based dedup
        const hash = sha256(document)
        if (existingHashes.has(hash)) {
          skipped++
          continue
        }

        if (dry_run) {
          if (!quiet) process.stderr.write(`[dry] would import: ${document.slice(0, 60)}...\n`)
          imported++
          continue
        }

        // Decode embedding
        const embB64 = record['embedding'] as string | null
        if (!embB64) {
          if (!quiet) process.stderr.write(`[!] Line ${lineNum}: no embedding, skipping\n`)
          skipped++
          continue
        }

        let embedding: number[]
        try {
          embedding = decodeEmbedding(embB64)
        } catch {
          if (!quiet) process.stderr.write(`[!] Line ${lineNum}: bad embedding, skipping\n`)
          errors++
          continue
        }

        // Preserve original ID unless it conflicts
        const originalId = record['id'] as string | undefined
        const drawer_id = originalId && !existingIds.has(originalId) ? originalId : randomUUID()

        const metadata = {
          wing: (record['wing'] as string) ?? '',
          room: (record['room'] as string) ?? '',
          source_file: (record['source_file'] as string) ?? '',
          source_mtime: (record['source_mtime'] as number) ?? 0,
          chunk_index: (record['chunk_index'] as number) ?? 0,
          normalize_version: (record['normalize_version'] as number) ?? 2,
          added_by: (record['added_by'] as string) ?? 'import',
          filed_at: (record['filed_at'] as string) ?? new Date().toISOString(),
          ingest_mode: ((record['ingest_mode'] as string) ?? 'project') as 'project' | 'convo' | 'diary' | 'registry',
          importance: (record['importance'] as number) ?? 0.5,
          chunk_size: (record['chunk_size'] as number) ?? document.length,
        }

        try {
          await col.add({
            ids: [drawer_id],
            embeddings: [embedding],
            documents: [document],
            metadatas: [metadata as unknown as Record<string, unknown>],
          })
          await wal.logWrite('import_drawer', { drawer_id, ...metadata }, { drawer_id })

          existingHashes.add(hash)
          existingIds.add(drawer_id)
          imported++
        } catch (err) {
          if (!quiet) process.stderr.write(`[!] Line ${lineNum}: insert failed: ${String(err)}\n`)
          errors++
        }
      }

      if (!quiet) {
        process.stderr.write(`\nImport complete:\n`)
        process.stderr.write(`  imported: ${imported}\n`)
        process.stderr.write(`  skipped (duplicate): ${skipped}\n`)
        process.stderr.write(`  errors: ${errors}\n`)
      } else {
        process.stdout.write(JSON.stringify({ imported, skipped, errors }) + '\n')
      }
    })
}
