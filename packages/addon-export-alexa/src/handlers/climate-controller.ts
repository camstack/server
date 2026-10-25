/**
 * The directives of a thermostat / air conditioner exported as its own device
 * (D874), through the `climate-control` cap:
 *
 *   `Alexa.ThermostatController` SetTargetTemperature, AdjustTargetTemperature,
 *   SetThermostatMode; `Alexa.PowerController` TurnOn / TurnOff;
 *   `Alexa.ModeController` SetMode on `Climate.Mode` and `Climate.FanSpeed`.
 *
 * A setpoint is checked against the device's own minimum / maximum / step
 * (the slice carries them) and refused with Amazon's
 * `TEMPERATURE_VALUE_OUT_OF_RANGE` and its `validRange`; a mode the device does
 * not have is `UNSUPPORTED_THERMOSTAT_MODE`. The commands are quick, so the
 * answer is synchronous (no DeferredResponse): the Response carries the state
 * the command set, projected from the slice read before it.
 */
import type { AddonApi, AddonContext, HvacMode, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import {
  boundsOf,
  type ClimateSlice,
  climateProperties,
  ecoPresetOf,
  fanModesOf,
  hvacModeForValue,
  INSTANCE_FAN,
  INSTANCE_MODE,
  onModeOf,
  readClimateSlice,
  round1,
  snapToStep,
  supportsDual,
  supportsSingle,
  type TemperatureBounds,
  temperatureValue,
} from '../endpoints/adapters/climate-model.js'
import type { AdapterDirectiveContext, GenericProperty } from '../endpoints/adapters/types.js'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

export interface ClimateControllerContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
}

const CAP_CLIMATE = 'climate-control'
const CAP_SWITCH = 'switch'
const UNCERTAINTY_MS = 500
const PRESET_NONE = 'none'

const ScaleSchema = z.enum(['CELSIUS', 'FAHRENHEIT', 'KELVIN'])
const TemperatureSchema = z.object({ value: z.number(), scale: ScaleSchema })
type AlexaTemperature = z.infer<typeof TemperatureSchema>

const SetTemperaturePayload = z.object({
  targetSetpoint: TemperatureSchema.optional(),
  lowerSetpoint: TemperatureSchema.optional(),
  upperSetpoint: TemperatureSchema.optional(),
})
const AdjustTemperaturePayload = z.object({ targetSetpointDelta: TemperatureSchema })
const ThermostatModePayload = z.object({
  thermostatMode: z.union([z.string(), z.object({ value: z.string() })]),
})
const ModePayload = z.object({ mode: z.string() })

/** Why a directive could not be carried out: the envelope to answer with. */
interface Refusal {
  readonly refusal: unknown
}

/** What a directive asks of the cap, and the state it leaves behind. */
interface Plan {
  readonly commands: ReadonlyArray<() => Promise<void>>
  readonly projected: ClimateSlice
  /** Which of the projected properties the Response carries. */
  readonly keep: (property: GenericProperty) => boolean
}

type Outcome = Plan | Refusal

function isRefusal(outcome: Outcome): outcome is Refusal {
  return 'refusal' in outcome
}

function toCelsius(t: AlexaTemperature): number {
  if (t.scale === 'FAHRENHEIT') return ((t.value - 32) * 5) / 9
  if (t.scale === 'KELVIN') return t.value - 273.15
  return t.value
}

/** A DELTA converts without the scale's offset. */
function deltaToCelsius(t: AlexaTemperature): number {
  return t.scale === 'FAHRENHEIT' ? (t.value * 5) / 9 : t.value
}

function withPayload(envelope: ReturnType<typeof errorEnvelope>, extra: object): unknown {
  return {
    event: { ...envelope.event, payload: { ...envelope.event.payload, ...extra } },
  }
}

