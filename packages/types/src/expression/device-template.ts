/**
 * Device value templates, the parts that need no template engine (D1021).
 *
 * A template is plain text with Jinja-style `{{ … }}` / `{% … %}` blocks:
 * `{{ stufa_veranda.temperature | unit('°F') | round(1) }}`. Devices are named
 * by their alias (`device-alias.ts`); a field is `alias.field` when the field
 * name is unique across the device's capabilities, else `alias.<cap>.field`,
 * and an ambiguous `alias.field` is refused by name.
 *
 * The engine itself (nunjucks) lives ONLY in the hub's renderer
 * (`packages/system/src/builtins/device-manager/device-template/`, guard
 * `check-device-template-grammar`): it does not sandbox, so it renders only in
 * a worker thread under a wall-time budget, over frozen plain data. This file
 * is the shared vocabulary — limits, refusal reasons, the trace, and how a
 * `(alias, path)` reference resolves against a device's slices.
 */
import { z } from 'zod'

export const DEVICE_TEMPLATE_MAX_LENGTH = 4096
/** Wall time a render may take, host-measured; the worker is terminated past it. */
export const DEVICE_TEMPLATE_BUDGET_MS = 50
export const DEVICE_TEMPLATE_MAX_OUTPUT = 4096
/** What an unknown or unavailable value renders as. */
export const DEVICE_TEMPLATE_UNAVAILABLE = '—'

export const DeviceTemplateSchema = z.string().min(1).max(DEVICE_TEMPLATE_MAX_LENGTH)

/** The filters a template may use. Anything else is refused at parse time. */
export const DEVICE_TEMPLATE_FILTERS = [
  'unit',
  'round',
  'default',
  'since',
  'ago',
  'format',
  'upper',
  'lower',
  'title',
  'capitalize',
  'trim',
  'abs',
  'int',
  'float',
  'length',
  'd',
  'join',
  'replace',
  'first',
  'last',
  'sort',
  'reverse',
  'sum',
  'string',
  'list',
  'truncate',
] as const
export type DeviceTemplateFilter = (typeof DEVICE_TEMPLATE_FILTERS)[number]

/** A device-state reference found in a template: the alias and the literal path after it. */
export interface DeviceTemplateRef {
  readonly alias: string
  readonly path: readonly (string | number)[]
}

export type DeviceTemplateRefusalReason =
  | 'too-long'
  | 'syntax'
  | 'forbidden-syntax'
  | 'forbidden-member'
  | 'unknown-filter'
  | 'ambiguous-field'
  | 'busy'
  | 'budget-exceeded'
  | 'timeout'
  | 'output-too-large'
  | 'render-failed'

/** A template the engine will not run, or a render that did not finish — named, never a bare string. */
export interface DeviceTemplateRefusal {
  readonly reason: DeviceTemplateRefusalReason
  readonly message: string
}

export type DeviceTemplateTraceReason =
  | 'unknown-alias'
  | 'unknown-field'
  | 'no-field'
  | 'unavailable'

/** One value that rendered as `—`, and why. */
export interface DeviceTemplateTraceEntry {
  readonly ref: string
  readonly reason: DeviceTemplateTraceReason
}

export type DeviceTemplateRender =
  | {
      readonly ok: true
      readonly text: string
      readonly trace: readonly DeviceTemplateTraceEntry[]
    }
  | {
      readonly ok: false
      readonly refusal: DeviceTemplateRefusal
      readonly trace: readonly DeviceTemplateTraceEntry[]
    }

/** What the renderer knows about one device when it resolves an alias. */
export interface DeviceTemplateView {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
  /** Capability name → its current runtime-state slice. */
  readonly slices: Readonly<Record<string, unknown>>
  /** The D944 base unit of a numeric field, when it has one (`unit()` converts from it). */
  readonly unitOf?: (cap: string, fieldPath: readonly (string | number)[]) => string | undefined
}

export type ResolvedTemplateRef =
  | {
      readonly kind: 'value'
      readonly cap: string
      readonly fieldPath: readonly (string | number)[]
      readonly value: unknown
    }
  | { readonly kind: 'ambiguous'; readonly field: string; readonly caps: readonly string[] }
  | { readonly kind: 'missing'; readonly reason: 'unknown-field' | 'no-field' }

/** A capability name as a template spells it: `temperature-sensor` → `temperature_sensor`. */
export function templateCapKey(cap: string): string {
  return cap.replace(/-/g, '_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickPath(root: unknown, path: readonly (string | number)[]): unknown {
  let cursor: unknown = root
  for (const part of path) {
    if (Array.isArray(cursor) && typeof part === 'number') {
      cursor = cursor[part]
    } else if (isRecord(cursor) && Object.hasOwn(cursor, String(part))) {
      cursor = cursor[String(part)]
    } else {
      return undefined
    }
  }
  return cursor
}

/**
 * Resolve the path after an alias. `<cap>.field…` when the first segment names
 * one of the device's caps; otherwise `field…` when exactly one cap carries a
 * field of that name; several caps carrying it is `ambiguous`, naming them.
 */
export function resolveTemplateRef(
  view: DeviceTemplateView,
  path: readonly (string | number)[],
): ResolvedTemplateRef {
  const head = path[0]
  if (head === undefined) return { kind: 'missing', reason: 'no-field' }
  const caps = Object.keys(view.slices)
  const named = caps.find((cap) => cap === head || templateCapKey(cap) === head)
  if (named !== undefined) {
    const rest = path.slice(1)
    if (rest.length === 0) return { kind: 'missing', reason: 'no-field' }
    const value = pickPath(view.slices[named], rest)
    if (value === undefined) return { kind: 'missing', reason: 'unknown-field' }
    return { kind: 'value', cap: named, fieldPath: rest, value }
  }
  const owners = caps.filter((cap) => {
    const slice = view.slices[cap]
    return isRecord(slice) && Object.hasOwn(slice, String(head))
  })
  if (owners.length === 0) return { kind: 'missing', reason: 'unknown-field' }
  const [only] = owners
  if (owners.length > 1 || only === undefined) {
    return { kind: 'ambiguous', field: String(head), caps: owners }
  }
  const value = pickPath(view.slices[only], path)
  if (value === undefined) return { kind: 'missing', reason: 'unknown-field' }
  return { kind: 'value', cap: only, fieldPath: path, value }
}
