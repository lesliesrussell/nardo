// forget command — bulk-delete drawers by source, wing, room, age, or ID
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { forgetDrawers } from '../../palace/drawers.js'
import { loadConfig } from '../../config.js'
import * as wal from '../../wal.js'

export function registerForget(program: Command): void {
  program
    .command('forget')
    .description('Delete drawers from the palace by source file, wing, room, age, or ID')
    .option('--source-file <path>', 'Delete all drawers from this source file')
    .option('--wing <name>', 'Delete all drawers in this wing')
    .option('--room <name>', 'Delete all drawers in this room (requires --wing)')
    .option('--before <iso-date>', 'Delete drawers filed before this date (e.g. 2024-01-01)')
    .option('--id <drawer-id>', 'Delete a specific drawer by ID')
    .option('--dry-run', 'Preview what would be deleted without deleting')
    .option('--palace <path>', 'Palace path override')
    .action(
      async (opts: {
        sourceFile?: string
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
        if (!opts.sourceFile && !opts.wing && !opts.before && !opts.id) {
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
