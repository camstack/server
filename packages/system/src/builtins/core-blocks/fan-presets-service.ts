/**
 * The `fan-presets` cap: named DESIRED fan-control states an operator keeps
 * for a fan (D1034) — speed, the fan's preset mode, direction and the
 * oscillation axes — stored in the fan's settings store (D865, key
 * `fanPresets`).
 *
 * Decisions that shape this file:
 *  - **A preset touches only the fan, through its own `fan-control` methods.**
 *    An axis the operator linked in Customize reaches its sibling device
 *    through the link's forward (`fan-link-forward.ts`), so a preset stores no
 *    sibling and is never re-judged when the container changes.
 *  - **Apply runs in a fixed order and stops at the first failure**: preset,
 *    speed, direction, then each axis. Every field is reported — applied,
 *    failed, not-run or refused — and a failure names its field (D391).
 *  - **Capture never stores a guess.** It reads the fan's merged fan-control
 *    state (a linked field reads its link); a reading that is unknown is left
 *    out and named, never written as 0 (D393).
 */
import {
  DeviceType,
  FAN_CAPTURE_FIELDS,
  FAN_OSCILLATION_AXES,
  FAN_OSCILLATION_AXIS_SETTABLE,
  FAN_PRESETS_MAX,
  type FanCaptureField,
  type FanCaptureOmission,
  type FanControlStatus,
  type FanOscillationAxis,
  type FanOscillationAxisName,
  type FanOscillationAxisResult,
  type FanPreset,
  type FanPresetAxis,
  type FanPresetFieldResult,
  type FanPresetState,
  fanAxisPath,
  type IFanPresetsProvider,
  type IScopedLogger,
  type SetOscillationAxisInput,
} from '@camstack/types'

/** The per-device store the presets live in. */
export interface FanPresetsStore {
  read(deviceId: number): Promise<readonly FanPreset[]>
  write(deviceId: number, presets: readonly FanPreset[]): Promise<void>
  /** Every fan that has at least one preset. */
  listAll(): Promise<ReadonlyMap<number, readonly FanPreset[]>>
}

export interface FanPresetDeviceFacts {
  readonly name: string
  readonly type: DeviceType
}

export interface FanPresetsDevices {
  describe(deviceId: number): Promise<FanPresetDeviceFacts | null>
}

/** The fan's merged fan-control state; null when no source answers (D393). */
export interface FanPresetsReadings {
  fan(deviceId: number): Promise<FanControlStatus | null>
}

/** The fan's own fan-control methods; each throws when the call fails. */
export interface FanPresetsFanControl {
  setPreset(deviceId: number, preset: string): Promise<void>
  setPercentage(deviceId: number, speed: number): Promise<void>
  setDirection(deviceId: number, direction: NonNullable<FanPresetState['direction']>): Promise<void>
  setOscillationAxis(input: SetOscillationAxisInput): Promise<FanOscillationAxisResult>
}

export interface FanPresetsServiceDeps {
  readonly store: FanPresetsStore
  readonly devices: FanPresetsDevices
  readonly readings: FanPresetsReadings
  readonly fanControl: FanPresetsFanControl
  readonly logger: IScopedLogger
}

type SetResult = Awaited<ReturnType<IFanPresetsProvider['setPresets']>>
type ApplyResult = Awaited<ReturnType<IFanPresetsProvider['applyPreset']>>
type CaptureResult = Awaited<ReturnType<IFanPresetsProvider['capturePreset']>>
type CaptureInput = Parameters<IFanPresetsProvider['capturePreset']>[0]

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function axisFields(axis: FanPresetAxis | undefined): readonly string[] {
  if (axis === undefined) return []
  return FAN_OSCILLATION_AXIS_SETTABLE.filter((f) => axis[f] !== undefined)
}

