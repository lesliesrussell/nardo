import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export interface InstallHooksResult {
  hook_path: string
  global_settings_path: string
  project_settings_path: string | null
  installed_command: string
  updated_global: boolean
  updated_project: boolean
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

  const exists = sessionStart.some(entry => {
    const entryHooks = Array.isArray(entry?.hooks) ? entry.hooks as Array<Record<string, unknown>> : []
    return entryHooks.some(h => h?.command === hook_command)
  })

  if (exists) return false

  const nextSettings = {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: [
        ...sessionStart,
        { matcher: '', hooks: [{ type: 'command', command: hook_command }] },
      ],
    },
  }

  mkdirSync(dirname(settings_path), { recursive: true })
  writeFileSync(settings_path, JSON.stringify(nextSettings, null, 2) + '\n', 'utf-8')
  return true
}

export function installWakeupHook(home = homedir(), cwd = process.cwd()): InstallHooksResult {
  const { hooks_dir, hook_path, settings_path: global_settings_path } = getClaudePaths(home)

  mkdirSync(hooks_dir, { recursive: true })
  writeFileSync(hook_path, getWakeupHookScript(), 'utf-8')
  chmodSync(hook_path, 0o755)

  const updated_global = injectHookEntry(global_settings_path, hook_path)

  // Also inject into project-level .claude/settings.json if it exists or if we're in a git repo
  const project_settings_path = join(cwd, '.claude', 'settings.json')
  let updated_project = false
  if (existsSync(project_settings_path)) {
    updated_project = injectHookEntry(project_settings_path, hook_path)
  }

  return {
    hook_path,
    global_settings_path,
    project_settings_path: existsSync(project_settings_path) ? project_settings_path : null,
    installed_command: hook_path,
    updated_global,
    updated_project,
  }
}
