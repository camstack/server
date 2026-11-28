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
  type DetectionSubject,
  LINKED_TRIGGER_ACTIONS,
  type LinkedTriggerAction,
  type LinkedTriggerParams,
  type LinkedTriggerSource,
  linkedTriggerParamsOf,
  linkedTriggerValues,
  onForActionOf,
  type TemplateInstance,
  type TemplateDeviceStateValue,
  type TemplateTimeWindowValue,
} from '@dominevo/types'

/** What the action column offers: the template's actions, plus "on" held for a time. */
export const ON_FOR_CHOICE = 'on-for'
export type TriggerActionChoice = LinkedTriggerAction | typeof ON_FOR_CHOICE

/** The time a new "on for" starts with. */
export const DEFAULT_ON_FOR_SECONDS = 300

/** The classes a camera source may fire on, in the order they are offered. */
export const DETECTION_CLASSES = ['person', 'vehicle', 'animal', 'package'] as const
export type DetectionClass = (typeof DETECTION_CLASSES)[number]

/** What kind of source a picked device is, from what it can report. */
export type TriggerSourceKind = 'emitter' | 'motion' | 'camera'
export const MOTION_CAP = 'motion'
const MOTION_FIELD = 'detected'

/** What a row fires on. Empty `events` / `parts` mean any. */
export type TriggerFilter =
  | {
      readonly kind: 'fired'
      readonly events: readonly string[]
      readonly parts: readonly string[]
    }
  | { readonly kind: 'category'; readonly categories: readonly string[] }
  /** A motion sensor reporting motion. */
  | { readonly kind: 'motion' }
  /** A camera detecting one of these classes. */
  | { readonly kind: 'detection'; readonly classes: readonly DetectionClass[] }
  /** Narrowed in a way one event-and-part pick cannot say; shown, never rewritten from here. */
  | { readonly kind: 'custom' }