/** Every state path a preset sets, in apply order. */
export function presetFields(state: FanPresetState): readonly string[] {
  return [
    ...(state.preset === undefined ? [] : ['preset']),
    ...(state.speed === undefined ? [] : ['speed']),
    ...(state.direction === undefined ? [] : ['direction']),
    ...FAN_OSCILLATION_AXES.flatMap((axis) =>
      axisFields(state.oscillationAxes?.[axis]).map((f) => `oscillationAxes.${axis}.${f}`),
    ),
  ]
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One unit of apply: a single call that sets one or more fields. */
interface ApplyStep {
  readonly fields: readonly string[]
  run(): Promise<readonly FanPresetFieldResult[]>
}

function plainStep(field: string, call: () => Promise<void>): ApplyStep {
  return {
    fields: [field],
    run: async () => {
      try {
        await call()
        return [{ field, outcome: 'applied' }]
      } catch (err: unknown) {
        return [{ field, outcome: 'failed', message: errorText(err) }]
      }
    },
  }
}

function axisStep(
  fan: FanPresetsFanControl,
  deviceId: number,
  axis: FanOscillationAxisName,
  want: FanPresetAxis,
): ApplyStep {
  const fields = axisFields(want)
  const path = (f: string): string => `oscillationAxes.${axis}.${f}`
  return {
    fields: fields.map(path),
    run: async () => {
      let result: FanOscillationAxisResult
      try {
        result = await fan.setOscillationAxis({ deviceId, axis, ...want })
      } catch (err: unknown) {
        const message = errorText(err)
        return fields.map((f) => ({ field: path(f), outcome: 'failed' as const, message }))
      }
      if (result.status === 'applied') {
        return fields.map((f) => ({ field: path(f), outcome: 'applied' as const }))
      }
      return fields.map((f): FanPresetFieldResult => {
        if (result.applied.some((a) => a === f)) return { field: path(f), outcome: 'applied' }
        if (result.field === f || result.field === undefined) {
          return {
            field: path(f),
            outcome: 'refused',
            message: `${result.reason}: ${result.detail}`,
          }
        }
        return { field: path(f), outcome: 'not-run', message: `${result.field} was refused first` }
      })
    },
  }
}

function applySteps(
  fan: FanPresetsFanControl,
  deviceId: number,
  state: FanPresetState,
): readonly ApplyStep[] {
  const { preset, speed, direction } = state
  return [
    ...(preset === undefined ? [] : [plainStep('preset', () => fan.setPreset(deviceId, preset))]),
    ...(speed === undefined ? [] : [plainStep('speed', () => fan.setPercentage(deviceId, speed))]),
    ...(direction === undefined
      ? []
      : [plainStep('direction', () => fan.setDirection(deviceId, direction))]),
    ...FAN_OSCILLATION_AXES.flatMap((axis): readonly ApplyStep[] => {
      const want = state.oscillationAxes?.[axis]
      return want === undefined || axisFields(want).length === 0
        ? []
        : [axisStep(fan, deviceId, axis, want)]
    }),
  ]
}

interface Captured {
  readonly state: FanPresetState
  readonly omitted: readonly FanCaptureOmission[]
}

const UNKNOWN = 'the fan reports no value for it'

function captureAxis(
  axis: FanOscillationAxisName,
  reading: FanOscillationAxis | null | undefined,
): { readonly want: FanPresetAxis | null; readonly omitted: readonly FanCaptureOmission[] } {
  if (reading === null || reading === undefined) {
    return {
      want: null,
      omitted: [{ what: `oscillationAxes.${axis}`, reason: 'the fan has no such axis' }],
    }
  }
  const omitted: FanCaptureOmission[] = []
  const want: { -readonly [K in keyof FanPresetAxis]: FanPresetAxis[K] } = {}
  if (reading.oscillating === null) {
    omitted.push({ what: fanAxisPath(axis, 'oscillating'), reason: UNKNOWN })
  } else {
    want.oscillating = reading.oscillating
  }
  for (const field of ['angle', 'sweepFrom', 'sweepTo'] as const) {
    const value = reading[field]
    if (value === null) omitted.push({ what: fanAxisPath(axis, field), reason: UNKNOWN })
    else want[field] = value
  }
  return { want: Object.keys(want).length === 0 ? null : want, omitted }
}

function captureState(status: FanControlStatus, fields: readonly FanCaptureField[]): Captured {
  const omitted: FanCaptureOmission[] = []
  const state: { -readonly [K in keyof FanPresetState]: FanPresetState[K] } = {}
  if (fields.includes('speed')) {
    if (status.speed === null) omitted.push({ what: 'speed', reason: UNKNOWN })
    else state.speed = status.speed
  }
  if (fields.includes('direction')) {
    if (status.direction === null) omitted.push({ what: 'direction', reason: UNKNOWN })
    else state.direction = status.direction
  }
  if (fields.includes('preset')) {
    if (status.preset === '') omitted.push({ what: 'preset', reason: 'no preset is active' })
    else state.preset = status.preset
  }
  if (fields.includes('oscillationAxes')) {
    const axes: { -readonly [K in FanOscillationAxisName]?: FanPresetAxis } = {}
    for (const axis of FAN_OSCILLATION_AXES) {
      const taken = captureAxis(axis, status.oscillationAxes?.[axis])
      omitted.push(...taken.omitted)
      if (taken.want !== null) axes[axis] = taken.want
    }
    if (Object.keys(axes).length > 0) state.oscillationAxes = axes
  }
  return { state, omitted }
}

export class FanPresetsService implements IFanPresetsProvider {
  constructor(private readonly deps: FanPresetsServiceDeps) {}

  async getPresets(input: { deviceId: number }): Promise<FanPreset[]> {
    return [...(await this.deps.store.read(input.deviceId))]
  }

  async setPresets(input: { deviceId: number; presets: FanPreset[] }): Promise<SetResult> {
    const { deviceId, presets } = input
    const refuse = (
      reason: Extract<SetResult, { status: 'refused' }>['reason'],
      detail: string,
    ): SetResult => {
      this.deps.logger.warn('fan presets save refused', {
        tags: { deviceId },
        meta: { reason, detail },
      })
      return { status: 'refused', reason, detail }
    }
    const facts = await this.deps.devices.describe(deviceId)
    if (facts === null || facts.type !== DeviceType.Fan) {
      return refuse('not-a-fan', `device ${deviceId} is not a fan`)
    }
    if (presets.length > FAN_PRESETS_MAX) {
      return refuse('too-many', `at most ${FAN_PRESETS_MAX} presets per fan`)
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const preset of presets) {
      if (ids.has(preset.id))
        return refuse('duplicate-id', `preset id "${preset.id}" is used twice`)
      ids.add(preset.id)
      const key = nameKey(preset.name)
      if (names.has(key)) {
        return refuse('duplicate-name', `two presets are called "${preset.name.trim()}"`)
      }
      names.add(key)
      if (presetFields(preset.state).length === 0) {
        return refuse('empty-state', `preset "${preset.name.trim()}" sets nothing`)
      }
    }
    await this.deps.store.write(deviceId, presets)
    this.deps.logger.info('fan presets saved', {
      tags: { deviceId },
      meta: { count: presets.length },
    })
    return { status: 'saved', count: presets.length }
  }

  async applyPreset(input: { deviceId: number; presetId: string }): Promise<ApplyResult> {
    const { deviceId, presetId } = input
    const preset = (await this.deps.store.read(deviceId)).find((p) => p.id === presetId)
    if (preset === undefined) {
      this.deps.logger.warn('fan preset apply refused — no such preset', {
        tags: { deviceId },
        meta: { presetId },
      })
      return { status: 'refused', fields: [] }
    }
    const results: FanPresetFieldResult[] = []
    let stopped: string | null = null
    for (const step of applySteps(this.deps.fanControl, deviceId, preset.state)) {
      if (stopped !== null) {
        results.push(
          ...step.fields.map((field) => ({
            field,
            outcome: 'not-run' as const,
            message: `${stopped} did not apply`,
          })),
        )
        continue
      }
      const outcome = await step.run()
      results.push(...outcome)
      const bad = outcome.find((r) => r.outcome !== 'applied')
      if (bad !== undefined) stopped = bad.field
    }
    const landed = results.filter((r) => r.outcome === 'applied').length
    const status = stopped === null ? 'applied' : landed > 0 ? 'partial' : 'refused'
    const log = status === 'applied' ? 'info' : 'warn'
    this.deps.logger[log](`fan preset ${status}`, {
      tags: { deviceId },
      meta: {
        presetId,
        fields: results.map((r) => `${r.field}=${r.outcome}`),
        ...(stopped === null ? {} : { stoppedAt: stopped }),
      },
    })
    return { status, fields: results }
  }

  async capturePreset(input: CaptureInput): Promise<CaptureResult> {
    const fields = input.fields ?? FAN_CAPTURE_FIELDS
    const status = await this.deps.readings.fan(input.deviceId)
    if (status === null) {
      this.deps.logger.warn('fan preset capture: the fan state could not be read', {
        tags: { deviceId: input.deviceId },
      })
      return {
        state: {},
        omitted: fields.map((what) => ({ what, reason: 'the fan state could not be read' })),
      }
    }
    const captured = captureState(status, fields)
    return { state: captured.state, omitted: [...captured.omitted] }
  }
}
