import type { EspConnection } from './config.js'

/**
 * The seam between this addon and the wire library (D952). Everything above it
 * (registry, mapping, devices, tests) speaks these types only, so the client
 * can be swapped for another one by rewriting `esphome-client-link.ts` alone.
 */

/** Entity kinds this addon maps. The adapter drops every other kind. */
export type EspEntityType =
  | 'switch'
  | 'light'
  | 'cover'
  | 'button'
  | 'number'
  | 'select'
  | 'event'
  | 'sensor'
  | 'binary_sensor'
  | 'text_sensor'

export type EspEntityCategory = 'none' | 'config' | 'diagnostic'

/** One entity of a board, as listed on connect. */
export interface EspEntity {
  /** The library's entity id (`<type>-<objectId>`); the stable per-board identity. */
  readonly id: string
  readonly type: EspEntityType
  readonly name: string
  /** ESPHome device class, empty when the board declares none. */
  readonly deviceClass: string
  readonly category: EspEntityCategory
  readonly disabledByDefault: boolean
  /** Unit as the board spells it, empty when none. */
  readonly unit: string
  readonly supportsPosition: boolean
  readonly supportsStop: boolean
  /** A binary sensor the firmware itself reserves for the API connection status. */
  readonly isStatusBinarySensor: boolean
  /** Light only: the colour modes can dim. */
  readonly supportsBrightness: boolean
  /** Number only. */
  readonly min: number | null
  readonly max: number | null
  readonly step: number | null
  /** Select only. */
  readonly options: readonly string[]
  /** Event only. */
  readonly eventTypes: readonly string[]
}

/**
 * The latest state of one entity. Every value field is OPTIONAL on purpose: the
 * wire format omits a field that holds its protobuf default, so an off switch
 * arrives without `state`, an idle cover without `currentOperation`, a sensor at
 * 0.0 without `state`. Reading "absent" as "unknown" would leave a relay
 * undecided forever; the decoder owns the defaults (`esphome-decode.ts`).
 */
export type EspState =
  | { readonly type: 'switch'; readonly id: string; readonly state?: boolean }
  | {
      readonly type: 'light'
      readonly id: string
      readonly state?: boolean
      readonly brightness?: number
    }
  | {
      readonly type: 'cover'
      readonly id: string
      readonly position?: number
      readonly currentOperation?: number
    }
  | {
      readonly type: 'number'
      readonly id: string
      readonly state?: number
      readonly missingState?: boolean
    }
  | {
      readonly type: 'select'
      readonly id: string
      readonly state?: string
      readonly missingState?: boolean
    }
  | {
      readonly type: 'sensor'
      readonly id: string
      readonly state?: number
      readonly missingState?: boolean
    }
  | {
      readonly type: 'binary_sensor'
      readonly id: string
      readonly state?: boolean
      readonly missingState?: boolean
    }
  | {
      readonly type: 'text_sensor'
      readonly id: string
      readonly state?: string
      readonly missingState?: boolean
    }
  | { readonly type: 'event'; readonly id: string; readonly eventType?: string }

/** A write to one entity. Cover position is a 0..1 fraction on the wire. */
export type EspCommand =
  | { readonly type: 'switch'; readonly id: string; readonly state: boolean }
  | {
      readonly type: 'light'
      readonly id: string
      readonly state?: boolean
      readonly brightness?: number
    }
  | {
      readonly type: 'cover'
      readonly id: string
      readonly position?: number
      readonly stop?: boolean
    }
  | { readonly type: 'button'; readonly id: string }
  | { readonly type: 'number'; readonly id: string; readonly state: number }
  | { readonly type: 'select'; readonly id: string; readonly state: string }

/** What the board says about itself on connect. Empty string = not reported. */
export interface EspBoardInfo {
  readonly name: string
  readonly friendlyName: string
  readonly model: string
  readonly manufacturer: string
  readonly esphomeVersion: string
  readonly macAddress: string
  readonly encrypted: boolean
}

/** Why a session failed or ended. Drives the broker status, never a retry loop of its own. */
export type EspFailureReason =
  | 'encryption-key-missing'
  | 'encryption-key-invalid'
  | 'encryption-required'
  | 'auth'
  | 'incompatible'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'error'

/** Reasons the operator must fix before another attempt can succeed. */
const PERMANENT_REASONS: ReadonlySet<EspFailureReason> = new Set([
  'encryption-key-missing',
  'encryption-key-invalid',
  'encryption-required',
  'auth',
  'incompatible',
])

export function isPermanentFailure(reason: EspFailureReason): boolean {
  return PERMANENT_REASONS.has(reason)
}

/** A failed session, with a message that never carries the key. */
export class EspLinkError extends Error {
  readonly reason: EspFailureReason

  constructor(reason: EspFailureReason, message: string) {
    super(message)
    this.name = 'EspLinkError'
    this.reason = reason
  }

  get permanent(): boolean {
    return isPermanentFailure(this.reason)
  }
}

/** Argument types of an ESPHome API user-defined service. */
export type EspServiceArgType =
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'bool[]'
  | 'int[]'
  | 'float[]'
  | 'string[]'

export interface EspServiceArgInfo {
  readonly name: string
  readonly type: EspServiceArgType
}

/** One user-defined service (a YAML `api: actions:` entry) a board exposes. */
export interface EspServiceInfo {
  readonly name: string
  readonly key: number
  readonly args: readonly EspServiceArgInfo[]
}

/** A value passed for one service argument. */
export type EspServiceArgValue =
  | boolean
  | number
  | string
  | readonly boolean[]
  | readonly number[]
  | readonly string[]

/** Why a service call was refused before or while sending. */
export type EspServiceFailureReason =
  | 'not-connected'
  | 'unknown-service'
  | 'bad-argument'
  | 'send-failed'

export class EspServiceError extends Error {
  readonly reason: EspServiceFailureReason

  constructor(reason: EspServiceFailureReason, message: string) {
    super(message)
    this.name = 'EspServiceError'
    this.reason = reason
  }
}

/** One live session with one board. */
export interface EspLink {
  entities(): readonly EspEntity[]
  /** The latest known state of every entity that has reported one. */
  snapshot(): readonly EspState[]
  info(): EspBoardInfo
  onState(handler: (state: EspState) => void): () => void
  /** Fires once when the session ends; `null` cause = closed by us. */
  onClose(handler: (cause: EspLinkError | null) => void): () => void
  command(command: EspCommand): void
  /** The user-defined services discovered on connect. */
  listServices(): readonly EspServiceInfo[]
  /**
   * Run a service. `args` are already validated against {@link listServices} by
   * the caller (`esphome-services.ts`); rejects with {@link EspServiceError}.
   */
  executeService(name: string, args: Readonly<Record<string, EspServiceArgValue>>): Promise<void>
  close(): Promise<void>
}

/** Opens a session. Rejects with {@link EspLinkError}. */
export interface EspLinkFactory {
  open(connection: Readonly<EspConnection>, signal: AbortSignal): Promise<EspLink>
}
