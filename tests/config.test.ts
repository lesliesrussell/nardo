import { describe, expect, it } from 'bun:test'
import {
  getIndexedEmbeddingDimension,
  getProviderEmbeddingDimension,
} from '../src/config.ts'

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
