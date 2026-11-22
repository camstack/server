/**
 * "Triggered by" on a device's Customize tab: the `builtin:linked-trigger`
 * automations that command this device, read as one row per SOURCE device.
 *
 * One automation per source device is what the tab writes, so a row is edited
 * and removed on its own. An automation written elsewhere may name several
 * source devices: it reads as several rows sharing one action, and removing a
 * row removes that device from it.
 */
import {
  findVocabAction,
  LINKED_TRIGGER_ACTIONS,
  type LinkedTriggerAction,
  type LinkedTriggerParams,
  type LinkedTriggerSource,
  linkedTriggerParamsOf,
  type TemplateInstance,
} from '@camstack/types'

/** What a row fires on. Empty `events` / `parts` mean any. */
export type TriggerFilter =
  | {
      readonly kind: 'fired'
      readonly events: readonly string[]
      readonly parts: readonly string[]
    }
  | { readonly kind: 'category'; readonly categories: readonly string[] }
  /** Narrowed in a way one event-and-part pick cannot say; shown, never rewritten from here. */
  | { readonly kind: 'custom' }

export interface TriggerRow {
  readonly key: string
  readonly blockId: string
  /** The device whose event commands this one. */
  readonly deviceId: number
  readonly action: LinkedTriggerAction
  readonly capability: string
  readonly enabled: boolean
  /** The last re-expansion refused the stored values. */
  readonly flagged: boolean
  readonly filter: TriggerFilter
}

export interface UnreadableTrigger {
  readonly blockId: string
  readonly name: string
}

export interface TriggerRowsRead {
  readonly rows: readonly TriggerRow[]
  readonly unreadable: readonly UnreadableTrigger[]
}

export interface FiredPick {
  readonly events: readonly string[]
  readonly parts: readonly string[]
}

export type RowRemoval =
  | { readonly kind: 'delete' }
  | { readonly kind: 'update'; readonly params: LinkedTriggerParams }

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v))
}

function union(lists: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(lists.flat())]
}

function filterOf(sources: readonly LinkedTriggerSource[]): TriggerFilter {
  const categories = sources.flatMap((s) => (s.kind === 'device-event' ? [s.category] : []))
  if (categories.length === sources.length) return { kind: 'category', categories }
  const fired = sources.flatMap((s) => (s.kind === 'device-fired' ? [s] : []))
  if (fired.length !== sources.length) return { kind: 'custom' }
  if (fired.some((s) => s.kinds !== undefined || s.match !== undefined)) return { kind: 'custom' }
  const events = fired.map((s) => s.eventIds ?? [])
  const parts = fired.map((s) => s.sourceIds ?? [])
  const first = { events: events[0] ?? [], parts: parts[0] ?? [] }
  const anyOf = (lists: readonly (readonly string[])[]): readonly string[] =>
    lists.some((l) => l.length === 0) ? [] : union(lists)
  if (events.every((e) => sameSet(e, first.events))) {
    return { kind: 'fired', events: first.events, parts: anyOf(parts) }
  }
  if (parts.every((p) => sameSet(p, first.parts))) {
    return { kind: 'fired', events: anyOf(events), parts: first.parts }
  }
  return { kind: 'custom' }
}

export function triggerRows(instances: readonly TemplateInstance[]): TriggerRowsRead {
  const rows: TriggerRow[] = []
  const unreadable: UnreadableTrigger[] = []
  for (const instance of instances) {
    const params = linkedTriggerParamsOf(instance.values)
    if (params === null) {
      unreadable.push({ blockId: instance.blockId, name: instance.name })
      continue
    }
    const deviceIds = [...new Set(params.sources.map((s) => s.deviceId))]
    for (const deviceId of deviceIds) {
      rows.push({
        key: `${instance.blockId}:${String(deviceId)}`,
        blockId: instance.blockId,
        deviceId,
        action: params.action,
        capability: params.capability,
        enabled: instance.enabled,
        flagged: instance.problems !== undefined && instance.problems.length > 0,
        filter: filterOf(params.sources.filter((s) => s.deviceId === deviceId)),
      })
    }
  }
  return { rows, unreadable }
}

