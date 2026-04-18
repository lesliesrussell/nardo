// forget command — bulk-delete drawers by source, wing, room, age, or ID
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { forgetDrawers } from '../../palace/drawers.js'
import { loadConfig } from '../../config.js'
import * as wal from '../../wal.js'

export function registerForget(program: Command): void {
  program
    .command('forget')
    .description('Bulk-delete drawers from the palace by source, wing, room, age, or ID')
    .addHelpText('after', `
Details:
  At least one selector (--source-file, --source-prefix, --wing, --before, or
  --id) is required. Use --dry-run first to preview what would be removed.
  After deleting, run "nardo compact" to reclaim disk space.

Examples:
  nardo forget --source-file src/old-module.ts --dry-run
  nardo forget --wing sessions --before 2024-01-01
  nardo forget --id 3f2a1b9c-...
`)
    .option('--source-file <path>', 'Delete drawers whose source_file exactly matches this path')
    .option('--source-prefix <prefix>', 'Delete drawers whose source_file starts with this prefix')
    .option('--wing <name>', 'Delete all drawers in this wing')
    .option('--room <name>', 'Delete all drawers in this room within the wing (requires --wing)')
    .option('--before <iso-date>', 'Delete drawers filed before this ISO date, e.g. 2024-01-01')
    .option('--id <drawer-id>', 'Delete a single drawer by its UUID')
    .option('--dry-run', 'Show how many drawers would be deleted without actually deleting them')
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .action(
      async (opts: {
        sourceFile?: string
        sourcePrefix?: string
        wing?: string
        room?: string
        before?: string
        id?: string
        dryRun?: boolean
        palace?: string
      }) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path

        // Validate: at least one selector required
        if (!opts.sourceFile && !opts.sourcePrefix && !opts.wing && !opts.before && !opts.id) {
          console.error('Error: at least one of --source-file, --wing, --before, or --id is required')
          console.error('Use --dry-run to preview before deleting.')
          process.exit(1)
        }

        // Validate: --room requires --wing
        if (opts.room && !opts.wing) {
          console.error('Error: --room requires --wing')
          process.exit(1)
        }

        // Validate: --before must be a valid ISO date
        if (opts.before && isNaN(Date.parse(opts.before))) {
          console.error(`Error: --before "${opts.before}" is not a valid date. Use ISO format, e.g. 2024-01-01`)
          process.exit(1)
        }

        const dry_run = opts.dryRun ?? false

        try {
          const client = new PalaceClient(palace_path)

          const count = await forgetDrawers(
            client,
            {
              source_file: opts.sourceFile,
              source_prefix: opts.sourcePrefix,
              wing: opts.wing,
              room: opts.room,
              before: opts.before,
              id: opts.id,
              dry_run,
            },
            wal,
          )

          if (dry_run) {
            console.log(`Would delete ${count} drawer${count !== 1 ? 's' : ''} (dry run — nothing deleted)`)
            if (count > 0) {
              console.log('Re-run without --dry-run to delete.')
            }
          } else {
            console.log(`Deleted ${count} drawer${count !== 1 ? 's' : ''}`)
          }
        } catch (err) {
          console.error(`Error: ${String(err)}`)
          process.exit(1)
        }
      },
    )
}
