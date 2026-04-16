import { describe, it, expect } from 'bun:test'
import { expandQuery } from '../src/search/expander.js'

describe('expandQuery', () => {
  it('returns original when no synonyms match', () => {
    const result = expandQuery('hello world')
    expect(result.expanded).toBe('hello world')
    expect(result.added_terms).toHaveLength(0)
  })

  it('expands known abbreviation', () => {
    const result = expandQuery('auth')
    expect(result.added_terms.length).toBeGreaterThan(0)
    expect(result.expanded).toContain('auth')
    expect(result.expanded).toContain('authentication')
  })

  it('expands "db" to database-related terms', () => {
    const result = expandQuery('db schema')
    expect(result.expanded).toContain('database')
    expect(result.expanded).toContain('sql')
    // 'schema' already in query, should not be duplicated
    const parts = result.expanded.split(' ')
    const schemaCnt = parts.filter(p => p === 'schema').length
    expect(schemaCnt).toBe(1)
  })

  it('does not duplicate terms already in query', () => {
    const result = expandQuery('auth authentication')
    const parts = result.expanded.split(' ')
    const authCnt = parts.filter(p => p === 'authentication').length
    expect(authCnt).toBe(1)
  })

  it('expands multi-token query with multiple hits', () => {
    const result = expandQuery('auth config')
    expect(result.added_terms.length).toBeGreaterThan(0)
    expect(result.expanded).toContain('authentication')
    expect(result.expanded).toContain('configuration')
  })

  it('is case-insensitive in token matching', () => {
    const lower = expandQuery('auth')
    const upper = expandQuery('AUTH')
    // Both should expand (uppercase tokenized to lowercase)
    expect(lower.added_terms).toEqual(upper.added_terms)
  })

  it('preserves original query at the start of expanded string', () => {
    const result = expandQuery('search embed')
    expect(result.expanded.startsWith('search embed')).toBe(true)
  })

  it('handles empty query gracefully', () => {
    const result = expandQuery('')
    expect(result.expanded).toBe('')
    expect(result.added_terms).toHaveLength(0)
  })
})
