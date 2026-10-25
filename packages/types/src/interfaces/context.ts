import type { IScopedLogger } from './logging.js'
import type { IEventBus } from './event-bus.js'
import type { ISettingsBackend, IStorageProvider } from './storage.js'

/**
 * CamstackContext -- injected into every provider, device, and addon.
 *
 * Each element receives a context scoped to its identity:
 * - logger is pre-scoped: (Reolink)[FrontDoor] for a device, (Reolink) for a provider
 * - settingsBackend provides structured storage (DB) for config, events, etc.
 * - storageProvider resolves file paths per location type
 * - eventBus is shared (system-wide) but the source is pre-filled
 * - config provides read/write access to this element's persisted configuration
 *
 * The `id` is an immutable progressive identifier assigned at creation time.
 * It never changes even if the element is renamed.
 */
export interface CamstackContext {
  /** Immutable progressive ID of this element (e.g., 'provider:reolink-1', 'device:reolink-1/front-door') */
  readonly id: string

  /** Pre-scoped logger -- logs automatically include this element's scope chain */
  readonly logger: IScopedLogger

  /** Event bus -- shared system-wide, use for emitting and subscribing to events */
  readonly eventBus: IEventBus

  /** Settings backend — query/insert structured data (events, settings, metadata) */
  readonly settingsBackend?: ISettingsBackend

  /** File storage provider — resolve paths, read/write files per location type */
  readonly storageProvider?: IStorageProvider

  /** Persisted configuration for this element -- read/write/subscribe to changes */
  readonly config: IElementConfig
}

/**
 * Scoped configuration store for an element.
 * Values are persisted in the element's storage namespace.
 */
export interface IElementConfig {
  /** Get the full config object */
  getAll(): Record<string, unknown>

  /** Get a single value by dot-path (e.g., 'mqtt.brokerUrl') */
  get<T = unknown>(key: string): T | undefined

  /** Set a single value */
  set(key: string, value: unknown): Promise<void>

  /** Set the entire config object (merge or replace) */
  setAll(config: Record<string, unknown>): Promise<void>

  /** Subscribe to config changes -- callback receives the new full config */
  onChange(callback: (config: Record<string, unknown>) => void): () => void

  /** Load config from storage into cache — must be called before synchronous get() */
  load(): Promise<void>
}
