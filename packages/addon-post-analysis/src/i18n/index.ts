import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the Pipeline Analytics widgets (namespace = the widget bundle's id). */
export const { useT } = createAddonI18n('pipeline-analytics', { en, it })
