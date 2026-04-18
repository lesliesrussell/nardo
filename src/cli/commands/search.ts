// search command
import type { Command } from 'commander'

const c = {
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
}
import { PalaceClient } from '../../palace/client.js'
import { HybridSearcher } from '../../search/hybrid.js'
import { getEmbeddingPipeline } from '../../embeddings/pipeline.js'
import { loadConfig } from '../../config.js'

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description(
      'Semantic search the palace and display ranked results in the terminal.\n\n' +
      'Embeds the query, runs a hybrid vector + keyword search across all drawers,\n' +
      'and prints the top results with wing/room, source file, similarity score,\n' +
      'and a text preview. Scores are color-coded: green ≥ 0.70, yellow ≥ 0.55.\n\n' +
      'Examples:\n' +
      '  nardo search "how does the scoring work"\n' +
      '  nardo search "auth bug" --wing sessions --limit 10'
    )
    .option('--wing <wing>', 'Restrict results to drawers in this wing')
    .option('--room <room>', 'Restrict results to drawers in this room (use with --wing)')
    .option('--limit <n>', 'Number of results to show (default: 5)', '5')
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
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

      console.log()
      console.log(c.bold(`  ${response.query}`))
      const filters = [opts.wing && `wing:${opts.wing}`, opts.room && `room:${opts.room}`].filter(Boolean)
      if (filters.length) console.log(c.dim(`  ${filters.join('  ')}`))
      console.log()

      if (response.results.length === 0) {
        console.log(c.dim('  No results found.'))
        return
      }

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i]
        const source = r.source_file ? r.source_file.split('/').pop() ?? r.source_file : ''
        const score = r.similarity >= 0.7 ? c.green(r.similarity.toFixed(2)) : r.similarity >= 0.55 ? c.yellow(r.similarity.toFixed(2)) : c.dim(r.similarity.toFixed(2))
        console.log(`  ${c.dim(`${i + 1}.`)} ${c.cyan(`${r.wing}`)}${c.dim('/')}${r.room}  ${c.dim(source)}  ${score}`)
        const lines = r.text.split('\n').slice(0, 5).filter(l => l.trim())
        for (const line of lines) {
          console.log(c.dim(`     ${line.slice(0, 100)}`))
        }
        console.log()
      }
    })
}