function outOfRange(header: DirectiveHeader, bounds: TemperatureBounds): Refusal {
  return {
    refusal: withPayload(
      errorEnvelope(
        header,
        'TEMPERATURE_VALUE_OUT_OF_RANGE',
        `the setpoint must be between ${bounds.min} and ${bounds.max} C`,
      ),
      {
        validRange: {
          minimumValue: temperatureValue(bounds.min),
          maximumValue: temperatureValue(bounds.max),
        },
      },
    ),
  }
}

function tooClose(header: DirectiveHeader, bounds: TemperatureBounds): Refusal {
  return {
    refusal: withPayload(
      errorEnvelope(
        header,
        'REQUESTED_SETPOINTS_TOO_CLOSE',
        'lowerSetpoint must be below upperSetpoint',
      ),
      { minimumTemperatureDelta: temperatureValue(bounds.step) },
    ),
  }
}

function refuse(header: DirectiveHeader, type: string, message: string): Refusal {
  return { refusal: errorEnvelope(header, type, message) }
}

function inRange(celsius: number, bounds: TemperatureBounds): boolean {
  const v = round1(celsius)
  return v >= bounds.min && v <= bounds.max
}

const THERMOSTAT_PROPERTIES: ReadonlySet<string> = new Set([
  'targetSetpoint',
  'lowerSetpoint',
  'upperSetpoint',
  'thermostatMode',
])

function thermostatProperty(property: GenericProperty): boolean {
  return (
    property.namespace === 'Alexa.ThermostatController' && THERMOSTAT_PROPERTIES.has(property.name)
  )
}

interface Commands {
  readonly setMode: (mode: HvacMode) => Promise<void>
  readonly setPreset: (preset: string) => Promise<void>
  readonly setFanMode: (fanMode: string) => Promise<void>
  readonly setTarget: (target: number) => Promise<void>
  readonly setTargetRange: (low: number, high: number) => Promise<void>
}

function commandsFor(api: AddonApi, deviceId: number): Commands {
  return {
    setMode: (mode) => api.climateControl.setMode.mutate({ deviceId, mode }),
    setPreset: (preset) => api.climateControl.setPreset.mutate({ deviceId, preset }),
    setFanMode: (fanMode) => api.climateControl.setFanMode.mutate({ deviceId, fanMode }),
    setTarget: (target) => api.climateControl.setTarget.mutate({ deviceId, target }),
    setTargetRange: (targetLow, targetHigh) =>
      api.climateControl.setTargetRange.mutate({ deviceId, targetLow, targetHigh }),
  }
}

// ── Setpoints ───────────────────────────────────────────────────────

function planRange(
  header: DirectiveHeader,
  slice: ClimateSlice,
  cmd: Commands,
  low: number,
  high: number,
): Outcome {
  const bounds = boundsOf(slice)
  if (!supportsDual(slice, [])) {
    return refuse(header, 'DUAL_SETPOINTS_UNSUPPORTED', 'this thermostat has a single setpoint')
  }
  if (!inRange(low, bounds) || !inRange(high, bounds)) return outOfRange(header, bounds)
  const targetLow = snapToStep(low, bounds)
  const targetHigh = snapToStep(high, bounds)
  if (targetHigh - targetLow < bounds.step) return tooClose(header, bounds)
  return {
    commands: [
      ...(slice.mode === 'heat_cool' ? [] : [() => cmd.setMode('heat_cool')]),
      () => cmd.setTargetRange(targetLow, targetHigh),
    ],
    projected: { ...slice, mode: 'heat_cool', targetLow, targetHigh },
    keep: thermostatProperty,
  }
}

function planSingle(
  header: DirectiveHeader,
  slice: ClimateSlice,
  cmd: Commands,
  celsius: number,
): Outcome {
  const bounds = boundsOf(slice)
  if (!supportsSingle(slice) || slice.mode === 'heat_cool') {
    return refuse(
      header,
      'UNWILLING_TO_SET_VALUE',
      'the thermostat is in range mode: set a lower and an upper setpoint',
    )
  }
  if (!inRange(celsius, bounds)) return outOfRange(header, bounds)
  const target = snapToStep(celsius, bounds)
  return {
    commands: [() => cmd.setTarget(target)],
    projected: { ...slice, target },
    keep: thermostatProperty,
  }
}

