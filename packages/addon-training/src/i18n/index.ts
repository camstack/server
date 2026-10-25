import { createAddonI18n } from '@camstack/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the Training page (namespace = addon id). */
export const { useT, Trans, translate } = createAddonI18n('training', { en, it })

/** The translate function `useT` hands out, for helpers that take `t` as a parameter. */
export type TFn = ReturnType<typeof useT>['t']
