import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'

export type SQLValue = string | number | boolean | null | bigint | Uint8Array
export type SQLBindings = SQLValue[]

export const DOLT_DDL = `
CREATE TABLE IF NOT EXISTS drawers (
  id VARCHAR(191) PRIMARY KEY,
  document LONGTEXT NOT NULL,
  label BIGINT UNIQUE,
  wing VARCHAR(191) NOT NULL,
  room VARCHAR(191) NOT NULL,
  source_file LONGTEXT NOT NULL,
  source_mtime DOUBLE NOT NULL,
  chunk_index BIGINT NOT NULL,
  normalize_version BIGINT DEFAULT 2,
  added_by VARCHAR(191) DEFAULT 'cli',
  filed_at VARCHAR(191) NOT NULL,
  ingest_mode VARCHAR(191) DEFAULT 'project',
  importance DOUBLE DEFAULT 1.0,
  chunk_size BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS closets (
  id VARCHAR(191) PRIMARY KEY,
  document LONGTEXT NOT NULL,
  label BIGINT UNIQUE,
  source_file LONGTEXT NOT NULL,
  wing VARCHAR(191) NOT NULL,
  room VARCHAR(191) NOT NULL
);

CREATE TABLE IF NOT EXISTS label_seq (
  collection VARCHAR(191) PRIMARY KEY,
  next_label BIGINT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS drawers_wing_idx ON drawers(wing);
CREATE INDEX IF NOT EXISTS drawers_room_idx ON drawers(room);
CREATE INDEX IF NOT EXISTS drawers_source_idx ON drawers(source_file(255));
CREATE INDEX IF NOT EXISTS closets_source_idx ON closets(source_file(255));
`

interface DoltExecOptions {
  input?: string
  allowFailure?: boolean
}

interface SqliteDrawerRow {
  id: string
  document: string
  label: number | null
  wing: string
  room: string
  source_file: string
  source_mtime: number
  chunk_index: number
  normalize_version: number
  added_by: string
  filed_at: string
  ingest_mode: string
  importance: number
  chunk_size: number
}

interface SqliteClosetRow {
  id: string
  document: string
  label: number | null
  source_file: string
  wing: string
  room: string
}

export interface DoltMigrationResult {
  drawers: number
  closets: number
  archived_sqlite: boolean
}

export function escapeSqlValue(value: SQLValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString('hex')}'`
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export function interpolateSql(sql: string, params: SQLBindings = []): string {
  let index = 0
  return sql.replace(/\?/g, () => {
    const value = params[index++]
    if (value === undefined) throw new Error('Missing SQL parameter')
    return escapeSqlValue(value)
  })
}

export function isDoltRepo(palacePath: string): boolean {
  return existsSync(join(palacePath, '.dolt'))
}

export function runDolt(
  palacePath: string,
  args: string[],
  options: DoltExecOptions = {},
): string {
  const result = spawnSync('dolt', args, {
    cwd: palacePath,
    encoding: 'utf-8',
    input: options.input,
  })

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `dolt ${args.join(' ')} failed`)
  }

  return result.stdout
}

export function runDoltJson<T>(
  palacePath: string,
  sql: string,
  params: SQLBindings = [],
): T[] {
  const output = runDolt(palacePath, ['sql', '-r', 'json', '-q', interpolateSql(sql, params)])
  const trimmed = output.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as { rows?: T[] }
  return parsed.rows ?? []
}

export function applyDoltSchema(palacePath: string): void {
  runDolt(palacePath, ['sql', '-q', DOLT_DDL])
}

export function ensureDoltRepo(
  palacePath: string,
  userName = 'nardo',
  userEmail = 'nardo@example.com',
): void {
  mkdirSync(palacePath, { recursive: true })
  if (!isDoltRepo(palacePath)) {
    runDolt(palacePath, ['init', '--name', userName, '--email', userEmail])
  }
  applyDoltSchema(palacePath)
}

function insertBatch(
  palacePath: string,
  table: 'drawers' | 'closets' | 'label_seq',
  columns: string[],
  rows: SQLValue[][],
): void {
  if (rows.length === 0) return
  const tuples = rows.map(row => `(${row.map(value => escapeSqlValue(value)).join(', ')})`).join(',\n')
  runDolt(
    palacePath,
    ['sql', '-q', `REPLACE INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`],
  )
}

export function migrateSqlitePalaceToDolt(
  palacePath: string,
  userName = 'nardo',
  userEmail = 'nardo@example.com',
): DoltMigrationResult {
  ensureDoltRepo(palacePath, userName, userEmail)
  runDolt(palacePath, ['sql', '-q', 'DELETE FROM drawers; DELETE FROM closets; DELETE FROM label_seq;'])

  const sqlitePath = join(palacePath, 'palace.sqlite3')
  if (!existsSync(sqlitePath)) {
    return { drawers: 0, closets: 0, archived_sqlite: false }
  }

  const sqlite = new Database(sqlitePath, { readonly: true })
  const drawers = sqlite.query<SqliteDrawerRow, []>(
    `SELECT id, document, label, wing, room, source_file, source_mtime, chunk_index,
            normalize_version, added_by, filed_at, ingest_mode, importance, chunk_size
     FROM drawers ORDER BY label ASC`,
  ).all()
  const closets = sqlite.query<SqliteClosetRow, []>(
    `SELECT id, document, label, source_file, wing, room
     FROM closets ORDER BY label ASC`,
  ).all()
  const labelSeq = sqlite.query<{ collection: string; next_label: number }, []>(
    `SELECT collection, next_label FROM label_seq`,
  ).all()
  sqlite.close()

  const batchSize = 100
  for (let start = 0; start < drawers.length; start += batchSize) {
    const batch = drawers.slice(start, start + batchSize)
    insertBatch(
      palacePath,
      'drawers',
      [
        'id',
        'document',
        'label',
        'wing',
        'room',
        'source_file',
        'source_mtime',
        'chunk_index',
        'normalize_version',
        'added_by',
        'filed_at',
        'ingest_mode',
        'importance',
        'chunk_size',
      ],
      batch.map(row => [
        row.id,
        row.document,
        row.label,
        row.wing,
        row.room,
        row.source_file,
        row.source_mtime,
        row.chunk_index,
        row.normalize_version,
        row.added_by,
        row.filed_at,
        row.ingest_mode,
        row.importance,
        row.chunk_size,
      ]),
    )
  }

  for (let start = 0; start < closets.length; start += batchSize) {
    const batch = closets.slice(start, start + batchSize)
    insertBatch(
      palacePath,
      'closets',
      ['id', 'document', 'label', 'source_file', 'wing', 'room'],
      batch.map(row => [
        row.id,
        row.document,
        row.label,
        row.source_file,
        row.wing,
        row.room,
      ]),
    )
  }

  insertBatch(
    palacePath,
    'label_seq',
    ['collection', 'next_label'],
    labelSeq.map(row => [row.collection, row.next_label]),
  )

  const archivePath = join(palacePath, 'palace.sqlite3.backup')
  let archivedSqlite = false
  if (!existsSync(archivePath)) {
    renameSync(sqlitePath, archivePath)
    archivedSqlite = true
  }

  return {
    drawers: drawers.length,
    closets: closets.length,
    archived_sqlite: archivedSqlite,
  }
}

export function commitDoltTables(
  palacePath: string,
  message: string,
  author?: string,
): void {
  runDolt(palacePath, ['add', '-A'])
  const args = ['commit', '--skip-empty', '-m', message]
  if (author) args.push(`--author=${author}`)
  runDolt(palacePath, args)
}