function planSetTemperature(
  c: AdapterDirectiveContext,
  slice: ClimateSlice,
  cmd: Commands,
): Outcome {
  const parsed = SetTemperaturePayload.safeParse(c.payload)
  if (!parsed.success) return refuse(c.header, 'INVALID_DIRECTIVE', parsed.error.message)
  const { targetSetpoint, lowerSetpoint, upperSetpoint } = parsed.data
  if (targetSetpoint !== undefined && lowerSetpoint !== undefined && upperSetpoint !== undefined) {
    return refuse(c.header, 'TRIPLE_SETPOINTS_UNSUPPORTED', 'a target AND a range were requested')
  }
  if (lowerSetpoint !== undefined && upperSetpoint !== undefined && targetSetpoint === undefined) {
    return planRange(c.header, slice, cmd, toCelsius(lowerSetpoint), toCelsius(upperSetpoint))
  }
  if (targetSetpoint !== undefined && lowerSetpoint === undefined && upperSetpoint === undefined) {
    return planSingle(c.header, slice, cmd, toCelsius(targetSetpoint))
  }
  return refuse(c.header, 'INVALID_DIRECTIVE', 'give a targetSetpoint, or a lower and an upper')
}

function planAdjust(c: AdapterDirectiveContext, slice: ClimateSlice, cmd: Commands): Outcome {
  const parsed = AdjustTemperaturePayload.safeParse(c.payload)
  if (!parsed.success) return refuse(c.header, 'INVALID_DIRECTIVE', parsed.error.message)
  const delta = deltaToCelsius(parsed.data.targetSetpointDelta)
  if (slice.mode === 'heat_cool' && slice.targetLow !== null && slice.targetHigh !== null) {
    return planRange(c.header, slice, cmd, slice.targetLow + delta, slice.targetHigh + delta)
  }
  if (slice.target === null) {
    return refuse(
      c.header,
      'ENDPOINT_UNREACHABLE',
      'the current setpoint is unknown, so it cannot be adjusted',
    )
  }
  return planSingle(c.header, slice, cmd, slice.target + delta)
}

// ── Mode and power ──────────────────────────────────────────────────

const ECO_FROM_OFF_MESSAGE = 'the thermostat has no mode to leave OFF into'

function hvacModeFor(requested: string, slice: ClimateSlice): HvacMode | null {
  const has = (m: HvacMode): boolean => slice.availableModes.includes(m)
  switch (requested) {
    case 'HEAT':
      return has('heat') ? 'heat' : null
    case 'COOL':
      return has('cool') ? 'cool' : null
    case 'AUTO':
      return has('auto') ? 'auto' : has('heat_cool') ? 'heat_cool' : null
    case 'OFF':
      return has('off') ? 'off' : null
    default:
      return null
  }
}

/** The preset that clears `eco` (HA and Gree both call it `none`), if the device has one. */
function presetClearing(slice: ClimateSlice): string | null {
  return slice.availablePresets.find((p) => p.toLowerCase() === PRESET_NONE) ?? null
}

function planEco(c: AdapterDirectiveContext, slice: ClimateSlice, cmd: Commands): Outcome {
  const eco = ecoPresetOf(slice)
  if (eco === null) return refuse(c.header, 'UNSUPPORTED_THERMOSTAT_MODE', 'ECO is not supported')
  const wake = slice.mode === 'off' ? onModeOf(slice) : null
  if (slice.mode === 'off' && wake === null) {
    return refuse(c.header, 'UNSUPPORTED_THERMOSTAT_MODE', ECO_FROM_OFF_MESSAGE)
  }
  return {
    commands: [...(wake === null ? [] : [() => cmd.setMode(wake)]), () => cmd.setPreset(eco)],
    projected: { ...slice, mode: wake ?? slice.mode, preset: eco },
    keep: thermostatProperty,
  }
}

