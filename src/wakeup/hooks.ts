import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { execSync } from 'child_process'

export interface InstallHooksResult {
  hook_path: string
  global_settings_path: string
  installed_command: string
  updated_global: boolean
}

export interface SetupProjectResult {
  project_settings_path: string
  updated_hook: boolean
}

export function getClaudePaths(home = homedir()): {
  claude_dir: string
  hooks_dir: string
  hook_path: string
  settings_path: string
} {
  const claude_dir = join(home, '.claude')
  const hooks_dir = join(claude_dir, 'hooks')
  return {
    claude_dir,
    hooks_dir,
    hook_path: join(hooks_dir, 'nardo_wakeup.sh'),
    settings_path: join(claude_dir, 'settings.json'),
  }
}

export function getWakeupHookScript(): string {
  return `#!/bin/bash
# Expand PATH so nardo is findable regardless of how Claude Code launches the hook
export PATH="$PATH:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin"

git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

PALACE="\${NARDO_PALACE_PATH:-$git_root/.nardo/palace}"

if ! command -v nardo >/dev/null 2>&1; then
  echo "nardo: not found in PATH — skipping wake-up (run 'nardo install-hooks' after installing)"
  exit 0
fi

if [ ! -d "$PALACE" ]; then
  echo "nardo: no palace found — run 'nardo mine . --wing $(basename "$git_root")' to index this repo"
  exit 0
fi

echo "nardo: loading memory..."
nardo wake-up --wing "$(basename "$git_root")"
`
}

function loadSettings(settings_path: string): Record<string, unknown> {
  if (!existsSync(settings_path)) return {}
  try {
    return JSON.parse(readFileSync(settings_path, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function injectHookEntry(settings_path: string, hook_command: string): boolean {
  const settings = loadSettings(settings_path)
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const sessionStart = Array.isArray(hooks['SessionStart'])
    ? hooks['SessionStart'] as Array<Record<string, unknown>>
    : []

  // Check if already present in any entry
  const exists = sessionStart.some(entry => {
    const entryHooks = Array.isArray(entry?.hooks) ? entry.hooks as Array<Record<string, unknown>> : []
    return entryHooks.some(h => h?.command === hook_command)
  })
  if (exists) return false

  // Merge into first entry's hooks array (Claude Code only runs the first matching entry)
  const newHook = { type: 'command', command: hook_command }
  let nextSessionStart: Array<Record<string, unknown>>
  if (sessionStart.length > 0 && Array.isArray(sessionStart[0]?.hooks)) {
    const first = { ...sessionStart[0], hooks: [...(sessionStart[0].hooks as Array<Record<string, unknown>>), newHook] }
    nextSessionStart = [first, ...sessionStart.slice(1)]
  } else {
    nextSessionStart = [{ matcher: '', hooks: [newHook] }]
  }

  mkdirSync(dirname(settings_path), { recursive: true })
  writeFileSync(settings_path, JSON.stringify({ ...settings, hooks: { ...hooks, SessionStart: nextSessionStart } }, null, 2) + '\n', 'utf-8')
  return true
}

function resolveNardoPath(): string {
  try {
    return execSync('which nardo', { encoding: 'utf-8' }).trim()
  } catch {
    return 'nardo'
  }
}

function registerMcpGlobal(nardo_path: string): void {
  try {
    execSync(`claude mcp add --scope user nardo ${nardo_path} -- mcp --serve`, { stdio: 'pipe' })
  } catch {
    // already registered or claude not in PATH — not fatal
  }
}

export function installWakeupHook(home = homedir()): InstallHooksResult {
  const { hooks_dir, hook_path, settings_path: global_settings_path } = getClaudePaths(home)

  mkdirSync(hooks_dir, { recursive: true })
  writeFileSync(hook_path, getWakeupHookScript(), 'utf-8')
  chmodSync(hook_path, 0o755)

  const updated_global = injectHookEntry(global_settings_path, hook_path)
  registerMcpGlobal(resolveNardoPath())

  return {
    hook_path,
    global_settings_path,
    installed_command: hook_path,
    updated_global,
  }
}

export function setupProject(cwd = process.cwd()): SetupProjectResult {
  const { hook_path } = getClaudePaths()
  const project_settings_path = join(cwd, '.claude', 'settings.json')
  mkdirSync(join(cwd, '.claude'), { recursive: true })

  const updated_hook = injectHookEntry(project_settings_path, hook_path)

  return { project_settings_path, updated_hook }
}
