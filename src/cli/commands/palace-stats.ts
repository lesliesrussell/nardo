// palace-stats command — storage and index health report
import type { Command } from 'commander'
import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../config.js'
import { openPalaceDB } from '../../palace/client.js'

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
    .description(
      'Show a detailed storage and index health report for the palace.\n\n' +
      'Reports total drawer and closet counts, breakdown by wing/room/ingest-mode,\n' +
      'date range, average importance score, FTS5 sync status (SQLite only), and\n' +
      'disk usage for each palace file. Use this to understand the size and shape\n' +
      'of your palace or to check for FTS drift after bulk operations.\n\n' +
      'Examples:\n' +
      '  nardo palace-stats\n' +
      '  nardo palace-stats --json   # machine-readable output'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--json', 'Output the full stats report as a JSON object instead of formatted text')
    .action(async (opts: { palace?: string; json?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const asJson = opts.json ?? false
      const sqlitePath = join(palace_path, 'palace.sqlite3')
      const hasSqlite = existsSync(sqlitePath)
      const hasDolt = existsSync(join(palace_path, '.dolt'))

      if (!hasSqlite && !hasDolt) {
        console.error(`No palace found at: ${palace_path}`)
        process.exit(1)
      }

      const db = await openPalaceDB(palace_path, config.palace.backend)
      const totalDrawers = (await db.get<{ n: number }>('SELECT COUNT(*) as n FROM drawers'))?.n ?? 0
      const totalClosets = (await db.get<{ n: number }>('SELECT COUNT(*) as n FROM closets'))?.n ?? 0
      const byWing = await db.all<{ wing: string; n: number }>(
        'SELECT wing, COUNT(*) as n FROM drawers GROUP BY wing ORDER BY n DESC',
      )
      const byRoom = await db.all<{ wing: string; room: string; n: number }>(
        'SELECT wing, room, COUNT(*) as n FROM drawers GROUP BY wing, room ORDER BY n DESC LIMIT 20',
      )
      const dates = await db.get<{ oldest: string; newest: string }>(
        'SELECT MIN(filed_at) as oldest, MAX(filed_at) as newest FROM drawers',
      )
      const importance = await db.get<{ avg: number; min: number; max: number }>(
        'SELECT AVG(importance) as avg, MIN(importance) as min, MAX(importance) as max FROM drawers',
      )
      const byMode = await db.all<{ ingest_mode: string; n: number }>(
        'SELECT ingest_mode, COUNT(*) as n FROM drawers GROUP BY ingest_mode ORDER BY n DESC',
      )
      const ftsCount = db.kind === 'sqlite'
        ? ((await db.get<{ n: number }>('SELECT COUNT(*) as n FROM drawers_fts'))?.n ?? 0)
        : null
      await db.close()

      const sizes = {
        'palace.sqlite3': fileSize(sqlitePath) + fileSize(sqlitePath + '-shm') + fileSize(sqlitePath + '-wal'),
        'drawers.hnsw': fileSize(join(palace_path, 'drawers.hnsw')),
        'closets.hnsw': fileSize(join(palace_path, 'closets.hnsw')),
        'kg.db': fileSize(join(palace_path, 'kg.db')),
      }
      const totalSize = Object.values(sizes).reduce((a, b) => a + b, 0)

      const stats = {
        palace_path,
        backend: config.palace.backend,
        drawers: {
          total: totalDrawers,
          fts5_synced: ftsCount,
          fts5_drift: ftsCount == null ? null : totalDrawers - ftsCount,
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

      console.log(`\nPalace: ${palace_path}`)
      console.log(`Backend: ${config.palace.backend}\n`)
      const ftsSummary = ftsCount == null
        ? ''
        : ` | FTS5: ${ftsCount.toLocaleString()} synced${stats.drawers.fts5_drift !== 0 ? ` (drift: ${stats.drawers.fts5_drift})` : ''}`
      console.log(`Drawers:  ${totalDrawers.toLocaleString()} total${ftsSummary}`)
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
