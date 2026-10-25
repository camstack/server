import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the stream-broker widgets (namespace = widget bundle id). */
export const { useT } = createAddonI18n('stream-broker', { en, it })
