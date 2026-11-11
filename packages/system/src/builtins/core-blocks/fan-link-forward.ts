/**
 * A write to a fan-control field the operator linked in Customize goes to the
 * linked device (D1034): `setOscillationAxis` and `setPreset` on a fan whose
 * stored composition claims the field are answered by the link — a switch's
 * `setState`, a control's `setValue` — at DISPATCH, through the device-call
 * redirect (D963), so every caller gets the same answer.
 *
 * The links are read from the STORED composition on each call, never kept as
 * a second copy (D676). A field nobody linked is the native provider's: when
 * no requested field is linked the call is not redirected. Writes run in the
 * order of the call and stop at the first refusal, which names the field and
 * lists what already landed. An angle is checked against the linked control's
 * own range, a preset against the linked select's live `options`.
 */
import {
  type CompositionFieldRead,
  type CompositionSourceRef,
  type ControlSetValueInput,
  type CoreBlock,
  coreBlockComposition,
  compositionFeatureEnabled,
  type DeviceCall,
  type DeviceCallAnswer,
  type DeviceCallRedirect,
  FAN_OSCILLATION_AXIS_SETTABLE,
  type FanOscillationAxisField,
  type FanOscillationAxisRefusal,
  type FanOscillationAxisResult,
  fanAxisPath,
  type IScopedLogger,
  SetOscillationAxisInputSchema,
  type SetOscillationAxisInput,
} from '@camstack/types'
import { z } from 'zod'

const FAN_CONTROL = 'fan-control'
const NOT_REDIRECTED: DeviceCallAnswer = { kind: 'not-redirected' }

/** The live facts of a linked control a write is checked against. */
export interface LinkedControlReading {
  readonly kind: string
  readonly options: readonly string[]
  readonly min?: number
  readonly max?: number
}

export interface FanLinkForwardPorts {
  /** The stored core blocks (Customize compositions among them). */
  readonly blocks: () => readonly Pick<CoreBlock, 'source'>[]
  /** The device id of a ref; null = it does not exist. Throws when the index did not answer. */
  readonly find: (ref: CompositionSourceRef) => Promise<{ id: number; name: string } | null>
  /** The linked control's live slice; null when it holds none. Throws when it cannot be read. */
  readonly readControl: (deviceId: number) => Promise<LinkedControlReading | null>
  readonly setSwitch: (deviceId: number, on: boolean) => Promise<void>
  readonly setControl: (deviceId: number, control: ControlSetValueInput) => Promise<void>
  readonly logger: IScopedLogger
}

/** A preset write the linked select refused; the message names the select and the reason. */
export class FanPresetRefusedError extends Error {
  constructor(
    readonly reason: FanOscillationAxisRefusal,
    detail: string,
  ) {
    super(`fan preset refused (${reason}): ${detail}`)
    this.name = 'FanPresetRefusedError'
  }
}

const SetPresetArgsSchema = z.object({ deviceId: z.number(), preset: z.string().min(1) })

type FanLinks = ReadonlyMap<string, CompositionFieldRead>

/** Every fan-control field of a stored composition that reads ONE source field directly. */
function linksOfBlock(block: Pick<CoreBlock, 'source'>): {
  readonly fan: CompositionSourceRef
  readonly links: FanLinks
} | null {
  const composition = coreBlockComposition(block)
  if (composition === null || composition.target.kind !== 'existing') return null
  const links = new Map<string, CompositionFieldRead>()
  for (const feature of composition.features) {
    if (!compositionFeatureEnabled(feature) || feature.kind !== 'fields') continue
    if (feature.cap !== FAN_CONTROL) continue
    for (const [path, source] of Object.entries(feature.fields)) {
      if (source.kind !== 'from') continue
      links.set(path, { source: source.source, cap: source.cap, fieldPath: source.fieldPath })
    }
  }
  return links.size === 0 ? null : { fan: composition.target.device, links }
}

async function linksOf(ports: FanLinkForwardPorts, deviceId: number): Promise<FanLinks> {
  for (const block of ports.blocks()) {
    const found = linksOfBlock(block)
    if (found === null) continue
    const fan = await ports.find(found.fan).catch(() => null)
    if (fan?.id === deviceId) return found.links
  }
  return new Map()
}

function describe(read: CompositionFieldRead): string {
  return `${read.source.addonId}/${read.source.stableId} ${read.cap}.${read.fieldPath}`
}

type Resolved =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly reason: FanOscillationAxisRefusal; readonly detail: string }

async function resolveSource(
  ports: FanLinkForwardPorts,
  read: CompositionFieldRead,
): Promise<Resolved> {
  try {
    const found = await ports.find(read.source)
    if (found === null) {
      return { ok: false, reason: 'source-gone', detail: `${describe(read)} no longer exists` }
    }
    return { ok: true, id: found.id }
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'source-unknown', detail: `${describe(read)}: ${why}` }
  }
}

interface AxisStep {
  readonly field: FanOscillationAxisField
  readonly value: boolean | number
}

function requestedSteps(input: SetOscillationAxisInput): readonly AxisStep[] {
  return FAN_OSCILLATION_AXIS_SETTABLE.flatMap((field): readonly AxisStep[] => {
    const value = input[field]
    return value === undefined ? [] : [{ field, value }]
  })
}

type StepOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FanOscillationAxisRefusal; readonly detail: string }

