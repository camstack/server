/**
 * The events a "device event" trigger offers: what the cap vocabulary declares
 * for the device (its caps' event triggers), through the same resolution the
 * state and action pickers use. The raw `EventCategory` enum is never the list.
 */
import type { ResolvedVocabTrigger, VocabLocale } from '@camstack/types'
import { CAP_VOCABULARY_BY_NAME, vocabularyTriggersForDevice } from '@camstack/types'

export interface EventOption {
  /** The `EventCategory` a stored trigger carries. */
  readonly value: string
  readonly label: string
}

function eventOptionsOf(
  triggers: readonly ResolvedVocabTrigger[],
  locale: VocabLocale,
): readonly EventOption[] {
  const byCategory = new Map<string, EventOption>()
  for (const trigger of triggers) {
    if (trigger.kind !== 'event' || byCategory.has(trigger.category)) continue
    byCategory.set(trigger.category, { value: trigger.category, label: trigger.label[locale] })
  }
  return [...byCategory.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** The events one device's bound caps declare; none when they declare none. */
export function declaredEventOptions(
  caps: readonly string[],
  deviceType: string | undefined,
  locale: VocabLocale,
): readonly EventOption[] {
  return eventOptionsOf(vocabularyTriggersForDevice(caps, deviceType), locale)
}

/** A trigger with no device: every event the vocabulary declares for any cap. */
export function fleetEventOptions(locale: VocabLocale): readonly EventOption[] {
  return declaredEventOptions(Object.keys(CAP_VOCABULARY_BY_NAME), undefined, locale)
}

/**
 * The select's options: the declared ones, plus the stored category when the
 * device does not declare it (flagged), so a saved row shows what it holds.
 */
export function eventSelectOptions(
  declared: readonly EventOption[],
  stored: string,
  notDeclaredLabel: string,
): readonly EventOption[] {
  if (stored === '' || declared.some((option) => option.value === stored)) return declared
  return [...declared, { value: stored, label: `${stored} (${notDeclaredLabel})` }]
}