export interface TriggerRow {
  readonly key: string
  readonly blockId: string
  /** The device whose event commands this one. */
  readonly deviceId: number
  readonly action: LinkedTriggerAction
  readonly capability: string
  /** With `on`: held on for this long, then turned off. Null: a plain action. */
  readonly onForSeconds: number | null
  /** The limit on when the trigger runs; null: always. It belongs to the whole automation. */
  readonly activeWindow: TemplateTimeWindowValue | null
  /** Only while a device reads a value (a derived night); null: no such limit. */
  readonly activeWhen: TemplateDeviceStateValue | null
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

/** The devices a source watches. */
export function sourceDeviceIds(source: LinkedTriggerSource): readonly number[] {
  return source.kind === 'detection' ? source.deviceIds : [source.deviceId]
}

function classOf(subject: DetectionSubject): DetectionClass | null {
  if ('label' in subject && subject.label !== undefined) return null
  return DETECTION_CLASSES.find((c) => c === subject.macro) ?? null
}

function stateFilterOf(sources: readonly LinkedTriggerSource[]): TriggerFilter | null {
  const [only] = sources
  if (only === undefined || sources.length !== 1) return null
  if (only.kind === 'device-becomes') {
    const motion =
      only.cap === MOTION_CAP && only.fieldPath === MOTION_FIELD && only.becomes === true
    return motion ? { kind: 'motion' } : { kind: 'custom' }
  }
  if (only.kind === 'detection') {
    const classes = only.subjects.map(classOf)
    const plain = classes.flatMap((c) => (c === null ? [] : [c]))
    return plain.length === classes.length
      ? { kind: 'detection', classes: plain }
      : { kind: 'custom' }
  }
  return null
}

function filterOf(sources: readonly LinkedTriggerSource[]): TriggerFilter {
  const state = stateFilterOf(sources)
  if (state !== null) return state
  const categories = sources.flatMap((s) => (s.kind === 'device-event' ? [s.category] : []))
  if (categories.length === sources.length) return { kind: 'category', categories }
  const fired = sources.flatMap((s) => (s.kind === 'device-fired' ? [s] : []))
  if (fired.length !== sources.length) return { kind: 'custom' }
  if (fired.some((s) => s.kinds !== undefined || s.match !== undefined)) return { kind: 'custom' }
  const events = fired.map((s) => s.eventIds ?? [])
  const parts = fired.map((s) => s.sourceIds ?? [])
  const first = { events: events[0] ?? [], parts: parts[0] ?? [] }
  if (events.every((e) => sameSet(e, first.events))) {
    return { kind: 'fired', events: first.events, parts: anyOf(parts) }
  }
  if (parts.every((p) => sameSet(p, first.parts))) {
    return { kind: 'fired', events: anyOf(events), parts: first.parts }
  }
  return { kind: 'custom' }
}

/** One unfiltered list means "any", so the union is empty; otherwise every id any list names. */
function anyOf(lists: readonly (readonly string[])[]): readonly string[] {
  return lists.some((l) => l.length === 0) ? [] : union(lists)
}

/**
 * Where the filter dialog starts for a row. A fired row starts from its own pick; a
 * narrower or foreign filter (per-part events, a payload predicate, a category) starts
 * from what its fired sources name together, or from "any" — saving replaces it with
 * the one pick the dialog can say.
 */
export function editPickOf(instance: TemplateInstance | undefined, deviceId: number): FiredPick {
  const params = instance === undefined ? null : linkedTriggerParamsOf(instance.values)
  if (params === null) return { events: [], parts: [] }
  const fired = params.sources.flatMap((s) =>
    s.kind === 'device-fired' && s.deviceId === deviceId ? [s] : [],
  )
  return {
    events: anyOf(fired.map((s) => s.eventIds ?? [])),
    parts: anyOf(fired.map((s) => s.sourceIds ?? [])),
  }
}

/** What kind of source a stored row has, read from its filter. */
export function rowSourceKindOf(filter: TriggerFilter): TriggerSourceKind {
  if (filter.kind === 'motion') return 'motion'
  return filter.kind === 'detection' ? 'camera' : 'emitter'
}

/** Whether saving the filter dialog drops something the dialog cannot show. */
export function replacesFilter(filter: TriggerFilter): boolean {
  return filter.kind === 'custom' || filter.kind === 'category'
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
    const deviceIds = [...new Set(params.sources.flatMap(sourceDeviceIds))]
    for (const deviceId of deviceIds) {
      rows.push({
        key: `${instance.blockId}:${String(deviceId)}`,
        blockId: instance.blockId,
        deviceId,
        action: params.action,
        capability: params.capability,
        onForSeconds: params.onForSeconds ?? null,
        activeWindow: params.activeWindow ?? null,
        activeWhen: params.activeWhen ?? null,
        enabled: instance.enabled,
        flagged: instance.problems !== undefined && instance.problems.length > 0,
        filter: filterOf(params.sources.filter((s) => sourceDeviceIds(s).includes(deviceId))),
      })
    }
  }
  return { rows, unreadable }
}

/** What the action column shows for a row. */
export function actionChoiceOf(
  row: Pick<TriggerRow, 'action' | 'onForSeconds'>,
): TriggerActionChoice {
  return row.action === 'on' && row.onForSeconds !== null ? ON_FOR_CHOICE : row.action
}

/** The instance with another action; null when its values cannot be read. A plain action drops the time. */
export function withRowAction(
  instance: TemplateInstance,
  choice: TriggerActionChoice,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  const { onForSeconds, ...plain } = params
  return choice === ON_FOR_CHOICE
    ? {
        ...plain,
        action: 'on',
        onForSeconds: onForSeconds ?? DEFAULT_ON_FOR_SECONDS,
      }
    : { ...plain, action: choice }
}

/** The instance held on for another time. */
export function withRowOnFor(
  instance: TemplateInstance,
  seconds: number,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  return params === null ? null : { ...params, action: 'on', onForSeconds: seconds }
}

