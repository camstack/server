/**
 * The clip stream's DIAL listener (D597): a one-shot token on this addon's own
 * loopback HTTP server, which the broker dials directly.
 *
 * ## Why a second front door
 *
 * The addon's data plane is `127.0.0.1` behind a per-listener secret that only
 * the HUB presents, and the hub's `/addon/<id>/…` proxy in front of it takes
 * only a user credential. An addon holds neither, and the framework has no
 * addon→addon byte transport for a live stream (D613's `peerBytes` carries one
 * finished BODY, which is the export path and not this one). The one working
 * precedent for addon→addon media is the broker's own restreams: a cap call
 * mints a URL carrying a token and the consumer dials it. This is that
 * precedent, and it is the SAME shape the Reolink and Hikvision providers
 * already answer with — the broker dials all three without knowing which
 * vendor is behind the socket.
 *
 * ## The token
 *
 * 24 random bytes, base64url, ONE shot: consumed by the first `GET`, refused
 * `dial-used` by any second, `dial-expired` past {@link CLIP_STREAM_DIAL_TTL_MS},
 * `dial-unknown` otherwise. `HEAD` answers the headers and consumes nothing.
 * Outstanding tokens are bounded so a caller that mints and never dials cannot
 * grow a map; expired ones are swept on every mint. Nothing is persisted, and
 * the camera is not touched until the token is taken.
 *
 * Loopback only: this provider is hub-only and the broker is hub-resident.
 *
 * ## Every refusal leaves in a header, and the header is sanitised
 *
 * An HTTP header value is Latin-1 and this repository writes its refusals in
 * prose with `—` and `’` in them. Node throws INSIDE the response handler on
 * anything above U+00FF: the status is never written, the socket hangs, and
 * the client sees nothing — the reason header silencing the reason it exists
 * to carry (D611). Every value goes through `clipReasonHeaderValue`.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  clipReasonHeaderValue,
  type IScopedLogger,
} from '@camstack/types'

import type { ClipStreamAudioAsk } from './clip-stream-mux.js'
import type { ClipStreamOutcome, ClipStreamRefusalCode, ClipStreamSink } from './clip-stream.js'

/** Long enough for the broker's dial→open hop, short enough that a leaked
 *  URL is worth nothing. */
export const CLIP_STREAM_DIAL_TTL_MS = 30_000
/** More than any fleet of sessions opens at once; a bound, not a budget. */
export const CLIP_STREAM_DIAL_MAX_OUTSTANDING = 64

/** The code a refusal carries beside its sentence, so a consumer can branch
 *  without parsing prose. */
export const CLIP_STREAM_REASON_CODE_HEADER = 'x-camstack-reason-code'
/** What the stream IS, stated on the wire: a consumer that cannot honour a
 *  forward-only stream must not play it. */
export const CLIP_STREAM_TRANSPORT_HEADER = 'x-camstack-clip-transport'

/** What one minted dial names. */
export interface ClipStreamTarget {
  readonly deviceId: number
  readonly clipKey: string
  readonly audio: ClipStreamAudioAsk
}

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

export interface ClipStreamDial {
  mint(input: ClipStreamTarget): Promise<ClipStreamDialTicket | ClipStreamDialRefusal>
  /** Tokens minted and not yet dialled or expired. */
  readonly outstanding: number
  dispose(): Promise<void>
}

