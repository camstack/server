/**
 * The WebSocket client of one Zigbee2MQTT server: connect, reconnect with a capped exponential
 * backoff, request/response by `transaction`, and a typed stream of validated envelopes.
 *
 * The socket is injected (`Z2mSocketFactory`), so the client is exercised against a fake. The token
 * rides in the URL's query string, as the server demands, and is therefore never logged: a log line
 * names `host:port`, never the URL.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  parseEnvelope,
  Z2M_CLOSE_UNAUTHORIZED,
  Z2M_RESPONSE_PREFIX,
  Z2mResponseSchema,
  type Z2mEnvelope,
} from './z2m-protocol.js'

export type Z2mConnection = 'connecting' | 'online' | 'offline' | 'auth-rejected' | 'closed'

export interface Z2mSocketHandlers {
  readonly open: () => void
  readonly message: (text: string) => void
  readonly close: (code: number, reason: string) => void
  readonly error: (message: string) => void
}

export interface Z2mSocket {
  readonly send: (text: string) => void
  readonly close: () => void
}

export type Z2mSocketFactory = (url: string, handlers: Z2mSocketHandlers) => Z2mSocket

/** Run once after `ms`; the returned function cancels it. */
export interface Z2mTimers {
  readonly after: (run: () => void, ms: number) => () => void
}

const REAL_TIMERS: Z2mTimers = {
  after: (run, ms) => {
    const handle = setTimeout(run, ms)
    return () => clearTimeout(handle)
  },
}

/** The runtime's own WebSocket, behind the narrow `Z2mSocket` surface. */
export const nativeSocketFactory: Z2mSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url)
  socket.addEventListener('open', () => handlers.open())
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.message(event.data)
  })
  socket.addEventListener('close', (event) => handlers.close(event.code, event.reason))
  socket.addEventListener('error', () => handlers.error('socket error'))
  return { send: (text) => socket.send(text), close: () => socket.close() }
}

export interface Z2mEndpoint {
  readonly host: string
  readonly port: number
  readonly tls: boolean
  readonly token: string | null
}

export function z2mDisplayAddress(endpoint: Pick<Z2mEndpoint, 'host' | 'port'>): string {
  return `${endpoint.host}:${endpoint.port}`
}

export function buildZ2mUrl(endpoint: Z2mEndpoint): string {
  const scheme = endpoint.tls ? 'wss' : 'ws'
  const query =
    endpoint.token === null || endpoint.token === ''
      ? ''
      : `?token=${encodeURIComponent(endpoint.token)}`
  return `${scheme}://${endpoint.host}:${endpoint.port}/api${query}`
}

export class Z2mRequestError extends Error {
  constructor(
    readonly topic: string,
    message: string,
  ) {
    super(`${topic}: ${message}`)
    this.name = 'Z2mRequestError'
  }
}

export interface Z2mClientOptions {
  readonly endpoint: Z2mEndpoint
  readonly logger: IScopedLogger
  readonly onEnvelope: (envelope: Z2mEnvelope) => void
  readonly onConnection: (state: Z2mConnection) => void
  readonly factory?: Z2mSocketFactory
  readonly timers?: Z2mTimers
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly requestTimeoutMs?: number
}

interface PendingRequest {
  readonly topic: string
  readonly resolve: (data: unknown) => void
  readonly reject: (err: Error) => void
  readonly cancel: () => void
}

export class Z2mClient {
  private readonly factory: Z2mSocketFactory
  private readonly timers: Z2mTimers
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private socket: Z2mSocket | null = null
  private cancelRetry: (() => void) | null = null
  private attempt = 0
  private transactionSeq = 0
  private stopped = false
  private state: Z2mConnection = 'closed'

  constructor(private readonly opts: Z2mClientOptions) {
    this.factory = opts.factory ?? nativeSocketFactory
    this.timers = opts.timers ?? REAL_TIMERS
    this.baseMs = opts.backoffBaseMs ?? 1_000
    this.maxMs = opts.backoffMaxMs ?? 60_000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
  }

  get connection(): Z2mConnection {
    return this.state
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.cancelRetry?.()
    this.cancelRetry = null
    this.failPending('connection closed')
    this.socket?.close()
    this.socket = null
    this.setState('closed')
  }