/** The instance limited to a time window, or with the limit removed. */
export function withActiveWindow(
  instance: TemplateInstance,
  window: TemplateTimeWindowValue | null,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  const { activeWindow: _dropped, ...rest } = params
  return window === null ? rest : { ...rest, activeWindow: window }
}

/** The instance limited to while a device reads a value, or with that limit removed. */
export function withActiveWhen(
  instance: TemplateInstance,
  state: TemplateDeviceStateValue | null,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  const { activeWhen: _dropped, ...rest } = params
  return state === null ? rest : { ...rest, activeWhen: state }
}

/** The instance with both limits set at once: the time window and the device state (null drops one). */
export function withActiveLimits(
  instance: TemplateInstance,
  window: TemplateTimeWindowValue | null,
  state: TemplateDeviceStateValue | null,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  const { activeWindow: _w, activeWhen: _s, ...rest } = params
  return {
    ...rest,
    ...(window === null ? {} : { activeWindow: window }),
    ...(state === null ? {} : { activeWhen: state }),
  }
}

/** The instance with one camera's source firing on these classes. */
export function withRowClasses(
  instance: TemplateInstance,
  deviceId: number,
  classes: readonly DetectionClass[],
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null || classes.length === 0) return null
  const sources = params.sources.map(
    (source): LinkedTriggerSource =>
      source.kind === 'detection' && source.deviceIds.includes(deviceId)
        ? { ...source, subjects: classes.map((macro) => ({ macro })) }
        : source,
  )
  return { ...params, sources }
}

/** The sources without one device: a camera source keeps its other cameras. */
function sourcesWithout(
  sources: readonly LinkedTriggerSource[],
  deviceId: number,
): LinkedTriggerSource[] {
  return sources.flatMap((source): LinkedTriggerSource[] => {
    if (source.kind !== 'detection') return source.deviceId === deviceId ? [] : [source]
    const deviceIds = source.deviceIds.filter((id) => id !== deviceId)
    return deviceIds.length === 0 ? [] : [{ ...source, deviceIds }]
  })
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
  const at = params.sources.findIndex((s) => sourceDeviceIds(s).includes(deviceId))
  const others = sourcesWithout(params.sources, deviceId)
  const sources =
    at < 0 ? [...others, source] : [...others.slice(0, at), source, ...others.slice(at)]
  return { ...params, sources }
}

/**
 * The instance with one source device swapped for another. The same kind of source
 * keeps every condition (events, parts, classes, payload) and only names the new
 * device; another kind starts from that kind's default source, in the old position.
 * The action, time, window and state stay as stored.
 */
export function withRowSource(
  instance: TemplateInstance,
  from: number,
  to: number,
  fromKind: TriggerSourceKind,
  toKind: TriggerSourceKind,
): LinkedTriggerParams | null {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return null
  if (from === to) return params
  if (fromKind === toKind) {
    const sources = params.sources.map((source): LinkedTriggerSource => {
      if (source.kind === 'detection') {
        if (!source.deviceIds.includes(from)) return source
        const ids = source.deviceIds.map((id) => (id === from ? to : id))
        return { ...source, deviceIds: [...new Set(ids)] }
      }
      return source.deviceId === from ? { ...source, deviceId: to } : source
    })
    return { ...params, sources }
  }
  const fresh = newTriggerParams(params.targetDeviceId, to, params.capability, toKind)
  const [source] = fresh?.sources ?? []
  if (source === undefined) return null
  const at = params.sources.findIndex((s) => sourceDeviceIds(s).includes(from))
  const others = sourcesWithout(params.sources, from)
  return {
    ...params,
    sources: at < 0 ? [...others, source] : [...others.slice(0, at), source, ...others.slice(at)],
  }
}

/** What the trigger dialog changed about a source's conditions; null = left as stored. */
export interface TriggerConditions {
  readonly fired: FiredPick | null
  readonly classes: readonly DetectionClass[] | null
  readonly activeWindow: TemplateTimeWindowValue | null
  readonly activeWhen: TemplateDeviceStateValue | null
}

