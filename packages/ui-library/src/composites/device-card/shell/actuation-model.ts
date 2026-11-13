/**
 * How a device transition reads on the card: the field's vocabulary label,
 * the from → to the card would show, who asked, and whether the list was
 * answered. Pure — the section only renders what this returns.
 */
import {
  CAP_VOCABULARY_BY_NAME,
  type DeviceTransition,
  type TransitionActor,
  type TransitionOutcome,
  type TransitionValue,
} from '@camstack/types'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How many transitions one page of the card asks for. */
export const ACTUATION_PAGE_SIZE = 30

export type ActuationOutcomeTone = 'danger' | 'warning' | 'neutral' | 'success' | 'default'

export type ActuationPresence = 'pending' | 'present' | 'absent' | 'unknown'

/** Words the host translates. Counts are already numbers. */
export interface ActuationPhrases {
  readonly justNow: string
  readonly minutesAgo: (n: number) => string
  readonly hoursAgo: (n: number) => string
  readonly daysAgo: (n: number) => string
  readonly on: string
  readonly off: string
  readonly unknown: string
  readonly device: string
  readonly automation: string
  readonly addon: string
  readonly scheduler: string
  readonly composition: string
  readonly node: string
  readonly confirmed: string
  readonly deviceOutcome: string
  readonly already: string
  readonly unconfirmed: string
  readonly failed: string
}

/** Names the ledger does not store. Missing means the generic word. */
export interface ActuationNameBook {
  readonly actionName: (actionId: string) => string | undefined
  readonly automationName: (automationId: string) => string | undefined
}

export interface ActuationRowView {
  readonly id: string
  readonly relative: string
  readonly absolute: string
  readonly field: string
  readonly change: string
  readonly actor: string
  readonly outcome: TransitionOutcome
  readonly tone: ActuationOutcomeTone
  readonly outcomeLabel: string
}

export type ActuationAsk =
  | { readonly status: 'pending' }
  | { readonly status: 'error' }
  | { readonly status: 'ok'; readonly count: number; readonly nextCursor: string | null }

export type ActuationSectionView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'skeleton' }
  | { readonly kind: 'unread' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'list'; readonly nextCursor: string | null }

type VocabLang = 'en' | 'it'

function vocabLang(locale: string): VocabLang {
  return locale.toLowerCase().startsWith('it') ? 'it' : 'en'
}

function stateOf(cap: string, field: string) {
  return CAP_VOCABULARY_BY_NAME[cap]?.state?.find((entry) => entry.field === field)
}

/** The vocabulary label of a status field, or the field name when it has none. */
export function actuationFieldLabel(cap: string, field: string, locale: string): string {
  const state = stateOf(cap, field)
  if (state === undefined) return field
  return state.label[vocabLang(locale)]
}

function formatNumber(value: number, unit: string | undefined): string {
  const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
  if (unit === undefined || unit.length === 0) return text
  return unit.startsWith('°') ? `${text}${unit}` : `${text} ${unit}`
}

function formatSide(
  cap: string,
  field: string,
  value: TransitionValue,
  locale: string,
  phrases: ActuationPhrases,
): string {
  if (value === null) return phrases.unknown
  const state = stateOf(cap, field)
  if (typeof value === 'boolean' || (state?.kind === 'boolean' && (value === 0 || value === 1))) {
    return value === true || value === 1 ? phrases.on : phrases.off
  }
  if (typeof value === 'number') {
    return formatNumber(value, state?.kind === 'numeric' ? state.unit : undefined)
  }
  if (typeof value === 'string') {
    if (state?.kind === 'enum') {
      const match = state.values.find((entry) => entry.value === value)
      if (match !== undefined) return match.label[vocabLang(locale)]
    }
    return value
  }
  return JSON.stringify(value)
}

/** Who asked, in the operator's words. */
export function actuationActorLabel(
  actor: TransitionActor,
  names: ActuationNameBook,
  phrases: ActuationPhrases,
): string {
  switch (actor.kind) {
    case 'user':
      return actor.username
    case 'action': {
      const byAction = names.actionName(actor.actionId)
      if (byAction !== undefined && byAction.length > 0) return byAction
      if (actor.automationId !== undefined) {
        const byAutomation = names.automationName(actor.automationId)
        if (byAutomation !== undefined && byAutomation.length > 0) return byAutomation
      }
      return phrases.automation
    }
    case 'addon':
      return actor.addonId.length > 0 ? actor.addonId : phrases.addon
    case 'scheduler':
      return actor.schedulerId.length > 0 ? actor.schedulerId : phrases.scheduler
    case 'composition':
      return actor.owner.length > 0 ? actor.owner : phrases.composition
    case 'node':
      return actor.nodeId.length > 0 ? actor.nodeId : phrases.node
    case 'device':
      return phrases.device
  }
}

