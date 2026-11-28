/**
 * The admin's view of the shared remote role vocabulary (`@dominevo/types`):
 * the name of a role in the operator's language. The viewer reads the same
 * vocabulary, so a key is called the same thing on both.
 */
import { remoteRoleLabel, type VocabLocale } from '@dominevo/types'

/** `it`, `it-IT` → `it`; everything else → `en`. */
export function vocabLocale(language: string): VocabLocale {
  return language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

/** The localized name of any role (a custom role is named by its key). */
export function roleName(role: string, language: string): string {
  return remoteRoleLabel(role, vocabLocale(language))
}
