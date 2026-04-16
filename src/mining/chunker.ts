export interface Chunk {
  text: string
  index: number
  start: number
  end: number
}

export function chunkText(
  text: string,
  chunkSize = 800,
  overlap = 100,
  minChunk = 50,
): Chunk[] {
  const chunks: Chunk[] = []

  if (text.length === 0) return chunks

  let index = 0
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    const chunkText = text.slice(start, end)

    if (chunkText.length >= minChunk) {
      chunks.push({ text: chunkText, index, start, end })
      index++
    }

    if (end === text.length) break

    start = end - overlap
  }

  return chunks
}
