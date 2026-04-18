import type { Command } from 'commander'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '../../config.js'
import {
  commitDoltTables,
  ensureDoltRepo,
  isDoltRepo,
  migrateSqlitePalaceToDolt,
  runDolt,
} from '../../palace/dolt.js'
import { rebuildPalaceIndexes } from '../../palace/reindex.js'

function resolveAuthor(name?: string, email?: string): string | undefined {
  if (!name || !email) return undefined
  return `${name} <${email}>`
}

export function registerDolt(program: Command): void {
  program
    .command('dolt-init')
    .description(
      'Convert the palace from SQLite to Dolt, enabling version-controlled sync.\n\n' +
      'Migrates all drawers and closets from palace.sqlite3 into a new Dolt database\n' +
      'in the same directory, archives the original SQLite file as a backup, and\n' +
      'updates nardo config to use the Dolt backend. Run once per palace.\n\n' +
      'Examples:\n' +
      '  nardo dolt-init\n' +
      '  nardo dolt-init --name "Alice" --email alice@example.com'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--name <name>', 'Name recorded in the initial Dolt commit author field (default: nardo)', 'nardo')
    .option('--email <email>', 'Email recorded in the initial Dolt commit author field (default: nardo@example.com)', 'nardo@example.com')
    .option('--message <message>', 'Message for the initial Dolt commit (default: init: migrate from sqlite)', 'init: migrate from sqlite')
    .action(async (opts: { palace?: string; name: string; email: string; message: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const result = migrateSqlitePalaceToDolt(palace_path, opts.name, opts.email)

      commitDoltTables(palace_path, opts.message, resolveAuthor(opts.name, opts.email))

      const nextConfig = {
        ...config,
        palace_path,
        palace: {
          ...config.palace,
          backend: 'dolt' as const,
        },
      }
      saveConfig(nextConfig)

      console.log(`Initialized Dolt palace at ${palace_path}`)
      console.log(`Migrated ${result.drawers} drawers and ${result.closets} closets`)
      if (result.archived_sqlite) {
        console.log(`Archived legacy SQLite DB to ${join(palace_path, 'palace.sqlite3.backup')}`)
      }
    })

  program
    .command('dolt-push')
    .description(
      'Commit any pending palace changes to Dolt and push to the configured remote.\n\n' +
      'Stages all modified drawer/closet tables, creates a Dolt commit, then runs\n' +
      '"dolt push". Use this to sync your palace to a remote Dolt server or\n' +
      'DoltHub repository so other machines can pull it.\n\n' +
      'Examples:\n' +
      '  nardo dolt-push\n' +
      '  nardo dolt-push --message "after indexing project docs"'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--message <message>', 'Dolt commit message describing this sync (default: sync: nardo palace update)', 'sync: nardo palace update')
    .option('--name <name>', 'Name for the Dolt commit author (overrides the stored identity)')
    .option('--email <email>', 'Email for the Dolt commit author (overrides the stored identity)')
    .action(async (opts: { palace?: string; message: string; name?: string; email?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      ensureDoltRepo(palace_path, opts.name ?? 'nardo', opts.email ?? 'nardo@example.com')
      commitDoltTables(palace_path, opts.message, resolveAuthor(opts.name, opts.email))
      const output = runDolt(palace_path, ['push'])
      process.stdout.write(output)
    })

  program
    .command('dolt-pull')
    .description(
      'Pull palace changes from a Dolt remote and rebuild local HNSW vector indexes.\n\n' +
      'Runs "dolt pull --no-edit" to merge remote changes, then reconstructs the\n' +
      'drawers.hnsw and closets.hnsw sidecar files so searches reflect the new data.\n' +
      'Use this to sync a palace that was pushed from another machine.\n\n' +
      'Examples:\n' +
      '  nardo dolt-pull\n' +
      '  nardo dolt-pull --remote origin --branch main'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--remote <name>', 'Name of the Dolt remote to pull from (default: origin)')
    .option('--branch <name>', 'Remote branch to pull (default: the tracked upstream branch)')
    .action(async (opts: { palace?: string; remote?: string; branch?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      if (!isDoltRepo(palace_path)) {
        throw new Error(`No Dolt repository found at ${palace_path}; run nardo dolt-init first`)
      }

      const args = ['pull']
      if (opts.remote) args.push(opts.remote)
      if (opts.branch) args.push(opts.branch)
      args.push('--no-edit')

      const output = runDolt(palace_path, args)
      if (output.trim()) process.stdout.write(output)

      const result = await rebuildPalaceIndexes({ palace_path, quiet: true })
      console.log(`Rebuilt HNSW sidecars from Dolt data: ${result.drawers} drawers, ${result.closets} closets`)
    })

  program
    .command('dolt-log')
    .description(
      'Show the Dolt commit history for the palace database.\n\n' +
      'Displays the full commit log from the Dolt repository in the palace directory,\n' +
      'including commit hash, author, date, and message. Useful for auditing when\n' +
      'and what was synced.\n\n' +
      'Example:\n' +
      '  nardo dolt-log'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['log']))
    })

  program
    .command('dolt-diff')
    .description(
      'Show uncommitted changes in the Dolt palace working set.\n\n' +
      'Runs "dolt diff" in the palace directory so you can see which rows have been\n' +
      'added, modified, or deleted since the last Dolt commit. Useful before running\n' +
      '"nardo dolt-push" to review what will be committed.\n\n' +
      'Example:\n' +
      '  nardo dolt-diff'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['diff']))
    })

  const remote = program
    .command('dolt-remote')
    .description(
      'Manage Dolt remote references for the palace.\n\n' +
      'Subcommands let you add remotes so "nardo dolt-push" and "nardo dolt-pull"\n' +
      'know where to sync. Run "nardo dolt-remote add <name> <url>" to register\n' +
      'a DoltHub repo or self-hosted Dolt server.\n\n' +
      'Example:\n' +
      '  nardo dolt-remote add origin https://doltremoteapi.dolthub.com/user/palace'
    )

  remote
    .command('add <name> <url>')
    .description(
      'Register a new Dolt remote for push/pull operations.\n\n' +
      'Associates <name> (e.g. "origin") with the Dolt remote <url> so that\n' +
      '"nardo dolt-push" and "nardo dolt-pull" can reach it.\n\n' +
      'Example:\n' +
      '  nardo dolt-remote add origin https://doltremoteapi.dolthub.com/alice/my-palace'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(async (name: string, url: string, opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['remote', 'add', name, url]))
    })
}
