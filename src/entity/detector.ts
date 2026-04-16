import type { EntityRegistry } from './registry.ts'
import { lookupWikipedia } from './wikipedia.ts'

const STOPWORDS = new Set([
  // English
  'The', 'This', 'That', 'When', 'Where', 'What', 'Which', 'With',
  'From', 'Into', 'Over', 'Under', 'After', 'Before', 'Been', 'Have',
  'Will', 'Should', 'Could', 'Would', 'Their', 'There', 'These', 'Those',
  'Then', 'Than', 'Also', 'Each', 'Some', 'Many', 'Most', 'More',
  'Other', 'Such', 'Just', 'Very', 'Well', 'Even', 'Only', 'Both',
  'Few', 'Own', 'Same',
  // JS/TS builtins and common code tokens
  'Array', 'Map', 'Set', 'Error', 'Math', 'Date', 'JSON', 'Object',
  'String', 'Number', 'Boolean', 'Promise', 'Symbol', 'Proxy', 'Reflect',
  'Function', 'Null', 'Undefined', 'True', 'False', 'Void', 'Never',
  'Type', 'Interface', 'Class', 'Enum', 'Const', 'Export', 'Import',
  'Default', 'Async', 'Await', 'Return', 'Throw', 'Catch', 'Finally',
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  // Common prose words that pass the capitalization filter
  'Note', 'See', 'Next', 'Last', 'New', 'Old', 'All', 'Any',
  // Generic verbs/nouns that appear capitalized in code contexts
  'Build', 'Buffer', 'Chunk', 'Command', 'Commit', 'Database',
  'Debounce', 'Delete', 'Fetch', 'Filed', 'Filter', 'Line', 'List',
  'Lone', 'Name', 'Priority', 'Relationship', 'Remote', 'Remove',
  'Scan', 'Step', 'Use', 'Validate', 'Lookup', 'Load', 'Save',
  'Open', 'Close', 'Read', 'Write', 'Parse', 'File', 'Path',
  'Index', 'Query', 'Result', 'Value', 'Item', 'Data', 'Options',
  'Config', 'Context', 'Request', 'Response', 'Event', 'Node',
  'Text', 'Block', 'Token', 'Hash', 'Scope', 'Store', 'State',
])

const PERSON_VERBS = new Set([
  'said', 'asked', 'laughed', 'told', 'replied', 'walked', 'ran',
  'smiled', 'cried', 'nodded', 'whispered', 'shouted', 'looked',
  'felt', 'thought',
])

const PROJECT_VERBS = new Set([
  'built', 'deployed', 'launched', 'shipped', 'released', 'created',
  'designed', 'implemented', 'migrated', 'refactored', 'fixed', 'wrote',
])

const CANDIDATE_RE = /\b[A-Z][a-z]{2,}\b/g
const PRONOUN_RE = /\b(she|he|they)\b/gi

export interface DetectedEntity {
  name: string
  type: 'person' | 'project' | 'unknown'
  confidence: number
  occurrences: number
}

export function detectEntities(content: string): DetectedEntity[] {
  // Pass 1: Extract candidates
  const raw = content.match(CANDIDATE_RE) ?? []
  const candidates = raw.filter(w => !STOPWORDS.has(w))

  // Count occurrences per candidate
  const counts = new Map<string, number>()
  for (const c of candidates) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }

  // Only keep those with 2+ occurrences
  const names = Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .map(([name]) => name)

  if (names.length === 0) return []

  // Pass 2: Score each candidate
  const words = content.split(/\s+/)
  const results: DetectedEntity[] = []

  for (const name of names) {
    let personScore = 0
    let projectScore = 0

    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, '').toLowerCase()

      if (PERSON_VERBS.has(w)) {
        // Check if name is nearby (within 5 words)
        const start = Math.max(0, i - 5)
        const end = Math.min(words.length - 1, i + 5)
        for (let j = start; j <= end; j++) {
          if (words[j].replace(/[^a-zA-Z]/g, '') === name) {
            personScore++
          }
        }
      }

      if (PROJECT_VERBS.has(w)) {
        const start = Math.max(0, i - 5)
        const end = Math.min(words.length - 1, i + 5)
        for (let j = start; j <= end; j++) {
          if (words[j].replace(/[^a-zA-Z]/g, '') === name) {
            projectScore++
          }
        }
      }
    }

    // Dialogue markers: > Name: or [Name]
    const dialogueRe = new RegExp(`(?:>\\s*${name}:|\\[${name}\\])`, 'g')
    const dialogueMatches = content.match(dialogueRe) ?? []
    personScore += dialogueMatches.length

    // Pronoun references within 5 words of the name
    const namePositions: number[] = []
    let m: RegExpExecArray | null
    const nameRe = new RegExp(`\\b${name}\\b`, 'g')
    while ((m = nameRe.exec(content)) !== null) {
      namePositions.push(m.index)
    }

    PRONOUN_RE.lastIndex = 0
    while ((m = PRONOUN_RE.exec(content)) !== null) {
      const pIdx = m.index
      for (const nIdx of namePositions) {
        // rough word-distance approximation: count words between positions
        const segment = content.slice(Math.min(pIdx, nIdx), Math.max(pIdx, nIdx))
        const wordDist = segment.split(/\s+/).length - 1
        if (wordDist <= 5) {
          personScore++
          break
        }
      }
    }

    const occurrences = counts.get(name) ?? 0
    const hasSignal = personScore > 0 || projectScore > 0
    const type: 'person' | 'project' | 'unknown' = !hasSignal
      ? 'unknown'
      : personScore >= projectScore ? 'person' : 'project'
    const gap = Math.abs(personScore - projectScore)
    // Confidence: base 0.5, scale up by gap, cap at 1.0
    const confidence = Math.min(1.0, 0.5 + gap * 0.1)

    results.push({ name, type, confidence, occurrences })
  }

  return results.sort((a, b) => b.occurrences - a.occurrences)
}

export async function detectAndClassify(
  content: string,
  registry: EntityRegistry,
  useWikipedia = false
): Promise<DetectedEntity[]> {
  const detected = detectEntities(content)

  for (const entity of detected) {
    const existing = registry.get(entity.name)
    if (existing) {
      entity.type = existing.type === 'concept' || existing.type === 'place' || existing.type === 'unknown'
        ? entity.type
        : existing.type as 'person' | 'project' | 'unknown'
      entity.confidence = existing.confidence
    } else if (useWikipedia) {
      const wiki = await lookupWikipedia(entity.name)
      registry.merge(entity.name, wiki)
      if (wiki.type === 'person' || wiki.type === 'project') {
        entity.type = wiki.type
        entity.confidence = wiki.confidence
      }
    }
  }

  return detected
}
