/**
 * The pure half of the fan presets editor: a preset is a desired fan-control
 * state (D1034) — the fields it sets, each optional. The list edits, the
 * field rows the dialog shows, and the same checks the hub applies on save
 * (so a refusal is rarely the first the operator hears of a problem).
 */
import type {
  FanCaptureOmission,
  FanOscillationAxisName,
  FanPreset,
  FanPresetAxis,
  FanPresetState,
} from '@camstack/types'

export function upsertPreset(list: readonly FanPreset[], next: FanPreset): readonly FanPreset[] {
  return list.some((p) => p.id === next.id)
    ? list.map((p) => (p.id === next.id ? next : p))
    : [...list, next]
}

export function removePreset(list: readonly FanPreset[], id: string): readonly FanPreset[] {
  return list.filter((p) => p.id !== id)
}

/** `p1`, `p2`, … — the smallest one no preset has. */
export function newPresetId(list: readonly FanPreset[]): string {
  const taken = new Set(list.map((p) => p.id))
  let n = 1
  while (taken.has(`p${String(n)}`)) n += 1
  return `p${String(n)}`
}

export const PRESET_AXES: readonly FanOscillationAxisName[] = ['horizontal', 'vertical']
export const PRESET_AXIS_NUMBERS = ['angle', 'sweepFrom', 'sweepTo'] as const
export type PresetAxisNumber = (typeof PRESET_AXIS_NUMBERS)[number]

/** How many fields a state sets. */
export function presetFieldCount(state: FanPresetState): number {
  const own = [state.speed, state.preset, state.direction].filter((v) => v !== undefined).length
  return PRESET_AXES.reduce((n, axis) => {
    const want = state.oscillationAxes?.[axis]
    if (want === undefined) return n
    return (
      n +
      [want.oscillating, want.angle, want.sweepFrom, want.sweepTo].filter((v) => v !== undefined)
        .length
    )
  }, own)
}

/** The state with one axis replaced; an axis that sets nothing is dropped. */
export function withAxis(
  state: FanPresetState,
  axis: FanOscillationAxisName,
  want: FanPresetAxis,
): FanPresetState {
  const kept: FanPresetAxis = {
    ...(want.oscillating === undefined ? {} : { oscillating: want.oscillating }),
    ...(want.angle === undefined ? {} : { angle: want.angle }),
    ...(want.sweepFrom === undefined ? {} : { sweepFrom: want.sweepFrom }),
    ...(want.sweepTo === undefined ? {} : { sweepTo: want.sweepTo }),
  }
  const pick = (name: FanOscillationAxisName): FanPresetAxis | undefined => {
    const value = name === axis ? kept : state.oscillationAxes?.[name]
    return value === undefined || Object.keys(value).length === 0 ? undefined : value
  }
  const horizontal = pick('horizontal')
  const vertical = pick('vertical')
  const { oscillationAxes: _dropped, ...rest } = state
  if (horizontal === undefined && vertical === undefined) return rest
  return {
    ...rest,
    oscillationAxes: {
      ...(horizontal === undefined ? {} : { horizontal }),
      ...(vertical === undefined ? {} : { vertical }),
    },
  }
}

export type PresetCheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'no-name' | 'no-fields' | 'duplicate-name'
    }

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export function checkPresetDraft(others: readonly FanPreset[], draft: FanPreset): PresetCheck {
  if (draft.name.trim() === '') return { ok: false, reason: 'no-name' }
  if (presetFieldCount(draft.state) === 0) return { ok: false, reason: 'no-fields' }
  if (others.some((p) => p.id !== draft.id && sameName(p.name, draft.name))) {
    return { ok: false, reason: 'duplicate-name' }
  }
  return { ok: true }
}

export function omissionText(omission: FanCaptureOmission): string {
  return `${omission.what}: ${omission.reason}`
}

/** A number typed in a field: empty = not set; anything unparsable = not set. */
export function parseOptionalNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}
