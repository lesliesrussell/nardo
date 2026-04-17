// wakeup command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { loadL0 } from '../../wakeup/l0.js'
import { generateL1 } from '../../wakeup/l1.js'
import { renderWakeupText } from '../../wakeup/render.js'
import { installWakeupHook } from '../../wakeup/hooks.js'

export function registerWakeup(program: Command): void {
  program
    .command('wake-up')
    .description('Show L0 + L1 wake-up context')
    .option('--wing <wing>', 'Filter L1 to this wing')
    .option('--palace <path>', 'Palace path override')
    .option('--token-budget <n>', 'Max tokens for L1 output (default 800)', parseInt)
    .option('--json', 'Output structured JSON')
    .option('--quiet', 'Output L0 only')
    .action(async (opts: { wing?: string; palace?: string; tokenBudget?: number; json?: boolean; quiet?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      const l0 = await loadL0()
      const l1 = opts.quiet
        ? undefined
        : await generateL1({ palace_path, wing: opts.wing, token_budget: opts.tokenBudget }).catch(() => '(no drawers yet)')

      const payload = { palace_path, wing: opts.wing, l0, ...(l1 ? { l1 } : {}) }

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2))
        return
      }

      console.log(renderWakeupText(payload, opts.quiet))
    })

  program
    .command('install-hooks')
    .description('Install a Claude Code sessionStart hook that runs nardo wake-up automatically')
    .action(() => {
      const result = installWakeupHook()
      console.log(`Hook: ${result.hook_path}`)
      console.log(`Global settings: ${result.global_settings_path}`)
      if (result.project_settings_path) {
        console.log(`Project settings: ${result.project_settings_path}`)
      }
      const updated = result.updated_global || result.updated_project
      console.log(updated ? 'Installed SessionStart hook.' : 'Hook already present.')
    })
}
