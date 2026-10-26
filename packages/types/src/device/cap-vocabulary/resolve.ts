/**
 * Resolve a DEVICE's vocabulary from the cap map (D920): the actions it can be
 * made to do and the triggers it can be watched for, phrased, with the
 * device-type / role wording applied.
 *
 * Walks the device's bindings (D12) and reads only the cap NAME of each entry
 * — never the binding kind (D13): a wrapped cap and a native one speak the
 * same words. System caps and caps the map does not know contribute nothing.
 * The order is the map's order, so a picker draws the same device the same way.
 */
import type { CapabilityMethodAccess } from '../../capabilities/capability-definition.js'
import { kebabToCamel } from '../../capabilities/cap-router-predicates.js'
import type { EventCategory } from '../../enums/event-category.js'
import { METHOD_ACCESS_MAP } from '../../generated/method-access-map.js'
import type { DeviceBinding, DeviceBindingEntry } from '../device-binding.js'
import { BECOMES, HELD_FOR, NUMERIC_ABOVE, NUMERIC_BELOW, NUMERIC_CHANGES_BY } from './templates.js'
import type {
  EnumStateValue,
  L10n,
  LooseCapVocabularyEntry,
  LooseDynamicOffer,
  LooseVocabAction,
  LooseVocabOpenArg,
  LooseVocabStateTrigger,
  LooseVocabWording,
  VocabActionWording,
  VocabEventWording,
  VocabIcon,
  VocabLocale,
  VocabStateWording,
} from './types.js'
import { CAP_VOCABULARY_BY_NAME } from './vocabulary.js'

/** A device's caps, however the caller holds them. */
export type VocabBindingsInput = DeviceBinding | readonly DeviceBindingEntry[] | readonly string[]

/** One action a device can be made to do — the wire is `{ cap, method, args }`. */
export interface ResolvedVocabAction {
  readonly id: string
  readonly cap: string
  readonly method: string
  readonly label: L10n
  readonly phrase: L10n
  readonly icon: VocabIcon
  /** Baked args — sent as they are. */
  readonly args: Readonly<Record<string, unknown>>
  /** Args the operator fills, each with how to offer its values. */
  readonly openArgs: readonly LooseVocabOpenArg[]
  /** The method's access tier (METHOD_ACCESS_MAP). */
  readonly access: CapabilityMethodAccess
}

interface ResolvedTriggerBase {
  readonly id: string
  readonly cap: string
  readonly label: L10n
  readonly icon: VocabIcon
}

/** A true/false field. `…For` phrases carry `{minutes}`. */
export interface ResolvedBooleanTrigger extends ResolvedTriggerBase {
  readonly kind: 'boolean'
  readonly field: string
  readonly whenTrue: L10n
  readonly whenFalse: L10n
  readonly whenTrueFor: L10n
  readonly whenFalseFor: L10n
}

/** A number: phrases carry `{threshold}` / `{delta}`. */
export interface ResolvedNumericTrigger extends ResolvedTriggerBase {
  readonly kind: 'numeric'
  readonly field: string
  readonly unit: string | null
  /** Status field holding the device's own unit, when it states one. */
  readonly unitField: string | null
  readonly above: L10n
  readonly below: L10n
  readonly changesBy: L10n
}

/** One value of an enum trigger, phrased. */
export interface ResolvedEnumValue {
  readonly value: string
  readonly label: L10n
  readonly phrase: L10n
  readonly phraseFor: L10n
}

/** A closed set of states. */
export interface ResolvedEnumTrigger extends ResolvedTriggerBase {
  readonly kind: 'enum'
  readonly field: string
  readonly values: readonly ResolvedEnumValue[]
}

/** A free value: phrases carry `{value}`. */
export interface ResolvedValueTrigger extends ResolvedTriggerBase {
  readonly kind: 'value'
  readonly field: string
  readonly phrase: L10n
  readonly phraseFor: L10n
  readonly offer: LooseDynamicOffer | null
}

/** A bus event the device emits. */
export interface ResolvedEventTrigger extends ResolvedTriggerBase {
  readonly kind: 'event'
  readonly category: EventCategory
  readonly phrase: L10n
}

