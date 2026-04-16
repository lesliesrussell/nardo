import { describe, it, expect } from 'bun:test'
import { sanitizeQuery } from '../src/search/sanitizer.ts'

describe('sanitizeQuery', () => {
  it('short query (<= 200 chars) → passthrough', () => {
    const query = 'what is the memory palace architecture?'
    const result = sanitizeQuery(query)
    expect(result.method).toBe('passthrough')
    expect(result.clean_query).toBe(query)
    expect(result.was_sanitized).toBe(false)
    expect(result.original_length).toBe(query.length)
    expect(result.clean_length).toBe(query.length)
  })

  it('long query with question mark → question_extraction', () => {
    // Build a long query: system prompt prefix + question at the end
    const systemPrompt = 'You are a helpful assistant. ' + 'a'.repeat(180) + '. '
    const question = 'What is the search algorithm used here?'
    const raw = systemPrompt + question
    expect(raw.length).toBeGreaterThan(200)

    const result = sanitizeQuery(raw)
    expect(result.method).toBe('question_extraction')
    expect(result.clean_query).toBe(question)
    expect(result.was_sanitized).toBe(true)
  })

  it('long query no question → tail_sentence', () => {
    // Long text with no question marks, last sentence is short enough
    const prefix = 'This is a long system prompt with lots of instructions. ' + 'b'.repeat(160) + '. '
    const tail = 'Find documents about memory architecture'
    const raw = prefix + tail
    expect(raw.length).toBeGreaterThan(200)

    const result = sanitizeQuery(raw)
    expect(result.method).toBe('tail_sentence')
    expect(result.clean_query).toBe(tail)
    expect(result.was_sanitized).toBe(true)
  })

  it('very long query with no suitable sentences → tail_truncation', () => {
    // One giant run-on string with no sentence delimiters, > 200 chars
    const raw = 'x'.repeat(300)
    const result = sanitizeQuery(raw)
    expect(result.method).toBe('tail_truncation')
    expect(result.clean_query).toBe(raw.slice(-250))
    expect(result.clean_length).toBe(250)
    expect(result.was_sanitized).toBe(true)
  })

  it('was_sanitized is false for passthrough, true otherwise', () => {
    const short = sanitizeQuery('hello world query')
    expect(short.was_sanitized).toBe(false)

    const long = sanitizeQuery('x'.repeat(300))
    expect(long.was_sanitized).toBe(true)
  })
})
