import type { MiotProp, PropertyResult, StateChangedEvent } from '@apocaliss92/nodedreame'
import { DreameAuthError, Nodreame } from '@apocaliss92/nodedreame'
import { errMsg, type IntegrationSessionSink, type IScopedLogger } from '@camstack/types'
import { type DreameConfig, toNodreameOptions } from './config.js'
import { catalogProps } from './dreame-entity-catalog.js'
import { dreameFacades } from './dreame-gateway.js'
import { dreameSession } from './dreame-session.js'

/**
 * The slice of a `@apocaliss92/nodedreame` device the manager actually drives:
 * seeding the diagnostic-property cache from the cloud shadow before the kernel
 * spawns the container children. The real `BaseDevice` satisfies this
 * structurally, and test fakes can implement it without faking the whole class
 * (no cast required).
 */
export interface DreameManagedDevice {
  refreshCachedProperties(props: MiotProp[]): Promise<PropertyResult[]>
}

/** Status of a single Dreamehome account connection. */
export type DreameBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link DreameIntegrationManager.getInfo}. */
export interface DreameBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'dreame'
  readonly status: DreameBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal facade surface the manager needs from {@link Nodreame}. Both the real
 * class and test stubs satisfy this structurally — no cast required.
 */
export interface DreameFacadeLike {
  login(): Promise<unknown>
  discoverDevices(): Promise<readonly DreameManagedDevice[]>
  close(): Promise<void>
  readonly devices: readonly DreameManagedDevice[]
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'stateChanged', cb: (push: StateChangedEvent) => void): unknown
}

/** Factory seam: build a {@link DreameFacadeLike} from a config (tests inject a fake). */
export type DreameFacadeFactory = (config: DreameConfig) => DreameFacadeLike

/** Constructor options for {@link DreameIntegrationManager}. */
export interface DreameIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: DreameConfig
  readonly logger: IScopedLogger
  readonly onConnected: (brokerId: string) => void
  readonly onDisconnected: (brokerId: string) => void
  /** Factory seam for testing. When omitted, builds a real {@link Nodreame}. */
  readonly makeFacade?: DreameFacadeFactory
  /** Session-health sink (the standard cloud-connection-lost alert). Defaults to the addon's. */
  readonly session?: IntegrationSessionSink
}

/**
 * Wraps exactly one `@apocaliss92/nodedreame` facade (= one Dreamehome account)
 * with observable status + lifecycle. {@link start} logs in + discovers devices
 * (opening their MQTT pushes); {@link stop} closes the facade;
 * {@link applyConnection} does both atomically when the operator changes
 * credentials.
 *
 * Mirrors `HmIntegrationManager`. The library owns reconnect (durable MQTT +
 * proactive token refresh + poll fallback), so the manager does not retry.
 */
