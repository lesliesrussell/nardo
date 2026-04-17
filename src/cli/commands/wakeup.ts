// wakeup command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { loadL0 } from '../../wakeup/l0.js'
import { generateL1 } from '../../wakeup/l1.js'
import { renderWakeupText } from '../../wakeup/render.js'
import { installWakeupHook, setupProject } from '../../wakeup/hooks.js'

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
    .description('Install nardo wake-up hook globally (~/.claude/settings.json)')
    .action(() => {
      const result = installWakeupHook()
      console.log(`Hook: ${result.hook_path}`)
      console.log(`Global settings: ${result.global_settings_path}`)
      console.log(result.updated_global ? 'Installed SessionStart hook.' : 'Hook already present.')
      console.log('')
      console.log('Run "nardo setup" in each project to register the MCP server there.')
    })

  program
    .command('setup')
    .description('Register nardo hook + MCP server in this project (.claude/settings.json)')
    .action(() => {
      const result = setupProject()
      console.log(`Project settings: ${result.project_settings_path}`)
      if (result.updated_hook) console.log('Added SessionStart wake-up hook.')
      console.log('Registered nardo MCP server for this project.')
      console.log('Restart Claude Code to activate.')
    })
}
