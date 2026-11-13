/**
 * "Mark as input" (#527): the pure model behind the automation template editor.
 *
 * The body of a template is JSON that is not a recipe yet. {@link bindableFields}
 * walks it and offers the places an input can be written into, by SHAPE — a
 * `deviceId` is a device, a command step's `target` is a set of devices, a
 * `device-fired` row is an event, a command step is an action, a `seconds` or
 * another number is a duration or a number. Picking one adds an input and the
 * `value` binding that writes it back; removing an input drops its bindings.
 * Nothing here knows the editor: it takes a payload and returns a payload.
 */
import type {
  AutomationTemplatePayload,
  TemplateBinding,
  TemplateInput,
  TemplatePath,
} from '@camstack/types'
import { TEMPLATE_INPUT_KEY_RE } from '@camstack/types'

export type BindableKind = 'device' | 'event' | 'action' | 'duration' | 'number'

export interface BindableField {
  /** The path joined, stable across renders. */
  readonly id: string
  readonly path: TemplatePath
  readonly kind: BindableKind
  /** A device written as a step target (`{ kind: 'devices', ids }`). */
  readonly as?: 'target'
  readonly multiple?: true
  /** The step or row the field sits in, as a short phrase key. */
  readonly where: string
  readonly suggestedKey: string
  readonly suggestedLabel: string
  /** The body's current value, when it is a number — becomes the input's default. */
  readonly current?: number
}

/** Leaf kinds of the WHEN tree that carry a `deviceId`. */
const DEVICE_LEAF_KINDS: readonly string[] = [
  'device-becomes',
  'device-event',
  'device-fired',
  'device-is',
  'stationary-present',
]

/** Numbers that are structure, not something to ask for. */
const STRUCTURAL_NUMBER_KEYS: readonly string[] = ['version', 'deviceId']

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function kindOf(node: Readonly<Record<string, unknown>>): string | undefined {
  const kind = node['kind']
  return typeof kind === 'string' ? kind : undefined
}

function samePath(a: TemplatePath, b: TemplatePath): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index])
}

function pathId(path: TemplatePath): string {
  return path.map(String).join('.')
}

/** A writable key from a free sentence: `camelCase`, a letter first. */
export function keyFromLabel(label: string): string {
  const words = label
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
  const joined = words
    .map(
      (w, index) =>
        (index === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1),
    )
    .join('')
  const key = /^[A-Za-z]/.test(joined) ? joined : `input${joined}`
  return key.slice(0, 40)
}

export function isValidInputKey(key: string): boolean {
  return TEMPLATE_INPUT_KEY_RE.test(key)
}

/** `base`, or `base2`, `base3`… — the first one no input uses. */
export function uniqueInputKey(inputs: readonly TemplateInput[], base: string): string {
  const safe = isValidInputKey(base) ? base : keyFromLabel(base)
  const taken = new Set(inputs.map((i) => i.key))
  if (!taken.has(safe)) return safe
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${safe.slice(0, 37)}${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
  return safe
}

interface Candidate {
  readonly path: TemplatePath
  readonly kind: BindableKind
  readonly where: string
  readonly as?: 'target'
  readonly multiple?: true
  readonly current?: number
  readonly keyHint: string
  readonly labelHint: string
}

function walk(node: unknown, path: TemplatePath, out: Candidate[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, [...path, index], out))
    return
  }
  if (!isRecord(node)) return
  const kind = kindOf(node)
  if (kind !== undefined && DEVICE_LEAF_KINDS.includes(kind)) {
    out.push({
      path: [...path, 'deviceId'],
      kind: 'device',
      where: kind,
      keyHint: 'device',
      labelHint: 'Device',
    })
  }
  if (kind === 'device-fired') {
    out.push({
      path,
      kind: 'event',
      where: kind,
      keyHint: 'event',
      labelHint: 'Event',
    })
  }
  if (kind === 'command') {
    out.push({
      path: [...path, 'target'],
      kind: 'device',
      as: 'target',
      multiple: true,
      where: kind,
      keyHint: 'targets',
      labelHint: 'Devices',
    })
    out.push({
      path,
      kind: 'action',
      where: kind,
      keyHint: 'action',
      labelHint: 'Action',
    })
  }
  for (const [key, child] of Object.entries(node)) {
    if (
      typeof child === 'number' &&
      Number.isFinite(child) &&
      !STRUCTURAL_NUMBER_KEYS.includes(key)
    ) {
      out.push({
        path: [...path, key],
        kind: key === 'seconds' ? 'duration' : 'number',
        where: kind ?? key,
        current: child,
        keyHint: key,
        labelHint: key === 'seconds' ? 'Seconds' : key,
      })
      continue
    }
    walk(child, [...path, key], out)
  }
}

