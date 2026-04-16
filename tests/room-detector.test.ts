import { describe, it, expect } from 'bun:test'
import { detectRoom } from '../src/mining/room-detector.ts'

const rooms = {
  architecture: { keywords: ['design', 'pattern', 'system', 'component'] },
  bugs: { keywords: ['error', 'fix', 'crash', 'null', 'undefined'] },
  general: { keywords: [] },
}

describe('detectRoom', () => {
  it('folder path match wins over keywords', () => {
    const content = 'error crash fix null undefined error crash fix null undefined'
    // Path contains 'architecture' folder → should match 'architecture' even though keywords favor 'bugs'
    const room = detectRoom('/home/user/architecture/design.md', content, rooms)
    expect(room).toBe('architecture')
  })

  it('filename match when no folder match', () => {
    const content = 'some unrelated content without any keywords'
    const room = detectRoom('/home/user/code/bugs_report.txt', content, rooms)
    expect(room).toBe('bugs')
  })

  it('keyword scoring fallback picks highest score', () => {
    // No path match, content heavily favors 'architecture' keywords
    const content = 'The design pattern for the system component is crucial. The component design matters.'
    const room = detectRoom('/home/user/notes/random.md', content, rooms)
    expect(room).toBe('architecture')
  })

  it('general fallback when no match', () => {
    const content = 'weather is nice today in the park'
    const room = detectRoom('/home/user/journal/entry.txt', content, rooms)
    expect(room).toBe('general')
  })

  it('keyword scoring with no keywords returns general', () => {
    const content = 'some content here'
    const emptyRooms = { myroom: { keywords: [] } }
    const room = detectRoom('/x/y/z.txt', content, emptyRooms)
    // No folder match, no filename match, no keywords → bestScore stays 0
    expect(room).toBe('general')
  })
})
