import { z } from 'zod'

/**
 * The declared vocabulary of an `event-emitter` device (D1044): what the
 * device can fire, named for a person and typed for a rule.
 *
 * `id` is the native token, verbatim. `kind` is the meaning shared by every
 * integration, so "any long press" can be asked without knowing a vendor's
 * token. A device with several buttons declares one entry per button and
 * token: an entry is identified by its token AND its source.
 */

/** The cross-integration meaning of an event. */
export const EVENT_VOCABULARY_KINDS = [
  'press',
  'long-press',
  'long-press-start',
  'release',
  'repeat',
  'double-press',
  'other',
] as const
export const EventVocabularyKindSchema = z.enum(EVENT_VOCABULARY_KINDS)
export type EventVocabularyKind = z.infer<typeof EventVocabularyKindSchema>

/** The part of the device an event comes from: a button, a channel. */
export const EventVocabularySourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})
export type EventVocabularySource = z.infer<typeof EventVocabularySourceSchema>

/** One scalar field of an event's `data`, by dotted path. */
export const EventVocabularyFieldSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['string', 'number', 'boolean', 'enum']),
  enumValues: z.array(z.string()).optional(),
  label: z.string().min(1).optional(),
})
export type EventVocabularyField = z.infer<typeof EventVocabularyFieldSchema>

export const EventVocabularyEntrySchema = z.object({
  /** The native token, verbatim. */
  id: z.string().min(1),
  source: EventVocabularySourceSchema.optional(),
  label: z.string().min(1),
  description: z.string().optional(),
  kind: EventVocabularyKindSchema.optional(),
  payload: z.array(EventVocabularyFieldSchema).optional(),
})
export type EventVocabularyEntry = z.infer<typeof EventVocabularyEntrySchema>

/**
 * A status as a reader may meet it. `vocabulary` is absent on a status
 * written by a provider older than the field.
 */
export interface EventVocabularyCarrier {
  readonly eventTypes: readonly string[]
  readonly vocabulary?: readonly EventVocabularyEntry[]
}

/**
 * The vocabulary of a source that declares tokens and nothing else: one
 * entry per token, labelled with the token itself.
 */
export function plainEventVocabulary(eventTypes: readonly string[]): EventVocabularyEntry[] {
  const unique = [...new Set(eventTypes)].filter((eventType) => eventType !== '')
  return unique.map((eventType) => ({ id: eventType, label: eventType }))
}

/**
 * Tokens many integrations use for a button, by their normalised spelling
 * (lower case, words joined by `_`). Exact matches only: a token that
 * merely contains one of these words gets no kind.
 */
const CONVENTIONAL_KINDS: Readonly<Record<string, EventVocabularyKind>> = {
  press: 'press',
  pressed: 'press',
  single: 'press',
  single_press: 'press',
  single_click: 'press',
  short_press: 'press',
  press_short: 'press',
  click: 'press',
  initial_press: 'press',
  long_press: 'long-press',
  press_long: 'long-press',
  long_click: 'long-press',
  hold: 'long-press',
  long_press_start: 'long-press-start',
  press_long_start: 'long-press-start',
  release: 'release',
  released: 'release',
  long_release: 'release',
  long_press_release: 'release',
  press_long_release: 'release',
  short_release: 'release',
  repeat: 'repeat',
  hold_repeat: 'repeat',
  press_cont: 'repeat',
  double_press: 'double-press',
  double_click: 'double-press',
  double: 'double-press',
  multi_press_2: 'double-press',
}

function normalisedToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function readableToken(token: string): string {
  const words = normalisedToken(token).replace(/_/g, ' ')
  if (words === '') return token
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/**
 * The vocabulary of a source that declares tokens only, read by convention:
 * a readable label, and the shared kind when the token is one many
 * integrations use for a button. The token itself is kept verbatim.
 */
export function conventionalEventVocabulary(eventTypes: readonly string[]): EventVocabularyEntry[] {
  return plainEventVocabulary(eventTypes).map((entry) => {
    const kind = CONVENTIONAL_KINDS[normalisedToken(entry.id)]
    const label = readableToken(entry.id)
    return kind === undefined ? { id: entry.id, label } : { id: entry.id, label, kind }
  })
}

/** The native tokens of a vocabulary, each once, in declaration order. */
export function eventTypesOfVocabulary(vocabulary: readonly EventVocabularyEntry[]): string[] {
  return [...new Set(vocabulary.map((entry) => entry.id))]
}

/**
 * The vocabulary to show and match against. A status with none declared
 * answers with its plain tokens, so an older provider is still usable.
 */
export function readEventVocabulary(
  status: EventVocabularyCarrier,
): readonly EventVocabularyEntry[] {
  const declared = status.vocabulary
  if (declared !== undefined && declared.length > 0) return declared
  return plainEventVocabulary(status.eventTypes)
}

/** The entry a fire belongs to: same token, same source (or both without one). */
export function findVocabularyEntry(
  vocabulary: readonly EventVocabularyEntry[],
  eventType: string,
  sourceId?: string,
): EventVocabularyEntry | undefined {
  return vocabulary.find((entry) => entry.id === eventType && entry.source?.id === sourceId)
}
