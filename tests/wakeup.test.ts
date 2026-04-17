import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { installWakeupHook } from '../src/wakeup/hooks.ts'
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

  it('creates hook script and settings entry idempotently', () => {
    const first = installWakeupHook(tmpHome)
    expect(existsSync(first.hook_path)).toBe(true)
    expect(existsSync(first.settings_path)).toBe(true)
    expect(readFileSync(first.hook_path, 'utf-8')).toContain('nardo wake-up --json')

    const settings = JSON.parse(readFileSync(first.settings_path, 'utf-8')) as {
      hooks: { SessionStart: Array<{ command: string }> }
    }
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.SessionStart[0]?.command).toBe(first.installed_command)

    const second = installWakeupHook(tmpHome)
    const settingsAgain = JSON.parse(readFileSync(second.settings_path, 'utf-8')) as {
      hooks: { SessionStart: Array<{ command: string }> }
    }
    expect(second.updated_settings).toBe(false)
    expect(settingsAgain.hooks.SessionStart).toHaveLength(1)
  })
})