function planSetThermostatMode(
  c: AdapterDirectiveContext,
  slice: ClimateSlice,
  cmd: Commands,
): Outcome {
  const parsed = ThermostatModePayload.safeParse(c.payload)
  if (!parsed.success) return refuse(c.header, 'INVALID_DIRECTIVE', parsed.error.message)
  const raw = parsed.data.thermostatMode
  const requested = (typeof raw === 'string' ? raw : raw.value).toUpperCase()
  if (requested === 'ECO') return planEco(c, slice, cmd)
  const mode = hvacModeFor(requested, slice)
  if (mode === null) {
    return refuse(
      c.header,
      'UNSUPPORTED_THERMOSTAT_MODE',
      `${requested} is not a mode this thermostat has`,
    )
  }
  const eco = ecoPresetOf(slice)
  const clear = eco !== null && slice.preset === eco ? presetClearing(slice) : null
  return {
    commands: [...(clear === null ? [] : [() => cmd.setPreset(clear)]), () => cmd.setMode(mode)],
    projected: { ...slice, mode, preset: clear ?? slice.preset },
    keep: thermostatProperty,
  }
}

function planPower(c: AdapterDirectiveContext, slice: ClimateSlice, cmd: Commands): Outcome {
  const turnOn = c.header.name === 'TurnOn'
  const keep = (p: GenericProperty): boolean => p.namespace === 'Alexa.PowerController'
  if (turnOn) {
    if (slice.mode !== 'off') return { commands: [], projected: slice, keep }
    const mode = onModeOf(slice)
    if (mode === null) return refuse(c.header, 'INVALID_DIRECTIVE', 'no mode to turn on into')
    return { commands: [() => cmd.setMode(mode)], projected: { ...slice, mode }, keep }
  }
  if (!slice.availableModes.includes('off')) {
    return refuse(c.header, 'INVALID_DIRECTIVE', 'this device cannot be turned off')
  }
  if (slice.mode === 'off') return { commands: [], projected: slice, keep }
  return {
    commands: [() => cmd.setMode('off')],
    projected: { ...slice, mode: 'off' },
    keep,
  }
}

function planModeController(
  c: AdapterDirectiveContext,
  slice: ClimateSlice,
  cmd: Commands,
): Outcome {
  const parsed = ModePayload.safeParse(c.payload)
  const instance = c.header.instance
  if (!parsed.success || instance === undefined) {
    return refuse(c.header, 'INVALID_DIRECTIVE', 'a mode and an instance are required')
  }
  const keep = (p: GenericProperty): boolean => p.instance === instance
  if (instance === INSTANCE_MODE) {
    const mode = hvacModeForValue(parsed.data.mode, slice)
    if (mode === null) return refuse(c.header, 'INVALID_VALUE', `unknown mode ${parsed.data.mode}`)
    return { commands: [() => cmd.setMode(mode)], projected: { ...slice, mode }, keep }
  }
  if (instance === INSTANCE_FAN) {
    const fan = fanModesOf(slice).find(([value]) => value === parsed.data.mode)
    if (fan === undefined) {
      return refuse(c.header, 'INVALID_VALUE', `unknown fan mode ${parsed.data.mode}`)
    }
    return {
      commands: [() => cmd.setFanMode(fan[1])],
      projected: { ...slice, fanMode: fan[1] },
      keep,
    }
  }
  return refuse(c.header, 'INVALID_DIRECTIVE', `unknown instance ${instance}`)
}

function plan(c: AdapterDirectiveContext, slice: ClimateSlice, cmd: Commands): Outcome {
  switch (`${c.header.namespace}/${c.header.name}`) {
    case 'Alexa.ThermostatController/SetTargetTemperature':
      return planSetTemperature(c, slice, cmd)
    case 'Alexa.ThermostatController/AdjustTargetTemperature':
      return planAdjust(c, slice, cmd)
    case 'Alexa.ThermostatController/SetThermostatMode':
      return planSetThermostatMode(c, slice, cmd)
    case 'Alexa.PowerController/TurnOn':
    case 'Alexa.PowerController/TurnOff':
      return planPower(c, slice, cmd)
    case 'Alexa.ModeController/SetMode':
      return planModeController(c, slice, cmd)
    default:
      return refuse(c.header, 'INVALID_DIRECTIVE', `${c.header.namespace}/${c.header.name}`)
  }
}

