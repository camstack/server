import {
  climateControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type ClimateControlStatus,
  type HvacMode,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: ClimateControlStatus = {
  mode: 'off',
  availableModes: [],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: [],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

/**
 * HA-backed thermostat. Single cap (`climate-control`) with the full
 * HVAC surface: mode + fan + preset + target / dual-range / humidity
 * + read-only current readings.
 *
 * HA `climate.*` attributes consumed:
 *   - `hvac_modes` (array) → `availableModes`
 *   - `hvac_mode` / `state.state` → `mode`
 *   - `fan_modes` / `fan_mode` → fan picker
 *   - `preset_modes` / `preset_mode` → preset picker
 *   - `temperature` → `target` (single-setpoint)
 *   - `target_temp_high` / `target_temp_low` → `targetHigh` / `targetLow`
 *   - `target_humidity` → `targetHumidity`
 *   - `current_temperature` / `current_humidity` → read-only
 *   - `min_temp` / `max_temp` / `target_temp_step` → setpoint bounds
 *
 * Mutations route to:
 *   - `climate.set_hvac_mode({ hvac_mode })`
 *   - `climate.set_fan_mode({ fan_mode })`
 *   - `climate.set_preset_mode({ preset_mode })`
 *   - `climate.set_temperature({ temperature })`
 *   - `climate.set_temperature({ target_temp_low, target_temp_high })`
 *   - `climate.set_humidity({ humidity })`
 */
export class HaClimateDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerClimateCap()
    this.runtimeState.setCapState('climate-control', COLD_START)
  }

  /** The louver vocabularies HA last advertised, for the swing setters. */
  private swingModes: readonly string[] = []
  private swingHorizontalModes: readonly string[] = []

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    this.swingModes = readStringArray(state.attributes, 'swing_modes')
    this.swingHorizontalModes = readStringArray(state.attributes, 'swing_horizontal_modes')
    this.runtimeState.setCapState('climate-control', climateSliceFromState(state))
  }

  private registerClimateCap(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_START
      },
      setMode: async ({ mode }) => {
        await this.callHaService('climate', 'set_hvac_mode', { hvac_mode: mode })
      },
      setFanMode: async ({ fanMode }) => {
        await this.callHaService('climate', 'set_fan_mode', { fan_mode: fanMode })
      },
      setPreset: async ({ preset }) => {
        await this.callHaService('climate', 'set_preset_mode', { preset_mode: preset })
      },
      setTarget: async ({ target }) => {
        await this.callHaService('climate', 'set_temperature', { temperature: target })
      },
      setTargetRange: async ({ targetLow, targetHigh }) => {
        await this.callHaService('climate', 'set_temperature', {
          target_temp_low: targetLow,
          target_temp_high: targetHigh,
        })
      },
      setTargetHumidity: async ({ targetHumidity }) => {
        await this.callHaService('climate', 'set_humidity', { humidity: targetHumidity })
      },
      // A device that advertised no swing vocabulary has a null axis in the
      // slice and no control; asking anyway is refused rather than guessed.
      setSwingVertical: async ({ on }) => {
        const swingMode = pickSwingMode(this.swingModes, on, VERTICAL_ON_MODES)
        if (swingMode === null) throw new Error('HaClimateDevice: vertical swing not supported')
        await this.callHaService('climate', 'set_swing_mode', { swing_mode: swingMode })
      },
      setSwingHorizontal: async ({ on }) => {
        if (this.swingHorizontalModes.length > 0) {
          const mode = pickSwingMode(this.swingHorizontalModes, on, HORIZONTAL_ON_MODES)
          if (mode === null) throw new Error('HaClimateDevice: horizontal swing not supported')
          await this.callHaService('climate', 'set_swing_horizontal_mode', {
            swing_horizontal_mode: mode,
          })
          return
        }
        const swingMode = pickSwingMode(this.swingModes, on, HORIZONTAL_ON_MODES)
        if (swingMode === null) throw new Error('HaClimateDevice: horizontal swing not supported')
        await this.callHaService('climate', 'set_swing_mode', { swing_mode: swingMode })
      },
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
  }
}

