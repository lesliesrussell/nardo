// repair command
import type { Command } from 'commander'
import { scanForCorrupt, pruneCorrupt, rebuildPalace } from '../../palace/repair.js'
import { loadConfig } from '../../config.js'

export function registerRepair(program: Command): void {
  // nardo repair [--yes] [--palace PATH] — full rebuild
  program
    .command('repair')
    .description('Full palace rebuild: scan, prune corrupt entries, and rebuild collection')
    .option('--yes', 'Auto-confirm without interactive prompt')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { yes?: boolean; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      if (config.palace.backend !== 'sqlite') {
        console.error('repair commands currently support only the SQLite backend')
        process.exit(1)
      }

      console.log('Scanning for corrupt entries...')
      let scan
      try {
        scan = await scanForCorrupt(palace_path)
      } catch (err) {
        console.error('Scan failed:', err)
        process.exit(1)
      }

      console.log(`  GOOD: ${scan.good.length}`)
      console.log(`  BAD:  ${scan.bad.length}`)

      if (scan.bad.length > 0) {
        console.log(`  Bad IDs written to: ${palace_path}/corrupt_ids.txt`)
      }

      if (!opts.yes) {
        console.log()
        console.log('This will backup and rebuild the entire collection.')
        console.log('Re-run with --yes to confirm.')
        return
      }

      console.log()
      console.log('Pruning corrupt entries...')
      let pruned: number
      try {
        pruned = await pruneCorrupt(palace_path, true)
        console.log(`  Deleted ${pruned} corrupt entries`)
      } catch (err) {
        console.error('Prune failed:', err)
        process.exit(1)
      }

      console.log()
      console.log('Rebuilding palace...')
      let repairResult
      try {
        repairResult = await rebuildPalace(palace_path)
      } catch (err) {
        console.error('Rebuild failed:', err)
        process.exit(1)
      }

      console.log(`  Extracted:  ${repairResult.extracted} drawers`)
      console.log(`  Backed up:  ${repairResult.backed_up}`)
      console.log(`  Upserted:   ${repairResult.upserted} drawers`)
      console.log('  Done.')
    })

  // nardo repair-scan [--wing X] [--palace P]
  program
    .command('repair-scan')
    .description('Scan for corrupt drawer IDs and write corrupt_ids.txt')
    .option('--wing <wing>', 'Scope scan to one wing')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { wing?: string; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      if (config.palace.backend !== 'sqlite') {
        console.error('repair commands currently support only the SQLite backend')
        process.exit(1)
      }

      const start = Date.now()
      let scan
      try {
        scan = await scanForCorrupt(palace_path, opts.wing)
      } catch (err) {
        console.error('Scan failed:', err)
        process.exit(1)
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const total = scan.good.length + scan.bad.length
      const pct = total > 0 ? ((scan.bad.length / total) * 100).toFixed(1) : '0.0'

      console.log(`  Scan complete in ${elapsed}s`)
      console.log(`  GOOD: ${scan.good.length.toLocaleString()}`)
      console.log(`  BAD:  ${scan.bad.length.toLocaleString()} (${pct}%)`)

      if (scan.bad.length > 0) {
        console.log()
        console.log(`  Bad IDs written to: ${palace_path}/corrupt_ids.txt`)
      }
    })

  // nardo repair-prune [--confirm] [--palace P]
  program
    .command('repair-prune')
    .description('Delete corrupt IDs listed in corrupt_ids.txt')
    .option('--confirm', 'Actually delete (default is dry-run)')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { confirm?: boolean; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      if (config.palace.backend !== 'sqlite') {
        console.error('repair commands currently support only the SQLite backend')
        process.exit(1)
      }

      let count: number
      try {
        count = await pruneCorrupt(palace_path, opts.confirm)
      } catch (err) {
        console.error('Prune failed:', err)
        process.exit(1)
      }

      if (!opts.confirm) {
        console.log(`${count} corrupt IDs queued for deletion`)
        console.log('Re-run with --confirm to delete them.')
      } else {
        console.log(`Deleted ${count} corrupt IDs.`)
      }
    })
}
