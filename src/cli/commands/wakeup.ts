// wakeup command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { loadL0 } from '../../wakeup/l0.js'
import { generateL1 } from '../../wakeup/l1.js'

export function registerWakeup(program: Command): void {
  program
    .command('wake-up')
    .description('Show L0 + L1 wake-up context')
    .option('--wing <wing>', 'Filter L1 to this wing')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { wing?: string; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      const [l0, l1] = await Promise.all([
        loadL0(),
        generateL1({ palace_path, wing: opts.wing }).catch(() => '(no drawers yet)'),
      ])

      const SEP = '=================================================='
      console.log(`Wake-up text:`)
      console.log(SEP)
      console.log('L0 — IDENTITY')
      if (l0) {
        console.log(l0)
      } else {
        console.log('(no identity.txt found at ~/.nardo/identity.txt)')
      }
      console.log()
      console.log('L1 — ESSENTIAL STORY')
      console.log(l1)
      console.log(SEP)
    })
}
