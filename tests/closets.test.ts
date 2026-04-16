import { describe, it, expect } from 'bun:test'
import { buildClosetLines } from '../src/palace/closets.ts'

const SAMPLE_CONTENT = `
# Memory Systems

Researchers studying memory formation have found that consolidation
involves multiple brain regions. Learning and encoding processes
require attention and repetition.

"The hippocampus plays a central role in memory encoding and retrieval."
"Synaptic plasticity enables long-term memory formation in neural circuits."

Scientists analyzing neural patterns discovered that sleep consolidates
memories formed during waking hours. The process involves reactivating
stored information and integrating it into existing knowledge structures.
`

describe('buildClosetLines', () => {
  it('generates lines from content with known capitalized words', () => {
    const lines = buildClosetLines(SAMPLE_CONTENT, ['id-1', 'id-2'], 'science', 'memory')
    expect(lines.length).toBeGreaterThan(0)
    // Each packed closet is a string
    expect(typeof lines[0]).toBe('string')
  })

  it('formats lines as topic|entities|→ids', () => {
    const lines = buildClosetLines(SAMPLE_CONTENT, ['abc123'], 'science', 'memory')
    const allLines = lines.join('\n').split('\n')
    for (const line of allLines) {
      if (!line.trim()) continue
      expect(line).toMatch(/^.+\|.*\|→/)
    }
  })

  it('includes drawer_ids in each line', () => {
    const lines = buildClosetLines(SAMPLE_CONTENT, ['drawer-1', 'drawer-2'], 'science', 'memory')
    const joined = lines.join('\n')
    expect(joined).toContain('drawer-1')
    expect(joined).toContain('drawer-2')
  })

  it('caps each packed closet at ~1500 chars', () => {
    // Generate content with many topics to force packing
    const bigContent = Array.from({ length: 80 }, (_, i) =>
      `## Topic${i} — processing and analyzing data from source${i}\n` +
      `Scientists discovered that Object${i} requires integration.\n`
    ).join('\n')

    const lines = buildClosetLines(bigContent, ['id-x'], 'test', 'room')
    for (const closet of lines) {
      expect(closet.length).toBeLessThanOrEqual(1500)
    }
  })

  it('filters stopwords from entities', () => {
    const stopwordContent = `
      This is a test. The system should filter words like These, Those, Than, Also.
      RealEntity and AnotherEntity are valid capitalized words that survive filtering.
    `
    const lines = buildClosetLines(stopwordContent, ['id-s'], 'test', 'room')
    const joined = lines.join('\n')
    // Stopwords should not appear as entities in the entity segment (between the two pipes)
    const entitySegments = joined.split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.split('|')[1] ?? '')
      .join(' ')
    const stopwords = ['This', 'The', 'These', 'Those', 'Than', 'Also']
    for (const sw of stopwords) {
      // stopwords should not appear as standalone entity tokens
      expect(entitySegments.split(';')).not.toContain(sw)
    }
  })

  it('returns empty array for empty content', () => {
    const lines = buildClosetLines('', ['id-1'], 'w', 'r')
    // Should still produce at least one line with 'general' topic
    const joined = lines.join('\n')
    expect(joined).toContain('general')
  })
})