/** Anything a device can be watched for. */
export type ResolvedVocabTrigger =
  | ResolvedBooleanTrigger
  | ResolvedNumericTrigger
  | ResolvedEnumTrigger
  | ResolvedValueTrigger
  | ResolvedEventTrigger

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g

/** Fill `{name}` placeholders from `values`; an unknown one stays visible. */
export function renderVocabPhrase(
  phrase: L10n,
  locale: VocabLocale,
  values: Readonly<Record<string, string>>,
): string {
  return phrase[locale].replace(PLACEHOLDER_RE, (whole, name: string) => values[name] ?? whole)
}

function fill(
  phrase: L10n,
  values: Readonly<Record<VocabLocale, Readonly<Record<string, string>>>>,
): L10n {
  return {
    en: renderVocabPhrase(phrase, 'en', values.en),
    it: renderVocabPhrase(phrase, 'it', values.it),
  }
}

function heldFor(trigger: L10n): L10n {
  return fill(HELD_FOR, {
    en: { trigger: trigger.en },
    it: { trigger: trigger.it },
  })
}

function isBindingList(
  bindings: VocabBindingsInput,
): bindings is readonly DeviceBindingEntry[] | readonly string[] {
  return Array.isArray(bindings)
}

function capNamesOf(bindings: VocabBindingsInput): readonly string[] {
  const names: string[] = []
  if (isBindingList(bindings)) {
    for (const item of bindings) names.push(typeof item === 'string' ? item : item.capName)
    return names
  }
  for (const entry of bindings.entries) names.push(entry.capName)
  return names
}

/** The device-scoped entries the device binds, in the map's order. */
function boundEntries(
  bindings: VocabBindingsInput,
): readonly (readonly [string, LooseCapVocabularyEntry])[] {
  const bound = new Set(capNamesOf(bindings))
  return Object.entries(CAP_VOCABULARY_BY_NAME).filter(
    ([cap, entry]) => bound.has(cap) && entry.scope === 'device',
  )
}

/** The wordings that apply: the type's first, then the role's (a role wins). */
function wordingsFor(
  entry: LooseCapVocabularyEntry,
  deviceType: string | undefined,
  role: string | null | undefined,
): readonly LooseVocabWording[] {
  const out: LooseVocabWording[] = []
  const byType = deviceType === undefined ? undefined : entry.overrides?.byType?.[deviceType]
  if (byType !== undefined) out.push(byType)
  const byRole = role === undefined || role === null ? undefined : entry.overrides?.byRole?.[role]
  if (byRole !== undefined) out.push(byRole)
  return out
}

function actionWording(wordings: readonly LooseVocabWording[], id: string): VocabActionWording {
  return wordings.reduce<VocabActionWording>((acc, w) => ({ ...acc, ...w.actions?.[id] }), {})
}

function stateWording(wordings: readonly LooseVocabWording[], field: string): VocabStateWording {
  return wordings.reduce<VocabStateWording>((acc, w) => ({ ...acc, ...w.state?.[field] }), {})
}

function eventWording(wordings: readonly LooseVocabWording[], name: string): VocabEventWording {
  return wordings.reduce<VocabEventWording>((acc, w) => ({ ...acc, ...w.events?.[name] }), {})
}

function accessOf(cap: string, method: string): CapabilityMethodAccess | undefined {
  return METHOD_ACCESS_MAP[`${kebabToCamel(cap)}.${method}`]?.access
}

function resolveAction(
  cap: string,
  action: LooseVocabAction,
  wordings: readonly LooseVocabWording[],
): ResolvedVocabAction | null {
  const access = accessOf(cap, action.method)
  if (access === undefined || access === 'view') return null
  const w = actionWording(wordings, action.id)
  return {
    id: action.id,
    cap,
    method: action.method,
    label: w.label ?? action.label,
    phrase: w.phrase ?? action.phrase,
    icon: w.icon ?? action.icon,
    args: action.args ?? {},
    openArgs: action.openArgs ?? [],
    access,
  }
}

/**
 * The actions a device can be made to do, phrased for its type and role.
 * An action whose method is no longer routable (absent from
 * METHOD_ACCESS_MAP, or a read) is dropped.
 */