/**
 * The `climate-control` slice for one HA `climate.*` state. Pure, and the ONLY
 * place the slice is assembled: every key the cap schema declares is present —
 * `swingVertical` / `swingHorizontal` are `nullable`, not optional, and a slice
 * that omitted them was refused by `setCapState` on every push (828 dropped
 * pushes in a day on the live hub, every thermostat stuck at its cold start).
 */
export function climateSliceFromState(state: HaEntityState): ClimateControlStatus {
  const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
  const attrs = state.attributes

  const mode = sanitizeHvacMode(state.state)
  const availableModes = readStringArray(attrs, 'hvac_modes')
    .map(sanitizeHvacMode)
    .filter((m): m is HvacMode => m !== null)
  const fanMode = readStringAttr(attrs, 'fan_mode') ?? ''
  const availableFanModes = readStringArray(attrs, 'fan_modes')
  const preset = readStringAttr(attrs, 'preset_mode') ?? ''
  const availablePresets = readStringArray(attrs, 'preset_modes')

  return {
    mode: mode ?? 'off',
    availableModes,
    fanMode,
    availableFanModes,
    preset,
    availablePresets,
    target: readNumberAttr(attrs, 'temperature'),
    targetHigh: readNumberAttr(attrs, 'target_temp_high'),
    targetLow: readNumberAttr(attrs, 'target_temp_low'),
    targetHumidity: readNumberAttr(attrs, 'target_humidity'),
    currentTemp: readNumberAttr(attrs, 'current_temperature'),
    currentHumidity: readNumberAttr(attrs, 'current_humidity'),
    ...readSwing(attrs),
    minTemp: readNumberAttr(attrs, 'min_temp'),
    maxTemp: readNumberAttr(attrs, 'max_temp'),
    tempStep: readNumberAttr(attrs, 'target_temp_step'),
    lastFetchedAt,
  }
}

/** HA `swing_mode` values that mean the VERTICAL louver is moving. */
const VERTICAL_ON_MODES: readonly string[] = ['vertical', 'both', 'on']
/** HA `swing_mode` / `swing_horizontal_mode` values that mean the HORIZONTAL louver is moving. */
const HORIZONTAL_ON_MODES: readonly string[] = ['horizontal', 'both', 'on']

/**
 * HA models swing as one `swing_mode` picked from `swing_modes` (`off`,
 * `vertical`, `horizontal`, `both`, vendor strings), plus — on newer cores —
 * a separate `swing_horizontal_mode`. An axis the device never advertised is
 * `null`: no vocabulary, no control (D62).
 */
function readSwing(
  attrs: Record<string, unknown>,
): Pick<ClimateControlStatus, 'swingVertical' | 'swingHorizontal'> {
  const swingModes = readStringArray(attrs, 'swing_modes')
  const horizontalModes = readStringArray(attrs, 'swing_horizontal_modes')
  const swingMode = (readStringAttr(attrs, 'swing_mode') ?? '').toLowerCase()
  const horizontalMode = (readStringAttr(attrs, 'swing_horizontal_mode') ?? '').toLowerCase()
  const swingVertical = swingModes.length === 0 ? null : VERTICAL_ON_MODES.includes(swingMode)
  const swingHorizontal =
    horizontalModes.length > 0
      ? HORIZONTAL_ON_MODES.includes(horizontalMode)
      : swingModes.some((m) => HORIZONTAL_ON_MODES.includes(m.toLowerCase()))
        ? HORIZONTAL_ON_MODES.includes(swingMode)
        : null
  return { swingVertical, swingHorizontal }
}

/**
 * The HA mode that turns one axis on or off, chosen from what the device
 * advertised; `null` when the vocabulary has no such value.
 */
function pickSwingMode(
  advertised: readonly string[],
  enabled: boolean,
  onModes: readonly string[],
): string | null {
  const lower = advertised.map((m) => m.toLowerCase())
  const wanted = enabled ? onModes : ['off']
  const index = lower.findIndex((m) => wanted.includes(m))
  return index === -1 ? null : (advertised[index] ?? null)
}

function sanitizeHvacMode(s: string): HvacMode | null {
  switch (s) {
    case 'off':
    case 'heat':
    case 'cool':
    case 'auto':
    case 'heat_cool':
    case 'fan_only':
    case 'dry':
      return s
    default:
      return null
  }
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
}

function readStringArray(attrs: Record<string, unknown>, key: string): string[] {
  const v = attrs[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
