// Dashboard server — Bun.serve() HTTP server for nardo web UI
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleStats, handleWings, handleRooms, handleSearch, handleKgGraph, handleRecentDrawers } from './api.js'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of url.searchParams) {
    out[k] = v
  }
  return out
}

export interface DashboardServerOptions {
  palace_path: string
  port?: number
}

export function startDashboardServer(opts: DashboardServerOptions): { url: string; server: ReturnType<typeof Bun.serve> } {
  const port = opts.port ?? 7432
  const palace_path = opts.palace_path

  // Resolve static HTML path — next to this file at build time, or in dist
  const staticDir = join(import.meta.dir, 'static')
  const htmlPath = join(staticDir, 'index.html')

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const q = parseQuery(url)

      // Serve static HTML
      if (path === '/' || path === '/index.html') {
        if (existsSync(htmlPath)) {
          const html = readFileSync(htmlPath, 'utf-8')
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }
        return new Response('Not found', { status: 404 })
      }

      // API routes
      if (path === '/api/stats') {
        return json(await handleStats(palace_path))
      }

      if (path === '/api/wings') {
        return json(await handleWings(palace_path))
      }

      if (path === '/api/rooms') {
        return json(await handleRooms(palace_path, q['wing']))
      }

      if (path === '/api/search') {
        const query = q['q'] ?? ''
        const limit = parseInt(q['limit'] ?? '10', 10) || 10
        return json(await handleSearch(palace_path, query, q['wing'], q['room'], limit))
      }

      if (path === '/api/kg/graph') {
        return json(await handleKgGraph(palace_path, q['wing']))
      }

      if (path === '/api/drawers/recent') {
        const limit = parseInt(q['limit'] ?? '20', 10) || 20
        return json(await handleRecentDrawers(palace_path, limit, q['wing']))
      }

      return json({ error: 'Not found' }, 404)
    },
  })

  return { url: `http://localhost:${port}`, server }
}
