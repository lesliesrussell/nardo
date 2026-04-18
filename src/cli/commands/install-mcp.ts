// install-mcp command
import { execSync } from 'child_process'
import type { Command } from 'commander'

function resolveNardoPath(): string {
  try {
    return execSync('which nardo', { encoding: 'utf-8' }).trim()
  } catch {
    return 'nardo'
  }
}

export function installMcpServer(): { already_installed: boolean; nardo_path: string } {
  const nardo_path = resolveNardoPath()
  try {
    execSync(`claude mcp add --scope user nardo ${nardo_path} -- mcp --serve`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return { already_installed: false, nardo_path }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('already') || msg.includes('exists')) {
      return { already_installed: true, nardo_path }
    }
    throw e
  }
}

export function registerInstallMcp(program: Command): void {
  program
    .command('install-mcp')
    .description('Register nardo as a global MCP server in Claude Code')
    .addHelpText('after', `
Details:
  Runs "claude mcp add --scope user nardo <path> -- mcp --serve" so that
  Claude Code automatically connects to nardo's MCP tools (nardo_search,
  nardo_add_drawer, etc.) in every session. Safe to run more than once —
  exits cleanly if already registered. Restart Claude Code after running.

Example:
  nardo install-mcp
`)
    .action(() => {
      try {
        const { already_installed, nardo_path } = installMcpServer()
        if (already_installed) {
          console.log('nardo MCP server already registered.')
        } else {
          console.log(`Registered nardo MCP server (${nardo_path}).`)
          console.log('Restart Claude Code to pick up the change.')
        }
        console.log('')
        console.log('Next steps:')
        console.log('  nardo install-hooks   # global session-start hook')
        console.log('  nardo setup           # per-project hook registration')
        console.log('  nardo mine . --wing <name>  # index the current project')
      } catch (e) {
        if (e instanceof Error) {
          console.error('nardo: claude mcp add failed:', e.message)
          console.error('')
          console.error('Manual alternative — run:')
          console.error(`  claude mcp add --scope user nardo ${resolveNardoPath()} -- mcp --serve`)
          process.exit(1)
        }
        throw e
      }
    })
}
