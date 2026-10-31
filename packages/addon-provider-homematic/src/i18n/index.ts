import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the CCU management page (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('provider-homematic', { en, it })
