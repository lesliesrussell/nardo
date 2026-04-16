import { PalaceClient } from '../palace/client.ts'
import { addDrawer } from '../palace/drawers.ts'
import { buildClosetLines, addClosets } from '../palace/closets.ts'
import { getEmbeddingPipeline } from '../embeddings/pipeline.ts'
import { normalizeConversation } from './normalizer.ts'
import * as wal from '../wal.ts'

export interface ConvoMineOptions {
  palace_path: string
  wing: string
  room: string
  agent?: string
  dry_run?: boolean
}

const MAX_CHUNK_SIZE = 800

function chunkExchange(userContent: string, assistantContent: string): string[] {
  const combined = `User: ${userContent}\n\nAssistant: ${assistantContent}`
  if (combined.length <= MAX_CHUNK_SIZE) {
    return [combined]
  }
  // Split into sub-chunks
  const chunks: string[] = []
  let start = 0
  while (start < combined.length) {
    chunks.push(combined.slice(start, start + MAX_CHUNK_SIZE))
    start += MAX_CHUNK_SIZE
  }
  return chunks
}

export async function mineConversation(
  filePath: string,
  opts: ConvoMineOptions,
): Promise<{ drawers: number }> {
  const agent = opts.agent ?? 'cli'
  const dry_run = opts.dry_run ?? false

  let raw: string
  try {
    raw = await Bun.file(filePath).text()
  } catch {
    return { drawers: 0 }
  }

  const filename = filePath.split('/').pop() ?? filePath
  const normalized = normalizeConversation(raw, filename)

  if (normalized.turns.length === 0) return { drawers: 0 }

  // Pair turns into exchanges: user + following assistant
  const textChunks: string[] = []
  const turns = normalized.turns

  let i = 0
  while (i < turns.length) {
    const turn = turns[i]
    if (!turn) { i++; continue }

    if (turn.role === 'user') {
      const next = turns[i + 1]
      if (next && next.role === 'assistant') {
        const chunks = chunkExchange(turn.content, next.content)
        textChunks.push(...chunks)
        i += 2
      } else {
        // Lone user turn
        if (turn.content.length >= 50) textChunks.push(`User: ${turn.content}`)
        i++
      }
    } else {
      // Lone assistant turn
      if (turn.content.length >= 50) textChunks.push(`Assistant: ${turn.content}`)
      i++
    }
  }

  if (textChunks.length === 0) return { drawers: 0 }

  if (dry_run) return { drawers: textChunks.length }

  const client = new PalaceClient(opts.palace_path)
  const embedder = getEmbeddingPipeline()

  const embeddings = await embedder.embed(textChunks)
  const now = new Date().toISOString()
  const drawer_ids: string[] = []

  for (let idx = 0; idx < textChunks.length; idx++) {
    const text = textChunks[idx]
    const embedding = embeddings[idx]
    if (!text || !embedding) continue

    const metadata = {
      wing: opts.wing,
      room: opts.room,
      source_file: filePath,
      source_mtime: Date.now(),
      chunk_index: idx,
      normalize_version: 2,
      added_by: agent,
      filed_at: now,
      ingest_mode: 'convo' as const,
      importance: 0.5,
      chunk_size: text.length,
    }

    const drawer_id = await addDrawer(client, embedding, text, metadata, wal)
    drawer_ids.push(drawer_id)
  }

  // Build closets from all text chunks joined
  const fullContent = textChunks.join('\n\n')
  const closetLines = buildClosetLines(fullContent, drawer_ids, opts.wing, opts.room)
  await addClosets(client, filePath, closetLines, opts.wing, opts.room)

  return { drawers: drawer_ids.length }
}
