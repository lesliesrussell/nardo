import type { Command } from 'commander'
import { loadConfig } from '../../config.js'
import { reembedPalace } from '../../palace/reembed.js'

export function registerReembed(program: Command): void {
  program
    .command('reembed')
    .description(
      'Re-generate all embeddings using the currently configured model and rebuild HNSW indexes.\n\n' +
      'Use this after changing the embedding model in nardo config. All drawer and closet\n' +
      'texts are re-embedded in batches and the HNSW sidecar files are rebuilt from scratch.\n' +
      'A backup of palace.sqlite3 is created before any writes. Currently requires the\n' +
      'SQLite backend.\n\n' +
      'Examples:\n' +
      '  nardo reembed --dry-run          # preview what would be re-embedded\n' +
      '  nardo reembed                    # full re-embed with current model\n' +
      '  nardo reembed --wing sessions    # re-embed one wing only'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .option('--wing <wing>', 'Re-embed only this wing (only valid when embedding dimension has not changed)')
    .option('--dry-run', 'Print a preview of counts and dimension change without writing anything')
    .option('--batch-size <n>', 'Number of texts to embed per batch — larger is faster but uses more memory (default: 16)', '16')
    .action(async (opts: {
      palace?: string
      wing?: string
      dryRun?: boolean
      batchSize: string
    }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path
      const batch_size = Math.max(1, parseInt(opts.batchSize, 10) || 16)
      const dry_run = opts.dryRun ?? false

      if (config.palace.backend !== 'sqlite') {
        console.error('nardo reembed currently supports only the SQLite backend')
        process.exit(1)
      }

      if (dry_run) {
        const preview = await reembedPalace({
          palace_path,
          wing: opts.wing,
          batch_size,
          dry_run: true,
        })

        console.log(`Re-embed preview for: ${palace_path}`)
        if (opts.wing) console.log(`Wing: ${opts.wing}`)
        console.log(`Dimension: ${preview.previous_dimension} -> ${preview.target_dimension}`)
        console.log(`Drawers:   ${preview.drawers_reembedded}`)
        console.log(`Closets:   ${preview.closets_reembedded}`)
        console.log(`Mode:      ${preview.full_rebuild ? 'full rebuild' : 'wing-only rebuild'}`)
        return
      }

      console.log(`Re-embedding palace: ${palace_path}`)
      if (opts.wing) console.log(`Wing: ${opts.wing}`)

      const result = await reembedPalace({
        palace_path,
        wing: opts.wing,
        batch_size,
        onProgress: (info) => {
          console.log(
            `${info.collection.padEnd(7)} ${String(info.completed).padStart(6)}/${info.total} ${String(info.percent).padStart(3)}%`,
          )
        },
      })

      console.log(`Dimension: ${result.previous_dimension} -> ${result.target_dimension}`)
      console.log(`Drawers re-embedded: ${result.drawers_reembedded}`)
      console.log(`Closets re-embedded: ${result.closets_reembedded}`)
      if (result.backup_created) {
        console.log(`Backup: ${palace_path}/palace.sqlite3.backup`)
      }
      if (result.config_updated) {
        console.log('Config updated with new indexed embedding dimension.')
      }
      console.log('Done.')
    })
}
