import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings for the Speak on Echo page (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('import-alexa', { en, it })
