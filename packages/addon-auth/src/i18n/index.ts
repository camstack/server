import { createAddonI18n } from '@dominevo/ui-library'
import en from './en.json'
import it from './it.json'

/** Strings of the `auth-webauthn` widgets (namespace = addon id). */
export const { useT } = createAddonI18n('auth-webauthn', { en, it })