  /** Fire-and-forget publish: a device command (`<friendly_name>/set`). */
  publish(topic: string, payload: unknown): void {
    if (this.socket === null || this.state !== 'online') {
      throw new Z2mRequestError(topic, 'not connected to Zigbee2MQTT')
    }
    this.socket.send(JSON.stringify({ topic, payload }))
  }

  /** A `bridge/request/*` call; resolves the response `data`, rejects on an error status or a timeout. */
  request(
    topic: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const transaction = `camstack-${++this.transactionSeq}`
    return new Promise<unknown>((resolve, reject) => {
      const cancel = this.timers.after(() => {
        this.pending.delete(transaction)
        reject(new Z2mRequestError(topic, 'timed out waiting for the response'))
      }, timeoutMs ?? this.requestTimeoutMs)
      this.pending.set(transaction, { topic, resolve, reject, cancel })
      try {
        this.publish(topic, { ...payload, transaction })
      } catch (err: unknown) {
        cancel()
        this.pending.delete(transaction)
        reject(err instanceof Error ? err : new Z2mRequestError(topic, errMsg(err)))
      }
    })
  }

  private open(): void {
    this.setState('connecting')
    const address = z2mDisplayAddress(this.opts.endpoint)
    try {
      this.socket = this.factory(buildZ2mUrl(this.opts.endpoint), {
        open: () => {
          this.attempt = 0
          this.opts.logger.info('zigbee2mqtt: connected', {
            meta: { server: address },
          })
          this.setState('online')
        },
        message: (text) => this.onText(text),
        close: (code, reason) => this.onClose(code, reason),
        error: (message) =>
          this.opts.logger.warn('zigbee2mqtt: socket error', {
            meta: { server: address, error: message },
          }),
      })
    } catch (err: unknown) {
      this.opts.logger.warn('zigbee2mqtt: could not open the socket', {
        // The constructor error can echo the URL, and the URL carries the token: log a fixed reason.
        meta: { server: address, error: 'the socket constructor threw' },
      })
      this.socket = null
      this.scheduleRetry()
    }
  }

  private onText(text: string): void {
    const envelope = parseEnvelope(text)
    if (envelope === null) {
      this.opts.logger.debug('zigbee2mqtt: a frame that is not an envelope was dropped', {
        meta: { bytes: text.length },
      })
      return
    }
    if (envelope.topic.startsWith(Z2M_RESPONSE_PREFIX)) this.settle(envelope)
    this.opts.onEnvelope(envelope)
  }

  private settle(envelope: Z2mEnvelope): void {
    const response = Z2mResponseSchema.safeParse(envelope.payload)
    if (!response.success || response.data.transaction === undefined) return
    const request = this.pending.get(response.data.transaction)
    if (request === undefined) return
    this.pending.delete(response.data.transaction)
    request.cancel()
    if (response.data.status === 'ok') request.resolve(response.data.data)
    else
      request.reject(
        new Z2mRequestError(request.topic, response.data.error ?? 'refused by Zigbee2MQTT'),
      )
  }

  private onClose(code: number, reason: string): void {
    this.socket = null
    this.failPending('connection lost')
    if (this.stopped) return
    if (code === Z2M_CLOSE_UNAUTHORIZED) {
      this.opts.logger.warn(
        'zigbee2mqtt: the token was refused; not retrying until it is changed',
        {
          meta: { server: z2mDisplayAddress(this.opts.endpoint) },
        },
      )
      this.setState('auth-rejected')
      return
    }
    this.opts.logger.warn('zigbee2mqtt: connection lost', {
      meta: { server: z2mDisplayAddress(this.opts.endpoint), code, reason },
    })
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    this.setState('offline')
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt)
    this.attempt += 1
    this.cancelRetry = this.timers.after(() => {
      this.cancelRetry = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private failPending(reason: string): void {
    for (const [transaction, request] of this.pending) {
      request.cancel()
      request.reject(new Z2mRequestError(request.topic, reason))
      this.pending.delete(transaction)
    }
  }

  private setState(state: Z2mConnection): void {
    if (this.state === state) return
    this.state = state
    this.opts.onConnection(state)
  }
}
