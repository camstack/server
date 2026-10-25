import {
  type AcDevice,
  type DiscoveredDevice,
  GreeAuthError,
  Nodegree,
} from '@apocaliss92/nodegree'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { type GreeConfig, settingsToGreeConfig, toNodegreeOptions } from './config.js'
import { type GreeConnectionSurface, macKey } from './gree-gateway.js'

/** Status of a single Gree AC connection. */
export type GreeConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link GreeIntegrationManager.getInfo}. */
export interface GreeConnectionInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'gree'
  readonly status: GreeConnectionStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal facade surface the manager needs from {@link Nodegree}. Both the real
 * class and test stubs satisfy this structurally — no cast required.
 */
export interface GreeFacadeLike {
  discover(opts?: { broadcastAddr?: string; timeoutMs?: number }): Promise<DiscoveredDevice[]>
  createAc(target: { ip: string; port?: number; mac: string }): Promise<AcDevice>
  close(): Promise<void>
}

/** Factory seam: build a {@link GreeFacadeLike} from a config (tests inject a fake). */
export type GreeFacadeFactory = (config: GreeConfig) => GreeFacadeLike

/** Sink the manager publishes its live connection surface to (the resolver). */
export interface GreeSurfaceSink {
  set(connectionKey: string, surface: GreeConnectionSurface | null): void
}

/** Outcome of a successful bind — the durable identity the caller persists. */
export interface GreeBindResult {
  readonly mac: string
  readonly ip: string
  readonly port: number
  readonly name: string
  readonly model?: string
}

/** Constructor options for {@link GreeIntegrationManager}. */
export interface GreeIntegrationManagerOptions {
  /** The per-device connection-resolver key (the device's own stableId). */
  readonly id: string
  readonly name: string
  readonly connection: GreeConfig
  readonly logger: IScopedLogger
  readonly onConnected: (connectionKey: string) => void
  readonly onDisconnected: (connectionKey: string) => void
  readonly surfaceSink: GreeSurfaceSink
  /** Per-AC poll cadence (ms). 0 disables polling. */
  readonly pollIntervalMs?: number
  /** Factory seam for testing. When omitted, builds a real {@link Nodegree}. */
  readonly makeFacade?: GreeFacadeFactory
}

function defaultFacade(config: GreeConfig): GreeFacadeLike {
  return new Nodegree(toNodegreeOptions(config))
}

const DEFAULT_POLL_INTERVAL_MS = 10_000

/**
 * Wraps exactly one `@apocaliss92/nodegree` facade bound to a SINGLE Gree AC
 * (standalone mode — the connection lives on the AC device). {@link start} runs a
 * DIRECTED bind scan aimed at the configured `host` (falling back to the
 * `broadcastAddr` / global broadcast), matches the responder for that host,
 * binds (creates) its {@link AcDevice} handle, publishes the connection surface
 * on the shared resolver keyed by the device's `connectionKey`, and starts
 * polling. {@link stop} closes the facade; {@link applyConnection} does both
 * atomically when the operator changes the connection.
 *
 * {@link bindOnce} is the create-time helper: a static one-shot directed scan
 * that returns the AC's durable identity (MAC/ip/name) WITHOUT holding a handle,
 * so `onCreateDevice` can persist the identity before the device exists.
 */
