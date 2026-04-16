import { Database } from 'bun:sqlite'
import { CREATE_ENTITIES, CREATE_TRIPLES, CREATE_ATTRIBUTES, CREATE_INDEXES } from './ddl.ts'

export interface Entity {
  id: string
  name: string
  type: 'person' | 'project' | 'concept' | 'place' | 'unknown'
  properties: Record<string, unknown>
  created_at: string
}

export interface Triple {
  id: string
  subject: string
  predicate: string
  object: string
  valid_from: string | null
  valid_to: string | null
  confidence: number
  source_closet: string | null
  source_file: string | null
  extracted_at: string
}

function canonicalize(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_')
}

export class KnowledgeGraph {
  private db: Database

  constructor(db_path: string) {
    this.db = new Database(db_path, { create: true })
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(CREATE_ENTITIES)
    this.db.exec(CREATE_TRIPLES)
    this.db.exec(CREATE_ATTRIBUTES)
    for (const idx of CREATE_INDEXES) {
      this.db.exec(idx)
    }
  }

  addEntity(
    name: string,
    options?: {
      type?: 'person' | 'project' | 'concept' | 'place' | 'unknown'
      properties?: Record<string, unknown>
    },
  ): string {
    const id = canonicalize(name)
    const type = options?.type ?? 'unknown'
    const properties = JSON.stringify(options?.properties ?? {})

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)`,
    )
    stmt.run(id, name, type, properties)

    return id
  }

  upsertEntity(
    name: string,
    options?: {
      type?: 'person' | 'project' | 'concept' | 'place' | 'unknown'
      properties?: Record<string, unknown>
    },
  ): string {
    const id = canonicalize(name)
    const type = options?.type ?? 'unknown'
    const properties = JSON.stringify(options?.properties ?? {})

    const stmt = this.db.prepare(
      `INSERT INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         properties = excluded.properties`,
    )
    stmt.run(id, name, type, properties)

    return id
  }

  getEntity(name: string): Entity | null {
    const id = canonicalize(name)
    const stmt = this.db.prepare(`SELECT * FROM entities WHERE id = ?`)
    const row = stmt.get(id) as {
      id: string
      name: string
      type: string
      properties: string
      created_at: string
    } | null

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      type: row.type as Entity['type'],
      properties: JSON.parse(row.properties) as Record<string, unknown>,
      created_at: row.created_at,
    }
  }

  addTriple(
    subject: string,
    predicate: string,
    obj: string,
    options?: {
      valid_from?: string
      valid_to?: string
      confidence?: number
      source_closet?: string
      source_file?: string
    },
  ): string {
    const id = `t_${subject}_${predicate}_${obj}_${Date.now()}`
    const valid_from = options?.valid_from ?? null
    const valid_to = options?.valid_to ?? null
    const confidence = options?.confidence ?? 1.0
    const source_closet = options?.source_closet ?? null
    const source_file = options?.source_file ?? null

    const stmt = this.db.prepare(
      `INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    stmt.run(id, subject, predicate, obj, valid_from, valid_to, confidence, source_closet, source_file)

    return id
  }

  queryEntity(
    name: string,
    options?: {
      as_of?: string
      direction?: 'incoming' | 'outgoing' | 'both'
    },
  ): Array<Triple & { current: boolean }> {
    const id = canonicalize(name)
    const direction = options?.direction ?? 'both'
    const as_of = options?.as_of ?? null

    let whereClause = ''
    const params: (string | null)[] = []

    if (direction === 'outgoing') {
      whereClause = 'WHERE subject = ?'
      params.push(id)
    } else if (direction === 'incoming') {
      whereClause = 'WHERE object = ?'
      params.push(id)
    } else {
      whereClause = 'WHERE (subject = ? OR object = ?)'
      params.push(id, id)
    }

    if (as_of !== null) {
      whereClause += ` AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`
      params.push(as_of, as_of)
    }

    const stmt = this.db.prepare(`SELECT * FROM triples ${whereClause}`)
    const rows = stmt.all(...params) as Array<{
      id: string
      subject: string
      predicate: string
      object: string
      valid_from: string | null
      valid_to: string | null
      confidence: number
      source_closet: string | null
      source_file: string | null
      extracted_at: string
    }>

    return rows.map(row => ({
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_closet: row.source_closet,
      source_file: row.source_file,
      extracted_at: row.extracted_at,
      current: row.valid_to === null || row.valid_to > new Date().toISOString(),
    }))
  }

  invalidate(
    subject: string,
    predicate: string,
    obj: string,
    ended?: string,
  ): boolean {
    const valid_to = ended ?? new Date().toISOString()
    const stmt = this.db.prepare(
      `UPDATE triples SET valid_to = ? WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL`,
    )
    const result = stmt.run(valid_to, subject, predicate, obj)
    return result.changes > 0
  }

  close(): void {
    this.db.close()
  }
}
