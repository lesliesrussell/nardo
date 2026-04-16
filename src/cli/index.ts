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

program.parse(process.argv)
