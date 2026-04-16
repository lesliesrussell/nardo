// init command
import type { Command } from 'commander'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as readline from 'readline'
import { detectEntities } from '../../entity/detector.js'
import { dump } from 'js-yaml'

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

function detectRoomsFromFolders(dir: string): string[] {
  const rooms: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== '__pycache__'
      ) {
        rooms.push(entry.name)
      }
    }
  } catch {
    // ignore
  }
  return rooms
}

function sampleFiles(dir: string, maxFiles = 20): string[] {
  const results: string[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (entry.isDirectory()) continue
      const ext = entry.name.split('.').pop() ?? ''
      if (['md', 'txt', 'py', 'ts', 'js'].includes(ext)) {
        results.push(join(dir, entry.name))
      }
    }
  } catch {
    // ignore
  }
  return results
}

export function registerInit(program: Command): void {
  program
    .command('init <dir>')
    .description('Initialize a new palace for a project')
    .action(async (dir: string) => {
      console.log(`  Scanning for entities in: ${dir}`)

      const files = sampleFiles(dir)
      console.log(`  Reading ${files.length} files...`)

      // Detect entities from sampled files
      let combinedContent = ''
      for (const f of files) {
        try {
          combinedContent += readFileSync(f, 'utf-8').slice(0, 2000) + '\n'
        } catch {
          // skip unreadable
        }
      }

      const detected = detectEntities(combinedContent)
      const people = detected.filter(e => e.type === 'person').map(e => e.name)
      const projects = detected.filter(e => e.type === 'project').map(e => e.name)

      console.log('  Detected:')
      if (people.length > 0) console.log(`    People: ${people.join(', ')}`)
      if (projects.length > 0) console.log(`    Projects: ${projects.join(', ')}`)
      if (people.length === 0 && projects.length === 0) console.log('    (none)')
      console.log()

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

      const confirmEntities = await prompt(rl, '  Confirm entities? [Y/n] ')
      if (confirmEntities.toLowerCase() === 'n') {
        rl.close()
        console.log('  Aborted.')
        return
      }

      const confirmRooms = await prompt(rl, '  Detect rooms from folder structure? [Y/n] ')
      rl.close()

      const rooms: Record<string, { keywords: string[] }> = {}

      if (confirmRooms.toLowerCase() !== 'n') {
        const detected_rooms = detectRoomsFromFolders(dir)
        for (const r of detected_rooms) {
          console.log(`  Room detected: ${r}`)
          rooms[r] = { keywords: [r] }
        }
      }

      // Determine wing name from directory
      const wing = dir.split('/').pop() ?? 'project'

      // Write nardo.yaml
      const yamlPath = join(dir, 'nardo.yaml')
      const yamlContent = dump({ wing, rooms })
      writeFileSync(yamlPath, yamlContent, 'utf-8')
      console.log()
      console.log(`  Created: ${yamlPath}`)

      // Create ~/.nardo/config.json if missing
      const configDir = join(homedir(), '.nardo')
      const configPath = join(configDir, 'config.json')
      if (!existsSync(configPath)) {
        mkdirSync(configDir, { recursive: true })
        const defaultConfig = {
          palace_path: join(configDir, 'palace'),
          collection_name: 'nardo_drawers',
          palace: {
            backend: 'sqlite',
            dolt_database: 'nardo',
          },
          mining: {
            auto_kg: true,
          },
          embedding: {
            provider: 'xenova',
            ollama_url: 'http://localhost:11434',
            model: 'nomic-embed-text',
            dimension: 384,
          },
        }
        writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
        console.log(`  Created: ${configPath}`)
      }
    })
}
