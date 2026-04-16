export function detectRoom(
  filePath: string,
  content: string,
  rooms: Record<string, { keywords: string[] }>,
): string {
  const pathLower = filePath.toLowerCase()
  const pathParts = pathLower.split(/[/\\]/)

  // Priority 1: folder path match
  for (const [room, _config] of Object.entries(rooms)) {
    const roomLower = room.toLowerCase()
    // Check if any path segment (excluding the filename) matches the room
    const dirParts = pathParts.slice(0, -1)
    if (dirParts.some(p => p === roomLower || p.includes(roomLower))) {
      return room
    }
  }

  // Priority 2: filename match
  const filename = pathParts[pathParts.length - 1] ?? ''
  for (const [room, _config] of Object.entries(rooms)) {
    const roomLower = room.toLowerCase()
    if (filename.includes(roomLower)) {
      return room
    }
  }

  // Priority 3: keyword scoring against content[:2000]
  const sample = content.slice(0, 2000).toLowerCase()
  let bestRoom = 'general'
  let bestScore = 0

  for (const [room, config] of Object.entries(rooms)) {
    let score = 0
    for (const kw of config.keywords) {
      const kwLower = kw.toLowerCase()
      let pos = 0
      while ((pos = sample.indexOf(kwLower, pos)) !== -1) {
        score++
        pos += kwLower.length
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestRoom = room
    }
  }

  return bestRoom
}
