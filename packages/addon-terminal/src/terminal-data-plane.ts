/**
 * Data-plane HTTP handler for terminal I/O. Mounted at
 * `/addon/terminal/io/*` (hub-authenticated, admin). The remaining path reaches
 * the handler verbatim:
 *
 *   GET  /<sessionId>/out  → Server-Sent Events stream of terminal output
 *   POST /<sessionId>/in   → keystrokes written to the pty
 *
 * Output rides SSE, not the event bus, because it must be ordered and lossless —
 * a dropped chunk desynchronises the vt parser permanently. Each SSE `data:`
 * line is a JSON-encoded {@link TerminalOutputEvent}, so embedded newlines are
 * escaped and never break framing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler } from '@camstack/types'
import type { TerminalSessionManager } from './terminal-session-manager.js'

const SSE_KEEPALIVE_MS = 15_000
const MAX_INPUT_BYTES = 64 * 1024

interface ParsedPath {
  readonly sessionId: string
  readonly action: 'out' | 'in'
}

function parsePath(url: string | undefined): ParsedPath | null {
  if (!url) return null
  const path = url.split('?')[0] ?? ''
  const parts = path.split('/').filter((p) => p.length > 0)
  if (parts.length !== 2) return null
  const [sessionId, action] = parts
  if (!sessionId) return null
  if (action !== 'out' && action !== 'in') return null
  return { sessionId, action }
}

function handleOut(
  manager: TerminalSessionManager,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!manager.hasEntry(sessionId)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no such session')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  const detach = manager.attachOutput(sessionId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (event.kind === 'exit') res.end()
  })

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n')
  }, SSE_KEEPALIVE_MS)
  keepalive.unref?.()

  const cleanup = (): void => {
    clearInterval(keepalive)
    detach()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

function handleIn(
  manager: TerminalSessionManager,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!manager.hasSession(sessionId)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no such session')
    return
  }
  const chunks: Buffer[] = []
  let total = 0
  let aborted = false
  req.on('data', (chunk: Buffer) => {
    if (aborted) return
    total += chunk.length
    if (total > MAX_INPUT_BYTES) {
      aborted = true
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end('input too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    const raw = Buffer.concat(chunks).toString('utf-8')
    const contentType = req.headers['content-type'] ?? ''
    let data = raw
    if (contentType.includes('application/json')) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'data' in parsed &&
          typeof (parsed as { data: unknown }).data === 'string'
        ) {
          data = (parsed as { data: string }).data
        } else {
          data = ''
        }
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('invalid json')
        return
      }
    }
    if (data.length > 0) manager.writeInputToSession(sessionId, data)
    res.writeHead(204)
    res.end()
  })
}

/** Build the data-plane handler bound to a session manager. */
export function createTerminalDataPlaneHandler(manager: TerminalSessionManager): DataPlaneHandler {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const parsed = parsePath(req.url)
    if (!parsed) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (parsed.action === 'out' && method === 'GET') {
      handleOut(manager, parsed.sessionId, req, res)
      return
    }
    if (parsed.action === 'in' && method === 'POST') {
      handleIn(manager, parsed.sessionId, req, res)
      return
    }
    res.writeHead(405, { 'content-type': 'text/plain' })
    res.end('method not allowed')
  }
}
