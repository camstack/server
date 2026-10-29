/**
 * Local types for the Alexa endpoint payloads we emit during Discovery.
 *
 * We deliberately keep this narrow rather than importing a 3rd-party
 * SDK — the Smart Home schema is wide and stable enough that we'd
 * only adopt a small slice anyway. If we ever need to validate the
 * payload before sending we can promote these to zod schemas.
 */

export type AlexaDisplayCategory =
  | 'CAMERA'
  | 'DOORBELL'
  | 'LIGHT'
  | 'SWITCH'
  | 'SECURITY_PANEL'
  | 'MOTION_SENSOR'
  | 'CONTACT_SENSOR'
  | 'TEMPERATURE_SENSOR'
  | 'SMARTLOCK'
  | 'SMARTPLUG'
  | 'INTERIOR_BLIND'
  | 'EXTERIOR_BLIND'
  | 'THERMOSTAT'
  | 'AIR_CONDITIONER'
  | 'SCENE_TRIGGER'
  | 'OTHER'

export interface CameraStreamConfiguration {
  readonly protocols: readonly string[]
  readonly resolutions: ReadonlyArray<{ width: number; height: number }>
  readonly authorizationTypes: readonly string[]
  readonly videoCodecs: readonly string[]
  readonly audioCodecs: readonly string[]
}

/**
 * `Alexa.ModeController` instance configuration. We use it for the
 * `ptz.preset` mode (preset name → goToPreset). Supported modes are
 * derived from the camera's PTZ preset list at discovery time.
 */
export interface AlexaModeFriendlyName {
  readonly '@type': 'text'
  readonly value: { readonly text: string; readonly locale: string }
}

/** A friendly name taken from Amazon's localized asset catalogue
 *  (`Alexa.Setting.Opening`, `Alexa.Value.Open`, …): Alexa speaks it in the
 *  account's own language, so no per-locale text is shipped. */
export interface AlexaAssetFriendlyName {
  readonly '@type': 'asset'
  readonly value: { readonly assetId: string }
}

export type AlexaFriendlyName = AlexaModeFriendlyName | AlexaAssetFriendlyName

export interface AlexaModeResource {
  readonly friendlyNames: ReadonlyArray<AlexaFriendlyName>
}

/** One `semantics.actionMappings` entry (Open / Close / Raise / Lower). */
export interface AlexaActionMapping {
  readonly '@type': 'ActionsToDirective'
  readonly actions: readonly string[]
  readonly directive: { readonly name: string; readonly payload: Readonly<Record<string, unknown>> }
}

/** One `semantics.stateMappings` entry (Closed / Open). */
export type AlexaStateMapping =
  | {
      readonly '@type': 'StatesToValue'
      readonly states: readonly string[]
      readonly value: number | string
    }
  | {
      readonly '@type': 'StatesToRange'
      readonly states: readonly string[]
      readonly range: { readonly minimumValue: number; readonly maximumValue: number }
    }

export interface AlexaSemantics {
  readonly actionMappings?: readonly AlexaActionMapping[]
  readonly stateMappings?: readonly AlexaStateMapping[]
}

export interface AlexaSupportedMode {
  readonly value: string
  readonly modeResources: AlexaModeResource
}

export interface AlexaCapability {
  readonly type: 'AlexaInterface'
  readonly interface: string
  readonly version: string
  readonly instance?: string
  readonly proactivelyReported?: boolean
  /** Alexa.SceneController: a scene trigger cannot be deactivated. */
  readonly supportsDeactivation?: boolean
  readonly retrievable?: boolean
  readonly cameraStreamConfigurations?: readonly CameraStreamConfiguration[]
  readonly configuration?: Record<string, unknown>
  /** `Alexa.SmartVision.ObjectDetectionSensor` and friends use the
   *  plural `configurations` block (object/array) instead of the
   *  singular `configuration` used by `Alexa.ModeController`. */
  readonly configurations?: Record<string, unknown>
  readonly capabilityResources?: AlexaModeResource
  /** `Alexa.RangeController` / `Alexa.ModeController` voice semantics. */
  readonly semantics?: AlexaSemantics
  readonly properties?: {
    readonly supported: ReadonlyArray<{ readonly name: string }>
    readonly proactivelyReported: boolean
    readonly retrievable: boolean
    readonly nonControllable?: boolean
  }
}

export interface AlexaEndpoint {
  readonly endpointId: string
  readonly manufacturerName: string
  readonly description: string
  readonly friendlyName: string
  readonly displayCategories: readonly AlexaDisplayCategory[]
  readonly capabilities: readonly AlexaCapability[]
  readonly cookie?: Record<string, string>
}
