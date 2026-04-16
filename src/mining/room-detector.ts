// Segments that add no useful room information — strip them when inferring from path
const TRANSPARENT_SEGMENTS = new Set([
  'src', 'lib', 'app', 'packages', 'source', 'pkg', 'dist', 'build',
  'main', 'core', 'common', 'shared', 'internal', 'modules',
])

/**
 * Infer a room name directly from the file path.
 * Strips common top-level containers (src/, lib/, etc.) and uses the first
 * meaningful subdirectory. Returns null if the file is at the top level
 * with no useful subdir (e.g. README.md at repo root).
 */
function inferRoomFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  // Take only the directory portion, drop the filename
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash < 0) return null  // top-level file, no directory

  const dirPath = normalized.slice(0, lastSlash).toLowerCase()
  const parts = dirPath.split('/').filter(Boolean)

  // Walk forward, skipping transparent segments, and return the first useful one
  for (const part of parts) {
    if (!TRANSPARENT_SEGMENTS.has(part) && part !== '') {
      return part
    }
  }

  return null  // file lives directly under a transparent segment (e.g. src/index.ts)
}

export function detectRoom(
  filePath: string,
  content: string,
  rooms: Record<string, { keywords: string[] }>,
): string {
  // Priority 1: explicit configured room override (user-defined or programmatic)
  // Only fires when rooms config is non-empty and the path/file matches.
  if (Object.keys(rooms).length > 0) {
    const pathLower = filePath.toLowerCase()
    const pathParts = pathLower.split(/[/\\]/)
    const dirParts = pathParts.slice(0, -1)
    const filename = pathParts[pathParts.length - 1] ?? ''

    for (const [room, _config] of Object.entries(rooms)) {
      const roomLower = room.toLowerCase()
      if (dirParts.some(p => p === roomLower || p.includes(roomLower))) return room
      if (filename.includes(roomLower)) return room
    }
  }

  // Priority 2: auto-infer from directory structure — zero config required
  const inferred = inferRoomFromPath(filePath)
  if (inferred) return inferred

  // Priority 3: keyword scoring (only meaningful when rooms config is provided)
  if (Object.keys(rooms).length > 0) {
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

  return 'general'
}
