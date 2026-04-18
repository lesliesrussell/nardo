// mcp command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('Start the nardo MCP server or print setup instructions')
    .addHelpText('after', `
Details:
  Without --serve, prints the JSON snippet to add nardo to Claude Code manually
  and shows the one-command setup shortcut. With --serve, launches the stdio
  MCP server that Claude Code calls directly — you normally never run this
  yourself; it is invoked by the Claude Code MCP config entry.

Examples:
  nardo mcp              # print setup instructions
  nardo mcp --serve      # start MCP server (used by Claude Code internally)
`)
    .option('--palace <path>', 'Path to palace directory, overriding nardo config')
    .option('--serve', 'Start the stdio MCP server (used by Claude Code internally)')
    .action(async (opts: { palace?: string; serve?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      if (opts.serve) {
        // Start the actual stdio MCP server inline
        const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
        const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
        const { registerReadTools } = await import('../../mcp/tools/read.js')
        const { registerWriteTools } = await import('../../mcp/tools/write.js')
        const { registerKgTools } = await import('../../mcp/tools/kg.js')
        const { registerMaintenanceTools } = await import('../../mcp/tools/maintenance.js')

        const server = new McpServer({ name: 'nardo', version: '0.1.0' })
        registerReadTools(server, palace_path)
        registerWriteTools(server, palace_path)
        registerKgTools(server, palace_path)
        registerMaintenanceTools(server, palace_path)

        const transport = new StdioServerTransport()
        await server.connect(transport)
        return
      }

      // Print setup instructions
      console.log('MCP Setup for nardo')
      console.log()
      console.log('One-command setup:')
      console.log('  nardo install-mcp && nardo install-hooks')
      console.log()
      console.log('Manual — add to ~/.claude/settings.json:')
      console.log()
      console.log(
        JSON.stringify(
          { mcpServers: { nardo: { command: 'nardo', args: ['mcp', '--serve'] } } },
          null,
          2,
        ),
      )
      console.log()
      console.log('Or via claude CLI:')
      console.log(`  claude mcp add nardo -- nardo mcp --serve`)
    })
}