async function writeStep(
  ports: FanLinkForwardPorts,
  read: CompositionFieldRead,
  step: AxisStep,
): Promise<StepOutcome> {
  const isSwitch = read.cap === 'switch' && read.fieldPath === 'on'
  const isControl = read.cap === 'control' && read.fieldPath === 'value'
  if (isSwitch !== (typeof step.value === 'boolean') || (!isSwitch && !isControl)) {
    return {
      ok: false,
      reason: 'axis-not-linked',
      detail: `${step.field} is linked to ${describe(read)}, which takes no ${typeof step.value} command`,
    }
  }
  const source = await resolveSource(ports, read)
  if (!source.ok) return source
  try {
    if (typeof step.value === 'boolean') {
      await ports.setSwitch(source.id, step.value)
      return { ok: true }
    }
    const control = await ports.readControl(source.id)
    const below = control?.min !== undefined && step.value < control.min
    const above = control?.max !== undefined && step.value > control.max
    if (below || above) {
      return {
        ok: false,
        reason: 'out-of-range',
        detail: `${step.field} ${step.value} is outside ${control?.min}…${control?.max} of ${describe(read)}`,
      }
    }
    await ports.setControl(source.id, { kind: 'numeric', value: step.value })
    return { ok: true }
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'source-call-failed', detail: `${describe(read)}: ${why}` }
  }
}

async function setOscillationAxis(
  ports: FanLinkForwardPorts,
  call: DeviceCall,
): Promise<DeviceCallAnswer> {
  const parsed = SetOscillationAxisInputSchema.safeParse(call.args)
  if (!parsed.success) return NOT_REDIRECTED
  const steps = requestedSteps(parsed.data)
  const links = await linksOf(ports, call.deviceId)
  const linked = (step: AxisStep): CompositionFieldRead | undefined =>
    links.get(fanAxisPath(parsed.data.axis, step.field))
  // Nothing requested is linked: the native provider's call, untouched.
  if (steps.length > 0 && steps.every((s) => linked(s) === undefined)) return NOT_REDIRECTED
  const refuse = (
    reason: FanOscillationAxisRefusal,
    detail: string,
    applied: readonly FanOscillationAxisField[],
    field?: FanOscillationAxisField,
  ): DeviceCallAnswer => {
    ports.logger.warn('fan: an oscillation axis write was refused', {
      tags: { deviceId: call.deviceId },
      meta: { axis: parsed.data.axis, reason, field, detail, applied },
    })
    const result: FanOscillationAxisResult = {
      status: 'refused',
      reason,
      detail,
      applied: [...applied],
      ...(field === undefined ? {} : { field }),
    }
    return { kind: 'redirected', result }
  }
  if (steps.length === 0) return refuse('nothing-to-set', 'no axis field was given', [])
  const applied: FanOscillationAxisField[] = []
  for (const step of steps) {
    const read = linked(step)
    if (read === undefined) {
      const detail = `${parsed.data.axis} ${step.field} is not linked in Customize, and a call is never split between a link and the native provider`
      return refuse('axis-not-linked', detail, applied, step.field)
    }
    const outcome = await writeStep(ports, read, step)
    if (!outcome.ok) return refuse(outcome.reason, outcome.detail, applied, step.field)
    applied.push(step.field)
  }
  const result: FanOscillationAxisResult = { status: 'applied' }
  return { kind: 'redirected', result }
}

async function setPreset(ports: FanLinkForwardPorts, call: DeviceCall): Promise<DeviceCallAnswer> {
  const parsed = SetPresetArgsSchema.safeParse(call.args)
  if (!parsed.success) return NOT_REDIRECTED
  const read = (await linksOf(ports, call.deviceId)).get('preset')
  if (read === undefined) return NOT_REDIRECTED
  const refuse = (reason: FanOscillationAxisRefusal, detail: string): never => {
    ports.logger.warn('fan: a preset write was refused', {
      tags: { deviceId: call.deviceId },
      meta: { reason, detail, preset: parsed.data.preset },
    })
    throw new FanPresetRefusedError(reason, detail)
  }
  if (read.cap !== 'control' || read.fieldPath !== 'value') {
    return refuse(
      'axis-not-linked',
      `preset is linked to ${describe(read)}, which takes no command`,
    )
  }
  const source = await resolveSource(ports, read)
  if (!source.ok) return refuse(source.reason, source.detail)
  let control: LinkedControlReading | null
  try {
    control = await ports.readControl(source.id)
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err)
    return refuse('source-unknown', `${describe(read)}: ${why}`)
  }
  if (
    control === null ||
    control.kind !== 'select' ||
    !control.options.includes(parsed.data.preset)
  ) {
    const offered = control === null ? 'none read' : control.options.join(', ')
    return refuse(
      'out-of-range',
      `"${parsed.data.preset}" is not an option of ${describe(read)} (${offered})`,
    )
  }
  try {
    await ports.setControl(source.id, { kind: 'select', value: parsed.data.preset })
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err)
    return refuse('source-call-failed', `${describe(read)}: ${why}`)
  }
  return { kind: 'redirected', result: undefined }
}

export function fanLinkForwardRedirect(ports: FanLinkForwardPorts): DeviceCallRedirect {
  return {
    covers: (capName, method) =>
      capName === FAN_CONTROL && (method === 'setOscillationAxis' || method === 'setPreset'),
    attempt: async (call) => {
      if (call.method === 'setOscillationAxis') return setOscillationAxis(ports, call)
      if (call.method === 'setPreset') return setPreset(ports, call)
      return NOT_REDIRECTED
    },
  }
}
