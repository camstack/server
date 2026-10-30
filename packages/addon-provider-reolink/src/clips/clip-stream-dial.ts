/**
 * The clip stream's DIAL listener (D597): the same stream handler as the
 * data plane, behind a one-shot token instead of the hub's secret.
 *
 * ## Why a second front door
 *
 * The data-plane listener is `127.0.0.1` behind a per-listener secret that
 * ONLY the hub presents, and the hub's `/addon/<id>/…` proxy in front of it
 * takes only a user credential — a session cookie, a scoped token, a
 * JWT. An addon holds none of those, and `ctx.api.<cap>.subscribe` is
 * refused on the addon caller by design, so the framework has no
 * addon→addon byte transport at all. The broker, which is the consumer
 * stage 2 exists for, therefore cannot reach the stream through either door.
 *
 * The one working precedent for addon→addon media in this repo is the
 * broker's own restreams: a cap call mints a URL carrying a token, the
 * consumer dials it directly (`getStreamWithCodec`, dialled by the recorder
 * and HomeKit). This is that precedent, one addon over: `videoclips.dialClipStream`
 * mints `http://127.0.0.1:<port>/<token>`, and the broker dials it. It is
 * loopback-only because the provider is `hub-only` and the broker is
 * hub-resident; a remote consumer would need the `hostname` rewrite the
 * restreams already have, and it is not built here.
 *
 * ## The token
 *
 * 24 random bytes, base64url, ONE shot: consumed by the first `GET`, refused
 * `dial-used` by any second, `dial-expired` past {@link CLIP_STREAM_DIAL_TTL_MS},
 * `dial-unknown` otherwise. `HEAD` answers the headers and consumes nothing.
 * Outstanding tokens are bounded ({@link CLIP_STREAM_DIAL_MAX_OUTSTANDING})
 * so a caller that mints and never dials cannot grow a map; expired ones are
 * swept on every mint. Nothing is persisted.
 *
 * The handler behind the token is `createClipStreamHandler` with a token
 * target resolver — the route's gates, the producer, the status line on the
 * first byte and the reason codes are all the data plane's own. A second
 * stream handler would be a second authority on what a stream is.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { IScopedLogger } from '@camstack/types'

import {
  type ClipStreamHandlerDeps,
  type ClipStreamTarget,
  type ClipStreamTargetResolution,
  createClipStreamHandler,
} from './clip-data-plane.js'

/** Long enough for the broker's dial→open hop (measured well under 100 ms
 *  on the same host), short enough that a leaked URL is worth nothing. */
export const CLIP_STREAM_DIAL_TTL_MS = 30_000
/** More than any fleet of sessions opens at once; a bound, not a budget. */
export const CLIP_STREAM_DIAL_MAX_OUTSTANDING = 64

export interface ClipStreamDialTicket {
  readonly kind: 'ticket'
  readonly url: string
  readonly expiresAtMs: number
}

export interface ClipStreamDialRefusal {
  readonly kind: 'refused'
  readonly code: 'dial-exhausted' | 'listener-failed'
  readonly detail: string
}

/**
 * A dial names the clip, the twin and the audio codec in ONE place.
 *
 * `ClipStreamTarget` already carries all three since D600, so the mint input
 * IS the target: a second shape here is how the twin came to be minted, kept
 * and never handed to the route.
 */
export type ClipStreamDialMintInput = ClipStreamTarget

export interface ClipStreamDial {
  mint(input: ClipStreamDialMintInput): Promise<ClipStreamDialTicket | ClipStreamDialRefusal>
  /** Tokens minted and not yet dialled or expired. */
  readonly outstanding: number
  dispose(): Promise<void>
}

export interface ClipStreamDialDeps {
  readonly logger: IScopedLogger
  /** The route: the same `stream` the data-plane handler is built on. */
  readonly stream: ClipStreamHandlerDeps['stream']
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxOutstanding?: number
  /** Bind host. Loopback, and only loopback, in production. */
  readonly host?: string
}

interface MintedToken {
  readonly target: ClipStreamTarget
  readonly expiresAtMs: number
}

function pathToken(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  const path = query === -1 ? raw : raw.slice(0, query)
  return path.replace(/^\/+/, '')
}

