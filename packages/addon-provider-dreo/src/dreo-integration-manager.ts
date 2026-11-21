import { errMsg, type IntegrationSessionSink, type IScopedLogger } from '@camstack/types'
import type { DreoConfig } from './config.js'
import {
  type DreoBridge,
  type DreoBridgeDevice,
  DreoBridgeError,
  type DreoPush,
} from './dreo-bridge.js'
import { DreoDeviceHandle } from './dreo-device-handle.js'
import type { DreoConnectionSurface } from './dreo-gateway.js'
import { DreoWorkerGaveUpError, dreoSession } from './dreo-session.js'
import { bumpDreoEpoch } from './dreo-state-refresh.js'

/** Status of a single Dreo account connection. */
export type DreoIntegrationStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link DreoIntegrationManager.getInfo}. */
export interface DreoIntegrationInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'dreo'
  readonly status: DreoIntegrationStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/** Factory seam: one new bridge (= one Python worker process). Tests inject a fake. */
export type DreoBridgeFactory = () => DreoBridge

/** Sink the manager publishes its live connection surface to (the resolver). */
export interface DreoSurfaceSink {
  set(integrationId: string, surface: DreoConnectionSurface | null): void
}

/** Constructor options for {@link DreoIntegrationManager}. */
export interface DreoIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: DreoConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: DreoSurfaceSink
  /** Builds the account's Python bridge; throws when the node has no Python. */
  readonly makeBridge: DreoBridgeFactory
  /** Session-health sink (the standard cloud-connection-lost alert). Defaults to the addon's. */
  readonly session?: IntegrationSessionSink
  /** Waits before each respawn of a crashed worker; its length is the bound. */
  readonly respawnDelaysMs?: readonly number[]
  /** A worker that stayed up this long earns its respawn budget back (D6). */
  readonly stableUptimeMs?: number
}

/**
 * A worker that signs in and then crashes again before this much uptime does not reset the
 * respawn budget: a crash loop after a successful login ends in a give-up, not a forever loop.
 */
export const DREO_STABLE_UPTIME_MS = 5 * 60_000

/** A crashed worker is respawned after these waits, then left failed (never an endless loop). */
export const DREO_RESPAWN_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]

/**
 * Wraps exactly one Dreo account: one Python worker (`python/dreo_worker.py`, the MIT
 * `pydreo-community` library) with observable status and lifecycle. {@link start} signs in,
 * opens the push channel and publishes one {@link DreoDeviceHandle} per device on the shared
 * resolver. {@link stop} closes the worker; {@link applyConnection} does both atomically when
 * the operator changes credentials.
 *
 * The library reconnects its WebSocket by itself and the worker reports it as a `channel`
 * push, which the manager turns into a reconnect notice on every handle (the state-refresh
 * epoch). A worker PROCESS that dies is respawned under a bound.
 */
