import { extname } from 'path'

export interface Chunk {
  text: string
  index: number
  start: number
  end: number
}

export interface ChunkOptions {
  strategy?: 'auto' | 'code' | 'markdown' | 'conversation' | 'fixed'
  chunkSize?: number
  overlap?: number
  minChunk?: number
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.txt', '.rst'])
const STRUCTURED_EXTENSIONS = new Set(['.json', '.yaml', '.yml'])

const DEFAULTS: Record<NonNullable<ChunkOptions['strategy']>, Required<ChunkOptions>> = {
  auto: { strategy: 'auto', chunkSize: 800, overlap: 100, minChunk: 50 },
  code: { strategy: 'code', chunkSize: 1200, overlap: 80, minChunk: 80 },
  markdown: { strategy: 'markdown', chunkSize: 1500, overlap: 60, minChunk: 80 },
  conversation: { strategy: 'conversation', chunkSize: 600, overlap: 40, minChunk: 40 },
  fixed: { strategy: 'fixed', chunkSize: 800, overlap: 100, minChunk: 50 },
}

function resolveOptions(
  optionsOrChunkSize?: ChunkOptions | number,
  overlap?: number,
  minChunk?: number,
): Required<ChunkOptions> {
  if (typeof optionsOrChunkSize === 'number') {
    return {
      strategy: 'fixed',
      chunkSize: optionsOrChunkSize,
      overlap: overlap ?? DEFAULTS.fixed.overlap,
      minChunk: minChunk ?? DEFAULTS.fixed.minChunk,
    }
  }

  const strategy = optionsOrChunkSize?.strategy ?? 'fixed'
  const defaults = DEFAULTS[strategy]
  return {
    strategy,
    chunkSize: optionsOrChunkSize?.chunkSize ?? defaults.chunkSize,
    overlap: optionsOrChunkSize?.overlap ?? defaults.overlap,
    minChunk: optionsOrChunkSize?.minChunk ?? defaults.minChunk,
  }
}

function pushChunk(chunks: Chunk[], text: string, start: number, end: number, minChunk: number): void {
  if (end <= start) return
  const chunkText = text.slice(start, end).trim()
  if (chunkText.length < minChunk) return
  chunks.push({ text: chunkText, index: chunks.length, start, end })
}

function findSentenceBoundary(text: string, start: number, proposedEnd: number, minChunk: number): number {
  const minEnd = Math.min(text.length, start + minChunk)
  if (proposedEnd <= minEnd) return Math.min(text.length, proposedEnd)

  const boundaryPatterns = ['\n\n', '. ', '! ', '? ', '}\n']
  let best = -1

  for (const pattern of boundaryPatterns) {
    const idx = text.lastIndexOf(pattern, proposedEnd)
    if (idx >= minEnd - pattern.length && idx > best) {
      best = idx + pattern.length
    }
  }

  return best !== -1 ? best : proposedEnd
}

function chunkFixed(text: string, options: Required<ChunkOptions>, startOffset = 0): Chunk[] {
  const chunks: Chunk[] = []
  if (text.length === 0) return chunks

  let start = 0

  while (start < text.length) {
    const rawEnd = Math.min(start + options.chunkSize, text.length)
    const end = rawEnd === text.length
      ? rawEnd
      : findSentenceBoundary(text, start, rawEnd, options.minChunk)

    pushChunk(chunks, text, start + startOffset, end + startOffset, options.minChunk)
    if (end >= text.length) break

    const nextStart = Math.max(start + 1, end - options.overlap)
    if (nextStart <= start) break
    start = nextStart
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }))
}

function splitByBoundaries(text: string, boundaryRegex: RegExp): Array<{ start: number; end: number }> {
  const starts = [0]
  boundaryRegex.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = boundaryRegex.exec(text)) !== null) {
    if (match.index > 0) starts.push(match.index)
  }

  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b)
  return uniqueStarts.map((start, index) => ({
    start,
    end: uniqueStarts[index + 1] ?? text.length,
  }))
}

function chunkBySections(
  text: string,
  boundaryRegex: RegExp,
  options: Required<ChunkOptions>,
): Chunk[] {
  const sections = splitByBoundaries(text, boundaryRegex)
  const chunks: Chunk[] = []
  let bufferStart: number | null = null
  let bufferEnd = 0

  const flush = (): void => {
    if (bufferStart == null || bufferEnd <= bufferStart) return
    const sectionText = text.slice(bufferStart, bufferEnd)
    if (sectionText.length > options.chunkSize) {
      const fixed = chunkFixed(sectionText, { ...options, strategy: 'fixed' }, bufferStart)
      chunks.push(...fixed)
    } else {
      pushChunk(chunks, text, bufferStart, bufferEnd, options.minChunk)
    }
    bufferStart = null
    bufferEnd = 0
  }

  for (const section of sections) {
    if (bufferStart == null) {
      bufferStart = section.start
      bufferEnd = section.end
      continue
    }

    if (section.end - bufferStart <= options.chunkSize) {
      bufferEnd = section.end
      continue
    }

    flush()
    bufferStart = section.start
    bufferEnd = section.end
  }

  flush()
  return chunks.map((chunk, index) => ({ ...chunk, index }))
}

function detectStrategy(filename: string): NonNullable<ChunkOptions['strategy']> {
  const ext = extname(filename).toLowerCase()
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (STRUCTURED_EXTENSIONS.has(ext)) return 'fixed'
  return 'fixed'
}

export function chunkText(
  text: string,
  optionsOrChunkSize?: ChunkOptions | number,
  overlap?: number,
  minChunk?: number,
): Chunk[] {
  const options = resolveOptions(optionsOrChunkSize, overlap, minChunk)

  switch (options.strategy) {
    case 'code':
      return chunkBySections(text, /^(?:export\s+)?(?:async\s+)?function\s+\w+|^class\s+\w+|^def\s+\w+|^fn\s+\w+/gm, options)
    case 'markdown':
      return chunkBySections(text, /^#{1,3}\s+/gm, options)
    case 'conversation':
      return chunkBySections(text, /^(?:[A-Z][^:\n]{0,40}:|\[[^\]\n]{1,40}\])/gm, options)
    case 'auto':
    case 'fixed':
    default:
      return chunkFixed(text, options)
  }
}

export function chunkFile(text: string, filename: string): Chunk[] {
  const strategy = detectStrategy(filename)
  return chunkText(text, DEFAULTS[strategy])
}
