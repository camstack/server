import { Homematic, type ConnectionEvent, type HomematicEventMap } from 'nodehomematic'
import type { IScopedLogger } from '@camstack/types'
import { type HomematicConfig, toHomematicOptions } from './config.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of the CCU session of one integration, managed by {@link HmIntegrationManager}. */
export type HmSessionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link HmIntegrationManager.getInfo}. */
export interface HmSessionInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'homematic'
  readonly status: HmSessionStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/**
 * Minimal facade surface the manager needs.
 *
 * Both the real {@link Homematic} class and the test stubs satisfy this
 * interface structurally — no cast required in either case.
 *
 * The `on` method uses a generic callback type `(arg: Payload) => void`
 * where `Payload` defaults to `unknown`. This keeps the interface
 * structurally compatible with both the test fakes (which use
 * `(arg: unknown) => void`) and any callable overloads from the real
 * facade. Inside the manager, concrete narrowing happens in the handler
 * wrappers; the type system does not need to see the event-map here.
 */
export interface HmFacadeLike {
  start(): Promise<void>
  stop(): Promise<void>
  devices(): readonly { address: string; name?: string }[]
  on(event: string, cb: (arg: unknown) => void): () => void
}

/** Constructor options for {@link HmIntegrationManager}. */
export interface HmIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: HomematicConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  /**
   * Called after EVERY state change (connected, disconnected, error), so the
   * devices that mirror the session (the CCU box) follow it.
   */
  readonly onStateChanged?: (integrationId: string) => void
  /**
   * Factory seam for testing. When omitted the manager builds a real
   * {@link Homematic} from `connection` via {@link toHomematicOptions}.
   */
  readonly makeFacade?: (config: HomematicConfig) => HmFacadeLike
}

// ---------------------------------------------------------------------------
// Real-facade adapter
// ---------------------------------------------------------------------------

/**
 * Thin adapter that wraps the real `Homematic` class so that it satisfies
 * the `HmFacadeLike` interface. The real `Homematic.on` overloads are typed
 * with per-event payload types; `HmFacadeLike.on` uses `(arg: unknown) =>
 * void` to stay structurally compatible with test fakes. The adapter bridges
 * the two shapes without casts by forwarding the typed overloads internally.
 */
class HomematicFacadeAdapter implements HmFacadeLike {
  readonly #homematic: Homematic

  constructor(homematic: Homematic) {
    this.#homematic = homematic
  }

  start(): Promise<void> {
    return this.#homematic.start()
  }

  stop(): Promise<void> {
    return this.#homematic.stop()
  }

  devices(): readonly { address: string; name?: string }[] {
    return this.#homematic.devices()
  }

  on(event: string, cb: (arg: unknown) => void): () => void {
    // We route only the two events the manager subscribes to through their
    // typed overloads; all other events are subscribed via the string
    // overload at the top-level `HomematicEventMap` value type.
    if (event === 'connection') {
      return this.#homematic.on('connection', (payload: ConnectionEvent) => cb(payload))
    }
    if (event === 'error') {
      return this.#homematic.on('error', (payload: HomematicEventMap['error']) => cb(payload))
    }
    // Fallback: subscribe via the string-indexed overload. TypeScript does
    // not expose a plain `(event: string, cb) => void` overload on the real
    // Homematic class — use the 'connection' overload as a safe channel and
    // rely on the event-name guard above for all events the manager actually
    // uses. Unreachable in practice.
    return this.#homematic.on('connection', (payload: ConnectionEvent) => cb(payload))
  }
}

/**
 * Wrap a real `Homematic` instance in the `HmFacadeLike` adapter. The
 * registry calls this so it can hand both the raw `Homematic` reference
 * (published on `homematicFacades` for device control) and the wrapped
 * `HmFacadeLike` (consumed by `HmIntegrationManager`) to the same
 * underlying connection without opening a second one.
 */
