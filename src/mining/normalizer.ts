export interface NormalizedConvo {
  turns: Array<{ role: 'user' | 'assistant'; content: string }>
  format: string
}

// Strip noise patterns from a block of text — process line by line to avoid crossing blank lines
function stripNoise(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inTag = false
  let tagName = ''

  for (const line of lines) {
    if (!inTag) {
      // Check if this line opens a noise tag (with optional > prefix)
      const openMatch = line.match(/^(>?\s*)<(system-reminder|command-message)>(.*)$/)
      if (openMatch) {
        const content = openMatch[3]!
        if (content.includes(`</${openMatch[2]}>`)) {
          // Single-line tag — skip entirely
          continue
        }
        inTag = true
        tagName = openMatch[2]!
        continue
      }
      // Check for hook output patterns
      if (/^>?\s*Ran \d+ \w+ hook/.test(line)) continue
      if (/^>?\s*\[\d[\d,]* tokens\]/.test(line)) continue
      if (/^>?\s*… \+\d+ lines/.test(line)) continue
      result.push(line)
    } else {
      // In a tag — skip until close tag (don't cross blank lines)
      if (line.trim() === '') {
        // Blank line — exit tag tracking (malformed tag, stop skipping)
        inTag = false
        tagName = ''
        continue
      }
      if (line.includes(`</${tagName}>`)) {
        inTag = false
        tagName = ''
      }
      // Skip lines inside the tag
    }
  }
  return result.join('\n').trim()
}

// Parse > marker format (3+ lines starting with >)
function parseMarkerFormat(lines: string[]): NormalizedConvo | null {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let currentRole: 'user' | 'assistant' = 'user'
  let currentLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('>')) {
      if (currentLines.length > 0) {
        const content = currentLines.join('\n').trim()
        if (content) turns.push({ role: currentRole, content })
        currentRole = currentRole === 'user' ? 'assistant' : 'user'
        currentLines = []
      }
      currentLines.push(line.slice(1).trimStart())
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim()
    if (content) turns.push({ role: currentRole, content })
  }

  return turns.length > 0 ? { turns, format: 'marker' } : null
}

// Claude.ai JSON: messages array with uuid/sender
function parseClaudeAiJson(data: unknown): NormalizedConvo | null {
  if (!Array.isArray(data)) return null
  if (data.length === 0) return null
  const first = data[0] as Record<string, unknown>
  if (!('uuid' in first) && !('sender' in first)) return null

  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const msg of data as Array<Record<string, unknown>>) {
    const sender = msg['sender'] as string | undefined
    const role: 'user' | 'assistant' = sender === 'human' ? 'user' : 'assistant'
    let content = ''
    if (typeof msg['text'] === 'string') {
      content = msg['text']
    } else if (Array.isArray(msg['content'])) {
      content = (msg['content'] as Array<Record<string, unknown>>)
        .filter(c => c['type'] === 'text')
        .map(c => c['text'] as string)
        .join('\n')
    }
    if (content.trim()) turns.push({ role, content: content.trim() })
  }
  return turns.length > 0 ? { turns, format: 'claude_ai_json' } : null
}

// ChatGPT conversations.json: has mapping field
function parseChatGptJson(data: unknown): NormalizedConvo | null {
  const obj = data as Record<string, unknown>
  if (!obj || typeof obj !== 'object' || !('mapping' in obj)) return null

  const mapping = obj['mapping'] as Record<string, Record<string, unknown>>
  const turns: Array<{ role: 'user' | 'assistant'; content: string; id: string }> = []

  for (const [id, node] of Object.entries(mapping)) {
    const msg = node['message'] as Record<string, unknown> | null
    if (!msg) continue
    const authorRole = (msg['author'] as Record<string, unknown>)?.['role'] as string
    if (authorRole !== 'user' && authorRole !== 'assistant') continue
    const contentObj = msg['content'] as Record<string, unknown>
    const parts = contentObj?.['parts'] as unknown[] | undefined
    if (!parts) continue
    const text = parts.filter(p => typeof p === 'string').join('\n').trim()
    if (!text) continue
    turns.push({ role: authorRole as 'user' | 'assistant', content: text, id })
  }

  // Sort by create_time if available
  turns.sort((a, b) => {
    const nodeA = mapping[a.id]
    const nodeB = mapping[b.id]
    const tA = (nodeA?.['message'] as Record<string, unknown> | undefined)?.['create_time'] as number ?? 0
    const tB = (nodeB?.['message'] as Record<string, unknown> | undefined)?.['create_time'] as number ?? 0
    return tA - tB
  })

  const result = turns.map(({ role, content }) => ({ role, content }))
  return result.length > 0 ? { turns: result, format: 'chatgpt_json' } : null
}

