/**
 * Second HTTP listener that shares the hub's existing request handler.
 *
 * Fastify is one protocol per instance; HTTPS stays on :4443 and this
 * binds a plain `http.Server` that emits `request` AND `upgrade` onto the
 * same handler graph (tRPC HTTP, cookies, data-plane, static, tRPC WS).
 *
 * Forwarding only `request` is not enough: the viewer speaks tRPC exclusively
 * over WebSocket (`wsLink`). `/health` wins the LAN race, then `ws://…/trpc`
 * hangs because nobody handles the upgrade on this socket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface LanHttpBindOptions {
  readonly enabled: boolean
  readonly port: number
  readonly host: string
}

export interface LanHttpBindResult {
  readonly listening: boolean
  readonly error: string | null
  readonly port: number
}

export type LanHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => void
export type LanHttpUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface LanHttpHandlers {
  readonly onRequest: LanHttpRequestHandler
  readonly onUpgrade: LanHttpUpgradeHandler
}

const DEFAULT_HTTP_PORT = 4480

let handlers: LanHttpHandlers | null = null
let server: Server | null = null
let pending: LanHttpBindOptions | null = null
let state: LanHttpBindResult = { listening: false, error: null, port: DEFAULT_HTTP_PORT }
let boundRequestedHost: string | null = null

export const DEFAULT_LAN_HTTP_PORT: number = DEFAULT_HTTP_PORT

/** Map "all IPv4" to dual-stack IPv6 (`::`, ipv6Only false) so IPv4 still works. */
export function allFamiliesListenHost(host: string): { host: string; ipv6Only: boolean } {
  if (host === '0.0.0.0' || host === '*' || host === '') {
    return { host: '::', ipv6Only: false }
  }
  return { host, ipv6Only: false }
}

export function registerLanHttpHandler(next: LanHttpHandlers | null): void {
  handlers = next
}

export function readLanHttpState(): LanHttpBindResult {
  return state
}

export async function applyLanHttp(options: LanHttpBindOptions): Promise<LanHttpBindResult> {
  pending = options
  if (!options.enabled) {
    await closeLanHttp()
    state = { listening: false, error: null, port: options.port }
    return state
  }
  if (handlers === null) {
    state = { listening: false, error: 'HTTP listener is not registered yet', port: options.port }
    return state
  }
  if (
    server !== null &&
    state.listening &&
    (options.port === 0 || state.port === options.port) &&
    boundRequestedHost === options.host
  ) {
    return state
  }
  await closeLanHttp()
  try {
    const bound = await listenHttp(options.port, options.host, handlers)
    server = bound
    boundRequestedHost = options.host
    const addr = bound.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : options.port
    state = { listening: true, error: null, port }
    return state
  } catch (err: unknown) {
    server = null
    state = {
      listening: false,
      error: err instanceof Error ? err.message : String(err),
      port: options.port,
    }
    return state
  }
}

/** After the hub registers the Fastify request handler, bind whatever was pending. */
export async function bindPendingLanHttp(): Promise<LanHttpBindResult> {
  if (pending === null) {
    return applyLanHttp({ enabled: true, port: DEFAULT_HTTP_PORT, host: '0.0.0.0' })
  }
  return applyLanHttp(pending)
}

export async function closeLanHttp(): Promise<void> {
  const current = server
  server = null
  boundRequestedHost = null
  if (current === null) return
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
  })
}

function listenHttp(port: number, host: string, next: LanHttpHandlers): Promise<Server> {
  const resolved = allFamiliesListenHost(host)
  return listenOn(port, resolved, next).catch((err: unknown) => {
    if (resolved.host === '::' && host !== '::') {
      return listenOn(port, { host: '0.0.0.0', ipv6Only: false }, next)
    }
    throw err
  })
}

function listenOn(
  port: number,
  bind: { host: string; ipv6Only: boolean },
  next: LanHttpHandlers,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const created = createServer(next.onRequest)
    created.on('upgrade', next.onUpgrade)
    const onError = (err: Error): void => {
      created.off('listening', onListening)
      created.close()
      reject(err)
    }
    const onListening = (): void => {
      created.off('error', onError)
      resolve(created)
    }
    created.once('error', onError)
    created.once('listening', onListening)
    created.listen({ port, host: bind.host, ipv6Only: bind.ipv6Only })
  })
}
