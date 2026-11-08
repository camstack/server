/**
 * What a climate-control slice means for a hero (D1023): one pure derivation,
 * so the contribution only maps it to model parts. Nothing here guesses: a
 * slice that did not answer is `null`, a missing bound is a missing bound.
 */
import type { ClimateControlStatus, HvacMode } from '../../capabilities/climate-control.cap.js'
import type { HeroSceneMode } from './hero-scene.js'
import { heroText, type HeroText } from './hero-text.js'

export interface ClimateSetpointRange {
  readonly min: number
  readonly max: number
  readonly step: number
}

export interface ClimateView {
  readonly mode: HvacMode
  readonly isOff: boolean
  readonly modeLabel: HeroText
  readonly target: number | null
  readonly measured: number | null
  /** The dual setpoint of a range mode (`heat_cool`); both ends or neither. */
  readonly targetRange: { readonly low: number; readonly high: number } | null
  readonly targetHumidity: number | null
  readonly humidity: number | null
  /** The bounds the device reported; `null` when it did not (the stepper is then not offered). */
  readonly range: ClimateSetpointRange | null
  readonly availableModes: readonly HvacMode[]
  readonly sceneMode: HeroSceneMode | null
  /** The setpoint inside its range, 0..1; `null` without a setpoint or a range. */
  readonly level: number | null
  /** The mode that "turn on" selects; `null` when the device lists none. */
  readonly onMode: HvacMode | null
}

const MODE_LABEL: Readonly<Record<HvacMode, HeroText>> = {
  off: heroText('Off', 'Spento'),
  heat: heroText('Heating', 'Riscalda'),
  cool: heroText('Cooling', 'Freddo'),
  auto: heroText('Auto', 'Auto'),
  heat_cool: heroText('Heat/Cool', 'Caldo/Freddo'),
  fan_only: heroText('Fan only', 'Solo ventola'),
  dry: heroText('Drying', 'Deumidifica'),
}

const SCENE_MODE: Readonly<Record<HvacMode, HeroSceneMode | null>> = {
  off: null,
  heat: 'heat',
  cool: 'cool',
  auto: 'auto',
  heat_cool: 'auto',
  fan_only: 'fan',
  dry: 'dry',
}

/** Without a remembered mode, "turn on" picks the first of these the device accepts. */
const ON_MODE_PREFERENCE: readonly HvacMode[] = ['auto', 'heat_cool', 'heat', 'cool']

export function modeLabelOf(mode: HvacMode): HeroText {
  return MODE_LABEL[mode]
}

/** 22 -> "22", 22.3 -> "22.3": a trailing zero is noise on a thermostat. */
export function formatDegrees(value: number): string {
  return `${Number(value.toFixed(1))}°`
}

/** "Turn on" returns to the mode the device last ran when it still accepts it, else the fixed order. */
function onModeOf(available: readonly HvacMode[], last: HvacMode | undefined): HvacMode | null {
  const candidates: HvacMode[] = available.filter((m) => m !== 'off')
  if (last !== undefined && candidates.includes(last)) return last
  for (const preferred of ON_MODE_PREFERENCE) {
    if (candidates.includes(preferred)) return preferred
  }
  return candidates[0] ?? null
}

export function deriveClimateView(slice: ClimateControlStatus): ClimateView {
  const range = rangeFrom(slice.minTemp, slice.maxTemp, slice.tempStep)
  const level = levelWithin(slice.target, range)
  return {
    mode: slice.mode,
    isOff: slice.mode === 'off',
    modeLabel: MODE_LABEL[slice.mode],
    target: slice.target,
    measured: slice.currentTemp,
    targetRange:
      slice.targetLow !== null && slice.targetHigh !== null
        ? { low: slice.targetLow, high: slice.targetHigh }
        : null,
    targetHumidity: slice.targetHumidity,
    humidity: slice.currentHumidity,
    range,
    availableModes: slice.availableModes,
    sceneMode: SCENE_MODE[slice.mode],
    level,
    onMode: onModeOf(slice.availableModes, slice.lastActiveMode),
  }
}

/** "22° (22.3°)": the setpoint and, in brackets, what is measured. The mode is the headline, not repeated here. */
export function thermalStatusText(
  target: number | string | null,
  measured: number | null,
): HeroText | null {
  const goal = target === null ? '' : typeof target === 'string' ? target : formatDegrees(target)
  const now = measured === null ? '' : formatDegrees(measured)
  const temps = goal !== '' && now !== '' ? `${goal} (${now})` : goal !== '' ? goal : now
  return temps === '' ? null : heroText(temps, temps)
}

export function climateStatusText(view: ClimateView): HeroText | null {
  const range = view.targetRange
  const goal =
    view.target !== null
      ? view.target
      : range === null
        ? null
        : `${Number(range.low.toFixed(1))}–${formatDegrees(range.high)}`
  return thermalStatusText(goal, view.measured)
}

/** The setpoint inside its range, 0..1. */
export function levelWithin(
  value: number | null,
  range: ClimateSetpointRange | null,
): number | null {
  if (value === null || range === null) return null
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)))
}

export function rangeFrom(
  min: number | null | undefined,
  max: number | null | undefined,
  step: number | null | undefined,
): ClimateSetpointRange | null {
  if (min === null || min === undefined) return null
  if (max === null || max === undefined || max <= min) return null
  return { min, max, step: step ?? 1 }
}
