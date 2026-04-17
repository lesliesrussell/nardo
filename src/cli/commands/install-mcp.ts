// install-mcp command
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Command } from 'commander'

const MCP_ENTRY = { command: 'nardo', args: ['mcp', '--serve'] }

function loadSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    throw new Error(`nardo: settings file exists but is not valid JSON: ${path}\nFix or delete it, then retry.`)
  }
}

export function installMcpServer(home = homedir()): {
  settings_path: string
  already_installed: boolean
} {
  const settings_path = join(home, '.claude', 'settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })

  const settings = loadSettings(settings_path)
  const mcpServers = (settings.mcpServers && typeof settings.mcpServers === 'object')
    ? settings.mcpServers as Record<string, unknown>
    : {}

  if (mcpServers['nardo']) {
    return { settings_path, already_installed: true }
  }

  const next = {
    ...settings,
    mcpServers: {
      ...mcpServers,
      nardo: MCP_ENTRY,
    },
  }

  writeFileSync(settings_path, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return { settings_path, already_installed: false }
}

export function registerInstallMcp(program: Command): void {
  program
    .command('install-mcp')
    .description('Register nardo as a global MCP server in ~/.claude/settings.json')
    .action(() => {
      try {
        const { settings_path, already_installed } = installMcpServer()
        if (already_installed) {
          console.log(`nardo MCP server already registered in ${settings_path}`)
          console.log('Restart Claude Code to pick up any changes.')
        } else {
          console.log(`Registered nardo MCP server in ${settings_path}`)
          console.log('Restart Claude Code — nardo tools will be available in every session.')
        }
        console.log('')
        console.log('Next steps:')
        console.log('  nardo install-hooks   # auto-load wake-up context on session start')
        console.log('  nardo init .          # initialize a repo palace')
        console.log('  nardo mine . --wing <name>  # index the current project')
      } catch (e) {
        if (e instanceof Error) {
          console.error(e.message)
          console.error('')
          console.error('Manual alternative — add this to ~/.claude/settings.json:')
          console.error(JSON.stringify({ mcpServers: { nardo: MCP_ENTRY } }, null, 2))
          process.exit(1)
        }
        throw e
      }
    })
}
