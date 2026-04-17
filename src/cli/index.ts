#!/usr/bin/env bun
// CLI entry (commander)
import { Command } from 'commander'
import { registerStatus } from './commands/status.js'
import { registerMine } from './commands/mine.js'
import { registerSearch } from './commands/search.js'
import { registerWakeup } from './commands/wakeup.js'
import { registerInit } from './commands/init.js'
import { registerMcp } from './commands/mcp.js'
import { registerRepair } from './commands/repair.js'
import { registerDedup } from './commands/dedup.js'
import { registerMigrate } from './commands/migrate.js'
import { registerSplit } from './commands/split.js'
import { registerAddDrawer } from './commands/add-drawer.js'
import { registerForget } from './commands/forget.js'
import { registerDiary } from './commands/diary.js'
import { registerWatch } from './commands/watch.js'
import { registerExport } from './commands/export.js'
import { registerImport } from './commands/import.js'
import { registerMineBeads } from './commands/mine-beads.js'
import { registerPalaceStats } from './commands/palace-stats.js'
import { registerCompact } from './commands/compact.js'
import { registerMineUrl } from './commands/mine-url.js'
import { registerMineGit } from './commands/mine-git.js'
import { registerReembed } from './commands/reembed.js'
import { registerDolt } from './commands/dolt.js'
import { registerInstallMcp } from './commands/install-mcp.js'

const program = new Command()

program
  .name('nardo')
  .description('Local-first memory system for AI agents')
  .version('0.1.0')

registerStatus(program)
registerMine(program)
registerSearch(program)
registerWakeup(program)
registerInit(program)
registerMcp(program)
registerRepair(program)
registerDedup(program)
registerMigrate(program)
registerSplit(program)
registerAddDrawer(program)
registerForget(program)
registerDiary(program)
registerWatch(program)
registerExport(program)
registerImport(program)
registerMineBeads(program)
registerPalaceStats(program)
registerCompact(program)
registerMineUrl(program)
registerMineGit(program)
registerReembed(program)
registerDolt(program)
registerInstallMcp(program)

try {
  await program.parseAsync(process.argv)
} catch (e) {
  if (e instanceof Error && e.message.startsWith('nardo:')) {
    console.error(e.message)
    process.exit(1)
  }
  throw e
}
