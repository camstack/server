/**
 * The climate scene's model from what a real device reports: its
 * `climate-control` status, its `heating-valve` status, or both. Pure, so the
 * cases the card must not lose (a held band, a valve that only reports) are
 * pinned by a spec without a device.
 */
import {
  CLIMATE_ROLES,
  climateRoleOf as deviceClimateRoleOf,
  type ClimateControlStatus,
  DeviceRole,
  type HeatingValveStatus,
  type HvacMode,
} from '@camstack/types'
import type { CardGlyph } from '../icons'
import type { ClimateRole } from '../illustrations/ClimateRoleGlyph'
import {
  type ClimateCardModel,
  type ClimateChoice,
  type ClimateRange,
  deriveClimateActivity,
} from '../scenes/climate/model'

export type ClimateSceneModel = Omit<ClimateCardModel, 'common'>

/** The optional commands the device's provider implements. */
export interface ClimateCommands {
  readonly targetRange: boolean
  readonly fanMode: boolean
  readonly preset: boolean
  readonly swingVertical: boolean
  readonly swingHorizontal: boolean
}

export interface ClimateModelInput {
  /** The device's role (D1033): which kind of climate device it is. */
  readonly role: string | null
  /** Undefined when the device binds no `climate-control`. */
  readonly climate: ClimateControlStatus | undefined
  /** Undefined when the device binds no `heating-valve`; null until it reports. */
  readonly valve: HeatingValveStatus | null | undefined
  readonly commands: ClimateCommands
  readonly modeLabel: (mode: HvacMode) => string
}

const MODE_GLYPH: Readonly<Partial<Record<HvacMode, CardGlyph>>> = {
  heat: 'heat',
  cool: 'cool',
  auto: 'auto',
  heat_cool: 'auto',
  fan_only: 'fanOnly',
  dry: 'dry',
}

const DEFAULT_MIN = 16
const DEFAULT_MAX = 30
const DEFAULT_STEP = 0.5

/** The card's glyph for each climate device role (D1033). */
const CARD_ROLE: Readonly<Record<string, ClimateRole>> = {
  [DeviceRole.ClimateAc]: 'ac',
  [DeviceRole.ClimateThermostat]: 'thermostat',
  [DeviceRole.ClimateFloor]: 'floor',
  [DeviceRole.ClimateRadiator]: 'radiator',
  [DeviceRole.ClimateHeater]: 'heater',
  [DeviceRole.ClimateHeatPumpCircuit]: 'hpcircuit',
}

/**
 * What draws the heat or the cold, from the device's ROLE. A bound valve
 * makes a plain thermostat (or an unset role) a radiator; a role the operator
 * named (floor, heat pump circuit, ac...) is kept.
 */
export function climateRoleOf(role: string | null | undefined, hasValve: boolean): ClimateRole {
  const named = role !== null && role !== undefined && CLIMATE_ROLES.some((r) => r === role)
  const resolved = deviceClimateRoleOf(role)
  if (hasValve && (!named || resolved === DeviceRole.ClimateThermostat)) return 'radiator'
  return CARD_ROLE[resolved] ?? 'thermostat'
}

const titled = (id: string): string =>
  id.length === 0 ? id : `${id.slice(0, 1).toUpperCase()}${id.slice(1).replaceAll('_', ' ')}`

function plainChoice(value: string | null, ids: readonly string[]): ClimateChoice {
  return { value, options: ids.map((id) => ({ id, label: titled(id) })) }
}

/**
 * The band a device holds: in `heat_cool` mode, or whenever it reports both a
 * low and a high setpoint. Null when either end is missing — one handle alone
 * is not a band.
 */
export function climateRangeOf(status: ClimateControlStatus, canSet: boolean): ClimateRange | null {
  const held =
    status.mode === 'heat_cool' || (status.targetLow !== null && status.targetHigh !== null)
  if (!held || status.targetLow === null || status.targetHigh === null) return null
  return {
    low: Math.min(status.targetLow, status.targetHigh),
    high: Math.max(status.targetLow, status.targetHigh),
    min: status.minTemp ?? DEFAULT_MIN,
    max: status.maxTemp ?? DEFAULT_MAX,
    step: status.tempStep ?? DEFAULT_STEP,
    editable: canSet,
  }
}

/** A valve that only reports: no setpoint, no mode, no power. */
function valveOnlyModel(role: string | null, valve: HeatingValveStatus | null): ClimateSceneModel {
  const position = valve?.position ?? null
  return {
    role: climateRoleOf(role, true),
    on: true,
    canPower: false,
    activity: position === null ? 'unknown' : position > 0 ? 'heat' : 'idle',
    since: null,
    current: null,
    flow: null,
    humidity: null,
    target: null,
    range: null,
    valve: { position },
    mode: null,
    fan: null,
    swing: null,
    swingHorizontal: null,
    preset: null,
    heatCool: null,
  }
}

/** Null when the device declares neither capability: there is no climate card to draw. */
export function climateModelOf(input: ClimateModelInput): ClimateSceneModel | null {
  const { climate, valve, commands, role } = input
  const hasValve = valve !== undefined
  if (climate === undefined) return hasValve ? valveOnlyModel(role, valve) : null

  const on = climate.mode !== 'off'
  const modes = climate.availableModes.filter((m) => m !== 'off')
  const range = climateRangeOf(climate, commands.targetRange)
  const target = range === null ? climate.target : null
  const current = climate.currentTemp
  const cooling =
    climate.mode === 'cool' ||
    ((climate.mode === 'auto' || climate.mode === 'heat_cool') &&
      target !== null &&
      current !== null &&
      target < current)
  return {
    role: climateRoleOf(role, hasValve),
    on,
    canPower: true,
    activity: deriveClimateActivity({ on, cooling, target, current, range }),
    since: null,
    current,
    flow: null,
    humidity: climate.currentHumidity,
    target:
      target === null
        ? null
        : {
            value: target,
            min: climate.minTemp ?? DEFAULT_MIN,
            max: climate.maxTemp ?? DEFAULT_MAX,
            step: climate.tempStep ?? DEFAULT_STEP,
            label: null,
          },
    range,
    valve: hasValve ? { position: valve?.position ?? null } : null,
    mode:
      modes.length === 0
        ? null
        : {
            value: on ? climate.mode : null,
            options: modes.map((m) => {
              const glyph = MODE_GLYPH[m]
              const label = input.modeLabel(m)
              return glyph === undefined ? { id: m, label } : { id: m, label, glyph }
            }),
          },
    fan:
      !commands.fanMode || climate.availableFanModes.length === 0
        ? null
        : plainChoice(climate.fanMode, climate.availableFanModes),
    swing: commands.swingVertical ? climate.swingVertical : null,
    swingHorizontal: commands.swingHorizontal ? climate.swingHorizontal : null,
    preset:
      !commands.preset || climate.availablePresets.length === 0
        ? null
        : plainChoice(climate.preset, climate.availablePresets),
    heatCool: null,
  }
}
