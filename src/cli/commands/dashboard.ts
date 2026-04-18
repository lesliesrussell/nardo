// dashboard command — nardo dashboard start / stop
import type { Command } from 'commander'
import { existsSync, writeFileSync, readFileSync, unlinkSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../config.js'
import { startDashboardServer } from '../../dashboard/server.js'

function pidFile(palace_path: string): string {
  return join(palace_path, '.dashboard.pid')
}

function logFile(palace_path: string): string {
  return join(palace_path, 'dashboard.log')
}

function readPid(palace_path: string): number | null {
  const p = pidFile(palace_path)
  if (!existsSync(p)) return null
  const pid = parseInt(readFileSync(p, 'utf-8').trim(), 10)
  return isNaN(pid) ? null : pid
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function handlePortError(err: unknown, port: number): void {
  const isAddrInUse = err instanceof Error && (err.message.includes('EADDRINUSE') || err.message.includes('in use'))
  if (isAddrInUse) {
    console.error(`\n  error: port ${port} is already in use.`)
    console.error(`  Kill the existing process:  lsof -ti:${port} | xargs kill`)
    console.error(`  Or use a different port:    nardo dashboard start --port ${port + 1}\n`)
    process.exit(1)
  }
}

async function openBrowser(url: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  try {
    if (process.platform === 'darwin') execSync(`open ${url}`)
    else if (process.platform === 'win32') execSync(`start ${url}`)
    else execSync(`xdg-open ${url}`)
  } catch { /* ignore */ }
}

export function registerDashboard(program: Command): void {
  const dashboard = program
    .command('dashboard')
    .description('Manage the nardo web dashboard')

  dashboard
    .command('start')
    .description('Start the dashboard (daemon by default, use --foreground to block)')
    .option('--port <port>', 'Port to listen on', '7432')
    .option('--palace <path>', 'Palace path override')
    .option('--foreground', 'Run in foreground (blocking, Ctrl+C to stop)')
    .action(async (opts: { port: string; palace?: string; foreground?: boolean }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const port = parseInt(opts.port, 10) || 7432

      const existingPid = readPid(palace_path)
      if (existingPid !== null && isRunning(existingPid)) {
        console.error(`\n  error: dashboard already running (pid ${existingPid})`)
        console.error(`  Stop it first:  nardo dashboard stop\n`)
        process.exit(1)
      }

      if (opts.foreground) {
        // If spawned as daemon, write our own PID so parent gets the correct value
        const pidFilePath = process.env.NARDO_DASHBOARD_PID_FILE
        if (pidFilePath) writeFileSync(pidFilePath, String(process.pid))

        let url: string
        let server: ReturnType<typeof import('../../dashboard/server.js').startDashboardServer>['server']
        try {
          ;({ url, server } = startDashboardServer({ palace_path, port }))
        } catch (err) {
          handlePortError(err, port)
          throw err
        }
        console.log(`\n  nardo dashboard`)
        console.log(`  palace: ${palace_path}`)
        console.log(`  url:    ${url}\n`)
        await openBrowser(url)
        console.log('  Press Ctrl+C to stop.\n')
        await new Promise<void>(resolve => process.on('SIGINT', resolve))
        server.stop()
        process.exit(0)
      } else {
        // Daemon: spawn detached child running this same entry point with --foreground
        const { spawn } = await import('node:child_process')
        const pf = pidFile(palace_path)
        const logFd = openSync(logFile(palace_path), 'a')
        const spawnArgs = [process.argv[1], 'dashboard', 'start', '--foreground', '--port', String(port)]
        if (opts.palace) spawnArgs.push('--palace', opts.palace)

        const child = spawn(process.argv[0], spawnArgs, {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, NARDO_DASHBOARD_PID_FILE: pf },
        })
        child.unref()

        // Wait briefly for child to write its own PID, then read it back
        await new Promise(r => setTimeout(r, 300))
        const actualPid = existsSync(pf) ? readFileSync(pf, 'utf-8').trim() : String(child.pid)

        const url = `http://localhost:${port}`
        console.log(`\n  nardo dashboard started`)
        console.log(`  palace: ${palace_path}`)
        console.log(`  url:    ${url}`)
        console.log(`  pid:    ${actualPid}`)
        console.log(`  log:    ${logFile(palace_path)}`)
        console.log(`\n  Stop with: nardo dashboard stop\n`)
        await openBrowser(url)
        process.exit(0)
      }
    })

  dashboard
    .command('stop')
    .description('Stop the running dashboard')
    .option('--palace <path>', 'Palace path override')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      const pid = readPid(palace_path)
      if (pid === null) {
        console.log('\n  nardo dashboard is not running.\n')
        process.exit(0)
      }

      if (!isRunning(pid)) {
        console.log(`\n  nardo dashboard is not running (stale pid ${pid} removed).\n`)
        unlinkSync(pidFile(palace_path))
        process.exit(0)
      }

      process.kill(pid, 'SIGTERM')
      unlinkSync(pidFile(palace_path))
      console.log(`\n  nardo dashboard stopped (pid ${pid}).\n`)
    })
}
