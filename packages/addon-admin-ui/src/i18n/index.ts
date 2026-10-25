import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import it from './it.json'

const STORAGE_KEY = 'camstack_language'

// Plain node scripts (guards, codegen) import helpers that reach this module: no storage there.
const storage = typeof localStorage === 'undefined' ? null : localStorage
const savedLanguage = storage?.getItem(STORAGE_KEY) ?? 'en'

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    it: { translation: it },
  },
  lng: savedLanguage,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes values
  },
})

// Persist language changes
i18n.on('languageChanged', (lng) => {
  storage?.setItem(STORAGE_KEY, lng)
  if (typeof document !== 'undefined') document.documentElement.lang = lng
})

// The channel addon pages (Module Federation remotes) read their language from:
// i18next is not a shared singleton, `<html lang>` is. See ui-library `useAddonT`.
if (typeof document !== 'undefined') document.documentElement.lang = i18n.language

export default i18n
