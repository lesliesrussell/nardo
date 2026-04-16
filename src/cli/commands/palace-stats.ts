// palace-stats command — storage and index health report
//
// Shows drawer counts, wing/room breakdown, index sizes on disk,
// oldest/newest drawer dates, and FTS5 sync status.
import type { Command } from 'commander'
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { loadConfig } from '../../config.js'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

export function registerPalaceStats(program: Command): void {
  program
    .command('palace-stats')
    .description('Show palace storage and index health report')
    .option('--palace <path>', 'Palace path override')
    .option('--json', 'Output as JSON')
    .action(async (opts: { palace?: string; json?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const asJson = opts.json ?? false

      const dbPath = join(palace_path, 'palace.sqlite3')
      if (!existsSync(dbPath)) {
        console.error(`No palace found at: ${palace_path}`)
        process.exit(1)
      }

      const db = new Database(dbPath, { readonly: true })

      // Total drawer count
      const totalRow = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM drawers').get()
      const totalDrawers = totalRow?.n ?? 0

      // Total closet count
      const closetRow = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM closets').get()
      const totalClosets = closetRow?.n ?? 0

      // FTS5 sync check
      const ftsRow = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM drawers_fts').get()
      const ftsCount = ftsRow?.n ?? 0

      // By wing
      const byWing = db.query<{ wing: string; n: number }, []>(
        'SELECT wing, COUNT(*) as n FROM drawers GROUP BY wing ORDER BY n DESC',
      ).all()

      // By wing + room (top 20)
      const byRoom = db.query<{ wing: string; room: string; n: number }, []>(
        'SELECT wing, room, COUNT(*) as n FROM drawers GROUP BY wing, room ORDER BY n DESC LIMIT 20',
      ).all()

      // Date range
      const dates = db.query<{ oldest: string; newest: string }, []>(
        'SELECT MIN(filed_at) as oldest, MAX(filed_at) as newest FROM drawers',
      ).get()

      // Importance distribution
      const importance = db.query<{ avg: number; min: number; max: number }, []>(
        'SELECT AVG(importance) as avg, MIN(importance) as min, MAX(importance) as max FROM drawers',
      ).get()

      // Ingest mode breakdown
      const byMode = db.query<{ ingest_mode: string; n: number }, []>(
        'SELECT ingest_mode, COUNT(*) as n FROM drawers GROUP BY ingest_mode ORDER BY n DESC',
      ).all()

      db.close()

      // File sizes
      const sizes = {
        'palace.sqlite3': fileSize(dbPath) + fileSize(dbPath + '-shm') + fileSize(dbPath + '-wal'),
        'drawers.hnsw': fileSize(join(palace_path, 'drawers.hnsw')),
        'closets.hnsw': fileSize(join(palace_path, 'closets.hnsw')),
        'kg.db': fileSize(join(palace_path, 'kg.db')),
      }
      const totalSize = Object.values(sizes).reduce((a, b) => a + b, 0)

      const stats = {
        palace_path,
        drawers: {
          total: totalDrawers,
          fts5_synced: ftsCount,
          fts5_drift: totalDrawers - ftsCount,
        },
        closets: { total: totalClosets },
        dates: {
          oldest: dates?.oldest ?? null,
          newest: dates?.newest ?? null,
        },
        importance: importance
          ? { avg: Math.round((importance.avg ?? 0) * 1000) / 1000, min: importance.min, max: importance.max }
          : null,
        by_ingest_mode: Object.fromEntries(byMode.map(r => [r.ingest_mode, r.n])),
        by_wing: Object.fromEntries(byWing.map(r => [r.wing, r.n])),
        top_rooms: byRoom.map(r => ({ wing: r.wing, room: r.room, drawers: r.n })),
        disk: {
          ...Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, fmtBytes(v)])),
          total: fmtBytes(totalSize),
        },
      }

      if (asJson) {
        console.log(JSON.stringify(stats, null, 2))
        return
      }

      // Human-readable output
      console.log(`\nPalace: ${palace_path}\n`)
      console.log(`Drawers:  ${totalDrawers.toLocaleString()} total | FTS5: ${ftsCount.toLocaleString()} synced${stats.drawers.fts5_drift !== 0 ? ` (drift: ${stats.drawers.fts5_drift})` : ''}`)
      console.log(`Closets:  ${totalClosets.toLocaleString()} total`)
      if (dates?.oldest) {
        console.log(`Dates:    ${dates.oldest.slice(0, 10)} → ${dates.newest?.slice(0, 10)}`)
      }
      if (importance) {
        console.log(`Importance: avg=${stats.importance?.avg} min=${importance.min} max=${importance.max}`)
      }

      console.log(`\nBy ingest mode:`)
      for (const [mode, n] of Object.entries(stats.by_ingest_mode)) {
        console.log(`  ${mode.padEnd(12)} ${(n as number).toLocaleString()}`)
      }

      console.log(`\nBy wing:`)
      for (const [wing, n] of Object.entries(stats.by_wing)) {
        console.log(`  ${wing.padEnd(20)} ${(n as number).toLocaleString()}`)
      }

      console.log(`\nTop rooms:`)
      for (const r of stats.top_rooms.slice(0, 10)) {
        console.log(`  ${r.wing.padEnd(16)} ${r.room.padEnd(20)} ${r.drawers}`)
      }

      console.log(`\nDisk usage:`)
      for (const [file, size] of Object.entries(stats.disk)) {
        if (file === 'total') continue
        console.log(`  ${file.padEnd(24)} ${size}`)
      }
      console.log(`  ${'total'.padEnd(24)} ${stats.disk.total}`)
    })
}
