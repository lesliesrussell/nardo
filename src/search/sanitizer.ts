export interface SanitizeResult {
  clean_query: string
  was_sanitized: boolean
  original_length: number
  clean_length: number
  method: 'passthrough' | 'question_extraction' | 'tail_sentence' | 'tail_truncation'
}

const SAFE_QUERY_LENGTH = 200
const MAX_QUERY_LENGTH = 250
const MIN_QUERY_LENGTH = 10

function splitSentences(text: string): string[] {
  return text.split(/(?<=\.|\?|!|\n)\s+|(?<=\n)/).filter(s => s.trim().length > 0)
}

function splitOnDelimiters(text: string): string[] {
  // Split by '. ' or '? ' or '! ' or '\n'
  return text.split(/\. |\? |! |\n/).map(s => s.trim()).filter(s => s.length > 0)
}

export function sanitizeQuery(raw: string): SanitizeResult {
  const original_length = raw.length

  // Step 1: passthrough
  if (original_length <= SAFE_QUERY_LENGTH) {
    return {
      clean_query: raw,
      was_sanitized: false,
      original_length,
      clean_length: original_length,
      method: 'passthrough',
    }
  }

  const segments = splitOnDelimiters(raw)

  // Step 2: question extraction — reversed, find segment with ? or ？ in valid length range
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if ((seg.includes('?') || seg.includes('？')) && seg.length >= MIN_QUERY_LENGTH && seg.length <= MAX_QUERY_LENGTH) {
      return {
        clean_query: seg,
        was_sanitized: true,
        original_length,
        clean_length: seg.length,
        method: 'question_extraction',
      }
    }
  }

  // Step 3: tail sentence extraction — reversed, any segment in valid length range
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.length >= MIN_QUERY_LENGTH && seg.length <= MAX_QUERY_LENGTH) {
      return {
        clean_query: seg,
        was_sanitized: true,
        original_length,
        clean_length: seg.length,
        method: 'tail_sentence',
      }
    }
  }

  // Step 4: tail truncation
  const truncated = raw.slice(-MAX_QUERY_LENGTH)
  return {
    clean_query: truncated,
    was_sanitized: true,
    original_length,
    clean_length: truncated.length,
    method: 'tail_truncation',
  }
}
