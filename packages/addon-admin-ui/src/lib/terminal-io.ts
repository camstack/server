/**
 * Terminal-session data-plane transport for the Admin UI.
 *
 * The `terminal-session` capability owns lifecycle only (open/resize/close/
 * list). The actual terminal bytes flow over the addon data plane, which is
 * ordered and lossless — a dropped chunk would desynchronise the vt parser and
 * corrupt the screen permanently (see the capability contract / [D8]).
 *
 *   - output: `GET  /addon/terminal/io/<sessionId>/out` — Server-Sent Events.
 *   - input:  `POST /addon/terminal/io/<sessionId>/in`  — `{ data }` JSON body.
 *
 * Both endpoints are admin-Bearer gated at the hub. Native `EventSource` cannot
 * attach an `Authorization` header, so the output stream is consumed via
 * `fetch` + `ReadableStream` and its SSE frames are parsed here by hand. The
 * token lives in `localStorage` under the same key the rest of the admin UI
 * uses (see `authed-media.ts`).
 */
import { hubPath } from './mount'

const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

/** Data-plane prefix the hub reverse-proxies to the terminal addon. */
export const TERMINAL_IO_BASE = hubPath('/addon/terminal/io')

/**
 * A single SSE event from the output stream. `data` carries raw terminal bytes
 * decoded as a utf-8 string (write it straight into xterm); `exit` reports the
 * pty terminating.
 */
export type TerminalIoEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'exit'; readonly exitCode: number; readonly signal?: number }

/** Handle returned by {@link openTerminalOutputStream}; call `close` to abort. */
export interface TerminalOutputStream {
  readonly close: () => void
}

interface TerminalOutputHandlers {
  readonly onEvent: (event: TerminalIoEvent) => void
  /** Fired when the stream fails for a reason other than a caller-side abort. */
  readonly onError?: (error: unknown) => void
  /** Fired when the server closes the stream cleanly (pty gone / EOF). */
  readonly onClose?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Narrow an arbitrary parsed JSON value to a {@link TerminalIoEvent}, or `null`
 * if it is not a recognised event shape. Kept cast-free (type guards only) per
 * the repo's no-`as` rule.
 */
export function toTerminalIoEvent(value: unknown): TerminalIoEvent | null {
  if (!isRecord(value)) return null
  if (value.kind === 'data' && typeof value.data === 'string') {
    return { kind: 'data', data: value.data }
  }
  if (value.kind === 'exit' && typeof value.exitCode === 'number') {
    return typeof value.signal === 'number'
      ? { kind: 'exit', exitCode: value.exitCode, signal: value.signal }
      : { kind: 'exit', exitCode: value.exitCode }
  }
  return null
}

/**
 * Parse whatever whole SSE frames are present in `buffer` and return the
 * decoded events plus the unconsumed tail (a partial frame still arriving).
 *
 * Frames are delimited by a blank line (`\n\n`). Within a frame only `data: `
 * lines carry payload; comment keepalives (`: keepalive`) and other field lines
 * are ignored, so a keepalive-only frame yields nothing. A frame's `data:`
 * lines are joined with `\n` (standard SSE) and JSON-parsed; a frame that does
 * not parse is skipped rather than corrupting the tail. Pure and synchronous so
 * it can be unit-tested without a stream.
 */
export function parseSseBuffer(buffer: string): {
  readonly events: readonly TerminalIoEvent[]
  readonly rest: string
} {
  const events: TerminalIoEvent[] = []
  let rest = buffer
  let boundary = rest.indexOf('\n\n')
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    boundary = rest.indexOf('\n\n')

    const dataLines: string[] = []
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (dataLines.length === 0) continue

    try {
      const event = toTerminalIoEvent(JSON.parse(dataLines.join('\n')))
      if (event) events.push(event)
    } catch {
      // Malformed frame — skip it. The transport is lossless, so this only
      // happens on a genuinely corrupt payload, not a torn read.
    }
  }
  return { events, rest }
}

function authHeaders(base: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  return token ? { ...base, Authorization: `Bearer ${token}` } : base
}

/**
 * Open the authed SSE output stream for a session and deliver decoded events.
 *
 * Consumes `response.body` as a byte stream, decodes incrementally, and feeds
 * complete SSE frames through {@link parseSseBuffer}. The returned handle's
 * `close()` aborts the underlying fetch — an abort is treated as an intentional
 * teardown and does NOT invoke `onError`.
 */
export function openTerminalOutputStream(
  sessionId: string,
  handlers: TerminalOutputHandlers,
): TerminalOutputStream {
  const controller = new AbortController()
  const url = `${TERMINAL_IO_BASE}/${encodeURIComponent(sessionId)}/out`

  const run = async (): Promise<void> => {
    const response = await fetch(url, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok || !response.body) {
      throw new Error(`terminal output stream failed: ${String(response.status)}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseBuffer(buffer)
      buffer = rest
      for (const event of events) handlers.onEvent(event)
    }
    handlers.onClose?.()
  }

  void run().catch((error: unknown) => {
    if (controller.signal.aborted) return
    handlers.onError?.(error)
  })

  return { close: () => controller.abort() }
}

/**
 * Send keystrokes to a session's pty. Pass xterm's `onData` payload straight
 * through — the addon writes it to the pty verbatim.
 */
export async function sendTerminalInput(sessionId: string, data: string): Promise<void> {
  const url = `${TERMINAL_IO_BASE}/${encodeURIComponent(sessionId)}/in`
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data }),
  })
  if (!response.ok) {
    throw new Error(`terminal input failed: ${String(response.status)}`)
  }
}
