// status command
import type { Command } from 'commander'
import { PalaceClient } from '../../palace/client.js'
import { getAllDrawerMetadata } from '../../palace/drawers.js'
import { loadConfig } from '../../config.js'

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description(
      'Show a quick summary of the palace: drawer count, wings, and rooms.\n\n' +
      'Connects to the palace database and prints total drawers, how many wings\n' +
      'and rooms exist, and a breakdown of drawer counts per wing and room sorted\n' +
      'by size. Use "nardo palace-stats" for a more detailed report including disk\n' +
      'usage and FTS5 health.\n\n' +
      'Example:\n' +
      '  nardo status'
    )
    .option('--palace <path>', 'Path to palace directory, overriding the value in nardo config')
    .action(async (opts: { palace?: string }) => {
      const config = loadConfig()
      const palace_path = opts.palace ?? config.palace_path

      const client = new PalaceClient(palace_path)
      let all
      try {
        all = await getAllDrawerMetadata(client)
      } catch {
        console.error('Could not connect to palace at:', palace_path)
        process.exit(1)
      }

      const wings: Record<string, number> = {}
      const rooms: Record<string, number> = {}
      for (const m of all) {
        const w = m.wing ?? 'unknown'
        const r = m.room ?? 'unknown'
        wings[w] = (wings[w] ?? 0) + 1
        rooms[r] = (rooms[r] ?? 0) + 1
      }

      console.log('==================================================')
      console.log('  nardo Status')
      console.log('==================================================')
      console.log()
      console.log(`Palace: ${palace_path}`)
      console.log(`Drawers: ${all.length.toLocaleString()}`)
      console.log(`Wings: ${Object.keys(wings).length}`)
      console.log(`Rooms: ${Object.keys(rooms).length}`)
      console.log()

      if (Object.keys(wings).length > 0) {
        console.log('Wings:')
        for (const [wing, count] of Object.entries(wings).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${wing}: ${count}`)
        }
        console.log()
      }

      if (Object.keys(rooms).length > 0) {
        console.log('Rooms:')
        for (const [room, count] of Object.entries(rooms).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${room}: ${count}`)
        }
      }
    })
}
