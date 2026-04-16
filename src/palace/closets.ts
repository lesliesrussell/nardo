// Closet builder + CRUD
import { createHash } from 'crypto'
import type { PalaceClient } from './client.ts'
import { getEmbeddingPipeline } from '../embeddings/pipeline.js'

export interface ClosetLine {
  topic: string
  entities: string[]
  drawer_ids: string[]
}

const STOPWORDS = new Set([
  'The', 'This', 'That', 'When', 'Where', 'What', 'Which', 'With', 'From',
  'Into', 'Over', 'Under', 'After', 'Before', 'Been', 'Have', 'Will',
  'Should', 'Could', 'Would', 'Their', 'There', 'These', 'Those', 'Then', 'Than', 'Also',
])

function extractEntities(content: string): string[] {
  // Capitalized words 3+ chars, filter stopwords
  const freq = new Map<string, number>()
  const matches = content.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []
  for (const word of matches) {
    if (!STOPWORDS.has(word)) {
      freq.set(word, (freq.get(word) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word)
}

function extractTopics(content: string): string[] {
  const freq = new Map<string, number>()

  // Markdown headers
  const headers = content.match(/^#{1,6}\s+(.+)$/gm) ?? []
  for (const h of headers) {
    const topic = h.replace(/^#+\s+/, '').trim()
    if (topic.length >= 3) freq.set(topic, (freq.get(topic) ?? 0) + 2)
  }

  // Action verbs: words ending in common verb patterns
  const verbPattern = /\b([a-z][a-z]{2,}(?:ing|ed|ize|ise|ate|ify|en))\b/g
  let m: RegExpExecArray | null
  while ((m = verbPattern.exec(content)) !== null) {
    const verb = m[1]
    freq.set(verb, (freq.get(verb) ?? 0) + 1)
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word)
}

function extractQuotes(content: string): string[] {
  const quotes: string[] = []
  const pattern = /"([^"]{15,150})"/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    quotes.push(m[1])
  }
  return quotes.slice(0, 3)
}

export function buildClosetLines(
  content: string,
  drawer_ids: string[],
  _wing: string,
  _room: string,
): string[] {
  const entities = extractEntities(content)
  const topics = extractTopics(content)
  const quotes = extractQuotes(content)

  const allTopics = [...topics, ...quotes]
  if (allTopics.length === 0) allTopics.push('general')

  // Format each line: "topic|ENTITY1;ENTITY2|→id1,id2,id3"
  const lines: string[] = allTopics.map((topic) => {
    const entityPart = entities.join(';')
    const idPart = drawer_ids.join(',')
    return `${topic}|${entityPart}|→${idPart}`
  })

  // Pack lines greedily into closet docs: max ~1500 chars each
  const packed: string[] = []
  let current = ''

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line
    if (candidate.length > 1500 && current) {
      packed.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current) packed.push(current)

  return packed
}

export async function addClosets(
  client: PalaceClient,
  source_file: string,
  closet_strings: string[],
  wing: string,
  room: string,
): Promise<void> {
  if (closet_strings.length === 0) return

  const collection = await client.getClosetsCollection()
  const hash = createHash('sha1').update(source_file).digest('hex').slice(0, 8)

  const ids = closet_strings.map((_, i) => `${hash}_${String(i + 1).padStart(2, '0')}`)
  const metadatas = closet_strings.map(() => ({
    source_file,
    wing,
    room,
  }))

  const pipeline = getEmbeddingPipeline()
  const embeddings = await pipeline.embed(closet_strings)

  await collection.upsert({
    ids,
    documents: closet_strings,
    metadatas,
    embeddings,
  })
}

export async function deleteClosetsBySource(
  client: PalaceClient,
  source_file: string,
): Promise<void> {
  const collection = await client.getClosetsCollection()

  const results = await collection.get({
    where: { source_file: { $eq: source_file } },
    include: ['metadatas'],
  })

  if (results.ids.length === 0) return
  await collection.delete({ ids: results.ids })
}
