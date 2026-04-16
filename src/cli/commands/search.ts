// search command
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { HybridSearcher } from '../../search/hybrid.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { loadConfig } from '../../config.js'

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Semantic search the palace')
    .option('--wing <wing>', 'Filter to wing')
    .option('--room <room>', 'Filter to room')
    .option('--limit <n>', 'Number of results', '5')
    .option('--palace <path>', 'Palace path override')
    .action(async (query: string, opts: { wing?: string; room?: string; limit: string; palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const n_results = parseInt(opts.limit, 10) || 5

      const client = new PalaceClient(palace_path)
      const embedder = getEmbeddingPipeline()
      const searcher = new HybridSearcher(client, embedder)

      let response
      try {
        response = await searcher.search({
          query,
          n_results,
          wing: opts.wing,
          room: opts.room,
        })
      } catch (err) {
        console.error('Search failed:', err)
        process.exit(1)
      }

      const SEP = '============================================================'
      const THIN = '──────────────────────────────────────────────────────────'
      console.log(SEP)
      console.log(`  Results for: "${response.query}"`)
      if (opts.wing) console.log(`  Wing: ${opts.wing}`)
      if (opts.room) console.log(`  Room: ${opts.room}`)
      console.log(SEP)
      console.log()

      if (response.results.length === 0) {
        console.log('  No results found.')
        return
      }

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i]
        const source = r.source_file ? r.source_file.split('/').pop() ?? r.source_file : ''
        console.log(`  [${i + 1}] ${r.wing} / ${r.room}`)
        console.log(`      Source: ${source}`)
        console.log(`      Match:  ${r.similarity.toFixed(2)}`)
        console.log()
        // Indent text
        const lines = r.text.split('\n').slice(0, 6)
        for (const line of lines) {
          console.log(`      ${line}`)
        }
        console.log()
        console.log(`  ${THIN}`)
      }
    })
}
