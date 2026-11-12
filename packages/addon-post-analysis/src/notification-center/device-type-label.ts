/**
 * The device-type label the admin UI shows (`uiLibrary.deviceMeta.type.*`).
 *
 * The strings are the admin catalog, sliced into {@link ./device-type-labels.json}
 * so this process does not load the admin UI. A type the catalog does not name
 * returns null — the sentence keeps the bare name.
 */
import labels from './device-type-labels.json' with { type: 'json' }

/** The languages both the notification catalog and the admin UI ship. */
export type DeviceLabelLanguage = 'en' | 'it'

/** Translated device-type name, or null when this catalog has no such type. */
export function deviceTypePhrase(type: string, language: DeviceLabelLanguage): string | null {
  const phrase = phraseIn(labels[language], type)
  if (phrase === undefined || phrase.trim().length === 0) return null
  return phrase
}

function phraseIn(table: object, type: string): string | undefined {
  if (!Object.hasOwn(table, type)) return undefined
  const value: unknown = Reflect.get(table, type)
  return typeof value === 'string' ? value : undefined
}
