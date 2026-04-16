import { describe, it, expect } from 'bun:test'
import { detectRoom } from '../src/mining/room-detector.ts'

const rooms = {
  architecture: { keywords: ['design', 'pattern', 'system', 'component'] },
  bugs: { keywords: ['error', 'fix', 'crash', 'null', 'undefined'] },
  general: { keywords: [] },
}

describe('detectRoom', () => {
  it('configured folder match wins over path inference', () => {
    const content = 'error crash fix null undefined error crash fix null undefined'
    // Path contains 'architecture' folder → configured room wins even though keywords favor 'bugs'
    const room = detectRoom('src/architecture/design.md', content, rooms)
    expect(room).toBe('architecture')
  })

  it('configured filename match when no folder match', () => {
    const content = 'some unrelated content without any keywords'
    const room = detectRoom('src/code/bugs_report.txt', content, rooms)
    expect(room).toBe('bugs')
  })

  it('keyword scoring fires when path is under a transparent segment', () => {
    // src/ is transparent → inferRoomFromPath returns null → falls through to keyword scoring
    const content = 'The design pattern for the system component is crucial. The component design matters.'
    const room = detectRoom('src/random.md', content, rooms)
    expect(room).toBe('architecture')
  })

  it('general fallback when path is transparent and no keywords match', () => {
    const content = 'weather is nice today in the park'
    const room = detectRoom('src/entry.txt', content, rooms)
    expect(room).toBe('general')
  })

  it('keyword scoring with no keywords returns general', () => {
    const content = 'some content here'
    const emptyRooms = { myroom: { keywords: [] } }
    // src/ is transparent → infer returns null → keyword scoring → no match → general
    const room = detectRoom('src/z.txt', content, emptyRooms)
    expect(room).toBe('general')
  })

  it('auto-infers room from directory structure with no rooms config', () => {
    const noRooms = {}
    expect(detectRoom('src/search/hybrid.ts', '', noRooms)).toBe('search')
    expect(detectRoom('src/cli/commands/mine.ts', '', noRooms)).toBe('cli')
    expect(detectRoom('src/palace/client.ts', '', noRooms)).toBe('palace')
    expect(detectRoom('tests/e2e.test.ts', '', noRooms)).toBe('tests')
    expect(detectRoom('src/config.ts', '', noRooms)).toBe('general')
    expect(detectRoom('README.md', '', noRooms)).toBe('general')
  })
})
