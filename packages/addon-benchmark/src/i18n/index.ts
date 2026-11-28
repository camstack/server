import { createAddonI18n } from '@dominevo/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the Benchmark page (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('benchmark', { en, it })
