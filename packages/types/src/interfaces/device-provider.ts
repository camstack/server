import type { CamstackContext } from './context.js'
import type { ConfigUISchema, FieldProbeResult } from './config-ui.js'

export interface ProviderStatus {
  connected: boolean
  error?: string
  deviceCount: number
}

export interface LiveEvent {
  type: string
  camera: string
  timestamp: number
  data: Record<string, unknown>
}

export interface IDeviceProvider {
  /** Immutable progressive ID */
  readonly id: string
  readonly type: string
  readonly name: string
  readonly discoveryMode: 'auto' | 'manual' | 'both'

  /** The provider's context -- logger, storage, eventBus scoped to this provider */
  readonly ctx: CamstackContext

  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): ProviderStatus
  /** Discover available devices via the provider's native protocol. */
  discoverDevices?(): Promise<readonly unknown[]>
  /** Schema for the device CREATION form (Add Device dialog) */
  getDeviceConfigSchema?(): ConfigUISchema
  /** Schema for EDITING settings of an existing device. Falls back to getDeviceConfigSchema if not implemented. */
  getDeviceSettingsSchema?(deviceId: string): ConfigUISchema | Promise<ConfigUISchema>
  /**
   * Test/probe a single field value from the device config/settings form.
   * Called when the user clicks the test button on a 'probe' field.
   * The provider implements the actual probing logic (e.g. ffprobe for RTSP URLs, an API check for a hub).
   */
  testField?(key: string, value: unknown): Promise<FieldProbeResult>
  subscribeLiveEvents(callback: (event: LiveEvent) => void): () => void

  /** Optional: declare configurable settings UI for this provider's addon-level config */
  getConfigSchema?(): ConfigUISchema
}
