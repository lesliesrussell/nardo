// split command — split a multi-session JSONL file into per-session files
import type { Command } from 'commander'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'

export function registerSplit(program: Command): void {
  program
    .command('split <file>')
    .description('Split a JSONL file with multiple conversations into per-session files')
    .option('--output-dir <dir>', 'Output directory (default: same dir as input file)')
    .action((file: string, opts: { outputDir?: string }) => {
      if (!existsSync(file)) {
        console.error(`File not found: ${file}`)
        process.exit(1)
      }

      const raw = readFileSync(file, 'utf-8')
      const lines = raw.split('\n').filter(line => line.trim() !== '')

      const outputDir = opts.outputDir ?? dirname(file)
      mkdirSync(outputDir, { recursive: true })

      const sessions: string[][] = []
      let currentSession: string[] = []

      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // Non-JSON line — append to current session
          currentSession.push(line)
          continue
        }

        const obj = parsed as Record<string, unknown>

        // Detect session boundary:
        // 1. type === "system" (Claude/Anthropic format new conversation marker)
        // 2. Root object is a UUID-keyed map (ChatGPT format)
        const isSystemMessage = obj['type'] === 'system'
        const isChatGPTRoot = isChatGPTFormat(obj)
        const isNewConversation = isSystemMessage || isChatGPTRoot

        if (isNewConversation && currentSession.length > 0) {
          sessions.push(currentSession)
          currentSession = []
        }

        currentSession.push(line)
      }

      if (currentSession.length > 0) {
        sessions.push(currentSession)
      }

      if (sessions.length === 0) {
        console.log('No sessions found.')
        return
      }

      const baseName = basename(file, '.jsonl')
      for (let i = 0; i < sessions.length; i++) {
        const sessionNum = String(i + 1).padStart(3, '0')
        const outFile = join(outputDir, `${baseName}_session_${sessionNum}.jsonl`)
        writeFileSync(outFile, sessions[i].join('\n') + '\n', 'utf-8')
      }

      console.log(`Split into ${sessions.length} files in ${outputDir}`)
    })
}

// Detect ChatGPT export format: root object has UUID keys mapping to objects
function isChatGPTFormat(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj)
  if (keys.length === 0) return false
  // UUID pattern: 8-4-4-4-12 hex chars
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return keys.every(k => uuidRe.test(k))
}