export function createClipStreamDial(deps: ClipStreamDialDeps): ClipStreamDial {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? CLIP_STREAM_DIAL_TTL_MS
  const maxOutstanding = deps.maxOutstanding ?? CLIP_STREAM_DIAL_MAX_OUTSTANDING
  const host = deps.host ?? '127.0.0.1'
  const tokens = new Map<string, MintedToken>()
  /** Tokens already dialled, kept for their TTL so a replay is named `dial-used`, not `dial-unknown`. */
  const used = new Map<string, number>()
  let server: Server | null = null
  let baseUrl: string | null = null
  let listening: Promise<string> | null = null

  const sweep = (): void => {
    const at = now()
    for (const [token, minted] of tokens) if (minted.expiresAtMs <= at) tokens.delete(token)
    for (const [token, expiresAtMs] of used) if (expiresAtMs <= at) used.delete(token)
  }

  const resolveTarget = (req: IncomingMessage): ClipStreamTargetResolution => {
    const token = pathToken(req)
    const minted = tokens.get(token)
    if (minted === undefined) {
      const usedAt = used.get(token)
      if (usedAt !== undefined) {
        return {
          kind: 'refused',
          status: 410,
          code: 'dial-used',
          detail: 'this dial was already taken',
        }
      }
      return { kind: 'refused', status: 404, code: 'dial-unknown', detail: 'no such dial' }
    }
    if (minted.expiresAtMs <= now()) {
      tokens.delete(token)
      return { kind: 'refused', status: 410, code: 'dial-expired', detail: 'this dial has expired' }
    }
    if (req.method === 'GET') {
      // One shot: the first GET takes it. A HEAD looks and leaves it.
      tokens.delete(token)
      used.set(token, minted.expiresAtMs)
      deps.logger.info('videoclips: a clip stream dial was taken', {
        tags: { deviceId: minted.target.deviceId },
        meta: {
          clipKey: minted.target.clipKey,
          twin: minted.target.twin,
          audio: minted.target.audio,
          outstanding: tokens.size,
        },
      })
    }
    return { kind: 'target', target: minted.target }
  }

  const handler = createClipStreamHandler({
    stream: deps.stream,
    logger: deps.logger,
    target: resolveTarget,
  })

  const listen = (): Promise<string> => {
    if (listening !== null) return listening
    listening = new Promise<string>((resolve, reject) => {
      const created = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res).catch((err: unknown) => {
          deps.logger.warn('videoclips: the clip stream dial handler threw', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
      created.on('error', (err) => {
        listening = null
        reject(err)
      })
      created.listen(0, host, () => {
        const address = created.address() as AddressInfo | string | null
        if (address === null || typeof address === 'string') {
          created.close()
          listening = null
          reject(new Error('the dial listener bound no TCP port'))
          return
        }
        server = created
        baseUrl = `http://${host}:${address.port}`
        deps.logger.info('videoclips: clip stream dial listener bound', {
          meta: { host, port: address.port, ttlMs, maxOutstanding },
        })
        resolve(baseUrl)
      })
    })
    return listening
  }

  return {
    get outstanding() {
      sweep()
      return tokens.size
    },
    mint: async (input) => {
      sweep()
      if (tokens.size >= maxOutstanding) {
        deps.logger.warn('videoclips: clip stream dial refused — too many outstanding', {
          tags: { deviceId: input.deviceId },
          meta: {
            clipKey: input.clipKey,
            twin: input.twin,
            outstanding: tokens.size,
            maxOutstanding,
          },
        })
        return {
          kind: 'refused',
          code: 'dial-exhausted',
          detail: `${tokens.size} dials outstanding against a bound of ${maxOutstanding}`,
        }
      }
      let base: string
      try {
        base = baseUrl ?? (await listen())
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        deps.logger.warn('videoclips: clip stream dial refused — no listener', {
          tags: { deviceId: input.deviceId },
          meta: { clipKey: input.clipKey, twin: input.twin, error: detail },
        })
        return { kind: 'refused', code: 'listener-failed', detail }
      }
      const token = randomBytes(24).toString('base64url')
      const expiresAtMs = now() + ttlMs
      tokens.set(token, { target: input, expiresAtMs })
      deps.logger.info('videoclips: clip stream dial minted', {
        tags: { deviceId: input.deviceId },
        meta: {
          clipKey: input.clipKey,
          twin: input.twin,
          audio: input.audio,
          expiresInMs: ttlMs,
          outstanding: tokens.size,
        },
      })
      return { kind: 'ticket', url: `${base}/${token}`, expiresAtMs }
    },
    dispose: async () => {
      tokens.clear()
      used.clear()
      const open = server
      server = null
      baseUrl = null
      listening = null
      if (open === null) return
      await new Promise<void>((resolve) => {
        open.close(() => resolve())
        open.closeAllConnections()
      })
      deps.logger.info('videoclips: clip stream dial listener closed', {})
    },
  }
}