/**
 * Everything in the body an input could be written into, minus the places a
 * `value` binding already writes.
 */
export function bindableFields(
  body: unknown,
  bindings: readonly TemplateBinding[],
): readonly BindableField[] {
  const found: Candidate[] = []
  walk(body, [], found)
  const valueBindingPaths = bindings.flatMap((b) => (b.kind === 'value' ? [b.path] : []))
  return found
    .filter((c) => !valueBindingPaths.some((p) => samePath(p, c.path)))
    .map((c): BindableField => {
      const field: BindableField = {
        id: `${pathId(c.path)}:${c.kind}`,
        path: c.path,
        kind: c.kind,
        where: c.where,
        suggestedKey: c.keyHint,
        suggestedLabel: c.labelHint,
        ...(c.as === undefined ? {} : { as: c.as }),
        ...(c.multiple === undefined ? {} : { multiple: c.multiple }),
        ...(c.current === undefined ? {} : { current: c.current }),
      }
      return field
    })
}

/** What the operator names when marking a field. */
export interface MarkDraft {
  readonly key: string
  readonly label: string
  readonly optional: boolean
  /** An event or action input reads the device input of this key. */
  readonly deviceInput?: string
}

function inputFor(field: BindableField, draft: MarkDraft): TemplateInput {
  const base = {
    key: draft.key,
    label: draft.label,
    ...(draft.optional ? { optional: true as const } : {}),
  }
  switch (field.kind) {
    case 'device':
      return { kind: 'device', ...base, ...(field.multiple === true ? { multiple: true } : {}) }
    case 'event':
      return { kind: 'event', ...base, deviceInput: draft.deviceInput ?? '' }
    case 'action':
      return {
        kind: 'action',
        ...base,
        ...(draft.deviceInput === undefined || draft.deviceInput === ''
          ? {}
          : { deviceInput: draft.deviceInput }),
      }
    case 'duration':
      return {
        kind: 'duration',
        ...base,
        ...(field.current === undefined ? {} : { default: Math.max(0, field.current) }),
      }
    case 'number':
      return {
        kind: 'number',
        ...base,
        ...(field.current === undefined ? {} : { default: field.current }),
      }
  }
}

/** Why the draft cannot be applied to the field, or null. */
export function markProblem(
  payload: AutomationTemplatePayload,
  field: BindableField,
  draft: MarkDraft,
): string | null {
  if (!isValidInputKey(draft.key)) return 'key'
  if (payload.inputs.some((i) => i.key === draft.key)) return 'key-taken'
  if (draft.label.trim() === '') return 'label'
  if (field.kind === 'event') {
    const device = payload.inputs.find((i) => i.key === draft.deviceInput)
    if (device === undefined || device.kind !== 'device') return 'device-input'
  }
  return null
}

/** The payload with `field` turned into an input and its `value` binding. */
export function markAsInput(
  payload: AutomationTemplatePayload,
  field: BindableField,
  draft: MarkDraft,
): AutomationTemplatePayload {
  const binding: TemplateBinding = {
    kind: 'value',
    input: draft.key,
    path: [...field.path],
    ...(field.as === undefined ? {} : { as: field.as }),
  }
  return {
    ...payload,
    inputs: [...payload.inputs, inputFor(field, { ...draft, label: draft.label.trim() })],
    bindings: [...payload.bindings, binding],
  }
}

/** The input and every binding that writes it — rows bindings of a group included. */
export function removeInput(
  payload: AutomationTemplatePayload,
  key: string,
): AutomationTemplatePayload {
  return {
    ...payload,
    inputs: payload.inputs.filter((i) => i.key !== key),
    bindings: payload.bindings.filter((b) => b.input !== key),
  }
}

/** One top-level input replaced by an edited copy of itself. */
export function replaceInput(
  payload: AutomationTemplatePayload,
  key: string,
  next: TemplateInput,
): AutomationTemplatePayload {
  return { ...payload, inputs: payload.inputs.map((i) => (i.key === key ? next : i)) }
}
