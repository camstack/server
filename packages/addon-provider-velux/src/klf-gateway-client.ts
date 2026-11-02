import { Socket } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  Connection,
  Gateway,
  GW_HOUSE_STATUS_MONITOR_DISABLE_REQ,
  GW_HOUSE_STATUS_MONITOR_ENABLE_REQ,
  LimitationType,
  NodeOperatingState,
  ParameterActive,
  Product,
  Products,
} from 'klf-200-api'
import {
  type VeluxDisconnect,
  type VeluxGatewayClient,
  VeluxLoginRefusedError,
  type VeluxNode,
} from './velux-client-contract.js'
import {
  coverClassOf,
  hasRainSensor,
  isRainLimitation,
  openPercentToRaw,
  rawToOpenPercent,
  serialToHex,
} from './velux-protocol.js'

/** The gateway closes a socket that is idle for 15 minutes; a state request every 10 keeps it open. */
export const KLF_KEEPALIVE_MS = 10 * 60 * 1000

/** Rain is a limitation, and the gateway does not push limitation changes; re-read it this often. */
export const KLF_RAIN_REFRESH_MS = 5 * 60 * 1000

/** Seconds allowed for the TLS handshake plus password exchange. */
const LOGIN_TIMEOUT_S = 20

/**
 * Seconds a house-status-monitor request may take on setup and teardown. A
 * gateway that never answers must not hold a teardown (or a server restart).
 */
const MONITOR_TIMEOUT_S = 5

/** Seconds the library may take to end the socket before it is destroyed. */
const LOGOUT_TIMEOUT_S = 5

/**
 * How long a teardown waits for the request in flight before it sends the
 * monitor disable: the library's own request timeout (10 s). The KLF-200 answers
 * one request at a time, and a disable sent on top of a pending request has no
 * documented behaviour, so the teardown lets that request finish (or time out)
 * first. A drain that times out is logged and the disable goes out anyway.
 */
export const KLF_TEARDOWN_DRAIN_MS = 10_000

/** How often the per-request-type counters are written to the log. */
export const KLF_STATS_INTERVAL_MS = 60 * 60 * 1000

/** How often the local socket state is inspected to notice a session the gateway ended. */
const SESSION_WATCH_MS = 5_000

/** Options of {@link KlfGatewayClient}. */
export interface KlfGatewayClientOptions {
  readonly host: string
  readonly password: string
  /** Logger already carrying the gateway device's `deviceId` tag. */
  readonly logger: IScopedLogger
  /**
   * TLS options replacing the library's built-in trust (the gateway's shared
   * certificate, pinned by fingerprint). Left unset in production: this is the
   * seam specs use to trust a scripted gateway.
   */
  readonly tls?: ConnectionOptions
  readonly keepAliveMs?: number
  readonly rainRefreshMs?: number
  readonly statsIntervalMs?: number
  /** Longest a teardown waits for the request in flight; defaults to {@link KLF_TEARDOWN_DRAIN_MS}. */
  readonly teardownDrainMs?: number
  /** Seam: builds the library connection. Defaults to a real one for `host`. */
  readonly makeConnection?: () => Connection
}

/** Which code path took a session down; logged on every teardown. */
export type KlfTeardownPath = 'disconnect' | 'session-ended' | 'setup-failed'

/** Why the gateway refused the password: the library rejects with this exact text. */
const LOGIN_REFUSED = 'Login failed.'

/**
 * {@link VeluxGatewayClient} over the `klf-200-api` library.
 *
 * One client = ONE socket to the gateway, which accepts very few at once (two,
 * per its API specification), so nothing else opens a second connection. After
 * login it enables the house status monitor so the gateway PUSHES every node
 * change (including ones made with a remote), reads all nodes with
 * `GW_GET_ALL_NODES_INFORMATION_REQ`, then only listens. Idle sessions are kept
 * alive with `GW_GET_STATE_REQ` every ten minutes.
 */
export class KlfGatewayClient implements VeluxGatewayClient {
  readonly #opts: KlfGatewayClientOptions
  #connection: Connection | null = null
  #products: Products | null = null
  readonly #raining: Map<number, boolean | null> = new Map()
  readonly #nodeListeners: Set<(node: VeluxNode) => void> = new Set()
  readonly #disconnectListeners: Set<(event: VeluxDisconnect) => void> = new Set()
  readonly #cleanups: Array<() => void> = []
  #watchTimer: ReturnType<typeof setInterval> | null = null
  #rainTimer: ReturnType<typeof setInterval> | null = null
  #closing = false
  /** The connection being opened: not yet a usable session, but a socket a stop must close. */
  #opening: Connection | null = null
  /** Connections whose house status monitor is on: per session, never shared with the next one. */
  readonly #monitorOn: WeakSet<Connection> = new WeakSet()
  /** Bumped by every connect(); a queued request carries the number it was asked under. */
  #session = 0
  readonly #tornDown: WeakSet<Connection> = new WeakSet()
  /** Tail of the request queue: the gateway gets one request in flight. */
  #tail: Promise<void> = Promise.resolve()
  #statsTimer: ReturnType<typeof setInterval> | null = null
  #counts: Map<string, number> = new Map()

