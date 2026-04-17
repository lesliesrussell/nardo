import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface InstallHooksResult {
  hook_path: string
  settings_path: string
  installed_command: string
  updated_settings: boolean
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
git_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

PALACE="\${NARDO_PALACE_PATH:-$git_root/.nardo/palace}"

if command -v nardo >/dev/null 2>&1 && [ -d "$PALACE" ]; then
  nardo wake-up --json --wing "$(basename "$PWD")" 2>/dev/null
fi
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

export function installWakeupHook(home = homedir()): InstallHooksResult {
  const { hooks_dir, hook_path, settings_path } = getClaudePaths(home)
  mkdirSync(hooks_dir, { recursive: true })
  writeFileSync(hook_path, getWakeupHookScript(), 'utf-8')
  chmodSync(hook_path, 0o755)

  const settings = loadSettings(settings_path)
  const hooks = (settings.hooks && typeof settings.hooks === 'object')
    ? settings.hooks as Record<string, unknown>
    : {}
  const sessionStart = Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] as Array<Record<string, unknown>> : []
  const installed_command = hook_path
  const exists = sessionStart.some(entry => entry?.command === installed_command)

  const nextSessionStart = exists
    ? sessionStart
    : [...sessionStart, { command: installed_command }]

  const nextSettings = {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: nextSessionStart,
    },
  }

  writeFileSync(settings_path, JSON.stringify(nextSettings, null, 2) + '\n', 'utf-8')

  return {
    hook_path,
    settings_path,
    installed_command,
    updated_settings: !exists,
  }
}