export class DreoIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: DreoConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: DreoSurfaceSink
  readonly #makeBridge: DreoBridgeFactory
  readonly #respawnDelaysMs: readonly number[]
  readonly #session: IntegrationSessionSink
  readonly #stableUptimeMs: number

  /** Handles outlive a worker respawn: the device classes hold them. */
  readonly #handles = new Map<string, DreoDeviceHandle>()
  #infos: DreoBridgeDevice[] = []
  #bridge: DreoBridge | null = null
  #status: DreoIntegrationStatus = 'disconnected'
  #lastCheckedAt: number | null = null
  #error: string | null = null
  #channelWasDown = false
  #stopped = true
  #respawnAttempts = 0
  #connectedAt: number | null = null
  readonly #unsupportedLogged = new Set<string>()
  #respawnTimer: ReturnType<typeof setTimeout> | null = null
  #refreshInFlight: Promise<void> | null = null

  constructor(options: DreoIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeBridge = options.makeBridge
    this.#respawnDelaysMs = options.respawnDelaysMs ?? DREO_RESPAWN_DELAYS_MS
    this.#session = options.session ?? dreoSession
    this.#stableUptimeMs = options.stableUptimeMs ?? DREO_STABLE_UPTIME_MS
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): DreoConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): DreoIntegrationInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'dreo',
      status: this.#status,
      info: { region: this.#connection.region, deviceCount: this.#handles.size },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Start the worker, sign in, open the push channel, publish the surface. Sets `connected`
   * on success; on failure the status is `error` and the error is rethrown (a refused
   * sign-in reads as a credential problem, never carrying the password).
   */
  async start(): Promise<void> {
    if (!this.#stopped) {
      this.#logger.warn('DreoIntegrationManager: start() called while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#stopped = false
    this.#respawnAttempts = 0
    this.#status = 'connecting'
    this.#error = null
    this.#session.register(this.#id, this.#name)
    try {
      await this.#connect()
      this.#markConnected()
    } catch (err: unknown) {
      this.#stopped = true
      this.#markFailed(err)
      this.#session.failure(this.#id, err)
      this.#onDisconnected(this.#id)
      throw err
    }
  }

  /** Close the worker, drop the surface and the handles, set disconnected. */
  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#respawnTimer !== null) {
      clearTimeout(this.#respawnTimer)
      this.#respawnTimer = null
    }
    this.#closeBridge()
    this.#handles.clear()
    this.#infos = []
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: DreoConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  // ── connect / push / respawn ────────────────────────────────────────────

  /** One worker: build, sign in, upsert the handles, publish the surface. */
  async #connect(): Promise<void> {
    const bridge = this.#makeBridge()
    this.#bridge = bridge
    this.#channelWasDown = false
    bridge.onPush((push) => this.#onPush(bridge, push))
    let listed: readonly DreoBridgeDevice[]
    try {
      listed = await bridge.login(this.#connection)
    } catch (err: unknown) {
      if (this.#bridge === bridge) this.#bridge = null
      bridge.close()
      throw err
    }
    // A model the library cannot read has no state: it is neither adopted nor shown as "off".
    const devices = listed.filter((device) => device.supported)
    for (const device of listed) {
      if (device.supported || this.#unsupportedLogged.has(device.deviceId)) continue
      this.#unsupportedLogged.add(device.deviceId)
      this.#logger.warn('DreoIntegrationManager: device model unsupported by the Dreo library', {
        // Never adopted, so it has no numeric device id: the cloud serial names it.
        tags: { integrationId: this.#id },
        meta: { dreoDeviceId: device.deviceId, model: device.model },
      })
    }
    this.#infos = [...devices]
    const seen = new Set<string>()
    for (const device of devices) {
      seen.add(device.deviceId)
      const existing = this.#handles.get(device.deviceId)
      if (existing === undefined) {
        this.#handles.set(
          device.deviceId,
          new DreoDeviceHandle(device.deviceId, device.state, (id, command) =>
            this.#send(id, command),
          ),
        )
      } else {
        existing.update(device.state)
      }
    }
    for (const id of [...this.#handles.keys()]) if (!seen.has(id)) this.#handles.delete(id)
    this.#surfaceSink.set(this.#id, this.#surface())
  }

  #surface(): DreoConnectionSurface {
    return {
      infos: this.#infos.map(({ deviceId, model, name }) => ({ deviceId, model, name })),
      handles: this.#handles,
      refresh: () => this.#refresh(),
    }
  }

  #send(deviceId: string, command: Parameters<DreoBridge['command']>[1]): Promise<void> {
    const bridge = this.#bridge
    if (bridge === null) {
      return Promise.reject(
        new DreoBridgeError('exited', `Dreo: cloud connection unavailable (device=${deviceId})`),
      )
    }
    return bridge.command(deviceId, command)
  }

  /** One account read at a time: concurrent device refreshes share it. */
  #refresh(): Promise<void> {
    const bridge = this.#bridge
    if (bridge === null) {
      return Promise.reject(new DreoBridgeError('exited', 'Dreo: cloud connection unavailable'))
    }
    if (this.#refreshInFlight !== null) return this.#refreshInFlight
    const read = bridge
      .refresh()
      .then((states) => {
        for (const [deviceId, state] of Object.entries(states))
          this.#handles.get(deviceId)?.update(state)
      })
      .finally(() => {
        this.#refreshInFlight = null
      })
    this.#refreshInFlight = read
    return read
  }

  #onPush(bridge: DreoBridge, push: DreoPush): void {
    if (bridge !== this.#bridge) return
    switch (push.push) {
      case 'state':
        this.#handles.get(push.deviceId)?.update(push.state)
        return
      case 'channel':
        if (push.state === 'down') {
          this.#channelWasDown = true
          return
        }
        if (this.#channelWasDown) {
          this.#channelWasDown = false
          this.#logger.info('DreoIntegrationManager: push channel reconnected', {
            tags: { integrationId: this.#id },
          })
          this.#notifyReconnected()
        }
        return
      case 'exited':
        this.#onWorkerExited(push.code)
        return
    }
  }

  #notifyReconnected(): void {
    bumpDreoEpoch(this.#id)
    for (const handle of this.#handles.values()) handle.notifyReconnected()
  }

  #onWorkerExited(code: number | null): void {
    if (this.#connectedAt !== null && Date.now() - this.#connectedAt >= this.#stableUptimeMs) {
      this.#respawnAttempts = 0
    }
    this.#connectedAt = null
    this.#bridge = null
    this.#refreshInFlight = null
    this.#status = 'error'
    this.#error = 'the Dreo worker process stopped'
    this.#lastCheckedAt = Date.now()
    this.#surfaceSink.set(this.#id, null)
    this.#onDisconnected(this.#id)
    this.#logger.warn('DreoIntegrationManager: worker exited', {
      tags: { integrationId: this.#id },
      meta: { code },
    })
    this.#scheduleRespawn()
  }

  #scheduleRespawn(): void {
    if (this.#stopped) return
    const delay = this.#respawnDelaysMs[this.#respawnAttempts]
    if (delay === undefined) {
      this.#logger.error('DreoIntegrationManager: worker respawn gave up', {
        tags: { integrationId: this.#id },
        meta: { attempts: this.#respawnAttempts },
      })
      this.#session.failure(this.#id, new DreoWorkerGaveUpError(this.#respawnAttempts))
      return
    }
    this.#respawnAttempts += 1
    this.#respawnTimer = setTimeout(() => {
      // not-a-state-poll: bounded backoff before respawning a crashed worker
      this.#respawnTimer = null
      void this.#respawn()
    }, delay)
  }

  async #respawn(): Promise<void> {
    if (this.#stopped) return
    try {
      await this.#connect()
      if (this.#stopped) {
        this.#closeBridge()
        return
      }
      this.#markConnected()
      this.#notifyReconnected()
    } catch (err: unknown) {
      this.#markFailed(err)
      this.#session.failure(this.#id, err)
      if (err instanceof DreoBridgeError && err.code === 'auth') return
      this.#scheduleRespawn()
    }
  }

  #closeBridge(): void {
    const bridge = this.#bridge
    this.#bridge = null
    this.#refreshInFlight = null
    if (bridge === null) return
    try {
      bridge.close()
    } catch (err: unknown) {
      this.#logger.warn('DreoIntegrationManager: bridge close failed', {
        tags: { integrationId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  #markConnected(): void {
    this.#connectedAt = Date.now()
    this.#status = 'connected'
    this.#error = null
    this.#lastCheckedAt = Date.now()
    void this.#session.ok(this.#id)
    this.#onConnected(this.#id)
    this.#logger.info('DreoIntegrationManager: connected', {
      tags: { integrationId: this.#id },
      meta: { region: this.#connection.region, deviceCount: this.#handles.size },
    })
  }

  #markFailed(err: unknown): void {
    this.#status = 'error'
    this.#error =
      err instanceof DreoBridgeError && err.code === 'auth'
        ? 'authentication failed — check credentials / region'
        : errMsg(err)
    this.#lastCheckedAt = Date.now()
    this.#surfaceSink.set(this.#id, null)
    this.#logger.warn('DreoIntegrationManager: connect failed', {
      tags: { integrationId: this.#id },
      meta: { error: this.#error },
    })
  }
}

/** True when two configs are the "same connection" (no worker rebuild needed). */
export function sameConnection(a: DreoConfig | null, b: DreoConfig | null): boolean {
  if (a === null || b === null) return false
  return a.email === b.email && a.password === b.password && a.region === b.region
}
