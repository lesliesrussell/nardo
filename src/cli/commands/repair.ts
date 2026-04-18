// repair command
import type { Command } from 'commander'
import { scanForCorrupt, pruneCorrupt, rebuildPalace } from '../../palace/repair.js'
import { loadConfig } from '../../config.js'

export function registerRepair(program: Command): void {
  // nardo repair [--yes] [--palace PATH] — full rebuild
  program
    .command('repair')
    .description('Scan for corrupt drawers, prune them, and rebuild the palace collection')
    .addHelpText('after', `
Details:
  Runs the full repair pipeline: scans all drawers for corruption, prints a
  count of bad entries, then — if you confirm with --yes — deletes the corrupt
  drawers and rebuilds the collection from the remaining clean data. Without
  --yes it prints a summary and exits so you can review before committing.
  Currently requires the SQLite backend.

Examples:
  nardo repair           # scan and report; no changes made
  nardo repair --yes     # scan, prune corrupt entries, and rebuild
`)
    .option('--yes', 'Skip the confirmation prompt and proceed with pruning and rebuilding')
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
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
    .description('Scan all drawers for corruption and write bad IDs to corrupt_ids.txt')
    .addHelpText('after', `
Details:
  Checks every drawer in the palace (or a single wing with --wing) and
  reports how many are good vs corrupt. Bad drawer IDs are written to
  {palace}/corrupt_ids.txt for review. This command is read-only — no
  drawers are deleted. Run "nardo repair-prune --confirm" afterwards to
  remove the listed IDs. Requires the SQLite backend.

Examples:
  nardo repair-scan
  nardo repair-scan --wing sessions
`)
    .option('--wing <wing>', 'Restrict the scan to a single wing instead of the whole palace')
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
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
    .description('Delete the corrupt drawer IDs listed in corrupt_ids.txt')
    .addHelpText('after', `
Details:
  Reads {palace}/corrupt_ids.txt (produced by "nardo repair-scan") and
  deletes those drawers. Without --confirm it runs in dry-run mode and only
  prints the count. Pass --confirm to actually perform the deletions.
  Requires the SQLite backend.

Examples:
  nardo repair-prune             # dry-run: count corrupt IDs
  nardo repair-prune --confirm   # delete the corrupt IDs
`)
    .option('--confirm', 'Actually delete the corrupt IDs (without this flag: dry-run)')
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
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