/** The instance with another action; null when its values cannot be read. */
export function withRowAction(
  instance: TemplateInstance,
  action: LinkedTriggerAction,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  return params === null ? null : { ...params, action }
}

/** The instance with one device's sources replaced by a single event-and-part pick. */
export function withRowFilter(
  instance: TemplateInstance,
  deviceId: number,
  pick: FiredPick,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  const source: LinkedTriggerSource = {
    kind: 'device-fired',
    deviceId,
    ...(pick.parts.length === 0 ? {} : { sourceIds: [...pick.parts] }),
    ...(pick.events.length === 0 ? {} : { eventIds: [...pick.events] }),
  }
  const at = params.sources.findIndex((s) => s.deviceId === deviceId)
  const others = params.sources.filter((s) => s.deviceId !== deviceId)
  const sources =
    at < 0 ? [...others, source] : [...others.slice(0, at), source, ...others.slice(at)]
  return { ...params, sources }
}

/** Removing a row: the instance without that device, or its deletion when nothing is left. */
export function withoutRow(instance: TemplateInstance, deviceId: number): RowRemoval {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return { kind: 'delete' }
  const sources = params.sources.filter((s) => s.deviceId !== deviceId)
  return sources.length === 0
    ? { kind: 'delete' }
    : { kind: 'update', params: { ...params, sources } }
}

/** The actions the capability's vocabulary declares, in the template's order. */
export function offeredActions(capability: string): readonly LinkedTriggerAction[] {
  return LINKED_TRIGGER_ACTIONS.filter(
    (action) => findVocabAction(`${capability}.${action}`) !== undefined,
  )
}

/** Capabilities a linked trigger can command, most specific first. */
const COMMAND_CAPS: readonly string[] = ['switch']

export const LINKED_TRIGGER_COMMAND_CAPS = COMMAND_CAPS

/** The capability a trigger commands on a device carrying `caps`; null when none can be. */
export function commandCapOf(caps: readonly string[]): string | null {
  return COMMAND_CAPS.find((cap) => caps.includes(cap)) ?? null
}

/** A new row: any event of the picked device; toggle when the capability can, else its first action. */
export function newTriggerParams(
  targetDeviceId: number,
  sourceDeviceId: number,
  capability: string,
): LinkedTriggerParams | null {
  const offered = offeredActions(capability)
  const action = offered.includes('toggle') ? 'toggle' : offered[0]
  if (action === undefined) return null
  return {
    targetDeviceId,
    action,
    capability,
    sources: [{ kind: 'device-fired', deviceId: sourceDeviceId }],
  }
}

/** The chips of one axis: what the device declares, then stored ids it no longer declares. */
export function chipIds(declared: readonly string[], stored: readonly string[]): readonly string[] {
  return [...declared, ...stored.filter((id) => !declared.includes(id))]
}

/** The chips that are off for a stored pick; an empty pick is "any", every chip on. */
export function chipsOff(ids: readonly string[], picked: readonly string[]): ReadonlySet<string> {
  return new Set(picked.length === 0 ? [] : ids.filter((id) => !picked.includes(id)))
}

/** The pick the chips say: every chip on is "any" (empty); every chip off is no pick at all (null). */
export function pickedOf(
  ids: readonly string[],
  off: ReadonlySet<string>,
): readonly string[] | null {
  const on = ids.filter((id) => !off.has(id))
  if (on.length === 0) return null
  return on.length === ids.length ? [] : on
}

export interface FilterSummary {
  /** Event tokens, or categories; empty = any event. */
  readonly events: readonly string[]
  /** Parts of the device; empty = any part. */
  readonly parts: readonly string[]
  readonly custom: boolean
}

export function filterSummary(filter: TriggerFilter): FilterSummary {
  if (filter.kind === 'custom') return { events: [], parts: [], custom: true }
  if (filter.kind === 'category') return { events: filter.categories, parts: [], custom: false }
  return { events: filter.events, parts: filter.parts, custom: false }
}