export interface ClipStreamDialDeps {
  readonly logger: IScopedLogger
  /** Run the gates and stream the clip into `sink`. Never throws for a gated
   *  branch; a throw is a defect and is answered 500. */
  stream(target: ClipStreamTarget, sink: ClipStreamSink): Promise<ClipStreamOutcome>
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

const STREAM_HEADERS = {
  'accept-ranges': 'none',
  'cache-control': 'no-store',
  [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only',
} as const

/**
 * What this response may still say AFTER its body (D623).
 *
 * The status line is spent on the first fragment, and whether the camera hung
 * up a third of the way through is only known at the last byte — so a short
 * serve has no code to come back as, and for one release it came back as a 200
 * that looked exactly like a whole clip. `Trailer` declares the two names it
 * may add; they are the SAME pair the refusal path already uses, so a consumer
 * parses one vocabulary either side of the body.
 *
 * **Only on the response that has a body**, and that is not a style choice.
 * Node throws `Trailers are invalid with this transfer encoding` from INSIDE
 * `writeHead` on a response that is not chunked — measured here on the `HEAD`,
 * which answers headers and no body: the status was never written, the handler
 * threw, and the probe every consumer makes before it dials turned into a 500.
 * The same shape as the refusal header that hung the socket it existed to
 * explain (D611).
 */
const BODY_TRAILER_HEADER = {
  trailer: `${CLIP_STILL_REASON_CODE_HEADER}, ${CLIP_STILL_REASON_HEADER}`,
} as const

/** `404` = nothing here to serve; `502` = the camera; `503` = its one replay. */
export function streamRefusalStatus(code: ClipStreamRefusalCode): 404 | 502 | 503 {
  switch (code) {
    // Temporarily held, and not for long: a status that says "come back",
    // where 502 would say the camera is broken and 404 would say the clip is
    // not there. Neither is true.
    case 'replay-busy':
      return 503
    case 'camera-refused':
    case 'fetch-failed':
      return 502
  }
}

function pathToken(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  const path = query === -1 ? raw : raw.slice(0, query)
  return path.replace(/^\/+/, '')
}

export function createClipStreamDial(deps: ClipStreamDialDeps): ClipStreamDial {
  const now = deps.now ?? ((): number => Date.now())
  const ttlMs = deps.ttlMs ?? CLIP_STREAM_DIAL_TTL_MS
  const maxOutstanding = deps.maxOutstanding ?? CLIP_STREAM_DIAL_MAX_OUTSTANDING
  const host = deps.host ?? '127.0.0.1'
  const tokens = new Map<string, MintedToken>()
  /** Tokens already dialled, kept for their TTL so a replay is named
   *  `dial-used` rather than `dial-unknown`. */
  const used = new Map<string, number>()
  let server: Server | null = null
  let baseUrl: string | null = null
  let listening: Promise<string> | null = null

  const sweep = (): void => {
    const at = now()
    for (const [token, minted] of tokens) if (minted.expiresAtMs <= at) tokens.delete(token)
    for (const [token, expiresAtMs] of used) if (expiresAtMs <= at) used.delete(token)
  }

  const refuse = (res: ServerResponse, status: number, code: string, detail: string): void => {
    res.writeHead(status, {
      [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(detail),
      [CLIP_STREAM_REASON_CODE_HEADER]: code,
    })
    res.end()
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const token = pathToken(req)
    const minted = tokens.get(token)
    if (minted === undefined) {
      const code = used.has(token) ? 'dial-used' : 'dial-unknown'
      deps.logger.warn('videoclips: a clip stream dial was not honoured', {
        meta: { branch: code },
      })
      refuse(
        res,
        code === 'dial-used' ? 410 : 404,
        code,
        code === 'dial-used' ? 'this dial was already taken' : 'no such dial',
      )
      return
    }
    if (minted.expiresAtMs <= now()) {
      tokens.delete(token)
      deps.logger.warn('videoclips: a clip stream dial had expired', {
        tags: { deviceId: minted.target.deviceId },
        meta: { clipKey: minted.target.clipKey, branch: 'dial-expired' },
      })
      refuse(res, 410, 'dial-expired', 'this dial has expired')
      return
    }
    if (req.method === 'HEAD') {
      // A HEAD takes no dial and spawns no mux, so the camera is not touched
      // and the token survives for the GET that follows.
      res.writeHead(200, { 'content-type': 'video/mp4', ...STREAM_HEADERS })
      res.end()
      return
    }
    // One shot: the first GET takes it.
    tokens.delete(token)
    used.set(token, minted.expiresAtMs)
    deps.logger.info('videoclips: a clip stream dial was taken', {
      tags: { deviceId: minted.target.deviceId },
      meta: {
        clipKey: minted.target.clipKey,
        audio: minted.target.audio,
        outstanding: tokens.size,
      },
    })
    if (req.headers.range !== undefined) {
      deps.logger.debug('videoclips: a Range header on the clip stream route is ignored', {
        tags: { deviceId: minted.target.deviceId },
        meta: { clipKey: minted.target.clipKey, range: req.headers.range },
      })
    }
    const sink: ClipStreamSink = {
      begin: (contentType) => {
        res.writeHead(200, {
          'content-type': contentType,
          ...STREAM_HEADERS,
          ...BODY_TRAILER_HEADER,
        })
      },
      write: (chunk) => res.write(chunk),
      onceDrain: (listener) => {
        res.once('drain', listener)
      },
      onceClose: (listener) => {
        res.once('close', listener)
      },
      // The producer's last word about its own stream. `addTrailers` is a
      // no-op on an empty object, so a whole clip costs nothing and a short
      // one arrives named.
      end: (trailers) => {
        res.addTrailers({ ...trailers })
        res.end()
      },
      destroy: () => {
        res.destroy()
      },
    }
    const outcome = await deps.stream(minted.target, sink)
    if (outcome.kind !== 'refused') return
    if (res.headersSent) {
      res.destroy()
      return
    }
    refuse(res, streamRefusalStatus(outcome.code), outcome.code, outcome.detail)
  }

  const listen = (): Promise<string> => {
    if (listening !== null) return listening
    listening = new Promise<string>((resolve, reject) => {
      const created = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res).catch((err: unknown) => {
          deps.logger.warn('videoclips: the clip stream dial handler threw', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
          if (res.headersSent) res.destroy()
          else {
            res.writeHead(500)
            res.end()
          }
        })
      })
      created.on('error', (err) => {
        listening = null
        reject(err)
      })
      created.listen(0, host, () => {
        const address: AddressInfo | string | null = created.address()
        if (address === null || typeof address === 'string') {
          created.close()
          listening = null
          reject(new Error('the dial listener bound no TCP port'))
          return
        }
        server = created
        baseUrl = `http://${host}:${String(address.port)}`
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
          meta: { clipKey: input.clipKey, outstanding: tokens.size, maxOutstanding },
        })
        return {
          kind: 'refused',
          code: 'dial-exhausted',
          detail: `${String(tokens.size)} dials outstanding against a bound of ${String(maxOutstanding)}`,
        }
      }
      let base: string
      try {
        base = baseUrl ?? (await listen())
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err)
        deps.logger.warn('videoclips: clip stream dial refused — no listener', {
          tags: { deviceId: input.deviceId },
          meta: { clipKey: input.clipKey, error: detail },
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
