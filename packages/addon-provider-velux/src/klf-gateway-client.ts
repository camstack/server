import type { ConnectionOptions } from 'node:tls'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  Connection,
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
}

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

  constructor(opts: KlfGatewayClientOptions) {
    this.#opts = opts
  }

  async connect(): Promise<void> {
    this.#closing = false
    const connection =
      this.#opts.tls === undefined
        ? new Connection(this.#opts.host)
        : new Connection(this.#opts.host, this.#opts.tls)
    try {
      await connection.loginAsync(this.#opts.password, LOGIN_TIMEOUT_S)
    } catch (err) {
      await settle(connection.logoutAsync())
      throw loginFailure(err)
    }
    try {
      await connection.sendFrameAsync(new GW_HOUSE_STATUS_MONITOR_ENABLE_REQ())
      const products = await Products.createProductsAsync(connection)
      this.#connection = connection
      this.#products = products
      this.#track(products)
      connection.startKeepAlive(this.#opts.keepAliveMs ?? KLF_KEEPALIVE_MS)
    } catch (err) {
      await settle(connection.logoutAsync())
      this.#connection = null
      this.#products = null
      throw new Error(`KLF-200 session setup failed: ${errMsg(err)}`, { cause: err })
    }
    this.#startSessionWatch(connection)
    this.#startRainRefresh()
    void this.#refreshAllRain()
  }

  async disconnect(): Promise<void> {
    this.#closing = true
    this.#stopTimers()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    const connection = this.#connection
    this.#connection = null
    this.#products = null
    this.#raining.clear()
    if (connection !== null) await settle(connection.logoutAsync())
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
    await this.#product(nodeId).setTargetPositionRawAsync(openPercentToRaw(100))
  }

  async close(nodeId: number): Promise<void> {
    await this.#product(nodeId).setTargetPositionRawAsync(openPercentToRaw(0))
  }

  async stop(nodeId: number): Promise<void> {
    await this.#product(nodeId).stopAsync()
  }

  async setPosition(nodeId: number, position: number): Promise<void> {
    await this.#product(nodeId).setTargetPositionRawAsync(openPercentToRaw(position))
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
      await product.refreshLimitationAsync(LimitationType.MinimumLimitation)
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
    if (connection !== null) void settle(connection.logoutAsync())
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

  #stopTimers(): void {
    if (this.#watchTimer !== null) clearInterval(this.#watchTimer)
    if (this.#rainTimer !== null) clearInterval(this.#rainTimer)
    this.#watchTimer = null
    this.#rainTimer = null
    this.#connection?.stopKeepAlive()
  }
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
function loginFailure(err: unknown): Error {
  const message = errMsg(err)
  if (message === LOGIN_REFUSED) return new VeluxLoginRefusedError()
  return new Error(`KLF-200 login failed: ${message}`)
}
