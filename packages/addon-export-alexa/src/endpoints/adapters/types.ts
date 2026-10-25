/**
 * The adapter contract (D869): ONE adapter per CamStack cap, declaring
 * everything Alexa needs from it, so a new cap is one file instead of five
 * (the endpoint row, the state mapping, the ChangeReport map, the directive
 * handler, the validator whitelist).
 *
 * Discovery, ReportState, ChangeReport, the reconcile and the directive router
 * all iterate the one registry in `index.ts`; none of them names a cap.
 */
import type { DirectiveRouterDeps, VerifiedDirectiveIdentity } from '../../directive-router.js'
import type { DirectiveHeader } from '../../handlers/types.js'
import type { AlexaCapability, AlexaDisplayCategory } from '../types.js'

/** What an adapter may look at when it decides what a device becomes. */
export interface AdapterDevice {
  readonly deviceId: number
  readonly type: string
  /** The device's `DeviceRole` value (a cover's KIND), or null. */
  readonly role: string | null
  readonly features: readonly string[]
  readonly capNames: readonly string[]
  /** Slices read at discovery, keyed by cap, for the caps an adapter lists in
   *  `discoveryReads`. A missing key means the read failed or was not asked. */
  readonly slices: Readonly<Record<string, unknown>>
}

/** What an adapter makes of a device. */
export type AdapterDescription =
  | {
      readonly kind: 'publish'
      readonly capabilities: readonly AlexaCapability[]
      readonly category: AlexaDisplayCategory
    }
  /** The device has the cap but is deliberately NOT exposed (and why). */
  | { readonly kind: 'skip'; readonly reason: string }

/** One Alexa property derived from a cap slice. `instance` is set for the
 *  instanced interfaces (Range / Mode). */
export interface GenericProperty {
  readonly namespace: string
  readonly name: string
  readonly value: unknown
  readonly instance?: string
}

/** How often a property may be reported (D869). Absent = every change. */
export interface PropertyShaping {
  /** A numeric change smaller than this is not a change. */
  readonly deadband?: number
  /** At most one report per this many ms; the last value wins (trailing send). */
  readonly minIntervalMs?: number
  /** Quiet period before a report: an actuator in motion reports its FINAL value. */
  readonly debounceMs?: number
  /** The number to compare (the property value is not always a number). */
  readonly numericOf?: (value: unknown) => number | null
}

export interface AdapterDirectiveContext {
  readonly header: DirectiveHeader
  readonly endpoint: { readonly endpointId: string }
  readonly payload: unknown
  readonly deviceId: number
  readonly deps: DirectiveRouterDeps
  readonly identity: VerifiedDirectiveIdentity
}

export interface AdapterDirective {
  /** `Namespace/Name` of the directive. */
  readonly key: string
  /** A device the registry reports OFFLINE is refused before the handler runs. */
  readonly needsReachableDevice: boolean
  readonly handle: (ctx: AdapterDirectiveContext) => Promise<unknown>
  /**
   * Two caps can answer the same `Namespace/Name` (`PowerController/TurnOn` on
   * a switch AND on a thermostat; `ModeController/SetMode` on a cover AND a fan
   * mode). The router asks each registered directive of the key in registry
   * order; the first that claims the endpoint handles it. Absent = claims all.
   */
  readonly claims?: (ctx: AdapterDirectiveContext) => Promise<boolean>
}

export interface GenericAdapter {
  /** The CamStack cap that makes a device eligible. */
  readonly cap: string
  /** Caps whose slices feed this adapter's properties (includes `cap`). */
  readonly stateCaps: readonly string[]
  /** Caps whose slice discovery must read to decide the shape. */
  readonly discoveryReads: readonly string[]
  /** What the device becomes through this adapter, or null (not applicable). */
  readonly describe: (device: AdapterDevice) => AdapterDescription | null
  /** The Alexa properties one state cap's slice sets ([] = unusable slice). */
  readonly properties: (capName: string, slice: unknown) => readonly GenericProperty[]
  readonly directives: readonly AdapterDirective[]
  /** Report shaping for one of this adapter's properties. */
  readonly shaping: (property: GenericProperty) => PropertyShaping | null
}
