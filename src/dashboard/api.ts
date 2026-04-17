// Dashboard API handlers — query the palace and return JSON
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openPalaceDB } from '../palace/client.js'
import { PalaceClient } from '../palace/client.js'
import { HybridSearcher } from '../search/hybrid.js'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'
import { KnowledgeGraph } from '../kg/graph.js'
import { loadConfig } from '../config.js'

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export async function handleStats(palace_path: string): Promise<unknown> {
  try {
    const config = loadConfig()
    const db = await openPalaceDB(palace_path, config.palace.backend)
    const totalDrawers = (await db.get<{ n: number }>('SELECT COUNT(*) as n FROM drawers'))?.n ?? 0
    const wingsCount = (await db.get<{ n: number }>('SELECT COUNT(DISTINCT wing) as n FROM drawers'))?.n ?? 0
    const roomsCount = (await db.get<{ n: number }>('SELECT COUNT(DISTINCT room) as n FROM drawers'))?.n ?? 0
    await db.close()

    const sqlitePath = join(palace_path, 'palace.sqlite3')
    const sizes = [
      fileSize(sqlitePath),
      fileSize(sqlitePath + '-shm'),
      fileSize(sqlitePath + '-wal'),
      fileSize(join(palace_path, 'drawers.hnsw')),
      fileSize(join(palace_path, 'closets.hnsw')),
      fileSize(join(palace_path, 'kg.db')),
    ]
    const totalBytes = sizes.reduce((a, b) => a + b, 0)

    return {
      total_drawers: totalDrawers,
      wings_count: wingsCount,
      rooms_count: roomsCount,
      palace_path,
      palace_size: fmtBytes(totalBytes),
      palace_size_bytes: totalBytes,
    }
  } catch {
    return {
      total_drawers: 0,
      wings_count: 0,
      rooms_count: 0,
      palace_path,
      palace_size: '0 B',
      palace_size_bytes: 0,
    }
  }
}

export async function handleWings(palace_path: string): Promise<unknown> {
  try {
    const config = loadConfig()
    const db = await openPalaceDB(palace_path, config.palace.backend)
    const rows = await db.all<{ wing: string; n: number }>(
      'SELECT wing, COUNT(*) as n FROM drawers GROUP BY wing ORDER BY n DESC',
    )
    await db.close()
    return { wings: rows.map(r => ({ name: r.wing, count: r.n })) }
  } catch {
    return { wings: [] }
  }
}

export async function handleRooms(palace_path: string, wing?: string): Promise<unknown> {
  try {
    const config = loadConfig()
    const db = await openPalaceDB(palace_path, config.palace.backend)
    let rows: Array<{ wing: string; room: string; n: number }>
    if (wing) {
      rows = await db.all<{ wing: string; room: string; n: number }>(
        'SELECT wing, room, COUNT(*) as n FROM drawers WHERE wing = ? GROUP BY wing, room ORDER BY n DESC',
        [wing],
      )
    } else {
      rows = await db.all<{ wing: string; room: string; n: number }>(
        'SELECT wing, room, COUNT(*) as n FROM drawers GROUP BY wing, room ORDER BY n DESC',
      )
    }
    await db.close()
    return { rooms: rows.map(r => ({ wing: r.wing, room: r.room, count: r.n })) }
  } catch {
    return { rooms: [] }
  }
}

export async function handleSearch(
  palace_path: string,
  query: string,
  wing?: string,
  room?: string,
  limit = 10,
): Promise<unknown> {
  if (!query.trim()) return { results: [], query: '' }
  try {
    const client = new PalaceClient(palace_path)
    const embedder = getEmbeddingPipeline()
    const searcher = new HybridSearcher(client, embedder)
    const response = await searcher.search({ query, n_results: limit, wing, room })
    return {
      query: response.query,
      total_before_filter: response.total_before_filter,
      results: response.results.map(r => ({
        text: r.text,
        wing: r.wing,
        room: r.room,
        source_file: r.source_file,
        similarity: r.similarity,
        distance: r.distance,
        matched_via: r.matched_via,
        filed_at: r.filed_at,
      })),
    }
  } catch {
    return { results: [], query, error: 'Search failed' }
  }
}

export async function handleKgGraph(palace_path: string, wing?: string): Promise<unknown> {
  const kgPath = join(palace_path, 'kg.db')
  if (!existsSync(kgPath)) return { nodes: [], edges: [] }
  try {
    const kg = new KnowledgeGraph(kgPath)
    // Query all triples — use a raw approach via the KG's internal patterns
    // We'll get entities that appear in the triples by querying all known entity names
    // Since KnowledgeGraph doesn't expose a listAll, we query the DB directly
    // The KG class wraps bun:sqlite so we open it separately for the graph dump
    const { Database } = await import('bun:sqlite')
    const db = new Database(kgPath, { readonly: true })

    let tripleQuery = 'SELECT subject, predicate, object, valid_to, confidence FROM triples'
    const params: string[] = []
    // No direct wing filter in KG, but we can apply it if needed — skip for now
    const triples = db.query<{
      subject: string; predicate: string; object: string
      valid_to: string | null; confidence: number
    }, string[]>(tripleQuery).all(...params)

    const entitySet = new Set<string>()
    for (const t of triples) {
      entitySet.add(t.subject)
      entitySet.add(t.object)
    }

    const entityRows = db.query<{ id: string; name: string; type: string }, string[]>(
      `SELECT id, name, type FROM entities WHERE id IN (${[...entitySet].map(() => '?').join(',')})`,
    ).all(...[...entitySet])

    db.close()
    kg.close()

    const now = new Date().toISOString()
    return {
      nodes: entityRows.map(e => ({ id: e.id, label: e.name, type: e.type })),
      edges: triples.map((t, i) => ({
        id: `e${i}`,
        source: t.subject,
        target: t.object,
        label: t.predicate,
        current: t.valid_to === null || t.valid_to > now,
        confidence: t.confidence,
      })),
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

export async function handleRecentDrawers(palace_path: string, limit = 20, wing?: string): Promise<unknown> {
  try {
    const config = loadConfig()
    const db = await openPalaceDB(palace_path, config.palace.backend)
    const rows = await db.all<{
      id: string; document: string; wing: string; room: string
      filed_at: string; source_file: string; importance: number
    }>(
      wing
        ? `SELECT id, document, wing, room, filed_at, source_file, importance FROM drawers WHERE wing = ? ORDER BY filed_at DESC LIMIT ?`
        : `SELECT id, document, wing, room, filed_at, source_file, importance FROM drawers ORDER BY filed_at DESC LIMIT ?`,
      wing ? [wing, limit] : [limit],
    )
    await db.close()
    return {
      drawers: rows.map(r => ({
        id: r.id,
        text: r.document,
        wing: r.wing,
        room: r.room,
        filed_at: r.filed_at,
        source_file: r.source_file,
        importance: r.importance,
      })),
    }
  } catch {
    return { drawers: [] }
  }
}
