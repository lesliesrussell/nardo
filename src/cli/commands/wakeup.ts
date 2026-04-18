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
    .description(
      'Print the wake-up context that nardo injects at the start of each Claude session.\n\n' +
      'L0 is a short static summary of the project loaded from the palace config.\n' +
      'L1 is a dynamic digest of recent high-importance drawers, budget-capped to\n' +
      '--token-budget tokens. Together they orient Claude Code at session start\n' +
      'without flooding the context window.\n\n' +
      'Examples:\n' +
      '  nardo wake-up\n' +
      '  nardo wake-up --wing myproject --token-budget 400\n' +
      '  nardo wake-up --json   # structured output for scripting'
    )
    .option('--wing <wing>', 'Restrict L1 digest to drawers in this wing')
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--token-budget <n>', 'Maximum tokens to include in the L1 digest (default: 800)', parseInt)
    .option('--json', 'Output the wake-up payload as structured JSON instead of formatted text')
    .option('--quiet', 'Output L0 only, skipping the L1 drawer digest')
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
    .description(
      'Install the nardo SessionStart wake-up hook globally in ~/.claude/settings.json.\n\n' +
      'After installation, Claude Code automatically runs "nardo wake-up" at the\n' +
      'start of every session and injects the L0+L1 context into the conversation.\n' +
      'Safe to run more than once — skips installation if the hook is already present.\n\n' +
      'Example:\n' +
      '  nardo install-hooks'
    )
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
    .description(
      'Register the nardo wake-up hook and MCP server for the current project.\n\n' +
      'Writes a SessionStart hook and the nardo MCP server entry into\n' +
      '.claude/settings.json in the current directory. Run this once per project\n' +
      'after "nardo install-hooks" so Claude Code uses nardo in this project.\n' +
      'Restart Claude Code after running.\n\n' +
      'Example:\n' +
      '  nardo setup'
    )
    .action(() => {
      const result = setupProject()
      console.log(`Project settings: ${result.project_settings_path}`)
      if (result.updated_hook) console.log('Added SessionStart wake-up hook.')
      console.log('Registered nardo MCP server for this project.')
      console.log('Restart Claude Code to activate.')
    })
}
