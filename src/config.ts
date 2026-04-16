// Config loader
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export interface NardoConfig {
  palace_path: string
  collection_name: string
  topic_wings: string[]
  palace: {
    backend: 'sqlite' | 'dolt'
    dolt_database: string
  }
  mining: {
    auto_kg: boolean
  }
  embedding: {
    provider: 'xenova' | 'ollama'
    ollama_url: string
    model: string
    // Dimension currently materialized in the on-disk HNSW indexes.
    dimension?: number
  }
  hooks: {
    silent_save: boolean
    desktop_toast: boolean
  }
}

const DEFAULTS_WITHOUT_PALACE: Omit<NardoConfig, 'palace_path'> = {
  collection_name: 'nardo_drawers',
  topic_wings: ['emotions', 'consciousness', 'memory', 'technical', 'identity', 'family', 'creative'],
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
  hooks: {
    silent_save: true,
    desktop_toast: false,
  },
}

export function findRepoRoot(startDir = process.cwd()): string | null {
  let current = resolve(startDir)

  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function getDefaultPalacePath(startDir = process.cwd()): string {
  const repoRoot = findRepoRoot(startDir)
  if (repoRoot) {
    return join(repoRoot, '.nardo', 'palace')
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

function resolvePalacePath(): string {
  return (
    process.env['NARDO_PALACE_PATH'] ??
    process.env['MEMPAL_PALACE_PATH'] ??
    getDefaultPalacePath()
  )
}

export function getConfigPath(): string | null {
  const repoRoot = findRepoRoot()
  if (!repoRoot) return null
  return join(repoRoot, '.nardo', 'config.json')
}

function loadRawFileConfig(): Partial<NardoConfig> {
  const configPath = getConfigPath()
  if (!configPath) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as Partial<NardoConfig>
  } catch {
    return {}
  }
}

export function loadConfig(): NardoConfig {
  const fileConfig = loadRawFileConfig()
  const palace_path = resolvePalacePath()

  const backendEnv = process.env['NARDO_BACKEND']
  const backendOverride: Partial<NardoConfig['palace']> =
    backendEnv === 'sqlite' || backendEnv === 'dolt' ? { backend: backendEnv } : {}

  const merged: NardoConfig = {
    ...DEFAULTS_WITHOUT_PALACE,
    ...fileConfig,
    palace_path,
    palace: {
      ...DEFAULTS_WITHOUT_PALACE.palace,
      ...(fileConfig.palace ?? {}),
      ...backendOverride,
    },
    mining: {
      ...DEFAULTS_WITHOUT_PALACE.mining,
      ...(fileConfig.mining ?? {}),
    },
    embedding: {
      ...DEFAULTS_WITHOUT_PALACE.embedding,
      ...(fileConfig.embedding ?? {}),
    },
    hooks: {
      ...DEFAULTS_WITHOUT_PALACE.hooks,
      ...(fileConfig.hooks ?? {}),
    },
  }

  mkdirSync(merged.palace_path, { recursive: true })

  return merged
}

export function saveConfig(config: NardoConfig): void {
  const configPath = getConfigPath()
  if (!configPath) {
    throw new Error('Cannot save config: not inside a git repository.')
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function getDefaultEmbeddingDimension(provider: 'xenova' | 'ollama'): number {
  return provider === 'ollama' ? 768 : 384
}

export function getProviderEmbeddingDimension(
  embedding: Partial<NardoConfig['embedding']> | undefined,
): number {
  return getDefaultEmbeddingDimension(embedding?.provider ?? DEFAULTS_WITHOUT_PALACE.embedding.provider)
}

export function getIndexedEmbeddingDimension(
  embedding: Partial<NardoConfig['embedding']> | undefined,
): number {
  if (typeof embedding?.dimension === 'number' && embedding.dimension > 0) {
    return embedding.dimension
  }

  return getProviderEmbeddingDimension(embedding)
}
