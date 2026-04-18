// dashboard command — launches the nardo web UI
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { startDashboardServer } from '../../dashboard/server.js'

export function registerDashboard(program: Command): void {
  program
    .command('dashboard')
    .description('Start the nardo web dashboard')
    .option('--port <port>', 'Port to listen on', '7432')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { port: string; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const port = parseInt(opts.port, 10) || 7432

      let url: string
      let server: ReturnType<typeof import('../../dashboard/server.js').startDashboardServer>['server']
      try {
        ;({ url, server } = startDashboardServer({ palace_path, port }))
      } catch (err: unknown) {
        const isAddrInUse = err instanceof Error && (err.message.includes('EADDRINUSE') || err.message.includes('in use'))
        if (isAddrInUse) {
          console.error(`\n  error: port ${port} is already in use.`)
          console.error(`  Kill the existing process:  lsof -ti:${port} | xargs kill`)
          console.error(`  Or use a different port:    nardo dashboard --port ${port + 1}\n`)
          process.exit(1)
        }
        throw err
      }

      console.log(`\n  nardo dashboard`)
      console.log(`  palace: ${palace_path}`)
      console.log(`  url:    ${url}\n`)

      // Open browser
      const { execSync } = await import('node:child_process')
      try {
        const platform = process.platform
        if (platform === 'darwin') {
          execSync(`open ${url}`)
        } else if (platform === 'win32') {
          execSync(`start ${url}`)
        } else {
          execSync(`xdg-open ${url}`)
        }
      } catch {
        // If browser open fails, just continue — server is still running
      }

      console.log('  Press Ctrl+C to stop.\n')

      // Keep process alive
      void server
      await new Promise<void>(resolve => process.on('SIGINT', resolve))
      server.stop()
      process.exit(0)
    })
}
