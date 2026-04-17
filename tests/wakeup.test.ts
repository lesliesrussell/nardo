import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { installWakeupHook, setupProject } from '../src/wakeup/hooks.ts'
import { renderWakeupText } from '../src/wakeup/render.ts'

describe('renderWakeupText', () => {
  it('renders full wake-up text with L0 and L1', () => {
    const text = renderWakeupText({
      palace_path: '/tmp/palace',
      wing: 'proj',
      l0: 'identity',
      l1: 'story',
    })

    expect(text).toContain('L0 — IDENTITY')
    expect(text).toContain('identity')
    expect(text).toContain('L1 — ESSENTIAL STORY')
    expect(text).toContain('story')
  })

  it('renders quiet mode as L0 only', () => {
    const text = renderWakeupText({
      palace_path: '/tmp/palace',
      l0: 'identity-only',
    }, true)

    expect(text).toBe('identity-only')
  })
})

describe('installWakeupHook', () => {
  const tmpHome = `/tmp/nardo-hooks-${Date.now()}`

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates hook script and global settings entry idempotently', () => {
    const first = installWakeupHook(tmpHome)
    expect(existsSync(first.hook_path)).toBe(true)
    expect(existsSync(first.global_settings_path)).toBe(true)
    expect(readFileSync(first.hook_path, 'utf-8')).toContain('nardo wake-up')

    const settings = JSON.parse(readFileSync(first.global_settings_path, 'utf-8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    }
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(first.installed_command)
    expect(settings.hooks.SessionStart[0]?.hooks[0]?.type).toBe('command')

    const second = installWakeupHook(tmpHome)
    const settingsAgain = JSON.parse(readFileSync(second.global_settings_path, 'utf-8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    }
    expect(second.updated_global).toBe(false)
    expect(settingsAgain.hooks.SessionStart).toHaveLength(1)
  })

  it('setupProject writes hook and mcp into project settings idempotently', () => {
    const projectDir = join(tmpHome, 'myproject')
    mkdirSync(join(projectDir, '.claude'), { recursive: true })

    const first = setupProject(projectDir)
    expect(existsSync(first.project_settings_path)).toBe(true)
    expect(first.updated_hook).toBe(true)
    expect(first.updated_mcp).toBe(true)

    const settings = JSON.parse(readFileSync(first.project_settings_path, 'utf-8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
      mcpServers: { nardo: { command: string; args: string[] } }
    }
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.mcpServers.nardo.args).toEqual(['mcp', '--serve'])

    const second = setupProject(projectDir)
    expect(second.updated_hook).toBe(false)
    expect(second.updated_mcp).toBe(false)
  })
})
