// MCP server entry
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerReadTools } from './tools/read.js'
import { registerWriteTools } from './tools/write.js'
import { registerKgTools } from './tools/kg.js'
import { registerMaintenanceTools } from './tools/maintenance.js'
import { loadConfig } from '../config.js'

// Parse --palace arg from process.argv before SDK init
function parsePalacePath(): string {
  const args = process.argv
  const idx = args.indexOf('--palace')
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]
  }
  // Fall back to config
  const config = loadConfig()
  return config.palace_path
}

const palace_path = parsePalacePath()

const server = new McpServer({ name: 'nardo', version: '0.1.0' })

registerReadTools(server, palace_path)
registerWriteTools(server, palace_path)
registerKgTools(server, palace_path)
registerMaintenanceTools(server, palace_path)

const transport = new StdioServerTransport()
await server.connect(transport)
