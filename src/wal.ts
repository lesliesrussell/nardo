// Write-ahead log
import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { findRepoRoot } from './config.js'

export function getDefaultWalPath(startDir = process.cwd()): string {
  const repoRoot = findRepoRoot(startDir)
  if (repoRoot) {
    return join(repoRoot, '.nardo', 'wal', 'write_log.jsonl')
  }
  throw new Error(
    'nardo: not inside a git repository.\n\n' +
    'By default, nardo stores your palace at <repo-root>/.nardo/palace.\n' +
    'To use nardo outside a git repo, point it at a fixed location:\n\n' +
    '  export NARDO_PALACE_PATH=~/.nardo/palace\n' +
    '  nardo status\n\n' +
    'Add that export to your shell profile (~/.zshrc or ~/.bashrc) to make it permanent.',
  )
}

const REDACT_KEYS = new Set([
  'content',
  'content_preview',
  'document',
  'entry',
  'query',
  'text',
])

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_KEYS.has(key) && typeof value === 'string') {
      out[key] = `[REDACTED ${value.length} chars]`
    } else {
      out[key] = value
    }
  }
  return out
}

export async function logWrite(
  operation: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const walPath = getDefaultWalPath()
  mkdirSync(dirname(walPath), { recursive: true })

  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    params: redact(params),
    result: redact(result),
  }

  appendFileSync(walPath, JSON.stringify(entry) + '\n', 'utf-8')
}
