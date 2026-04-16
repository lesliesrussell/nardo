// mcp command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_PATH = resolve(__dirname, '../../mcp/server.ts')

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('Print MCP setup commands for Claude and other clients')
    .option('--palace <path>', 'Palace path override')
    .action((opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      console.log('MCP Setup for nardo')
      console.log()
      console.log('Add to Claude Desktop (claude_desktop_config.json):')
      console.log()
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              nardo: {
                command: 'bun',
                args: ['run', SERVER_PATH, '--palace', palace_path],
              },
            },
          },
          null,
          2,
        ),
      )
      console.log()
      console.log('Or via claude CLI:')
      console.log(`  claude mcp add nardo -- bun run ${SERVER_PATH} --palace ${palace_path}`)
    })
}