export function actionsForDevice(
  bindings: VocabBindingsInput,
  deviceType?: string,
  role?: string | null,
): readonly ResolvedVocabAction[] {
  const out: ResolvedVocabAction[] = []
  for (const [cap, entry] of boundEntries(bindings)) {
    const wordings = wordingsFor(entry, deviceType, role)
    for (const action of entry.actions ?? []) {
      const resolved = resolveAction(cap, action, wordings)
      if (resolved !== null) out.push(resolved)
    }
  }
  return out
}

function resolveEnumValue(v: EnumStateValue): ResolvedEnumValue {
  const phrase = v.phrase ?? fill(BECOMES, { en: { value: v.label.en }, it: { value: v.label.it } })
  return { value: v.value, label: v.label, phrase, phraseFor: heldFor(phrase) }
}

function resolveState(
  cap: string,
  trigger: LooseVocabStateTrigger,
  wordings: readonly LooseVocabWording[],
): ResolvedVocabTrigger {
  const w = stateWording(wordings, trigger.field)
  const id = `${cap}.state.${trigger.field}`
  const label = w.label ?? trigger.label
  const icon = w.icon ?? trigger.icon
  if (trigger.kind === 'boolean') {
    const whenTrue = w.whenTrue ?? trigger.whenTrue
    const whenFalse = w.whenFalse ?? trigger.whenFalse
    return {
      kind: 'boolean',
      id,
      cap,
      field: trigger.field,
      label,
      icon,
      whenTrue,
      whenFalse,
      whenTrueFor: heldFor(whenTrue),
      whenFalseFor: heldFor(whenFalse),
    }
  }
  if (trigger.kind === 'numeric') {
    const quantity = w.quantity ?? trigger.quantity
    const values = {
      en: { quantity: quantity.en },
      it: { quantity: quantity.it },
    }
    return {
      kind: 'numeric',
      id,
      cap,
      field: trigger.field,
      label,
      icon,
      unit: trigger.unit ?? null,
      unitField: trigger.unitField ?? null,
      above: fill(NUMERIC_ABOVE, values),
      below: fill(NUMERIC_BELOW, values),
      changesBy: fill(NUMERIC_CHANGES_BY, values),
    }
  }
  if (trigger.kind === 'enum') {
    return {
      kind: 'enum',
      id,
      cap,
      field: trigger.field,
      label,
      icon,
      values: trigger.values.map(resolveEnumValue),
    }
  }
  const phrase = trigger.phrase ?? BECOMES
  return {
    kind: 'value',
    id,
    cap,
    field: trigger.field,
    label,
    icon,
    phrase,
    phraseFor: heldFor(phrase),
    offer: trigger.offer ?? null,
  }
}

function eventTriggersOf(
  cap: string,
  entry: LooseCapVocabularyEntry,
  wordings: readonly LooseVocabWording[],
): readonly ResolvedEventTrigger[] {
  const out: ResolvedEventTrigger[] = []
  for (const [name, ev] of Object.entries(entry.events ?? {})) {
    if ('notOperatorFacing' in ev) continue
    const wording = eventWording(wordings, name)
    out.push({
      kind: 'event',
      id: `${cap}.event.${ev.category}`,
      cap,
      category: ev.category,
      label: wording.label ?? ev.label,
      phrase: wording.phrase ?? ev.phrase,
      icon: wording.icon ?? ev.icon,
    })
  }
  for (const ev of entry.extraEvents ?? []) {
    out.push({
      kind: 'event',
      id: `${cap}.event.${ev.category}`,
      cap,
      category: ev.category,
      label: ev.label,
      phrase: ev.phrase,
      icon: ev.icon,
    })
  }
  return out
}

/**
 * The triggers a device can be watched for — its state fields, then the bus
 * events it emits — phrased for its type and role.
 */
export function triggersForDevice(
  bindings: VocabBindingsInput,
  deviceType?: string,
  role?: string | null,
): readonly ResolvedVocabTrigger[] {
  const state: ResolvedVocabTrigger[] = []
  const events: ResolvedVocabTrigger[] = []
  for (const [cap, entry] of boundEntries(bindings)) {
    const wordings = wordingsFor(entry, deviceType, role)
    for (const trigger of entry.state ?? []) state.push(resolveState(cap, trigger, wordings))
    events.push(...eventTriggersOf(cap, entry, wordings))
  }
  return [...state, ...events]
}
