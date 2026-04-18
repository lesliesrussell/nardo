// watch command — incremental file watcher that auto-mines changed files
//
// Uses Node.js fs.watch (FSEvents on macOS, inotify on Linux via Bun).
// Only mines files whose mtime has advanced — unchanged files are skipped
// in one SQLite lookup. Deleted files have their drawers removed.
import type { Command } from 'commander'
import { watch } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, extname, relative, basename } from 'node:path'
import { loadConfig } from '../../config.js'
import { mineSingleFile, READABLE_EXTENSIONS, SKIP_DIRS } from '../../mining/file-miner.js'
import { PalaceClient } from '../../palace/client.js'
import { deleteDrawersBySource } from '../../palace/drawers.js'
import { deleteClosetsBySource } from '../../palace/closets.js'
import { readNardoYaml } from '../../mining/yaml-reader.js'

const DEFAULT_DEBOUNCE_MS = 500

export function registerWatch(program: Command): void {
  program
    .command('watch <path>')
    .description('Watch a directory and automatically re-index files as they change')
    .addHelpText('after', `
Details:
  Uses the OS filesystem event API (FSEvents on macOS, inotify on Linux) to
  detect file creates, modifications, and deletes. Changed files are re-mined
  after a debounce delay; deleted files have their drawers removed. Only files
  with known readable extensions are processed; node_modules and similar
  directories are skipped. Wing is read from nardo.yaml if present.

Examples:
  nardo watch .
  nardo watch ~/myproject --wing myproject --debounce 1000
`)
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .option('--wing <name>', 'Wing to file drawers under (default: from nardo.yaml or directory name)')
    .option('--debounce <ms>', `Milliseconds to wait after last event before re-mining (default: ${DEFAULT_DEBOUNCE_MS})`)
    .option('--quiet', 'Suppress per-file log lines (only errors are shown)')
    .action(
      async (
        targetPath: string,
        opts: {
          palace?: string
          wing?: string
          debounce?: string
          quiet?: boolean
        },
      ) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path
        const debounceMs = opts.debounce ? parseInt(opts.debounce, 10) : DEFAULT_DEBOUNCE_MS
        const quiet = opts.quiet ?? false

        // Resolve wing: explicit > nardo.yaml > directory name
        let nardoYaml: Awaited<ReturnType<typeof readNardoYaml>> | null = null
        try { nardoYaml = await readNardoYaml(targetPath) } catch { /* no yaml */ }

        const wing = opts.wing ?? nardoYaml?.wing ?? basename(targetPath)
        const rooms = nardoYaml?.rooms ?? {}

        const mineOpts = { palace_path, wing, rooms, agent: 'watch' }

        if (!quiet) {
          console.log(`Watching: ${targetPath}`)
          console.log(`Palace:   ${palace_path}`)
          console.log(`Wing:     ${wing}`)
          console.log(`Debounce: ${debounceMs}ms`)
          console.log('Press Ctrl+C to stop.\n')
        }

        // Debounce map: fullPath → timer
        const pending = new Map<string, ReturnType<typeof setTimeout>>()

        const watcher = watch(targetPath, { recursive: true }, (_event, filename) => {
          if (!filename) return

          const fullPath = join(targetPath, filename)

          // Filter by extension
          const ext = extname(filename).toLowerCase()
          if (!READABLE_EXTENSIONS.has(ext)) return

          // Filter out skip dirs (check each path segment)
          const segments = filename.split(/[/\\]/)
          if (segments.some(seg => SKIP_DIRS.has(seg))) return

          // Debounce: reset timer on each event for this file
          const existing = pending.get(fullPath)
          if (existing) clearTimeout(existing)

          pending.set(fullPath, setTimeout(async () => {
            pending.delete(fullPath)

            try {
              const exists = existsSync(fullPath)

              if (!exists) {
                // File deleted — remove its drawers
                const client = new PalaceClient(palace_path)
                await deleteDrawersBySource(client, fullPath)
                await deleteClosetsBySource(client, fullPath)
                if (!quiet) console.log(`[-] ${relative(targetPath, fullPath)}`)
                return
              }

              // File created or modified
              const result = await mineSingleFile(fullPath, mineOpts)

              if (!quiet) {
                if (result.skipped) {
                  // Unchanged mtime or unreadable — no output
                } else if (result.remined) {
                  console.log(`[~] ${relative(targetPath, fullPath)} (${result.drawers} drawers, remined)`)
                } else {
                  console.log(`[+] ${relative(targetPath, fullPath)} (${result.drawers} drawers)`)
                }
              }
            } catch (err) {
              if (!quiet) console.error(`[!] ${filename}: ${String(err)}`)
            }
          }, debounceMs))
        })

        watcher.on('error', (err) => {
          console.error(`Watch error: ${String(err)}`)
          process.exit(1)
        })

        // Keep process alive until Ctrl+C
        process.on('SIGINT', () => {
          watcher.close()
          if (!quiet) console.log('\nWatch stopped.')
          process.exit(0)
        })

        // Bun needs an explicit await to keep the process alive
        await new Promise(() => { /* runs until SIGINT */ })
      },
    )
}
