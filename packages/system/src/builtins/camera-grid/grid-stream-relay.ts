/**
 * The loopback HTTP endpoint the broker dials to consume a grid.
 *
 * A GET is the demand signal and the transport in one: the connection opening
 * is the first consumer arriving, and the connection closing is it leaving.
 * There is no other way to start or stop a composition, which is what makes
 * "off when nobody watches" true by construction rather than by a policy
 * somebody has to remember to apply.
 *
 * Bound on 127.0.0.1 only. The broker is hub-only and so is this addon
 * ({@link ../package.json} `placement: hub-only`), so the endpoint never needs
 * to be reachable from another node — and an MPEG-TS of every camera in the
 * grid is not something to expose on a LAN interface by accident.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { errMsg, type CamProfile } from '@camstack/types'
import { GRID_PROFILES } from './grid-profiles.js'
import type { GridStreamLogger, GridStreamSession } from './grid-stream-session.js'

import { GRID_WIRE_CONTENT_TYPE, GRID_WIRE_PATH_SUFFIX } from './grid-wire-format.js'

const PATH_PREFIX = '/grid/'
const PATH_SUFFIX = GRID_WIRE_PATH_SUFFIX
/** How long a reader may refuse to drain before it is cut. */
const SLOW_READER_MS = 5_000

/**
 * Which grid, and WHICH COMPOSITION of it.
 *
 * The profile is a path segment and not a query string for the reason the
 * restream suffixes are (`restream-intent.ts`): the choice belongs to the URL
 * the consumer was handed, so a broker configured once keeps asking for the
 * same thing. It is REQUIRED — a dial naming none would be the broker asking
 * for "whichever", which is how a `low` slot ends up holding a `high`
 * composition.
 */
export interface GridStreamRequest {
  readonly instanceId: string
  readonly profile: CamProfile
}

function asProfile(raw: string): CamProfile | null {
  return GRID_PROFILES.find((profile) => profile === raw) ?? null
}

/** `/grid/<instanceId>/<profile>.flv`, or `null` when it is anything else. */
export function parseGridStreamPath(url: string | undefined): GridStreamRequest | null {
  const path = (url ?? '').split('?')[0] ?? ''
  if (!path.startsWith(PATH_PREFIX) || !path.endsWith(PATH_SUFFIX)) return null
  const raw = path.slice(PATH_PREFIX.length, path.length - PATH_SUFFIX.length)
  const at = raw.lastIndexOf('/')
  if (at <= 0) return null
  const profile = asProfile(raw.slice(at + 1))
  if (profile === null) return null
  try {
    const instanceId = decodeURIComponent(raw.slice(0, at))
    return instanceId.length > 0 ? { instanceId, profile } : null
  } catch {
    return null
  }
}

export interface GridStreamRelayDeps {
  readonly logger: GridStreamLogger
  /** `null` when no grid serves that instance/profile pair right now. */
  readonly sessionFor: (request: GridStreamRequest) => GridStreamSession | null
}

export class GridStreamRelay {
  private server: Server | null = null
  private baseUrl = ''
  private readonly open = new Set<ServerResponse>()

  constructor(private readonly deps: GridStreamRelayDeps) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      const request = parseGridStreamPath(req.url)
      if (req.method !== 'GET' || request === null) {
        res.writeHead(404).end()
        return
      }
      void this.serve(request, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) {
      server.close()
      throw new Error('camera-grid: the stream relay did not bind a TCP port')
    }
    this.server = server
    this.baseUrl = `http://127.0.0.1:${String(address.port)}`
  }

  /** The URL a grid's catalog descriptor advertises. Empty before {@link start}. */
  streamUrl(request: GridStreamRequest): string {
    if (!this.baseUrl) throw new Error('camera-grid: the stream relay is not started')
    const instance = encodeURIComponent(request.instanceId)
    return `${this.baseUrl}${PATH_PREFIX}${instance}/${request.profile}${PATH_SUFFIX}`
  }

  private async serve(request: GridStreamRequest, res: ServerResponse): Promise<void> {
    const { instanceId, profile } = request
    const session = this.deps.sessionFor(request)
    if (session === null) {
      // A dial for a grid that no longer exists. Logged: the broker retrying a
      // withdrawn camera forever is otherwise invisible.
      this.deps.logger.warn('camera grid: a stream was requested for an unknown grid', {
        meta: { instanceId, profile },
      })
      res.writeHead(404).end()
      return
    }
    this.open.add(res)
    let hold: { close(): void } | null = null
    // D447: a raw HTTP stream reads no chunk the socket has not taken. Honour
    // `write()`'s return, wait for `drain`, and CUT a peer that never drains —
    // one stuck reader must not buffer a composite in the hub's heap, and a
    // silent cut is indistinguishable from a camera that stopped.
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const sendHead = (): void => {
      if (res.headersSent) return
      res.writeHead(200, {
        'content-type': GRID_WIRE_CONTENT_TYPE,
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      // `writeHead` only RECORDS the head; node sends it with the first body
      // write. A composite's first byte can be seconds away (N probes, then a
      // key frame), and a consumer blocked on headers for that long looks like
      // a camera that never answered.
      res.flushHeaders()
    }
    const clearStall = (): void => {
      if (stallTimer === null) return
      clearTimeout(stallTimer)
      stallTimer = null
    }
    res.on('drain', clearStall)
    try {
      hold = await session.open({
        onData: (chunk) => {
          if (res.writableEnded || res.destroyed) return
          // A consumer can be attached to a composition that is ALREADY
          // running, so a byte can reach it before `open()` has resolved.
          sendHead()
          if (res.write(chunk) || stallTimer !== null) return
          stallTimer = setTimeout(() => {
            stallTimer = null
            this.deps.logger.warn(
              'camera grid: cutting a reader that never drained — it was holding the composition',
              {
                tags: { deviceId: session.deviceId },
                meta: { instanceId, profile, stalledForMs: SLOW_READER_MS },
              },
            )
            res.destroy()
          }, SLOW_READER_MS)
          stallTimer.unref?.()
        },
        onClose: (reason) => {
          this.deps.logger.info('camera grid: ending a reader', {
            tags: { deviceId: session.deviceId },
            meta: { instanceId, profile, reason },
          })
          clearStall()
          res.end()
        },
      })
    } catch (error) {
      this.deps.logger.warn('camera grid: could not serve a grid stream', {
        tags: { deviceId: session.deviceId },
        meta: { instanceId, profile, error: errMsg(error) },
      })
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('camera grid unavailable')
      this.open.delete(res)
      return
    }
    // The composition is live: answer now rather than on the first byte, so a
    // reader is not left waiting on headers while ffmpeg probes its inputs.
    sendHead()
    res.on('close', () => {
      this.open.delete(res)
      clearStall()
      hold?.close()
    })
  }

  async dispose(): Promise<void> {
    for (const res of this.open) res.destroy()
    this.open.clear()
    const server = this.server
    this.server = null
    this.baseUrl = ''
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
