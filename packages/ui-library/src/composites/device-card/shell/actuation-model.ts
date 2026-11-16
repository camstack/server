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

/** How many transitions one page of the card asks for. */
export const ACTUATION_PAGE_SIZE = 30

export type ActuationPresence = 'pending' | 'present' | 'absent' | 'unknown'

/** Words the host translates. Counts are already numbers. */
export interface ActuationPhrases {
  readonly today: string
  readonly yesterday: string
  readonly on: string
  readonly off: string
  readonly unknown: string
  readonly device: string
  readonly user: string
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
  readonly absolute: string
  /** Local calendar day, `YYYY-MM-DD`: the key rows are grouped under. */
  readonly dayKey: string
  /** The day header: Today, Yesterday, or the localized date. */
  readonly dayLabel: string
  readonly field: string
  readonly change: string
  readonly actor: string
  /** HH:MM:SS: the row's exact time (the day is its header). */
  readonly time: string
  /** The detail block (ⓘ): everything the ledger knows about this change. */
  readonly details: ActuationDetails
  readonly outcome: TransitionOutcome
}

export interface ActuationDetails {
  /** Date and time down to the millisecond. */
  readonly exact: string
  readonly capability: string
  readonly field: string
  readonly from: string
  readonly to: string
  /** The kind of actor (user, automation, device ...). */
  readonly actorKind: string
  /** The named actor: the user, the automation, the add-on. */
  readonly actorName: string
  /** The command that caused the change, with its arguments; null when none was matched. */
  readonly command: string | null
  readonly outcome: string
  readonly rowId: string
}

export type ActuationAsk =
  | { readonly status: 'pending' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ok'
      readonly count: number
      readonly nextCursor: string | null
    }

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

export function actuationAbsoluteTime(at: number, locale: string): string {
  return new Date(at).toLocaleString(locale)
}

function clockParts(at: number): {
  readonly time: string
  readonly ms: string
} {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return {
    time: `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`,
    ms: String(d.getMilliseconds()).padStart(3, '0'),
  }
}

/** HH:MM:SS of the local time. */
export function actuationTime(at: number): string {
  return clockParts(at).time
}

function dayKeyOf(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** The header a day's rows sit under: Today, Yesterday, else the localized date. */
export function actuationDayLabel(
  at: number,
  now: number,
  locale: string,
  phrases: ActuationPhrases,
): string {
  const key = dayKeyOf(at)
  if (key === dayKeyOf(now)) return phrases.today
  const before = new Date(now)
  before.setDate(before.getDate() - 1)
  if (key === dayKeyOf(before.getTime())) return phrases.yesterday
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Date(at).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Full local date and time with milliseconds. */
export function actuationExactTime(at: number, locale: string): string {
  const { time, ms } = clockParts(at)
  return `${new Date(at).toLocaleDateString(locale)} ${time}.${ms}`
}

/** The kind of actor, in the operator's words. */
export function actuationActorKindLabel(actor: TransitionActor, phrases: ActuationPhrases): string {
  switch (actor.kind) {
    case 'user':
      return phrases.user
    case 'action':
      return phrases.automation
    case 'addon':
      return phrases.addon
    case 'scheduler':
      return phrases.scheduler
    case 'composition':
      return phrases.composition
    case 'node':
      return phrases.node
    case 'device':
      return phrases.device
  }
}

function commandText(transition: DeviceTransition): string | null {
  const command = transition.command
  if (command === undefined) return null
  const args = Object.keys(command.args).length === 0 ? '' : JSON.stringify(command.args)
  const call = `${command.method}(${args})`
  return command.error === undefined ? call : `${call} — ${command.error}`
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
  const field = actuationFieldLabel(transition.capName, transition.field, locale)
  const actor = actuationActorLabel(transition.actor, names, phrases)
  return {
    id: transition.id,
    time: actuationTime(transition.at),
    dayKey: dayKeyOf(transition.at),
    dayLabel: actuationDayLabel(transition.at, now, locale, phrases),
    details: {
      exact: actuationExactTime(transition.at, locale),
      capability: transition.capName,
      field,
      from,
      to,
      actorKind: actuationActorKindLabel(transition.actor, phrases),
      actorName: actor,
      command: commandText(transition),
      outcome: outcomeLabel(transition.outcome, phrases),
      rowId: transition.id,
    },
    absolute: actuationAbsoluteTime(transition.at, locale),
    field,
    change: `${from} → ${to}`,
    actor,
    outcome: transition.outcome,
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
