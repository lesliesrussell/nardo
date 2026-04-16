// migrate command
import type { Command } from 'commander'

export function registerMigrate(program: Command): void {
  program
    .command('migrate')
    .description('Migrate palace data (not yet implemented)')
    .action(() => {
      console.log('migrate: not yet implemented')
    })
}