export function wrapFacade(homematic: Homematic): HmFacadeLike {
  return new HomematicFacadeAdapter(homematic)
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Wraps exactly one `nodehomematic` facade (= one CCU) with observable
 * status, structured info, and lifecycle callbacks.
 *
 * The manager owns the facade lifecycle: {@link start} constructs and
 * starts it; {@link stop} tears it down; {@link applyConnection} does both
 * when the operator changes connection settings.
 *
 * All state is private except for the read-only {@link facade} accessor and
 * {@link getInfo}, which returns an immutable snapshot safe to hand to
 * consumers.
 */
export class HmIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: HomematicConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #onStateChanged: (integrationId: string) => void
  readonly #makeFacade: (config: HomematicConfig) => HmFacadeLike

  #facade: HmFacadeLike | null = null
  #status: HmSessionStatus = 'disconnected'
  #deviceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  /** Active event-listener disposers, cleared on stop. */
  readonly #unsubs: Array<() => void> = []

  constructor(options: HmIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onStateChanged = options.onStateChanged ?? (() => undefined)
    this.#makeFacade =
      options.makeFacade ??
      ((config: HomematicConfig): HmFacadeLike =>
        new HomematicFacadeAdapter(new Homematic(toHomematicOptions(config))))
  }

  // ── Public accessors ────────────────────────────────────────────────────

  /**
   * The live facade, or `null` when stopped. Expose as a public readonly
   * property so callers (e.g. device-cap implementations) can reach the
   * full `nodehomematic` API without the manager needing to proxy every
   * method.
   */
  get facade(): HmFacadeLike | null {
    return this.#facade
  }

  /**
   * Convenience delegation to the facade's device list. Returns an empty
   * array when the facade is not yet started. Used by the registry and
   * Phase 2 device-wiring code to avoid reaching through `manager.facade`.
   */
  devices(): readonly { address: string; name?: string }[] {
    return this.#facade?.devices() ?? []
  }

  /**
   * The connection settings the manager is currently configured with.
   * Exposed so the addon can compare the persisted connection against the
   * live one and skip a redundant stop+start when only an out-of-band FK
   * (e.g. `integrationId`) changed but the connection itself is identical.
   */
  getConnection(): HomematicConfig {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): HmSessionInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'homematic',
      status: this.#status,
      info: {
        host: this.#connection.host,
        tls: this.#connection.tls,
        deviceCount: this.#deviceCount,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Build and start the facade. Sets status to `'connecting'` before
   * the async start, then waits for the facade's `'connection'` event
   * to transition to `'connected'`. Throws on facade start failure so
   * the caller can decide whether to retry or surface an error.
   */
  async start(): Promise<void> {
    if (this.#facade !== null) {
      this.#logger.warn('HmIntegrationManager: start() called while already running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }

    this.#status = 'connecting'
    this.#error = null

    const facade = this.#makeFacade(this.#connection)
    this.#facade = facade
    this.#attachListeners(facade)

    await facade.start()

    this.#deviceCount = facade.devices().length
    this.#lastCheckedAt = Date.now()
    // A start that RESOLVED is the proof of connection, and the only one on
    // offer: `nodehomematic` publishes CONNECTED on its internal bus inside
    // `Central.start()`, BEFORE it mounts the bridge to the public
    // `connection` event, and exposes no getter for the current state. The
    // live session sat on `connecting` for 18 minutes with 47 devices
    // enumerated (2026-09-05). A later `connection` event stays the authority
    // for every transition after this one.
    this.#status = 'connected'
    this.#error = null
    this.#onConnected(this.#id)
    this.#onStateChanged(this.#id)
    this.#logger.info('HmIntegrationManager: facade started', {
      tags: { integrationId: this.#id },
      meta: { host: this.#connection.host, deviceCount: this.#deviceCount },
    })
  }

  /**
   * Unsubscribe all listeners, stop the facade, null it out, and set
   * status to `'disconnected'`. Safe to call when already stopped.
   */
  async stop(): Promise<void> {
    this.#teardownListeners()
    const facade = this.#facade
    this.#facade = null
    this.#status = 'disconnected'
    this.#onStateChanged(this.#id)

    if (facade) {
      try {
        await facade.stop()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.#logger.warn('HmIntegrationManager: facade stop failed', {
          tags: { integrationId: this.#id },
          meta: { error: msg },
        })
      }
    }
  }

  /**
   * Atomically replace the connection config: stop the current facade
   * (if running), swap the config, then start fresh.
   */
  async applyConnection(conn: HomematicConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Wire facade event listeners and collect their disposers. */
  #attachListeners(facade: HmFacadeLike): void {
    // The `HmFacadeLike.on` callback is typed as `(arg: unknown) => void`,
    // so each handler receives an opaque value and narrows it via runtime
    // type guards before use. This keeps the interface structurally
    // compatible with both the real adapter and the test fakes.
    this.#unsubs.push(
      facade.on('connection', (arg: unknown) => {
        // Payload shape: { interfaceId: string; state: string }
        // The CCU state machine emits 'CONNECTED' (uppercase) for the
        // connected state — see nodehomematic ConnectionStateMachine.
        if (!isConnectionArg(arg)) return
        this.#lastCheckedAt = Date.now()
        if (arg.state === 'CONNECTED') {
          this.#status = 'connected'
          this.#error = null
          this.#logger.info('HmIntegrationManager: interface connected', {
            tags: { integrationId: this.#id },
            meta: { interfaceId: arg.interfaceId },
          })
          this.#onConnected(this.#id)
          this.#onStateChanged(this.#id)
        } else {
          this.#status = 'disconnected'
          this.#logger.info('HmIntegrationManager: interface disconnected', {
            tags: { integrationId: this.#id },
            meta: { interfaceId: arg.interfaceId, state: arg.state },
          })
          this.#onDisconnected(this.#id)
          this.#onStateChanged(this.#id)
        }
      }),

      facade.on('error', (arg: unknown) => {
        const msg = arg instanceof Error ? arg.message : String(arg)
        this.#status = 'error'
        this.#error = msg
        this.#lastCheckedAt = Date.now()
        this.#logger.warn('HmIntegrationManager: facade error', {
          tags: { integrationId: this.#id },
          meta: { error: msg },
        })
        this.#onStateChanged(this.#id)
      }),
    )
  }

  /** Call and clear all disposers. */
  #teardownListeners(): void {
    for (const unsub of this.#unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Private type guards
// ---------------------------------------------------------------------------

/** Payload shape for the facade's 'connection' event. */
interface ConnectionArg {
  readonly interfaceId: string
  readonly state: string
}

function isConnectionArg(arg: unknown): arg is ConnectionArg {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    'interfaceId' in arg &&
    'state' in arg &&
    typeof (arg as Record<string, unknown>)['state'] === 'string'
  )
}
