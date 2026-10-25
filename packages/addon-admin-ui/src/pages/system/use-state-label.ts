/**
 * The admin UI's door to the shared state-word dictionary (R7, D690):
 * `stateLabel` from `@camstack/types`, in the language the admin UI is
 * showing. The viewer resolves the same dictionary, so a device state reads
 * the same on both surfaces.
 */
import type { StateLabelLocale } from '@camstack/types'
import { stateLabel } from '@camstack/types'
import { useTranslation } from 'react-i18next'

/** The dictionary locale for an i18next language tag; anything not Italian is English. */
export function stateLabelLocaleOf(language: string | undefined): StateLabelLocale {
  return language?.toLowerCase().startsWith('it') === true ? 'it' : 'en'
}

/** `(raw state word) → label` in the admin UI's current language. */
export function useStateLabel(): (key: string) => string {
  const { i18n } = useTranslation()
  const locale = stateLabelLocaleOf(i18n.language)
  return (key) => stateLabel(key, locale)
}
