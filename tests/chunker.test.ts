import { describe, it, expect } from 'bun:test'
import { chunkFile, chunkText } from '../src/mining/chunker.ts'

describe('chunkText', () => {
  it('basic chunking with known input', () => {
    const text = 'a'.repeat(2000)
    const chunks = chunkText(text, 800, 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].text.length).toBe(800)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].end).toBe(800)
  })

  it('overlap between consecutive chunks', () => {
    const text = 'x'.repeat(2000)
    const chunks = chunkText(text, 800, 100)
    // second chunk starts at 800 - 100 = 700
    expect(chunks[1].start).toBe(700)
    // The overlapping region: chars 700-800 appear in both chunk[0] and chunk[1]
    const overlap = chunks[0].text.slice(-100)
    const start = chunks[1].text.slice(0, 100)
    expect(overlap).toBe(start)
  })

  it('skips chunks shorter than minChunk', () => {
    // 810 chars: first chunk is 800, remainder is 10 which is < minChunk=50
    const text = 'b'.repeat(810)
    const chunks = chunkText(text, 800, 100, 50)
    // Second chunk would start at 700, end at min(1500,810)=810, length=110 >= 50 → included
    // Third chunk would start at 810 (end of text) → loop breaks
    expect(chunks.every(c => c.text.length >= 50)).toBe(true)
  })

  it('single short text returns one chunk', () => {
    const text = 'Hello world, this is a short text.'
    const chunks = chunkText(text, 800, 100, 10)
    expect(chunks.length).toBe(1)
    expect(chunks[0].text).toBe(text)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].end).toBe(text.length)
  })

  it('empty text returns no chunks', () => {
    expect(chunkText('')).toEqual([])
  })

  it('chunk indices are sequential', () => {
    const text = 'z'.repeat(3000)
    const chunks = chunkText(text, 800, 100)
    chunks.forEach((c, i) => expect(c.index).toBe(i))
  })

  it('fixed chunking prefers sentence boundaries near the end', () => {
    const text = 'A short sentence. Another sentence ends here. Final sentence.'
    const chunks = chunkText(text, 30, 5, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].text.endsWith('.')).toBe(true)
  })
})

describe('chunkFile', () => {
  it('chunks markdown on heading boundaries', () => {
    const text = [
      '# One',
      'Alpha '.repeat(180),
      '',
      '## Two',
      'Beta '.repeat(180),
      '',
      '## Three',
      'Gamma '.repeat(180),
    ].join('\n')
    const chunks = chunkFile(text, 'notes.md')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].text.startsWith('# One')).toBe(true)
    expect(chunks.some(chunk => chunk.text.startsWith('## Two'))).toBe(true)
  })

  it('chunks code on function boundaries', () => {
    const text = [
      'function alpha() {',
      `  return "${'a'.repeat(700)}"`,
      '}',
      '',
      'function beta() {',
      `  return "${'b'.repeat(700)}"`,
      '}',
    ].join('\n')

    const chunks = chunkFile(text, 'example.ts')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].text.startsWith('function alpha')).toBe(true)
    expect(chunks[1].text.startsWith('function beta')).toBe(true)
  })
})
