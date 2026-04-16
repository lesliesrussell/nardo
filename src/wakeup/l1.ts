// L1 essential story
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PalaceClient } from '../palace/client.js'
import type { Collection } from '../palace/client.js'
import type { DrawerMetadata } from '../palace/drawers.js'

export interface L1Options {
  palace_path: string
  wing?: string
  scan_limit?: number   // default 2000
  top_n?: number        // default 15
  token_budget?: number // default 800; stops adding items at budget, no mid-item cuts
}

interface L1Cache {
  hash: string
  output: string
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function computeHash(candidates: Array<{ meta: DrawerMetadata; doc: string }>): string {
  const fingerprint = candidates
    .map(c => `${c.meta.source_file}:${c.meta.chunk_index}:${c.meta.importance ?? 1.0}`)
    .join('|')
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

function readCache(cache_path: string): L1Cache | null {
  try {
    return JSON.parse(readFileSync(cache_path, 'utf8')) as L1Cache
  } catch {
    return null
  }
}

function writeCache(cache_path: string, cache: L1Cache): void {
  try {
    writeFileSync(cache_path, JSON.stringify(cache))
  } catch {
    // cache write failure is non-fatal
  }
}

export async function generateL1(opts: L1Options): Promise<string> {
  const scan_limit = opts.scan_limit ?? 2000
  const top_n = opts.top_n ?? 15
  const token_budget = opts.token_budget ?? 800

  const client = new PalaceClient(opts.palace_path)
  const collection = await client.getDrawersCollection()
  const allResults = await (collection as Collection).get({ include: ['documents', 'metadatas'] })

  // Build sorted list of drawers with documents
  const metaWithDocs: Array<{ meta: DrawerMetadata; doc: string }> = []
  for (let i = 0; i < allResults.ids.length; i++) {
    const doc = allResults.documents[i]
    const raw = allResults.metadatas[i]
    if (!doc || !raw) continue
    if (opts.wing && raw['wing'] !== opts.wing) continue
    metaWithDocs.push({ doc, meta: raw as unknown as DrawerMetadata })
  }

  metaWithDocs.sort((a, b) => (b.meta.importance ?? 1.0) - (a.meta.importance ?? 1.0))
  const candidates = metaWithDocs.slice(0, Math.min(top_n, scan_limit))

  // Check content-addressed cache
  const cache_path = join(opts.palace_path, 'l1_cache.json')
  const hash = computeHash(candidates)
  const cached = readCache(cache_path)
  if (cached?.hash === hash) return cached.output

  // Build output lines within token budget — no mid-item cuts
  const lines: string[] = []
  let tokens_used = 0

  for (const { meta, doc } of candidates) {
    const snippet = doc.slice(0, 200).replace(/\n/g, ' ')
    const source = meta.source_file ? meta.source_file.split('/').pop() ?? meta.source_file : ''
    const room = meta.room ?? 'general'
    const line = `[${room}] ${snippet} (${source})`
    const line_tokens = estimateTokens(line)
    if (tokens_used + line_tokens > token_budget) break
    lines.push(line)
    tokens_used += line_tokens
  }

  const output = lines.join('\n') + '\n[more in L3 search]'
  writeCache(cache_path, { hash, output })
  return output
}