  constructor(opts: KlfGatewayClientOptions) {
    this.#opts = opts
  }

  async connect(): Promise<void> {
    this.#closing = false
    this.#session += 1
    const log = this.#opts.logger
    const connection = this.#makeConnection()
    this.#opening = connection
    log.info('velux: socket opening', { meta: { host: this.#opts.host } })
    try {
      await connection.loginAsync(this.#opts.password, LOGIN_TIMEOUT_S)
    } catch (err) {
      this.#opening = null
      log.warn('velux: login failed', {
        meta: { host: this.#opts.host, error: errMsg(err) },
      })
      await settle(connection.logoutAsync(LOGOUT_TIMEOUT_S))
      this.#destroySocket(connection)
      throw loginFailure(err)
    }
    log.info('velux: login ok', { meta: { host: this.#opts.host } })
    this.#watchSocket(connection)
    try {
      // pyvlx order: disable (clears a monitor a lost session left on), read, enable.
      await this.#setMonitor(connection, false)
      const products = await Products.createProductsAsync(connection)
      this.#count('read-all-nodes')
      await this.#setMonitor(connection, true)
      this.#connection = connection
      this.#products = products
      this.#opening = null
      this.#track(products)
      connection.startKeepAlive(this.#opts.keepAliveMs ?? KLF_KEEPALIVE_MS)
    } catch (err) {
      this.#opening = null
      this.#connection = null
      this.#products = null
      await this.#teardown(connection, 'setup-failed')
      throw new Error(`KLF-200 session setup failed: ${errMsg(err)}`, {
        cause: err,
      })
    }
    this.#startSessionWatch(connection)
    this.#startRainRefresh()
    this.#startStats()
    void this.#refreshAllRain()
  }

  async disconnect(): Promise<void> {
    this.#closing = true
    this.#stopTimers()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    const connection = this.#connection ?? this.#opening
    this.#connection = null
    this.#opening = null
    this.#products = null
    this.#raining.clear()
    if (connection !== null) await this.#teardown(connection, 'disconnect')
  }

  listNodes(): readonly VeluxNode[] {
    const products = this.#products
    if (products === null) return []
    const nodes: VeluxNode[] = []
    for (const product of products.Products) {
      const node = this.#toNode(product)
      if (node !== null) nodes.push(node)
    }
    return nodes
  }

  async open(nodeId: number): Promise<void> {
    const product = this.#product(nodeId)
    await this.#enqueue('command', () => product.setTargetPositionRawAsync(openPercentToRaw(100)))
  }

  async close(nodeId: number): Promise<void> {
    const product = this.#product(nodeId)
    await this.#enqueue('command', () => product.setTargetPositionRawAsync(openPercentToRaw(0)))
  }

  async stop(nodeId: number): Promise<void> {
    const product = this.#product(nodeId)
    await this.#enqueue('command', () => product.stopAsync())
  }

  async setPosition(nodeId: number, position: number): Promise<void> {
    const product = this.#product(nodeId)
    await this.#enqueue('command', () =>
      product.setTargetPositionRawAsync(openPercentToRaw(position)),
    )
  }

  async readVersion(): Promise<string> {
    const gateway = this.#gateway()
    const { SoftwareVersion } = await this.#enqueue('get-version', () => gateway.getVersionAsync())
    return SoftwareVersion.toString()
  }

  async reboot(): Promise<void> {
    const gateway = this.#gateway()
    await this.#enqueue('reboot', () => gateway.rebootAsync())
  }

  onNodeChanged(listener: (node: VeluxNode) => void): () => void {
    this.#nodeListeners.add(listener)
    return () => {
      this.#nodeListeners.delete(listener)
    }
  }

  onDisconnected(listener: (event: VeluxDisconnect) => void): () => void {
    this.#disconnectListeners.add(listener)
    return () => {
      this.#disconnectListeners.delete(listener)
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #gateway(): Gateway {
    if (this.#connection === null) throw new Error('KLF-200 gateway session is down')
    return new Gateway(this.#connection)
  }

  #product(nodeId: number): Product {
    const product = this.#products?.Products[nodeId]
    if (product === undefined || this.#connection === null) {
      throw new Error(`KLF-200 node ${nodeId} is not available: the gateway session is down`)
    }
    return product
  }

  #track(products: Products): void {
    for (const product of products.Products) this.#watch(product)
    const added = products.onNewProduct((nodeId) => {
      const product = products.Products[nodeId]
      if (product === undefined) return
      this.#watch(product)
      void this.#refreshRain(product)
      this.#emit(product)
    })
    const removed = products.onRemovedProduct((nodeId) => {
      this.#raining.delete(nodeId)
    })
    this.#cleanups.push(
      () => added[Symbol.dispose](),
      () => removed[Symbol.dispose](),
    )
  }

  #watch(product: Product | undefined): void {
    if (product === undefined) return
    const subscription = product.propertyChangedEvent.on(() => {
      this.#emit(product)
      // A window that finished moving may have been shut by its rain sensor.
      if (product.State !== NodeOperatingState.Executing) void this.#refreshRain(product)
    })
    this.#cleanups.push(() => subscription[Symbol.dispose]())
  }

  #emit(product: Product): void {
    const node = this.#toNode(product)
    if (node === null) return
    for (const listener of this.#nodeListeners) {
      try {
        listener(node)
      } catch (err) {
        this.#opts.logger.warn('velux: node listener threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  #toNode(product: Product | undefined): VeluxNode | null {
    if (product === undefined) return null
    const coverClass = coverClassOf(product.TypeID)
    if (coverClass === null) return null
    const state = product.State
    const rainSensor = hasRainSensor(product.TypeID, product.SubType)
    return {
      nodeId: product.NodeID,
      serial: serialToHex(product.SerialNumber),
      name: product.Name,
      position: rawToOpenPercent(product.CurrentPositionRaw),
      targetPosition: rawToOpenPercent(product.TargetPositionRaw),
      moving: state === NodeOperatingState.Executing,
      coverClass,
      online: state !== NodeOperatingState.Error && state !== NodeOperatingState.WaitingForPower,
      rainSensor,
      raining: rainSensor ? (this.#raining.get(product.NodeID) ?? null) : null,
    }
  }

  async #refreshRain(product: Product): Promise<void> {
    if (!hasRainSensor(product.TypeID, product.SubType) || this.#connection === null) return
    try {
      await this.#enqueue('get-limitation', () =>
        product.refreshLimitationAsync(LimitationType.MinimumLimitation),
      )
      const raining = isRainLimitation(product.getLimitationMinRaw(ParameterActive.MP))
      if (this.#raining.get(product.NodeID) === raining) return
      this.#raining.set(product.NodeID, raining)
      this.#emit(product)
    } catch (err) {
      if (this.#closing) return
      this.#opts.logger.warn('velux: rain limitation read failed', {
        meta: { nodeId: product.NodeID, error: errMsg(err) },
      })
    }
  }

  async #refreshAllRain(): Promise<void> {
    const products = this.#products
    if (products === null) return
    for (const product of products.Products) {
      if (product !== undefined) await this.#refreshRain(product)
    }
  }

  #startRainRefresh(): void {
    this.#rainTimer = setInterval(() => {
      void this.#refreshAllRain()
    }, this.#opts.rainRefreshMs ?? KLF_RAIN_REFRESH_MS)
    this.#rainTimer.unref?.()
  }

  /**
   * The library offers no close event, but it clears its protocol object the
   * moment its socket closes. Reading that field costs no traffic; it is how an
   * idle drop or a reset becomes a reported disconnect.
   */
  #startSessionWatch(connection: Connection): void {
    this.#watchTimer = setInterval(() => {
      if (this.#closing || connection.KLF200SocketProtocol !== undefined) return
      this.#sessionEnded('the gateway closed the socket (idle timeout, reset or network loss)')
    }, SESSION_WATCH_MS)
    this.#watchTimer.unref?.()
  }

  #sessionEnded(reason: string): void {
    if (this.#closing) return
    this.#closing = true
    this.#stopTimers()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    const connection = this.#connection
    this.#connection = null
    this.#products = null
    this.#raining.clear()
    if (connection !== null) void this.#teardown(connection, 'session-ended')
    for (const listener of this.#disconnectListeners) {
      try {
        listener({ reason })
      } catch (err) {
        this.#opts.logger.warn('velux: disconnect listener threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  #makeConnection(): Connection {
    if (this.#opts.makeConnection !== undefined) return this.#opts.makeConnection()
    return this.#opts.tls === undefined
      ? new Connection(this.#opts.host)
      : new Connection(this.#opts.host, this.#opts.tls)
  }

  /** Queue a gateway request behind the one in flight; counted per type for the hourly line. */
  #enqueue<T>(type: string, task: () => Promise<T>): Promise<T> {
    const token = this.#session
    const run = this.#tail.then(() => {
      // A request queued under an older session must never run on the new one.
      if (token !== this.#session || this.#closing) {
        throw new Error('KLF-200 gateway session is closing')
      }
      this.#count(type)
      return task()
    })
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #count(type: string): void {
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
  }

  async #setMonitor(connection: Connection, enabled: boolean): Promise<void> {
    this.#count(enabled ? 'monitor-enable' : 'monitor-disable')
    if (enabled) {
      await connection.sendFrameAsync(new GW_HOUSE_STATUS_MONITOR_ENABLE_REQ(), MONITOR_TIMEOUT_S)
    } else {
      await connection.sendFrameAsync(new GW_HOUSE_STATUS_MONITOR_DISABLE_REQ(), MONITOR_TIMEOUT_S)
    }
    if (enabled) this.#monitorOn.add(connection)
    else this.#monitorOn.delete(connection)
    this.#opts.logger.info(`velux: house status monitor ${enabled ? 'enabled' : 'disabled'}`, {
      meta: {},
    })
  }

  /**
   * One teardown for every path. A socket closed while the house status monitor
   * is on makes the gateway refuse the next TLS handshake, so the monitor is
   * switched off first (bounded, failure logged, never blocking), then the
   * socket is ended; if the library's `end()` does not complete the socket is
   * destroyed.
   */
  async #teardown(connection: Connection, path: KlfTeardownPath): Promise<void> {
    if (this.#tornDown.has(connection)) return
    this.#tornDown.add(connection)
    const log = this.#opts.logger
    log.info('velux: tearing the session down', { meta: { path } })
    const drained = await Promise.race([
      this.#tail.then(() => true),
      delay(this.#opts.teardownDrainMs ?? KLF_TEARDOWN_DRAIN_MS).then(() => false),
    ])
    if (!drained) {
      log.warn(
        'velux: a request was still in flight at teardown, sending the monitor disable anyway',
        {
          meta: { path },
        },
      )
    }
    try {
      await this.#setMonitor(connection, false)
    } catch (err) {
      log.warn('velux: house status monitor disable failed on teardown', {
        meta: { path, error: errMsg(err) },
      })
    }
    try {
      await connection.logoutAsync(LOGOUT_TIMEOUT_S)
      log.info('velux: socket ended cleanly', { meta: { path } })
    } catch (err) {
      log.warn('velux: socket end timed out, destroying it', {
        meta: { path, error: errMsg(err) },
      })
      this.#destroySocket(connection)
    }
  }

  /** The library keeps its socket private and leaves it open when `end()` times out. */
  #destroySocket(connection: Connection): void {
    const socket: unknown = Reflect.get(connection, 'sckt')
    if (socket instanceof Socket && !socket.destroyed) socket.destroy()
  }

  /** Log who closed the socket: this side (a teardown ran) or the gateway. */
  #watchSocket(connection: Connection): void {
    const socket: unknown = Reflect.get(connection, 'sckt')
    if (!(socket instanceof Socket)) return
    socket.once('close', (hadError) => {
      this.#opts.logger.info('velux: socket closed', {
        meta: {
          by: this.#tornDown.has(connection) || this.#closing ? 'local' : 'remote',
          hadError,
          monitorOn: this.#monitorOn.has(connection),
        },
      })
    })
  }

  #startStats(): void {
    this.#statsTimer = setInterval(() => {
      const counts = Object.fromEntries(this.#counts)
      this.#counts = new Map()
      this.#opts.logger.info('velux: gateway requests in the last interval', {
        meta: { counts },
      })
    }, this.#opts.statsIntervalMs ?? KLF_STATS_INTERVAL_MS)
    this.#statsTimer.unref?.()
  }

  #stopTimers(): void {
    if (this.#watchTimer !== null) clearInterval(this.#watchTimer)
    if (this.#rainTimer !== null) clearInterval(this.#rainTimer)
    this.#watchTimer = null
    this.#rainTimer = null
    if (this.#statsTimer !== null) clearInterval(this.#statsTimer)
    this.#statsTimer = null
    this.#connection?.stopKeepAlive()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/** Await a promise and swallow its failure: used where the session is already being thrown away. */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    // the socket is being discarded either way
  }
}

/** Never echoes the password: only the library's cause text is passed on. */
export function loginFailure(err: unknown): Error {
  const message = errMsg(err)
  if (message === LOGIN_REFUSED) return new VeluxLoginRefusedError()
  return new Error(`KLF-200 login failed: ${message}`)
}
