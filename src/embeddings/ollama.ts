export class OllamaEmbedder {
  static readonly DIMENSION = 768

  private base_url: string
  private model: string

  constructor(base_url = 'http://localhost:11434', model = 'nomic-embed-text') {
    this.base_url = base_url.replace(/\/+$/, '')
    this.model = model
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.base_url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    })

    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as {
      embeddings?: number[][]
      embedding?: number[]
    }

    if (Array.isArray(data.embeddings)) {
      return data.embeddings
    }

    if (Array.isArray(data.embedding)) {
      return [data.embedding]
    }

    throw new Error('Ollama embed response missing embeddings array')
  }

  getDimension(): number {
    return OllamaEmbedder.DIMENSION
  }
}
