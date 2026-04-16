import { describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  findRepoRoot,
  getDefaultPalacePath,
  getIndexedEmbeddingDimension,
  getProviderEmbeddingDimension,
} from '../src/config.ts'
import { getDefaultWalPath } from '../src/wal.ts'

describe('embedding dimension helpers', () => {
  it('provider dimension follows provider defaults', () => {
    expect(getProviderEmbeddingDimension({ provider: 'xenova' })).toBe(384)
    expect(getProviderEmbeddingDimension({ provider: 'ollama' })).toBe(768)
  })

  it('indexed dimension honors stored config dimension', () => {
    expect(getIndexedEmbeddingDimension({ provider: 'ollama', dimension: 384 })).toBe(384)
    expect(getIndexedEmbeddingDimension({ provider: 'xenova', dimension: 768 })).toBe(768)
  })

  it('indexed dimension falls back to provider default when not stored', () => {
    expect(getIndexedEmbeddingDimension({ provider: 'xenova' })).toBe(384)
    expect(getIndexedEmbeddingDimension({ provider: 'ollama' })).toBe(768)
  })
})

describe('palace path defaults', () => {
  it('uses repo-local .nardo/palace inside a git repo', () => {
    const tmp = join(import.meta.dir, '__config_repo_tmp__')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(tmp, '.git'), { recursive: true })
    mkdirSync(join(tmp, 'nested', 'dir'), { recursive: true })

    expect(findRepoRoot(join(tmp, 'nested', 'dir'))).toBe(tmp)
    expect(getDefaultPalacePath(join(tmp, 'nested', 'dir'))).toBe(
      join(tmp, '.nardo', 'palace'),
    )

    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws outside a git repo', () => {
    expect(() => getDefaultPalacePath('/tmp/not-a-repo')).toThrow(
      'nardo requires a git repository',
    )
  })

  it('uses repo-local .nardo/wal inside a git repo', () => {
    const tmp = join(import.meta.dir, '__config_wal_tmp__')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(tmp, '.git'), { recursive: true })
    mkdirSync(join(tmp, 'nested'), { recursive: true })

    expect(getDefaultWalPath(join(tmp, 'nested'))).toBe(
      join(tmp, '.nardo', 'wal', 'write_log.jsonl'),
    )

    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws wal path outside a git repo', () => {
    expect(() => getDefaultWalPath('/tmp/not-a-repo')).toThrow(
      'nardo requires a git repository',
    )
  })
})
