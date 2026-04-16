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
    .description('Initialize a Dolt repo in the palace directory and migrate SQLite data')
    .option('--palace <path>', 'Palace path override')
    .option('--name <name>', 'Dolt commit identity name', 'nardo')
    .option('--email <email>', 'Dolt commit identity email', 'nardo@example.com')
    .option('--message <message>', 'Initial commit message', 'init: migrate from sqlite')
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
    .description('Commit Dolt palace changes and push to the configured remote')
    .option('--palace <path>', 'Palace path override')
    .option('--message <message>', 'Commit message', 'sync: nardo palace update')
    .option('--name <name>', 'Dolt commit identity name')
    .option('--email <email>', 'Dolt commit identity email')
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
    .description('Pull Dolt palace changes from the configured remote and rebuild local HNSW sidecars')
    .option('--palace <path>', 'Palace path override')
    .option('--remote <name>', 'Remote name')
    .option('--branch <name>', 'Remote branch name')
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
    .description('Show Dolt palace commit history')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['log']))
    })

  program
    .command('dolt-diff')
    .description('Show Dolt palace working-set changes')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['diff']))
    })

  const remote = program
    .command('dolt-remote')
    .description('Manage Dolt remotes for the palace')

  remote
    .command('add <name> <url>')
    .description('Add a Dolt remote')
    .option('--palace <path>', 'Palace path override')
    .action(async (name: string, url: string, opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      process.stdout.write(runDolt(palace_path, ['remote', 'add', name, url]))
    })
}
