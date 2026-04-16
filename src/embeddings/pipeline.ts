// EmbeddingPipeline singleton — config-driven provider with Ollama + Xenova fallback
import { pipeline, env } from '@xenova/transformers'
import { getProviderEmbeddingDimension, loadConfig } from '../config.js'
import { OllamaEmbedder } from './ollama.js'

const XENOVA_MODEL = 'Xenova/all-MiniLM-L6-v2'
const XENOVA_DIMENSION = 384

// Silence progress output when not running in a TTY (e.g. MCP server mode)
if (!process.stdout.isTTY) {
  env.allowLocalModels = true
  env.useBrowserCache = false
}

type XenovaPipeline = Awaited<ReturnType<typeof pipeline>>

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  getDimension(): number
}

function normalize(vec: number[]): number[] {
  let norm = 0
  for (const value of vec) {
    norm += value * value
  }

  norm = Math.sqrt(norm)
  if (norm <= 0) return vec
  return vec.map(value => value / norm)
}

function adaptDimension(embeddings: number[][], targetDimension: number): number[][] {
  return embeddings.map((embedding) => {
    if (embedding.length === targetDimension) return embedding

    if (embedding.length > targetDimension) {
      return normalize(embedding.slice(0, targetDimension))
    }

    const padded = [...embedding, ...new Array(targetDimension - embedding.length).fill(0)]
    return normalize(padded)
  })
}

class XenovaEmbedder implements Embedder {
  private pipe: XenovaPipeline | null = null

  private async init(): Promise<void> {
    if (this.pipe) return
    const progressCallback = process.stdout.isTTY ? undefined : () => {}
    this.pipe = await pipeline('feature-extraction', XENOVA_MODEL, {
      progress_callback: progressCallback,
    })
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await (this.pipe as any)(texts, { pooling: 'none', normalize: false }) as { dims: number[]; data: Float32Array }
    const [batch, tokens, dim] = output.dims as [number, number, number]
    const data = output.data
    const results: number[][] = []

    for (let b = 0; b < batch; b++) {
      const vec = new Float32Array(dim)
      for (let t = 0; t < tokens; t++) {
        for (let d = 0; d < dim; d++) {
          vec[d] += data[b * tokens * dim + t * dim + d]
        }
      }
      for (let d = 0; d < dim; d++) {
        vec[d] /= tokens
      }

      let norm = 0
      for (let d = 0; d < dim; d++) norm += vec[d] * vec[d]
      norm = Math.sqrt(norm)
      if (norm > 0) {
        for (let d = 0; d < dim; d++) vec[d] /= norm
      }
      results.push(Array.from(vec))
    }

    return results
  }

  getDimension(): number {
    return XENOVA_DIMENSION
  }
}

export class EmbeddingPipeline implements Embedder {
  private static instance: EmbeddingPipeline | null = null

  private readonly preferredProvider: 'xenova' | 'ollama'
  private readonly targetDimension: number
  private readonly xenova = new XenovaEmbedder()
  private readonly ollama?: OllamaEmbedder
  private warnedFallback = false

  private constructor() {
    const config = loadConfig()
    this.preferredProvider = config.embedding.provider
    this.targetDimension = getProviderEmbeddingDimension(config.embedding)

    if (config.embedding.provider === 'ollama') {
      this.ollama = new OllamaEmbedder(config.embedding.ollama_url, config.embedding.model)
    }
  }

  static getInstance(): EmbeddingPipeline {
    if (!EmbeddingPipeline.instance) {
      EmbeddingPipeline.instance = new EmbeddingPipeline()
    }
    return EmbeddingPipeline.instance
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.preferredProvider === 'ollama' && this.ollama) {
      try {
        const embeddings = await this.ollama.embed(texts)
        return adaptDimension(embeddings, this.targetDimension)
      } catch (error) {
        if (!this.warnedFallback) {
          console.warn(`Ollama embeddings unavailable, falling back to Xenova MiniLM: ${String(error)}`)
          this.warnedFallback = true
        }
      }
    }

    const embeddings = await this.xenova.embed(texts)
    return adaptDimension(embeddings, this.targetDimension)
  }

  getDimension(): number {
    return this.targetDimension
  }
}

export function getEmbeddingPipeline(): EmbeddingPipeline {
  return EmbeddingPipeline.getInstance()
}