export function actuationOutcomeTone(outcome: TransitionOutcome): ActuationOutcomeTone {
  switch (outcome) {
    case 'failed':
      return 'danger'
    case 'unconfirmed':
      return 'warning'
    case 'already':
      return 'neutral'
    case 'confirmed':
      return 'success'
    case 'device':
      return 'default'
  }
}

function outcomeLabel(outcome: TransitionOutcome, phrases: ActuationPhrases): string {
  switch (outcome) {
    case 'confirmed':
      return phrases.confirmed
    case 'device':
      return phrases.deviceOutcome
    case 'already':
      return phrases.already
    case 'unconfirmed':
      return phrases.unconfirmed
    case 'failed':
      return phrases.failed
  }
}

/** How long ago `at` was. A future stamp reads as just now. */
export function actuationRelativeTime(at: number, now: number, phrases: ActuationPhrases): string {
  const diff = now - at
  if (diff < MINUTE_MS) return phrases.justNow
  if (diff < HOUR_MS) return phrases.minutesAgo(Math.max(1, Math.floor(diff / MINUTE_MS)))
  if (diff < DAY_MS) return phrases.hoursAgo(Math.floor(diff / HOUR_MS))
  return phrases.daysAgo(Math.floor(diff / DAY_MS))
}

export function actuationAbsoluteTime(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale)
}

/** One row, newest-friendly: the caller sorts. */
export function actuationRow(
  transition: DeviceTransition,
  now: number,
  locale: string,
  phrases: ActuationPhrases,
  names: ActuationNameBook,
): ActuationRowView {
  const from = formatSide(transition.capName, transition.field, transition.from, locale, phrases)
  const to = formatSide(transition.capName, transition.field, transition.to, locale, phrases)
  return {
    id: transition.id,
    relative: actuationRelativeTime(transition.at, now, phrases),
    absolute: actuationAbsoluteTime(transition.at, locale),
    field: actuationFieldLabel(transition.capName, transition.field, locale),
    change: `${from} → ${to}`,
    actor: actuationActorLabel(transition.actor, names, phrases),
    outcome: transition.outcome,
    tone: actuationOutcomeTone(transition.outcome),
    outcomeLabel: outcomeLabel(transition.outcome, phrases),
  }
}

/**
 * What the section is allowed to say. An absent capability is hidden.
 * Pending and a failed read are never "no actuations" — only an answered
 * empty page is.
 */
export function actuationSection(
  presence: ActuationPresence,
  ask: ActuationAsk | null,
): ActuationSectionView {
  if (presence === 'absent') return { kind: 'hidden' }
  if (presence === 'pending') return { kind: 'skeleton' }
  if (presence === 'unknown') return { kind: 'unread' }
  if (ask === null || ask.status === 'pending') return { kind: 'skeleton' }
  if (ask.status === 'error') return { kind: 'unread' }
  if (ask.count === 0) return { kind: 'empty' }
  return { kind: 'list', nextCursor: ask.nextCursor }
}

/** Pages concatenated, first occurrence kept, newest `at` first. Does not mutate. */
export function mergeActuationPages(
  pages: readonly (readonly DeviceTransition[])[],
): readonly DeviceTransition[] {
  const byId = new Map<string, DeviceTransition>()
  for (const page of pages) {
    for (const entry of page) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry)
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
}

function namedEntry(value: unknown): { readonly id: string; readonly name: string } | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('id' in value) || !('name' in value)) return null
  const id = value.id
  const name = value.name
  if (typeof id !== 'string' || typeof name !== 'string' || name.length === 0) return null
  return { id, name }
}

/** `actions.list` as a name book. Anything that is not that list is empty. */
export function actionNamesFromList(data: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(data)) return new Map()
  const names = new Map<string, string>()
  for (const entry of data) {
    const named = namedEntry(entry)
    if (named !== null) names.set(named.id, named.name)
  }
  return names
}
