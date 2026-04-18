// dedup command
import type { Command } from 'commander'
import { dedupPalace } from '../../search/dedup.js'
import { loadConfig } from '../../config.js'

export function registerDedup(program: Command): void {
  program
    .command('dedup')
    .description('Find and remove near-duplicate drawers using cosine similarity')
    .addHelpText('after', `
Details:
  Compares drawers within each source group: pairs whose cosine distance is
  below --threshold are considered duplicates and the newer copy is deleted.
  Use --dry-run first to preview what would be removed before committing.

Examples:
  nardo dedup --dry-run          # preview duplicates without deleting
  nardo dedup --threshold 0.10   # stricter: only near-exact duplicates
  nardo dedup --wing sessions    # deduplicate one wing only
`)
    .option('--threshold <n>', 'Cosine distance threshold for duplicates (default: 0.15)', '0.15')
    .option('--dry-run', 'Show which drawers would be deleted without actually deleting them')
    .option('--stats', 'Show duplicate counts only without deleting (implies --dry-run)')
    .option('--wing <wing>', 'Restrict dedup to a single wing instead of the whole palace')
    .option('--source <pattern>', 'Restrict dedup to drawers whose source_file matches this pattern')
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .action(async (opts: {
      threshold: string
      dryRun?: boolean
      stats?: boolean
      wing?: string
      source?: string
      palace?: string
    }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const dry_run = opts.dryRun ?? opts.stats ?? false
      const threshold = parseFloat(opts.threshold) || 0.15

      let result
      try {
        result = await dedupPalace({
          palace_path,
          threshold,
          wing: opts.wing,
          source: opts.source,
          dry_run,
        })
      } catch (err) {
        console.error('Dedup failed:', err)
        process.exit(1)
      }

      console.log(`Scanned ${result.scanned} drawers, found ${result.duplicates} duplicates`)

      if (opts.stats || dry_run) {
        console.log('(dry-run — no deletions performed)')
      } else {
        console.log(`Deleted ${result.deleted} duplicate drawers`)
      }

      if (result.groups.length > 0) {
        console.log()
        console.log('Groups:')
        for (const group of result.groups) {
          console.log(`  kept: ${group.kept}`)
          console.log(`  removed (${group.removed.length}): ${group.removed.slice(0, 3).join(', ')}${group.removed.length > 3 ? '...' : ''}`)
        }
      }
    })
}
