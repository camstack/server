/**
 * Kernel side of the addon HTTP **data-plane** (see {@link AddonDataPlane}).
 *
 * Each addon context gets one facility. On the first `serve()`, it binds a
 * `127.0.0.1` HTTP listener IN THE ADDON'S PROCESS and multiplexes registered
 * prefixes → the addon's real `(req, res)` handlers (longest-prefix wins). Every
 * request must carry the per-listener shared secret (injected by the hub's
 * reverse-proxy) — anything else gets 403, so no other local process can reach
 * the listener. The facility reports its live endpoints through a `sink` so the
 * runner can hand them to the hub (which pulls them when it mounts the addon).
 *
 * The addon never sees the secret, the port, or any transport detail — it just
 * streams to `res`. The hub authenticates and reverse-proxies in front.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { DATAPLANE_SECRET_HEADER } from '@camstack/types/addon'
import type {
  AddonDataPlane,
  AddonDataPlaneHandle,
  AddonDataPlaneEndpoint,
  DataPlaneHandler,
  RouteAccess,
  IScopedLogger,
  ShareViewKind,
} from '@camstack/types'

/** Where the facility publishes the addon's current data-plane endpoints so the
 *  runner can expose them to the hub's pull. */
export interface DataPlaneSink {
  set(addonId: string, endpoints: readonly AddonDataPlaneEndpoint[]): void
}

export interface AddonDataPlaneFacility {
  readonly dataPlane: AddonDataPlane
  /** Close the listener + clear endpoints. Wired to the context disposer chain. */
  dispose(): Promise<void>
}

interface ServedPrefix {
  readonly access: RouteAccess
  readonly handler: DataPlaneHandler
  readonly share?: readonly ShareViewKind[]
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
}

export function createAddonDataPlaneFacility(args: {
  readonly addonId: string
  readonly logger: IScopedLogger
  readonly sink?: DataPlaneSink
  /** Bind host — `127.0.0.1` for a hub-local addon (default). Remote agents bind
   *  their reachable interface (deferred — single-hub first). */
  readonly bindHost?: string
}): AddonDataPlaneFacility {
  const bindHost = args.bindHost ?? '127.0.0.1'
  const secret = randomBytes(24).toString('hex')
  const served = new Map<string, ServedPrefix>() // normalized prefix → entry
  let server: Server | null = null
  let baseUrl = ''

  const route = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers[DATAPLANE_SECRET_HEADER] !== secret) {
      res.writeHead(403).end()
      return
    }
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
    const normalized = `/${trimSlashes(urlPath)}`
    let best: { prefix: string; entry: ServedPrefix; rest: string } | null = null
    for (const [prefix, entry] of served) {
      const p = `/${prefix}`
      if (normalized === p || normalized.startsWith(`${p}/`)) {
        if (best === null || p.length > `/${best.prefix}`.length) {
          best = { prefix, entry, rest: normalized.slice(p.length) || '/' }
        }
      }
    }
    if (best === null) {
      res.writeHead(404).end()
      return
    }
    // Hand the addon a `req.url` relative to its prefix (`/<rest>?<query>`).
    const original = req.url ?? ''
    const qIdx = original.indexOf('?')
    req.url = best.rest + (qIdx >= 0 ? original.slice(qIdx) : '')
    Promise.resolve(best.entry.handler(req, res)).catch((err: unknown) => {
      args.logger.warn('data-plane handler threw', {
        meta: { prefix: best.prefix, error: err instanceof Error ? err.message : String(err) },
      })
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    })
  }

  const ensureServer = async (): Promise<void> => {
    if (server) return
    const s = createServer((req, res) => route(req, res))
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(0, bindHost, () => resolve())
    })
    const addr = s.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    server = s
    baseUrl = `http://${bindHost}:${port}`
  }

  const publish = (): void => {
    const endpoints: AddonDataPlaneEndpoint[] = [...served.entries()].map(([prefix, entry]) => ({
      prefix,
      access: entry.access,
      baseUrl,
      secret,
      ...(entry.share !== undefined ? { share: entry.share } : {}),
    }))
    args.sink?.set(args.addonId, endpoints)
  }

  const dataPlane: AddonDataPlane = {
    serve: async (options) => {
      const prefix = trimSlashes(options.prefix)
      if (prefix.length === 0) throw new Error('dataPlane.serve: a non-empty prefix is required')
      await ensureServer()
      served.set(prefix, {
        access: options.access,
        handler: options.handler,
        ...(options.share !== undefined ? { share: options.share } : {}),
      })
      publish()
      args.logger.info('data-plane endpoint served', {
        meta: { prefix, access: options.access, baseUrl },
      })
      const handle: AddonDataPlaneHandle = {
        baseUrl,
        prefix,
        dispose: async () => {
          served.delete(prefix)
          publish()
        },
      }
      return handle
    },
  }

  const dispose = async (): Promise<void> => {
    served.clear()
    args.sink?.set(args.addonId, [])
    if (server) {
      const s = server
      server = null
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  }

  return { dataPlane, dispose }
}
