/**
 * Non-camera devices as Alexa endpoints (R5, D775; adapter registry D869).
 *
 * What a cap becomes is declared by ONE adapter per cap in `adapters/` — this
 * file only folds the adapters that apply to a device into one endpoint. The
 * table below is the map those adapters implement:
 *
 *   | cap                   | Alexa interface              | category           |
 *   | --------------------- | ---------------------------- | ------------------ |
 *   | `lock-control`        | `Alexa.LockController`       | SMARTLOCK          |
 *   | `contact`             | `Alexa.ContactSensor`        | CONTACT_SENSOR     |
 *   | `motion`              | `Alexa.MotionSensor`         | MOTION_SENSOR      |
 *   | `presence` (occupancy)| `Alexa.MotionSensor`         | MOTION_SENSOR      |
 *   | `temperature-sensor`  | `Alexa.TemperatureSensor`    | TEMPERATURE_SENSOR |
 *   | `humidity-sensor`     | `Alexa.HumiditySensor`       | TEMPERATURE_SENSOR |
 *   | `switch` (+brightness)| `Alexa.PowerController` (+`Alexa.BrightnessController`) | LIGHT / SWITCH |
 *   | `cover` (blind kinds) | `Alexa.RangeController` / `Alexa.ModeController` | INTERIOR_BLIND / EXTERIOR_BLIND |
 *   | `climate-control`     | `Alexa.ThermostatController` + `Alexa.TemperatureSensor` (+ power, mode, fan) | THERMOSTAT / AIR_CONDITIONER |
 *
 * NOT exported, because Alexa has no interface for them and a sensor that
 * "detects motion" when the bathroom floods is a claim, not a mapping:
 * `smoke`, `carbon-monoxide`, `flood`, `ambient-light-sensor`, `battery`.
 * The alarm panel keeps its own builder.
 *
 * One endpoint per device, `<deviceId>__dev`, every one with
 * `Alexa.EndpointHealth` (required on sensors and locks; reported like a
 * camera's, D770). Every property is retrievable and proactively reported
 * (`state-reports/`, D776).
 */
import { type GenericPlan, planGenericDevice } from './adapters/index.js'
import type { AlexaEndpoint } from './types.js'

export const GENERIC_ENDPOINT_SUFFIX = 'dev'

/** Device types this export may publish as a generic endpoint. `thermostat`
 *  (Home Assistant) and `climate` (an air conditioner, e.g. Gree) both carry
 *  the `climate-control` cap (D874). */
export const GENERIC_DEVICE_TYPES: readonly string[] = [
  'light',
  'switch',
  'siren',
  'sensor',
  'lock',
  'presence',
  'thermostat',
  'climate',
  'cover',
  'generic',
]

export interface BuildGenericEndpointInput {
  readonly deviceId: number
  readonly stableId: string
  readonly name: string
  readonly type: string
  readonly capNames: readonly string[]
  /** The device's `DeviceRole` (a cover's kind). */
  readonly role?: string | null
  readonly features?: readonly string[]
  /** The operator's Alexa name for this device (D875); the device name when absent. */
  readonly alexaName?: string | null
  /** Slices read at discovery for the caps that shape the endpoint. */
  readonly slices?: Readonly<Record<string, unknown>>
}

/** What a device becomes as a generic endpoint: the endpoint, or why not. */
export type GenericEndpointPlan =
  | { readonly kind: 'endpoint'; readonly endpoint: AlexaEndpoint }
  | { readonly kind: 'skip'; readonly reasons: readonly string[] }
  | { readonly kind: 'none' }

function toEndpoint(
  input: BuildGenericEndpointInput,
  plan: Extract<GenericPlan, { kind: 'publish' }>,
): AlexaEndpoint {
  const override = input.alexaName?.trim() ?? ''
  const name = override.length > 0 ? override : input.name.trim()
  return {
    endpointId: `${input.deviceId}__${GENERIC_ENDPOINT_SUFFIX}`,
    manufacturerName: 'camstack',
    description: `CamStack ${input.type || 'device'}`,
    friendlyName: name.length > 0 ? name : `Device ${input.deviceId}`,
    displayCategories: [plan.category],
    capabilities: plan.capabilities,
    cookie: { stableId: input.stableId },
  }
}

export function planGenericEndpoint(input: BuildGenericEndpointInput): GenericEndpointPlan {
  const plan = planGenericDevice({
    deviceId: input.deviceId,
    type: input.type,
    role: input.role ?? null,
    features: input.features ?? [],
    capNames: input.capNames,
    slices: input.slices ?? {},
  })
  if (plan.kind === 'publish') return { kind: 'endpoint', endpoint: toEndpoint(input, plan) }
  return plan
}

/** The endpoint for a non-camera device, or null when none of its caps has an
 *  Alexa interface (or the interface is deliberately withheld). */
export function buildGenericDeviceEndpoint(input: BuildGenericEndpointInput): AlexaEndpoint | null {
  const plan = planGenericEndpoint(input)
  return plan.kind === 'endpoint' ? plan.endpoint : null
}
