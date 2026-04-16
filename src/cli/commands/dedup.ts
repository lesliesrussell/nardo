// dedup command
import type { Command } from 'commander'
import { dedupPalace } from '../../search/dedup.js'
import { loadConfig } from '../../config.js'

export function registerDedup(program: Command): void {
  program
    .command('dedup')
    .description('Deduplicate drawers by cosine similarity within source groups')
    .option('--threshold <n>', 'Cosine distance threshold (default 0.15)', '0.15')
    .option('--dry-run', 'Preview without deleting')
    .option('--stats', 'Show stats only (implies dry-run)')
    .option('--wing <wing>', 'Scope to one wing')
    .option('--source <pattern>', 'Filter by source_file pattern')
    .option('--palace <path>', 'Palace path override')
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
