/**
 * The unit switch of a History chart: which units a chart of a given stored
 * unit may be shown in, which one the user's preferences pick, and the
 * conversion of its points. Stored numbers stay in the base unit (D944); only
 * the display moves.
 */
import { convertUnit, unitDimension, type UnitDimension } from '@camstack/types'
import type { TimePoint } from '../charts/chart-data'
import type { UnitPreferences } from '../../lib/unit-preferences'

/** The units worth offering per dimension, in the order a person reads them. */
const CHOICES: Readonly<Partial<Record<UnitDimension, readonly string[]>>> = {
  temperature: ['°C', '°F'],
  power: ['W', 'kW'],
  energy: ['Wh', 'kWh', 'MWh'],
  speed: ['m/s', 'km/h', 'mph'],
  pressure: ['hPa', 'inHg'],
  length: ['mm', 'in'],
  'precipitation-rate': ['mm/h', 'in/h'],
}

/** The units a chart whose series is stored in `unit` can switch to; empty = no switch. */
export function chartUnitChoices(unit: string | null): readonly string[] {
  if (unit === null) return []
  const dimension = unitDimension(unit)
  const choices = dimension === undefined ? undefined : CHOICES[dimension]
  if (choices === undefined || !choices.includes(unit)) return []
  return choices
}

const IMPERIAL: Readonly<Partial<Record<UnitDimension, string>>> = {
  speed: 'mph',
  pressure: 'inHg',
  length: 'in',
  'precipitation-rate': 'in/h',
}

/** The unit a chart opens in: the user's preference, else the stored unit. */
export function defaultChartUnit(unit: string, preferences: UnitPreferences): string {
  const choices = chartUnitChoices(unit)
  if (choices.length === 0) return unit
  const dimension = unitDimension(unit)
  const wanted =
    dimension === 'temperature'
      ? preferences.temperature === 'fahrenheit'
        ? '°F'
        : undefined
      : preferences.system === 'imperial' && dimension !== undefined
        ? IMPERIAL[dimension]
        : undefined
  return wanted !== undefined && choices.includes(wanted) ? wanted : unit
}

function convertOrNull(v: number | null | undefined, from: string, to: string): number | null {
  return v === null || v === undefined ? null : convertUnit(v, from, to)
}

/** Points (value and min/max band) converted `from` → `to`; the same array when nothing changes. */
export function convertPoints(
  points: readonly TimePoint[],
  from: string,
  to: string,
): readonly TimePoint[] {
  if (from === to) return points
  return points.map((p) => ({
    ...p,
    v: convertOrNull(p.v, from, to),
    ...(p.min === undefined ? {} : { min: convertOrNull(p.min, from, to) }),
    ...(p.max === undefined ? {} : { max: convertOrNull(p.max, from, to) }),
  }))
}

export interface ChartUnitState {
  /** The unit shown; `null` when the stored unit is unknown — never a guess. */
  readonly unit: string | null
  readonly choices: readonly string[]
}

/** What a chart stored in `base` shows and offers, given the user's pick and preferences. */
export function chartUnitState(
  base: string | null,
  picked: string | null,
  preferences: UnitPreferences,
): ChartUnitState {
  if (base === null) return { unit: null, choices: [] }
  const choices = chartUnitChoices(base)
  const unit =
    picked !== null && choices.includes(picked) ? picked : defaultChartUnit(base, preferences)
  return { unit, choices }
}
