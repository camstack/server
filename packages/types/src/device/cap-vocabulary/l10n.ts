/**
 * The one way the vocabulary writes a human string: English and Italian side
 * by side, so neither language can be forgotten in a diff.
 */
import type { L10n } from './types.js'

/** A string in English and Italian. */
export function t(en: string, it: string): L10n {
  return { en, it }
}