/** The instance's params with one source's touched conditions and both run limits applied. */
export function withConditions(
  instance: TemplateInstance,
  deviceId: number,
  conditions: TriggerConditions,
): LinkedTriggerParams | null {
  const asInstance = (params: LinkedTriggerParams): TemplateInstance => ({
    ...instance,
    values: linkedTriggerValues(params),
  })
  let params: LinkedTriggerParams | null = linkedTriggerParamsOf(instance.values)
  if (params !== null && conditions.fired !== null) {
    params = withRowFilter(asInstance(params), deviceId, conditions.fired)
  }
  if (params !== null && conditions.classes !== null) {
    params = withRowClasses(asInstance(params), deviceId, conditions.classes)
  }
  return params === null
    ? null
    : withActiveLimits(asInstance(params), conditions.activeWindow, conditions.activeWhen)
}

/** Removing a row: the instance without that device, or its deletion when nothing is left. */
export function withoutRow(instance: TemplateInstance, deviceId: number): RowRemoval {
  const params = linkedTriggerParamsOf(instance.values)
  if (params === null) return { kind: 'delete' }
  const sources = sourcesWithout(params.sources, deviceId)
  return sources.length === 0
    ? { kind: 'delete' }
    : { kind: 'update', params: { ...params, sources } }
}

/** The action column's choices: the plain actions, and "on for" when the capability's on can be held. */
export function offeredChoices(capability: string): readonly TriggerActionChoice[] {
  const plain = offeredActions(capability)
  return plain.includes('on') && onForActionOf(`${capability}.on`) !== null
    ? [...plain, ON_FOR_CHOICE]
    : plain
}

/** What a picked device is as a source: a camera detects, a motion sensor reports, the rest fire events. */
export function sourceKindOf(
  type: string | null,
  caps: readonly string[],
): TriggerSourceKind | null {
  if (type === 'camera') return 'camera'
  if (caps.includes(MOTION_CAP)) return 'motion'
  return caps.length > 0 ? 'emitter' : null
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

/**
 * A new row. A button toggles on any of its events. A motion sensor or a camera
 * holds the device on for a time (when its on can be held): what follows
 * motion is light for a while, not a light left on.
 */
export function newTriggerParams(
  targetDeviceId: number,
  sourceDeviceId: number,
  capability: string,
  sourceKind: TriggerSourceKind = 'emitter',
): LinkedTriggerParams | null {
  const offered = offeredActions(capability)
  if (sourceKind === 'emitter') {
    const action = offered.includes('toggle') ? 'toggle' : offered[0]
    if (action === undefined) return null
    return {
      targetDeviceId,
      action,
      capability,
      sources: [{ kind: 'device-fired', deviceId: sourceDeviceId }],
    }
  }
  if (!offered.includes('on')) return null
  const source: LinkedTriggerSource =
    sourceKind === 'motion'
      ? {
          kind: 'device-becomes',
          deviceId: sourceDeviceId,
          cap: MOTION_CAP,
          fieldPath: MOTION_FIELD,
          becomes: true,
        }
      : {
          kind: 'detection',
          deviceIds: [sourceDeviceId],
          subjects: [{ macro: 'person' }],
        }
  return {
    targetDeviceId,
    action: 'on',
    capability,
    ...(offeredChoices(capability).includes(ON_FOR_CHOICE)
      ? { onForSeconds: DEFAULT_ON_FOR_SECONDS }
      : {}),
    sources: [source],
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
  if (filter.kind === 'custom' || filter.kind === 'motion' || filter.kind === 'detection') {
    return { events: [], parts: [], custom: filter.kind === 'custom' }
  }
  if (filter.kind === 'category') return { events: filter.categories, parts: [], custom: false }
  return { events: filter.events, parts: filter.parts, custom: false }
}
