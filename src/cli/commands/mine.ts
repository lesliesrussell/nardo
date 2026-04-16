// mine command
import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { mineDirectory } from '../../mining/file-miner.js'
import { mineConversation } from '../../mining/convo-miner.js'
import { readNardoYaml } from '../../mining/yaml-reader.js'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

export function registerMine(program: Command): void {
  program
    .command('mine <path>')
    .description('Mine project files or conversations into the palace')
    .option('--palace <path>', 'Palace path override')
    .option('--wing <wing>', 'Wing name override')
    .option('--mode <mode>', 'Ingest mode: project or convos', 'project')
    .option('--agent <name>', 'Agent name for audit trail', 'cli')
    .option('--limit <n>', 'Mine only first N files')
    .option('--dry-run', 'Preview without writing')
    .option('--no-gitignore', 'Ignore .gitignore patterns')
    .option('--include-ignored <paths>', 'Force-include paths (comma-separated)')
    .action(
      async (
        targetPath: string,
        opts: {
          palace?: string
          wing?: string
          mode: string
          agent: string
          limit?: string
          dryRun?: boolean
          gitignore: boolean
          includeIgnored?: string
        },
      ) => {
        const config = loadConfig()
        const palace_path = opts.palace ?? config.palace_path
        const dry_run = opts.dryRun ?? false
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined
        const include_ignored = opts.includeIgnored
          ? opts.includeIgnored.split(',').map(s => s.trim())
          : []

        console.log(`Mining: ${targetPath}`)
        console.log(`Palace: ${palace_path}`)
        console.log(`Mode: ${opts.mode}`)

        if (opts.mode === 'convos') {
          // Mine conversation files
          const wing = opts.wing ?? 'conversations'
          console.log(`Wing: ${wing}`)
          console.log()

          let files: string[] = []
          try {
            const stat = statSync(targetPath)
            if (stat.isDirectory()) {
              const entries = readdirSync(targetPath)
              files = entries
                .filter(e => e.endsWith('.json') || e.endsWith('.md') || e.endsWith('.txt'))
                .map(e => join(targetPath, e))
            } else {
              files = [targetPath]
            }
          } catch (err) {
            console.error('Error reading path:', err)
            process.exit(1)
          }

          if (limit !== undefined) files = files.slice(0, limit)

          let totalDrawers = 0
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i]
            const filename = filePath.split('/').pop() ?? filePath
            const result = await mineConversation(filePath, {
              palace_path,
              wing,
              room: 'conversations',
              agent: opts.agent,
              dry_run,
            })
            console.log(
              `  [${String(i + 1).padStart(3, ' ')}/${files.length}] ${filename.padEnd(30)} → ${result.drawers} drawers`,
            )
            totalDrawers += result.drawers
          }

          console.log()
          console.log(`Filed: ${totalDrawers} drawers`)
        } else {
          // Project mode
          let nardoYaml = null
          try {
            nardoYaml = await readNardoYaml(targetPath)
          } catch {
            // no yaml
          }

          const wing = opts.wing ?? nardoYaml?.wing ?? targetPath.split('/').pop() ?? 'project'
          const rooms = nardoYaml?.rooms ?? {}

          console.log(`Wing: ${wing}`)
          if (dry_run) console.log('(dry run)')
          if (nardoYaml) console.log('Reading nardo.yaml...')
          console.log()

          const result = await mineDirectory(targetPath, {
            palace_path,
            wing,
            rooms,
            agent: opts.agent,
            limit,
            dry_run,
            include_ignored,
          })

          console.log()
          console.log(`Filed: ${result.drawers} drawers`)
          console.log(`Files: ${result.files}`)
        }
      },
    )
}
