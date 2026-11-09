/**
 * The `fan-presets` cap: named settings an operator composes for a fan — its
 * own fields (speed, oscillation, direction, native preset) and the devices
 * that sit in the same container (a light, a control). A preset is a short
 * sequence of action steps kept in the fan's settings store (D865, key
 * `fanPresets`).
 *
 * Decisions that shape this file:
 *  - **A step may only touch the fan or one of its siblings.** The sibling
 *    set is the children of the fan's parent device (the container), or the
 *    fan's own children when it has none. Checked at save AND again at apply,
 *    because the container changes after a preset was written.
 *  - **Apply runs the shared step runner** (`buildActionSteps` + `runSteps`),
 *    in order, stopping at the first failure; every step is reported and a
 *    failure names its step (D391). Nothing the operator did not write runs.
 *  - **Capture never stores a guess.** A reading that is unknown is left out
 *    and named, never written as 0 (D393).
 */
import {
  type ActionStep,
  type CapCall,
  type ControlStatus,
  type FanCaptureField,
  type FanCaptureItem,
  type FanCaptureOmission,
  type FanControlStatus,
  FAN_CAPTURE_FIELDS,
  FAN_PRESETS_MAX,
  type FanPreset,
  type FanPresetStepResult,
  type IFanPresetsProvider,
  type IScopedLogger,
  type NormalizedCapStep,
  type SwitchStatus,
  buildActionSteps,
  DeviceType,
  normalizeCapStep,
  runSteps,
} from '@camstack/types'
import { type DeviceTemplateDoor, stepRenderer } from './device-template-door.js'
import {
  conditionDeps,
  type StepConditionDoor,
  stepConditionEvaluator,
} from './step-condition-door.js'

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
  readonly parentDeviceId: number | null
}

export interface FanPresetsDevices {
  describe(deviceId: number): Promise<FanPresetDeviceFacts | null>
  childrenOf(parentDeviceId: number): Promise<readonly number[]>
}

/** Current values, each null when no source answers (D393). */
export interface FanPresetsReadings {
  fan(deviceId: number): Promise<FanControlStatus | null>
  control(deviceId: number): Promise<ControlStatus | null>
  switchState(deviceId: number): Promise<SwitchStatus | null>
}

export interface FanPresetsServiceDeps {
  readonly store: FanPresetsStore
  readonly devices: FanPresetsDevices
  readonly readings: FanPresetsReadings
  /** Runs one device cap call; throws when it fails. */
  invoke(call: CapCall): Promise<void>
  readonly logger: IScopedLogger
  readonly now?: () => number
  /** The device template renderer (D1021); a templated step fails where there is none. */
  readonly templates?: DeviceTemplateDoor
  readonly conditions?: StepConditionDoor
}

type SetResult = Awaited<ReturnType<IFanPresetsProvider['setPresets']>>
type ApplyResult = Awaited<ReturnType<IFanPresetsProvider['applyPreset']>>
type CaptureResult = Awaited<ReturnType<IFanPresetsProvider['capturePreset']>>
type CaptureInput = Parameters<IFanPresetsProvider['capturePreset']>[0]