export class DreameIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: DreameConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (brokerId: string) => void
  readonly #onDisconnected: (brokerId: string) => void
  readonly #makeFacade: DreameFacadeFactory
  readonly #session: IntegrationSessionSink

  #facade: DreameFacadeLike | null = null
  #status: DreameBrokerStatus = 'disconnected'
  #deviceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: DreameIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#session = options.session ?? dreameSession
    this.#makeFacade =
      options.makeFacade ??
      ((config: DreameConfig): DreameFacadeLike => new Nodreame(toNodreameOptions(config)))
  }

  /** The live facade, or null when stopped. */
  get facade(): DreameFacadeLike | null {
    return this.#facade
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): DreameConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): DreameBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'dreame',
      status: this.#status,
      info: {
        region: this.#connection.region,
        deviceCount: this.#deviceCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Build the facade, authenticate, and discover devices (which opens each
   * device's MQTT push). Sets `connected` on success. Surfaces a clear
   * credential error on {@link DreameAuthError} without leaking the token.
   */
  async start(): Promise<void> {
    if (this.#facade !== null) {
      this.#logger.warn('DreameIntegrationManager: start() called while running — stop first', {
        tags: { brokerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null
    this.#session.register(this.#id, this.#name)

    const facade = this.#makeFacade(this.#connection)
    this.#facade = facade
    facade.on('error', (err: Error) => {
      // Library errors are operational churn (transient MQTT / offline). Log,
      // flag last-error, but keep the broker "connected" — the library reconnects.
      // An offline/reconnecting robot re-emits the SAME error continuously, so
      // dedupe: WARN only when the message CHANGES (the transition), and drop
      // identical repeats to debug — otherwise one line floods the log.
      // A refused token mid-session is a lost session, however quiet the library keeps it.
      this.#session.failure(this.#id, err)
      const message = errMsg(err)
      const changed = message !== this.#error
      this.#error = message
      this.#lastCheckedAt = Date.now()
      const entry = {
        tags: { brokerId: this.#id },
        meta: { error: message },
      }
      if (changed) {
        this.#logger.warn('DreameIntegrationManager: facade error', entry)
      } else {
        this.#logger.debug('DreameIntegrationManager: facade error (repeat)', entry)
      }
    })
    // Fan every device's state pushes out to the accessory children via the
    // shared per-broker bus. The facade re-emits each handle's `stateChanged`
    // tagged with the deviceId, so this SINGLE subscription serves all
    // children — attaching one listener per child directly to a handle's
    // emitter tripped Node's default MaxListeners cap (a robot container
    // spawns dozens of children).
    facade.on('stateChanged', (push: StateChangedEvent) => {
      // A push means the cloud session is alive (idempotent, cheap).
      void this.#session.ok(this.#id)
      dreameFacades.emitStateChanged(this.#id, push.deviceId)
    })

    try {
      await facade.login()
      const devices = await facade.discoverDevices()
      // Seed the catalog props (diagnostic sensors/switches/selects) from the
      // cloud SHADOW BEFORE the kernel spawns the containers' children, so the
      // container's presence-detection (getProperty != null) decides which
      // children to spawn. The shadow is used (not a live read) because a
      // docked/asleep robot times out live `get_properties`; the shadow + the
      // library's MQTT push then keep these values current. Best-effort: a seed
      // failure just yields fewer sensors this cycle (a later reconcile re-derives).
      await this.#seedCatalogFromShadow(devices)
      this.#deviceCount = devices.length
      this.#status = 'connected'
      this.#error = null
      this.#lastCheckedAt = Date.now()
      void this.#session.ok(this.#id)
      this.#onConnected(this.#id)
      this.#logger.info('DreameIntegrationManager: connected', {
        tags: { brokerId: this.#id },
        meta: { region: this.#connection.region, deviceCount: this.#deviceCount },
      })
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error =
        err instanceof DreameAuthError
          ? 'authentication failed — check credentials / region'
          : errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#session.failure(this.#id, err)
      this.#onDisconnected(this.#id)
      this.#logger.warn('DreameIntegrationManager: connect failed', {
        tags: { brokerId: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  /**
   * Seed the full diagnostic catalog from the cloud SHADOW for every device.
   * Used once at boot so the container's presence-detection can spawn children
   * off the last-known values even when the robot is asleep. Best-effort per
   * device: a failure logs at debug and resolves to `[]` so one offline device
   * never blocks the others.
   */
  async #seedCatalogFromShadow(devices: readonly DreameManagedDevice[]): Promise<void> {
    const props = [...catalogProps()]
    await Promise.all(
      devices.map((d) =>
        d.refreshCachedProperties(props).catch((err: unknown) => {
          this.#logger.debug('DreameIntegrationManager: catalog seed failed', {
            tags: { brokerId: this.#id },
            meta: { error: errMsg(err) },
          })
          return []
        }),
      ),
    )
  }

  /** Close the facade (tears down every device push), null it, set disconnected. */
  async stop(): Promise<void> {
    const facade = this.#facade
    this.#facade = null
    this.#status = 'disconnected'
    if (facade) {
      try {
        await facade.close()
      } catch (err: unknown) {
        this.#logger.warn('DreameIntegrationManager: facade close failed', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: DreameConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}

/** True when two configs are the "same connection" (no facade rebuild needed). */
export function sameConnection(a: DreameConfig | null, b: DreameConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.username === b.username &&
    a.password === b.password &&
    a.region === b.region &&
    a.pollIntervalMs === b.pollIntervalMs
  )
}
