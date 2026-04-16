export interface WikiResult {
  type: 'person' | 'project' | 'concept' | 'place' | 'unknown'
  confidence: number
  source: 'researched'
}

export async function lookupWikipedia(word: string): Promise<WikiResult> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`

  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'Accept': 'application/json' },
    })
  } catch {
    return { type: 'unknown', confidence: 0.30, source: 'researched' }
  }

  if (response.status === 404) {
    // Unusual name heuristic — likely a person
    return { type: 'person', confidence: 0.70, source: 'researched' }
  }

  if (!response.ok) {
    return { type: 'unknown', confidence: 0.30, source: 'researched' }
  }

  let body: { extract?: string }
  try {
    body = await response.json() as { extract?: string }
  } catch {
    return { type: 'unknown', confidence: 0.30, source: 'researched' }
  }

  const extract = (body.extract ?? '').toLowerCase()

  if (extract.includes('given name') || extract.includes('personal name')) {
    return { type: 'person', confidence: 0.80, source: 'researched' }
  }

  if (extract.includes('city in') || extract.includes('capital of')) {
    return { type: 'place', confidence: 0.80, source: 'researched' }
  }

  return { type: 'concept', confidence: 0.60, source: 'researched' }
}