// ── Entry points ────────────────────────────────────────────────────

async function readSlice(
  c: AdapterDirectiveContext,
  deps: ClimateControllerContext,
): Promise<ClimateSlice | null> {
  try {
    const slice = await deps.ctx.api.deviceState.getCapSlice.query({
      deviceId: c.deviceId,
      capName: CAP_CLIMATE,
    })
    return readClimateSlice(slice)
  } catch (err: unknown) {
    deps.logger.warn('alexa climate-controller: the climate state could not be read', {
      tags: { deviceId: c.deviceId },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}

function successResponse(
  c: AdapterDirectiveContext,
  properties: readonly GenericProperty[],
): unknown {
  const now = new Date().toISOString()
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: c.header.messageId,
        ...(c.header.correlationToken !== undefined
          ? { correlationToken: c.header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      endpoint: { endpointId: c.endpoint.endpointId },
      payload: {},
    },
    context: {
      properties: properties.map((p) => ({
        ...p,
        timeOfSample: now,
        uncertaintyInMilliseconds: UNCERTAINTY_MS,
      })),
    },
  }
}

/** The one handler behind every climate directive. */
export async function handleClimateDirective(c: AdapterDirectiveContext): Promise<unknown> {
  const deps = c.deps.climateController
  const slice = await readSlice(c, deps)
  if (slice === null) {
    return errorEnvelope(c.header, 'ENDPOINT_UNREACHABLE', 'the climate state could not be read')
  }
  const outcome = plan(c, slice, commandsFor(deps.ctx.api, c.deviceId))
  if (isRefusal(outcome)) return outcome.refusal
  try {
    for (const command of outcome.commands) await command()
  } catch (err: unknown) {
    deps.logger.warn('alexa climate-controller: the climate command failed', {
      tags: { deviceId: c.deviceId },
      meta: { directive: c.header.name, error: err instanceof Error ? err.message : String(err) },
    })
    return errorEnvelope(c.header, 'ENDPOINT_UNREACHABLE', 'the device did not accept the command')
  }
  deps.logger.info(`alexa climate-controller: ${c.header.name}`, {
    tags: { deviceId: c.deviceId },
    meta: { commands: outcome.commands.length },
  })
  return successResponse(c, climateProperties(outcome.projected).filter(outcome.keep))
}

/**
 * Last answer per device, per deps instance: a failed bindings read changes
 * nothing (AGENTS D49) — a thermostat's TurnOff must not fall through to the
 * switch handler because one `getBindings` call failed.
 */
const lastPowerClaim = new WeakMap<object, Map<number, boolean>>()

/** PowerController on a climate endpoint, not on a switch: decided by the bound caps. */
export async function handlesPower(c: AdapterDirectiveContext): Promise<boolean> {
  const deps = c.deps.climateController
  const known = lastPowerClaim.get(deps) ?? new Map<number, boolean>()
  lastPowerClaim.set(deps, known)
  try {
    const bindings = await deps.ctx.api.deviceManager.getBindings.query({ deviceId: c.deviceId })
    const caps = bindings.entries.map((e) => e.capName)
    const claim = caps.includes(CAP_CLIMATE) && !caps.includes(CAP_SWITCH)
    known.set(c.deviceId, claim)
    return claim
  } catch (err: unknown) {
    const previous = known.get(c.deviceId)
    deps.logger.warn('alexa climate-controller: the bound caps could not be read', {
      tags: { deviceId: c.deviceId },
      meta: {
        error: err instanceof Error ? err.message : String(err),
        decidedFrom: previous === undefined ? 'no previous answer: not claimed' : 'previous answer',
      },
    })
    return previous ?? false
  }
}
