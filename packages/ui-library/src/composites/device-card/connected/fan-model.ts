/**
 * A real fan's slices as the fan card draws them: the `fan-control` slice
 * (speed, presets, direction, oscillation or its axes) and the saved presets
 * of `fan-presets`, in one menu.
 */
import {
  DeviceFeature,
  type FanControlStatus,
  type FanOscillationAxis,
  type FanPreset,
  type FanPresetApplyResult,
} from '@camstack/types'
import type { MenuOption } from '../parts/MenuButton'
import type { FanAxisModel, FanCardModel } from '../scenes/fan/model'

/** A menu id says which list it came from: the device's own, or a saved one. */
const DEVICE_PRESET = 'device:'
const SAVED_PRESET = 'saved:'

export type FanPresetChoice =
  | { readonly kind: 'device'; readonly preset: string }
  | { readonly kind: 'saved'; readonly presetId: string }

export function fanPresetChoice(id: string): FanPresetChoice | null {
  if (id.startsWith(DEVICE_PRESET))
    return { kind: 'device', preset: id.slice(DEVICE_PRESET.length) }
  if (id.startsWith(SAVED_PRESET)) return { kind: 'saved', presetId: id.slice(SAVED_PRESET.length) }
  return null
}

const AXIS_DEFAULT_MIN = -90
const AXIS_DEFAULT_MAX = 90
const AXIS_DEFAULT_STEP = 5

/** An axis the fan reports; null when it reports nothing on it. */
export function fanAxisOf(axis: FanOscillationAxis | null | undefined): FanAxisModel | null {
  if (axis === null || axis === undefined) return null
  if (axis.oscillating === null && axis.angle === null && axis.sweepFrom === null) return null
  const min = axis.min ?? AXIS_DEFAULT_MIN
  const max = axis.max ?? AXIS_DEFAULT_MAX
  return {
    oscillating: axis.oscillating === true,
    sweepFrom: axis.sweepFrom ?? min,
    sweepTo: axis.sweepTo ?? max,
    angle: axis.angle ?? 0,
    min,
    max,
    step: axis.step ?? AXIS_DEFAULT_STEP,
  }
}

export interface FanSliceInput {
  readonly fan: FanControlStatus | null | undefined
  readonly saved: readonly FanPreset[]
  readonly commands: {
    readonly speed: boolean
    readonly preset: boolean
    readonly direction: boolean
    readonly oscillating: boolean
    readonly axis: boolean
  }
  /**
   * What the device declares (`DeviceFeature`). Before the fan-control slice
   * answers, a declared speed or direction is drawn as a pending control —
   * present, value unknown — rather than missing.
   */
  readonly features?: readonly string[]
}

export type FanSliceModel = Pick<
  FanCardModel,
  'speed' | 'speedStep' | 'presets' | 'preset' | 'direction' | 'oscillating' | 'axes' | 'pending'
>

/** What the fan card draws from the slices; a field the device cannot command is not drawn. */
export function fanSliceModel({
  fan,
  saved,
  commands,
  features = [],
}: FanSliceInput): FanSliceModel {
  if (fan === null || fan === undefined) return pendingFanModel(saved, commands, features)
  const devicePresets: readonly MenuOption[] = commands.preset
    ? fan.availablePresets.map((p) => ({ id: `${DEVICE_PRESET}${p}`, label: p, glyph: 'fanOnly' }))
    : []
  const horizontal = commands.axis ? fanAxisOf(fan.oscillationAxes?.horizontal) : null
  const vertical = commands.axis ? fanAxisOf(fan.oscillationAxes?.vertical) : null
  const axes = horizontal === null && vertical === null ? null : { horizontal, vertical }
  return {
    speed: commands.speed ? fan.speed : null,
    speedStep: fan.percentageStep ?? 1,
    presets: [...devicePresets, ...savedOptions(saved)],
    preset: fan.preset === '' ? null : `${DEVICE_PRESET}${fan.preset}`,
    direction: commands.direction ? fan.direction : null,
    oscillating: commands.oscillating && axes === null ? fan.oscillating : null,
    axes,
    pending: false,
  }
}

const savedOptions = (saved: readonly FanPreset[]): readonly MenuOption[] =>
  saved.map((p) => ({ id: `${SAVED_PRESET}${p.id}`, label: p.name, glyph: 'fanOnly' }))

/**
 * The fan before its fan-control slice answers: the controls the device
 * declares are drawn, their values unknown (`pending`), never a made-up reading.
 */
function pendingFanModel(
  saved: readonly FanPreset[],
  commands: FanSliceInput['commands'],
  features: readonly string[],
): FanSliceModel {
  const speed = commands.speed && features.includes(DeviceFeature.FanSpeed)
  const direction = commands.direction && features.includes(DeviceFeature.FanDirection)
  return {
    speed: speed ? 0 : null,
    speedStep: 1,
    presets: savedOptions(saved),
    preset: null,
    direction: direction ? 'forward' : null,
    oscillating: null,
    axes: null,
    pending: true,
  }
}

/**
 * Why a saved preset did not fully apply, naming each field that did not
 * (D1034); null when everything applied.
 */
export function fanPresetFailure(result: FanPresetApplyResult): string | null {
  if (result.status === 'applied') return null
  const failed = result.fields
    .filter((f) => f.outcome !== 'applied')
    .map((f) =>
      f.message === undefined ? `${f.field} (${f.outcome})` : `${f.field}: ${f.message}`,
    )
  return failed.length === 0 ? result.status : failed.join(', ')
}