// Claude Code JSONL: type: 'user'|'assistant' with message.content array
function parseClaudeCodeJsonl(lines: string[]): NormalizedConvo | null {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return null
    }
    const type = obj['type'] as string | undefined
    if (type !== 'user' && type !== 'assistant') continue

    const msg = obj['message'] as Record<string, unknown> | undefined
    if (!msg) continue

    let content = ''
    if (Array.isArray(msg['content'])) {
      content = (msg['content'] as Array<Record<string, unknown>>)
        .filter(c => c['type'] === 'text')
        .map(c => c['text'] as string)
        .join('\n')
    } else if (typeof msg['content'] === 'string') {
      content = msg['content']
    }

    if (content.trim()) turns.push({ role: type, content: content.trim() })
  }

  return turns.length > 0 ? { turns, format: 'claude_code_jsonl' } : null
}

// Slack JSON: channel messages with ts/user fields
function parseSlackJson(data: unknown): NormalizedConvo | null {
  if (!Array.isArray(data)) return null
  if (data.length === 0) return null
  const first = data[0] as Record<string, unknown>
  if (!('ts' in first) || !('user' in first)) return null

  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const msg of data as Array<Record<string, unknown>>) {
    const text = msg['text'] as string | undefined
    if (!text?.trim()) continue
    // In Slack, treat bot_id messages as assistant, others as user
    const role: 'user' | 'assistant' = msg['bot_id'] ? 'assistant' : 'user'
    turns.push({ role, content: text.trim() })
  }

  return turns.length > 0 ? { turns, format: 'slack_json' } : null
}

// Plain text: paragraph chunking
function parsePlainText(text: string): NormalizedConvo {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = paragraphs.map(
    (p, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: p }),
  )
  return { turns, format: 'plain_text' }
}

export function normalizeConversation(raw: string, _filename: string): NormalizedConvo {
  const cleaned = stripNoise(raw)
  const lines = cleaned.split('\n')

  // 1. Check for > marker format (3+ lines starting with >)
  const markerLines = lines.filter(l => l.startsWith('>'))
  if (markerLines.length >= 3) {
    const result = parseMarkerFormat(lines)
    if (result) return result
  }

  // 2. Try JSON/JSONL
  const trimmed = cleaned.trim()

  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed) as unknown
      const claudeAi = parseClaudeAiJson(data)
      if (claudeAi) return claudeAi

      const slack = parseSlackJson(data)
      if (slack) return slack
    } catch {
      // not valid JSON array
    }
  }

  // Try JSON object (ChatGPT)
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as unknown
      const chatgpt = parseChatGptJson(data)
      if (chatgpt) return chatgpt
    } catch {
      // not valid JSON object
    }
  }

  // Try JSONL (Claude Code)
  if (trimmed.includes('\n')) {
    const jsonlLines = trimmed.split('\n').filter(l => l.trim())
    const allJson = jsonlLines.every(l => {
      try { JSON.parse(l); return true } catch { return false }
    })
    if (allJson && jsonlLines.length > 0) {
      const claudeCode = parseClaudeCodeJsonl(jsonlLines)
      if (claudeCode) return claudeCode
    }
  }

  // 3. Plain text fallback
  return parsePlainText(cleaned)
}
