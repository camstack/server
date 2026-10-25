/**
 * clip-stream-http — the `node:http` half of {@link ClipStreamOpener}.
 *
 * Dials the URL `videoclips.dialClipStream` handed back — plain HTTP on the
 * provider's own token-gated listener, never the hub's proxy (an addon holds
 * no user credential, and the hub proxy takes only those) — and turns the
 * response into what the feeder drives: `pause`/`resume`/`destroy` on the
 * socket and the three events.
 *
 * A status other than 200 is a REFUSAL, named by the provider's own headers
 * (`x-camstack-reason-code`, `x-camstack-reason`), never a stream of nothing.
 * A 200 that does not declare `x-camstack-clip-transport: forward-only` is
 * refused too: it means the URL is not the stream route, and playing a
 * progressive file through a forward-only feeder would look like it worked
 * until the first seek.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import {
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  CLIP_STREAM_TRANSPORT_HEADER,
} from '@camstack/types'
import type {
  ClipIncompleteReport,
  ClipStreamHandlers,
  ClipStreamOpened,
  ClipStreamOpener,
} from './clip-stream-feeder.js'

/**
 * The codes a provider may add AFTER its body, and the only two this hop
 * carries onward.
 *
 * A stream's status line is spent on its first fragment, so a serve the camera
 * cut short has nothing left to say it with but a trailer — and a trailer this
 * reader did not know about would be read as a whole clip, which is the defect
 * D623 is about, one hop further out. Anything else a provider writes there is
 * ITS diagnostic and stays in ITS log: a viewer is shown what it can act on.
 */
const CARRIED_TRAILER_CODES: readonly string[] = ['stream-short', 'stream-empty']

function trailerText(trailers: NodeJS.Dict<string>, name: string): string | undefined {
  const value = trailers[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * What the provider said about its own stream once the last byte was out.
 *
 * `null` for a stream that added nothing, which is a whole one — the absence
 * is the statement, and it is never read as "unknown". A code with no sentence
 * is still reported, with the code standing in for one: a consumer that
 * branches on the code must not lose the branch because the prose was dropped
 * by a proxy.
 */
export function readClipStreamTrailers(trailers: NodeJS.Dict<string>): ClipIncompleteReport | null {
  const code = trailerText(trailers, CLIP_STILL_REASON_CODE_HEADER)
  if (code === undefined || !CARRIED_TRAILER_CODES.includes(code)) return null
  return {
    code: code === 'stream-empty' ? 'stream-empty' : 'stream-short',
    reason: trailerText(trailers, CLIP_STILL_REASON_HEADER) ?? code,
  }
}

/** The provider's first byte follows the camera's first fragment and the
 *  cmd-5 retry ladder; the file path waits on the same camera for as long. */
export const CLIP_STREAM_HEADERS_TIMEOUT_MS = 30_000

export interface ClipStreamHttpOptions {
  readonly headersTimeoutMs?: number
}

/** The abort's reason, as a sentence the provider's log can be matched against. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  return 'the clip stream was abandoned before it opened'
}

function headerText(res: IncomingMessage, name: string): string | undefined {
  const value = res.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

export function createHttpClipStreamOpener(options: ClipStreamHttpOptions = {}): ClipStreamOpener {
  const headersTimeoutMs = options.headersTimeoutMs ?? CLIP_STREAM_HEADERS_TIMEOUT_MS
  return (
    url: string,
    handlers: ClipStreamHandlers,
    signal: AbortSignal,
  ): Promise<ClipStreamOpened> =>
    new Promise<ClipStreamOpened>((resolve) => {
      let settled = false
      let onAbort: (() => void) | null = null
      const settle = (value: ClipStreamOpened): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (onAbort !== null) signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const abandoned = (): ClipStreamOpened => ({
        kind: 'refused',
        status: 0,
        code: 'abandoned',
        detail: describeReason(signal.reason),
      })
      // Already gone before the socket was made: never dial at all. A ticket
      // spent on a request nobody is waiting for is a lane the provider will
      // serve for nothing.
      if (signal.aborted) {
        resolve(abandoned())
        return
      }
      let target: URL
      try {
        target = new URL(url)
      } catch (err) {
        settle({ kind: 'refused', status: 0, code: 'bad-url', detail: String(err) })
        return
      }
      if (target.protocol !== 'http:') {
        settle({
          kind: 'refused',
          status: 0,
          code: 'bad-url',
          detail: `a clip stream is dialled over plain http on the provider's listener, not ${target.protocol}`,
        })
        return
      }
      const req = httpRequest(target, { method: 'GET', headers: { accept: 'video/mp4' } })
      const timer = setTimeout(() => {
        req.destroy(new Error(`no status line in ${headersTimeoutMs} ms`))
      }, headersTimeoutMs)
      // THE cancellation lever, and the only one that exists before the
      // status line. `destroy()` on the connection below is the lever AFTER
      // it; between the two there used to be nothing, and that gap is what
      // held a Reolink host's serial clip lane for thirty seconds a tap.
      onAbort = (): void => {
        req.destroy(new Error(describeReason(signal.reason)))
        settle(abandoned())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('error', (err) => {
        // An abort raises `error` on the request too; the refusal it settles
        // with must name the abandonment, not the socket.
        if (signal.aborted) {
          settle(abandoned())
          return
        }
        settle({ kind: 'refused', status: 0, code: 'connect-failed', detail: err.message })
      })
      req.on('response', (res) => {
        const status = res.statusCode ?? 0
        if (status !== 200) {
          res.resume()
          settle({
            kind: 'refused',
            status,
            code: headerText(res, CLIP_STILL_REASON_CODE_HEADER) ?? `http-${status}`,
            detail: headerText(res, CLIP_STILL_REASON_HEADER) ?? '',
          })
          return
        }
        if (headerText(res, CLIP_STREAM_TRANSPORT_HEADER) !== 'forward-only') {
          req.destroy()
          settle({
            kind: 'refused',
            status,
            code: 'not-a-stream',
            detail: 'the URL answered 200 without declaring the forward-only clip transport',
          })
          return
        }
        res.on('data', (chunk: Buffer) => handlers.onData(chunk))
        // Trailers are readable only HERE — they arrive after the last chunk,
        // and `res.trailers` is empty until the message is complete.
        res.on('end', () => handlers.onEnd(readClipStreamTrailers(res.trailers)))
        res.on('error', (err) => handlers.onError(err))
        settle({
          kind: 'open',
          connection: {
            pause: () => {
              res.pause()
            },
            resume: () => {
              res.resume()
            },
            destroy: () => {
              req.destroy()
            },
          },
        })
      })
      req.end()
    })
}
