// EmbeddingPipeline singleton — @xenova/transformers, MiniLM-L6-v2
import { pipeline, env } from '@xenova/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const DIMENSION = 384

// Silence progress output when not running in a TTY (e.g. MCP server mode)
if (!process.stdout.isTTY) {
  env.allowLocalModels = true
  env.useBrowserCache = false
}

type XenovaPipeline = Awaited<ReturnType<typeof pipeline>>

export class EmbeddingPipeline {
  private static instance: EmbeddingPipeline | null = null
  private pipe: XenovaPipeline | null = null

  private constructor() {}

  static getInstance(): EmbeddingPipeline {
    if (!EmbeddingPipeline.instance) {
      EmbeddingPipeline.instance = new EmbeddingPipeline()
    }
    return EmbeddingPipeline.instance
  }

  private async init(): Promise<void> {
    if (this.pipe) return
    const progressCallback = process.stdout.isTTY ? undefined : () => {}
    this.pipe = await pipeline('feature-extraction', MODEL, {
      progress_callback: progressCallback,
    })
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await (this.pipe as any)(texts, { pooling: 'none', normalize: false }) as { dims: number[]; data: Float32Array }
    // output.dims = [batch, tokens, dim]
    const [batch, tokens, dim] = output.dims as [number, number, number]
    const data = output.data
    const results: number[][] = []

    for (let b = 0; b < batch; b++) {
      // Mean-pool over token dimension
      const vec = new Float32Array(dim)
      for (let t = 0; t < tokens; t++) {
        for (let d = 0; d < dim; d++) {
          vec[d] += data[b * tokens * dim + t * dim + d]
        }
      }
      for (let d = 0; d < dim; d++) {
        vec[d] /= tokens
      }
      // L2 normalize
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
    return DIMENSION
  }
}

export function getEmbeddingPipeline(): EmbeddingPipeline {
  return EmbeddingPipeline.getInstance()
}