/** A step's refusal against the sibling set; null when the step is fine. */
interface StepRefusal {
  readonly reason: 'not-sibling' | 'bad-target'
  readonly message: string
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function fanTarget(deviceId: number): NormalizedCapStep['target'] {
  return { kind: 'devices', ids: [deviceId] }
}

function fanStep(deviceId: number, method: string, args: Record<string, unknown>): ActionStep {
  return { kind: 'cap', target: fanTarget(deviceId), cap: 'fan-control', method, args }
}

/**
 * A proposed step and where it sorts. The order is the order a fan wants to be
 * driven in: the sweep limits first, so that turning oscillation on sweeps
 * inside them; then the oscillation switches; then fixed angles; then the
 * fan's own settings, speed last so the fan only spins up once it is aimed.
 */
interface Proposal {
  readonly step: ActionStep
  readonly rank: number
  readonly item: FanCaptureItem
}

const RANK_BOUND = 0
const RANK_SWITCH = 1
const RANK_OSCILLATING = 1
const RANK_ANGLE = 2
const RANK_GIVEN = 3
const FAN_FIELD_RANK: Readonly<Record<FanCaptureField, number>> = {
  oscillating: RANK_OSCILLATING,
  direction: 4,
  preset: 5,
  speed: 6,
}

/** A control that sets one end of the sweep (left/right, top/bottom), by its name. */
const ANGLE_BOUND_NAME =
  /oscillazione.*(sinistra|destra|alto|basso)|oscillation.*(left|right|top|bottom|upper|lower)/i

function orderProposals(
  proposals: readonly Proposal[],
  omitted: FanCaptureOmission[],
): CaptureResult {
  const sorted = [...proposals].sort((a, b) => a.rank - b.rank)
  const items: FanCaptureItem[] = sorted.map((p) => p.item)
  return { steps: sorted.map((p) => p.step), items, omitted }
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
    ) => {
      this.deps.logger.warn('fan presets save refused', {
        tags: { deviceId },
        meta: { reason, detail },
      })
      return { status: 'refused' as const, reason, detail }
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
    }
    const siblings = await this.siblingsOf(deviceId, facts)
    for (const preset of presets) {
      for (const [index, step] of preset.steps.entries()) {
        const refusal = this.judgeStep(step, siblings)
        if (refusal !== null) {
          return refuse(refusal.reason, `preset "${preset.name}" step ${index}: ${refusal.message}`)
        }
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
    const presets = await this.deps.store.read(deviceId)
    const preset = presets.find((p) => p.id === presetId)
    if (preset === undefined) {
      this.deps.logger.warn('fan preset apply refused — no such preset', {
        tags: { deviceId },
        meta: { presetId },
      })
      return { status: 'refused', steps: [] }
    }
    const facts = await this.deps.devices.describe(deviceId)
    const siblings = await this.siblingsOf(deviceId, facts)
    const refused = this.refusedSteps(preset, siblings)
    if (refused !== null) {
      this.deps.logger.warn('fan preset apply refused — a step left the fan container', {
        tags: { deviceId },
        meta: { presetId, name: preset.name },
      })
      return { status: 'refused', steps: refused }
    }
    const runnable = buildActionSteps(
      preset.steps,
      {},
      {
        invokeCap: (call) => this.deps.invoke(call),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        resolveTarget: async (target) => ({
          deviceIds: target.kind === 'devices' ? target.ids : [],
        }),
        owner: `fan-preset:${deviceId}/${presetId}`,
        // Bound to the fan itself: the scope gate proved that device, nothing else.
        renderTemplates: stepRenderer(this.deps.templates, [deviceId]),
        ...conditionDeps(stepConditionEvaluator(this.deps.conditions, [deviceId])),
        onMissingVar: () => undefined,
      },
    )
    const result = await runSteps(runnable, {
      pathPrefix: 'steps',
      isAborted: () => false,
      abortReason: 'the run was stopped',
      now: this.deps.now ?? Date.now,
      onFailure: (failure) => {
        this.deps.logger.warn('fan preset step failed — stopping the sequence', {
          tags: { deviceId: failure.deviceId ?? deviceId },
          meta: { fanDeviceId: deviceId, presetId, step: failure.index, error: failure.message },
        })
      },
      onGuardUnknown: (skipped) => {
        this.deps.logger.warn('fan preset step skipped — its condition could not be read', {
          tags: { deviceId: skipped.deviceId ?? deviceId },
          meta: { fanDeviceId: deviceId, presetId, step: skipped.index, reason: skipped.reason },
        })
      },
    })
    const steps: FanPresetStepResult[] = result.steps.map((trace, index) => ({
      index,
      outcome:
        trace.outcome === 'ok' ? 'applied' : trace.outcome === 'not-run' ? 'not-run' : 'failed',
      ...(trace.deviceId === undefined ? {} : { deviceId: trace.deviceId }),
      ...(trace.cap === undefined ? {} : { cap: trace.cap }),
      ...(trace.method === undefined ? {} : { method: trace.method }),
      ...(trace.message === undefined ? {} : { message: trace.message }),
    }))
    const failed = steps.some((s) => s.outcome === 'failed')
    const appliedCap = result.steps.some((t) => t.kind === 'cap' && t.outcome === 'ok')
    const status: ApplyResult['status'] = !failed ? 'applied' : appliedCap ? 'partial' : 'refused'
    this.deps.logger.info('fan preset applied', {
      tags: { deviceId },
      meta: { presetId, status, steps: steps.length },
    })
    return { status, steps }
  }

  async capturePreset(input: CaptureInput): Promise<CaptureResult> {
    const { deviceId } = input
    const fields: readonly FanCaptureField[] = input.fields ?? FAN_CAPTURE_FIELDS
    const omitted: FanCaptureOmission[] = []
    const omit = (what: string, reason: string): void => {
      omitted.push({ what, reason })
      this.deps.logger.info('fan preset capture left a value out', {
        tags: { deviceId },
        meta: { what, reason },
      })
    }

    const fanSteps = await this.captureFanFields(deviceId, fields, omit)
    const proposals =
      input.steps.length === 0
        ? await this.captureSiblings(deviceId, omit)
        : await this.captureGiven(deviceId, input.steps, omit)
    return orderProposals([...proposals, ...fanSteps], omitted)
  }

  private async captureFanFields(
    deviceId: number,
    fields: readonly FanCaptureField[],
    omit: (what: string, reason: string) => void,
  ): Promise<Proposal[]> {
    const out: Proposal[] = []
    const fan = await this.deps.readings.fan(deviceId)
    for (const field of FAN_CAPTURE_FIELDS) {
      if (!fields.includes(field)) continue
      if (fan === null) {
        omit(field, 'the fan reports no current state')
        continue
      }
      const captured = this.fanFieldStep(deviceId, field, fan)
      if (captured === null) omit(field, `${field} is unknown on this fan`)
      else
        out.push({
          step: captured,
          rank: FAN_FIELD_RANK[field],
          item: { group: field === 'oscillating' ? 'oscillation' : 'fan', label: field },
        })
    }
    return out
  }

  /** The steps the caller composed, each refreshed with its current value. */
  private async captureGiven(
    deviceId: number,
    steps: readonly ActionStep[],
    omit: (what: string, reason: string) => void,
  ): Promise<Proposal[]> {
    const out: Proposal[] = []
    for (const [index, step] of steps.entries()) {
      if (step.kind === 'wait') {
        out.push({ step, rank: RANK_GIVEN, item: { group: 'fan', label: 'wait' } })
        continue
      }
      const target = normalizeCapStep(step).target
      if (target.kind !== 'devices' || target.ids.length !== 1) {
        omit(`step ${index}`, 'its target is not one device, so there is no value to read')
        continue
      }
      const [targetId] = target.ids
      if (targetId === undefined || targetId === deviceId) continue
      const captured = await this.siblingStep(step, targetId)
      if (captured.step === null) omit(`step ${index}`, captured.reason)
      else
        out.push({
          step: captured.step,
          rank: RANK_GIVEN,
          item: { group: step.cap === 'switch' ? 'oscillation' : 'angles', label: `step ${index}` },
        })
    }
    return out
  }

  /** Every switch and control in the fan's container, read as they are now. */
  private async captureSiblings(
    deviceId: number,
    omit: (what: string, reason: string) => void,
  ): Promise<Proposal[]> {
    const out: Proposal[] = []
    const facts = await this.deps.devices.describe(deviceId)
    const siblings = await this.siblingsOf(deviceId, facts)
    for (const id of siblings) {
      if (id === deviceId) continue
      const sibling = await this.deps.devices.describe(id)
      if (sibling === null) continue
      if (sibling.type === DeviceType.Switch) {
        const status = await this.deps.readings.switchState(id)
        if (status === null) {
          omit(sibling.name, `switch ${id} reports no state`)
          continue
        }
        out.push({
          step: {
            kind: 'cap',
            target: fanTarget(id),
            cap: 'switch',
            method: 'setState',
            args: { on: status.on },
          },
          rank: RANK_SWITCH,
          item: { group: 'oscillation', label: sibling.name },
        })
      } else if (sibling.type === DeviceType.Control) {
        const status = await this.deps.readings.control(id)
        if (status === null) {
          omit(sibling.name, `control ${id} reports no value`)
          continue
        }
        out.push({
          step: {
            kind: 'cap',
            target: fanTarget(id),
            cap: 'control',
            method: 'setValue',
            args: { control: { kind: status.kind, value: status.value } },
          },
          rank: ANGLE_BOUND_NAME.test(sibling.name) ? RANK_BOUND : RANK_ANGLE,
          item: { group: 'angles', label: sibling.name },
        })
      }
    }
    return out
  }

  // ── internals ───────────────────────────────────────────────────────────

  private fanFieldStep(
    deviceId: number,
    field: FanCaptureField,
    fan: FanControlStatus,
  ): ActionStep | null {
    switch (field) {
      case 'speed':
        return fan.speed === null ? null : fanStep(deviceId, 'setPercentage', { speed: fan.speed })
      case 'oscillating':
        return fan.oscillating === null
          ? null
          : fanStep(deviceId, 'setOscillating', { oscillating: fan.oscillating })
      case 'direction':
        return fan.direction === null
          ? null
          : fanStep(deviceId, 'setDirection', { direction: fan.direction })
      case 'preset':
        return fan.preset === '' ? null : fanStep(deviceId, 'setPreset', { preset: fan.preset })
    }
  }

  private async siblingStep(
    step: Extract<ActionStep, { kind: 'cap' }>,
    targetId: number,
  ): Promise<{ step: ActionStep; reason?: undefined } | { step: null; reason: string }> {
    if (step.cap === 'control' && step.method === 'setValue') {
      const status = await this.deps.readings.control(targetId)
      if (status === null) return { step: null, reason: `control ${targetId} reports no value` }
      return {
        step: {
          ...step,
          args: { ...step.args, control: { kind: status.kind, value: status.value } },
        },
      }
    }
    if (step.cap === 'switch' && step.method === 'setState') {
      const status = await this.deps.readings.switchState(targetId)
      if (status === null) return { step: null, reason: `switch ${targetId} reports no state` }
      return { step: { ...step, args: { ...step.args, on: status.on } } }
    }
    return { step: null, reason: `${step.cap}.${step.method} has no current value to read` }
  }

  /** The fan and every device in its container. */
  private async siblingsOf(
    deviceId: number,
    facts: FanPresetDeviceFacts | null,
  ): Promise<ReadonlySet<number>> {
    const parent = facts?.parentDeviceId ?? null
    const children = await this.deps.devices.childrenOf(parent ?? deviceId)
    return new Set([deviceId, ...children])
  }

  private judgeStep(step: ActionStep, siblings: ReadonlySet<number>): StepRefusal | null {
    if (step.kind === 'wait') return null
    const target = normalizeCapStep(step).target
    if (target.kind !== 'devices') {
      return {
        reason: 'bad-target',
        message: 'a preset step names devices, not a domain or variable',
      }
    }
    const outside = target.ids.filter((id) => !siblings.has(id))
    if (outside.length > 0) {
      return {
        reason: 'not-sibling',
        message: `[not-sibling] device ${outside.join(', ')} is not in the fan's container`,
      }
    }
    return null
  }

  /** Every step reported, the offending ones `refused`, nothing run; null when all pass. */
  private refusedSteps(
    preset: FanPreset,
    siblings: ReadonlySet<number>,
  ): FanPresetStepResult[] | null {
    const verdicts = preset.steps.map((step) => this.judgeStep(step, siblings))
    if (verdicts.every((v) => v === null)) return null
    return preset.steps.map((step, index): FanPresetStepResult => {
      const verdict = verdicts[index] ?? null
      const where = step.kind === 'cap' ? { cap: step.cap, method: step.method } : {}
      return verdict === null
        ? { index, outcome: 'not-run', ...where, message: 'an earlier step was refused' }
        : {
            index,
            outcome: 'refused',
            ...where,
            message: verdict.message.startsWith('[')
              ? verdict.message
              : `[${verdict.reason}] ${verdict.message}`,
          }
    })
  }
}