export class GreeIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: GreeConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (connectionKey: string) => void
  readonly #onDisconnected: (connectionKey: string) => void
  readonly #surfaceSink: GreeSurfaceSink
  readonly #pollIntervalMs: number
  readonly #makeFacade: GreeFacadeFactory
  /** When set, only the responder for this MAC is bound (standalone: one AC). */
  readonly #expectMac: string | null

  #facade: GreeFacadeLike | null = null
  #handles: Map<string, AcDevice> = new Map()
  #status: GreeConnectionStatus = 'disconnected'
  #deviceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: GreeIntegrationManagerOptions & { readonly expectMac?: string }) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.#makeFacade = options.makeFacade ?? defaultFacade
    this.#expectMac = options.expectMac !== undefined ? macKey(options.expectMac) : null
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): GreeConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): GreeConnectionInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'gree',
      status: this.#status,
      info: {
        host: this.#connection.host,
        broadcastAddr: this.#connection.broadcastAddr,
        deviceCount: this.#deviceCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Build the facade, run a DIRECTED bind scan (aimed at `host`), bind the
   * responder for the expected AC, and publish the connection surface. Sets
   * `connected` on a successful bind. Surfaces a clear bind error on
   * {@link GreeAuthError}.
   */
  async start(): Promise<void> {
    if (this.#facade !== null) {
      this.#logger.warn('GreeIntegrationManager: start() called while running — stop first', {
        tags: { connectionKey: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const facade = this.#makeFacade(this.#connection)
    this.#facade = facade

    try {
      const discovered = await facade.discover(this.#discoverOpts())
      const matched = this.#selectResponders(discovered)
      const handles = new Map<string, AcDevice>()

      for (const dev of matched) {
        try {
          const ac = await facade.createAc({ ip: dev.ip, port: dev.port, mac: dev.mac })
          if (this.#pollIntervalMs > 0) ac.startPolling(this.#pollIntervalMs)
          handles.set(macKey(dev.mac), ac)
        } catch (err: unknown) {
          this.#logger.warn('GreeIntegrationManager: bind (createAc) failed', {
            tags: { connectionKey: this.#id },
            meta: { mac: dev.mac, ip: dev.ip, error: errMsg(err) },
          })
        }
      }

      this.#handles = handles
      const surface: GreeConnectionSurface = { discovered: matched, handles }
      this.#surfaceSink.set(this.#id, surface)

      this.#deviceCount = handles.size
      this.#status = handles.size > 0 ? 'connected' : 'error'
      this.#error = handles.size > 0 ? null : 'AC not reachable — bind returned no handle'
      this.#lastCheckedAt = Date.now()
      if (handles.size > 0) {
        this.#onConnected(this.#id)
        this.#logger.info('GreeIntegrationManager: connected', {
          tags: { connectionKey: this.#id },
          meta: { discovered: discovered.length, bound: handles.size },
        })
      } else {
        this.#onDisconnected(this.#id)
      }
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error =
        err instanceof GreeAuthError
          ? 'device bind failed — check the AC is reachable'
          : errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#surfaceSink.set(this.#id, null)
      this.#onDisconnected(this.#id)
      this.#logger.warn('GreeIntegrationManager: scan failed', {
        tags: { connectionKey: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  /** Stop per-AC polling, close the facade, null it, set disconnected. */
  async stop(): Promise<void> {
    for (const ac of this.#handles.values()) {
      try {
        ac.stopPolling()
      } catch {
        // best-effort
      }
    }
    this.#handles = new Map()
    const facade = this.#facade
    this.#facade = null
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    if (facade) {
      try {
        await facade.close()
      } catch (err: unknown) {
        this.#logger.warn('GreeIntegrationManager: facade close failed', {
          tags: { connectionKey: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: GreeConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  /** Keep only the responder(s) this manager should bind: the one matching the
   *  expected MAC when set, else the one matching the configured host, else all. */
  #selectResponders(discovered: readonly DiscoveredDevice[]): DiscoveredDevice[] {
    if (this.#expectMac !== null) {
      return discovered.filter((d) => macKey(d.mac) === this.#expectMac)
    }
    const host = this.#connection.host.trim()
    if (host.length > 0) {
      const byHost = discovered.filter((d) => d.ip === host)
      if (byHost.length > 0) return byHost
    }
    return [...discovered]
  }

  #discoverOpts(): { broadcastAddr?: string; timeoutMs?: number } {
    const out: { broadcastAddr?: string; timeoutMs?: number } = {
      timeoutMs: this.#connection.timeoutMs,
    }
    const broadcast = resolveBroadcastTarget(this.#connection)
    if (broadcast.length > 0) out.broadcastAddr = broadcast
    return out
  }
}

/**
 * Resolve the directed-scan target for a connection: the explicit
 * `broadcastAddr` when set, else the AC `host` (unicast-directed scan), else the
 * empty string (library default global broadcast).
 */
export function resolveBroadcastTarget(connection: GreeConfig): string {
  const broadcast = connection.broadcastAddr.trim()
  if (broadcast.length > 0) return broadcast
  return connection.host.trim()
}

/**
 * Create-time one-shot directed bind: build a throwaway facade, run a directed
 * scan (aimed at the connection's `host`/`broadcastAddr`), bind the matching
 * responder to prove the AC is reachable and learn its durable identity, then
 * close the facade. Returns the AC's identity (MAC/ip/name/model). Throws when no
 * AC responds or the bind fails — surfaced to the operator in the Add modal.
 *
 * The returned identity is what {@link import('./config.js').greeAcDeviceSchema}
 * persists on the new device; the live per-device manager re-binds on activate.
 */
/**
 * One-shot LAN broadcast scan for Gree ACs — the network-discovery pass. Builds a
 * throwaway facade from default (or provided) UDP settings, runs the broadcast,
 * and returns every responder. No bind, no persistence. The provider's
 * `discoverDevices()` maps the responders to adoption candidates.
 */
export async function discoverGreeDevices(input: {
  /** Directed broadcast address to sweep (e.g. `192.168.20.255` for another
   *  subnet). Empty/omitted → the addon node's local-subnet broadcast. */
  readonly broadcastAddress?: string
  readonly timeoutMs?: number
  readonly makeFacade?: GreeFacadeFactory
}): Promise<readonly DiscoveredDevice[]> {
  // Build a discovery-only config carrying the requested broadcast address so
  // resolveBroadcastTarget honours it; blank falls back to the default sweep.
  const connection = settingsToGreeConfig({
    ...(input.broadcastAddress ? { broadcastAddr: input.broadcastAddress } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  })
  const facade = (input.makeFacade ?? defaultFacade)(connection)
  try {
    const broadcast = resolveBroadcastTarget(connection)
    const opts: { broadcastAddr?: string; timeoutMs?: number } = { timeoutMs: connection.timeoutMs }
    if (broadcast.length > 0) opts.broadcastAddr = broadcast
    return await facade.discover(opts)
  } finally {
    await facade.close().catch(() => undefined)
  }
}

export async function bindOnce(input: {
  readonly connection: GreeConfig
  readonly logger: IScopedLogger
  readonly makeFacade?: GreeFacadeFactory
}): Promise<GreeBindResult> {
  const { connection, logger } = input
  const facade = (input.makeFacade ?? defaultFacade)(connection)
  try {
    const broadcast = resolveBroadcastTarget(connection)
    const opts: { broadcastAddr?: string; timeoutMs?: number } = {
      timeoutMs: connection.timeoutMs,
    }
    if (broadcast.length > 0) opts.broadcastAddr = broadcast
    const discovered = await facade.discover(opts)

    const host = connection.host.trim()
    const target =
      host.length > 0 ? (discovered.find((d) => d.ip === host) ?? discovered[0]) : discovered[0]
    if (target === undefined) {
      throw new Error(
        host.length > 0
          ? `no Gree AC responded at ${host}`
          : 'no Gree AC responded to the discovery scan',
      )
    }

    // Bind to prove reachability + correct cipher; discard the handle (the live
    // per-device manager re-binds on activate).
    const ac = await facade.createAc({ ip: target.ip, port: target.port, mac: target.mac })
    try {
      ac.stopPolling()
    } catch {
      // best-effort — the handle is discarded regardless
    }
    return {
      mac: target.mac,
      ip: target.ip,
      port: target.port,
      name: target.name.length > 0 ? target.name : target.mac,
      ...(target.model !== undefined ? { model: target.model } : {}),
    }
  } catch (err: unknown) {
    const message =
      err instanceof GreeAuthError
        ? 'device bind failed — check the AC is reachable and the encryption mode'
        : errMsg(err)
    logger.warn('gree bindOnce failed', { meta: { host: connection.host, error: message } })
    throw new Error(message)
  } finally {
    try {
      await facade.close()
    } catch {
      // best-effort — the throwaway facade is discarded
    }
  }
}

/** True when two configs are the "same connection" (no facade rebuild needed). */
export function sameConnection(a: GreeConfig | null, b: GreeConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.host === b.host &&
    a.broadcastAddr === b.broadcastAddr &&
    a.timeoutMs === b.timeoutMs &&
    a.retries === b.retries &&
    a.encryption === b.encryption
  )
}
