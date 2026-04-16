// Config loader
import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface NardoConfig {
  palace_path: string
  collection_name: string
  topic_wings: string[]
  hooks: {
    silent_save: boolean
    desktop_toast: boolean
  }
}

const DEFAULTS: NardoConfig = {
  palace_path: join(homedir(), '.nardo', 'palace'),
  collection_name: 'nardo_drawers',
  topic_wings: ['emotions', 'consciousness', 'memory', 'technical', 'identity', 'family', 'creative'],
  hooks: {
    silent_save: true,
    desktop_toast: false,
  },
}

function resolvePalacePath(): string {
  return (
    process.env['NARDO_PALACE_PATH'] ??
    process.env['MEMPAL_PALACE_PATH'] ??
    DEFAULTS.palace_path
  )
}

function loadFileConfig(): Partial<NardoConfig> {
  const configPath = join(homedir(), '.nardo', 'config.json')
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as Partial<NardoConfig>
  } catch {
    return {}
  }
}

export function loadConfig(): NardoConfig {
  const fileConfig = loadFileConfig()
  const palace_path = resolvePalacePath()

  const merged: NardoConfig = {
    ...DEFAULTS,
    ...fileConfig,
    palace_path,
    hooks: {
      ...DEFAULTS.hooks,
      ...(fileConfig.hooks ?? {}),
    },
  }

  mkdirSync(merged.palace_path, { recursive: true })

  return merged
}
