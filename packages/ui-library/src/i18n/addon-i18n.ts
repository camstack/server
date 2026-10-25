/**
 * Translation core for the pages and widgets an addon ships.
 *
 * Serves the strings of an ADDON's own pages and widgets. The strings of
 * ui-library's own components are served by `useUiText` in
 * `../contexts/ui-text`; both follow the admin language (the admin sets
 * `<html lang>` AND mounts `AdminUiTextProvider`).
 *
 * Why this is not i18next: an addon page is a Module Federation remote and
 * i18next is NOT a shared singleton (`addon-admin-ui/vite.config.ts`), so a
 * remote cannot reach the host's instance. This module lives in the ui-library,
 * which IS the host-shared singleton, so every remote sees the same registry.
 *
 * Two seams keep call sites stable when the hub starts serving bundles
 * (`translations.getBundle({ lang, ns })`):
 *  - bundles enter ONLY through {@link registerAddonBundle}; a call site never
 *    imports a JSON file, it asks `useAddonT(ns)`;
 *  - the language comes ONLY from {@link currentAddonLanguage}, which reads the
 *    `lang` attribute the host admin sets on `<html>` (and falls back to the
 *    browser language for a host-less page such as the agent dashboard).
 */

/** A translation bundle: nested keys, leaves are message strings. */
export interface TranslationTree {
  readonly [key: string]: string | TranslationTree
}

/** Values interpolated into `{{name}}` placeholders; a numeric `count` also picks the plural form. */
export type TranslationVars = Readonly<Record<string, string | number>>

const FALLBACK_LANGUAGE = 'en'

/** `status.ok_one` / `status.ok_other` are addressed as `status.ok`. */
type StripPlural<K extends string> =
  K extends `${infer Base}_${'zero' | 'one' | 'two' | 'few' | 'many' | 'other'}` ? Base : K

/** Every dotted key a bundle answers, plural variants collapsed to their base. */
export type TranslationKey<T> = {
  [K in keyof T & string]: T[K] extends string ? StripPlural<K> : `${K}.${TranslationKey<T[K]>}`
}[keyof T & string]

const bundles = new Map<string, Map<string, TranslationTree>>()
const listeners = new Set<() => void>()
let bundleVersion = 0

/** Lower-cased primary subtag: `it-IT` -> `it`. */
export function normalizeLanguage(raw: string | null | undefined): string {
  const primary = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return primary === '' ? FALLBACK_LANGUAGE : primary
}

/** The language the host admin shows, else the browser's, else English. */
export function currentAddonLanguage(): string {
  if (typeof document !== 'undefined') {
    const htmlLang = document.documentElement.lang
    if (htmlLang.trim() !== '') return normalizeLanguage(htmlLang)
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return normalizeLanguage(navigator.language)
  }
  return FALLBACK_LANGUAGE
}

/** Install (or replace) one language of one namespace. Subscribers re-render. */
export function registerAddonBundle(ns: string, lang: string, tree: TranslationTree): void {
  const language = normalizeLanguage(lang)
  const byLanguage = bundles.get(ns) ?? new Map<string, TranslationTree>()
  byLanguage.set(language, tree)
  bundles.set(ns, byLanguage)
  bundleVersion += 1
  for (const listener of listeners) listener()
}

/** Subscribe to bundle changes AND to the host switching language. */
export function subscribeAddonI18n(listener: () => void): () => void {
  listeners.add(listener)
  let observer: MutationObserver | null = null
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(listener)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  return () => {
    listeners.delete(listener)
    observer?.disconnect()
  }
}

/** Changes whenever a rendered string could differ (new bundle, new language). */
export function addonI18nSnapshot(): string {
  return `${currentAddonLanguage()}#${bundleVersion}`
}

function leafOf(tree: TranslationTree, path: readonly string[]): string | undefined {
  let node: string | TranslationTree | undefined = tree
  for (const segment of path) {
    if (node === undefined || typeof node === 'string') return undefined
    node = node[segment]
  }
  return typeof node === 'string' ? node : undefined
}

function pluralCategory(lang: string, count: number): string {
  try {
    return new Intl.PluralRules(lang).select(count)
  } catch {
    return 'other'
  }
}

function lookup(
  ns: string,
  lang: string,
  key: string,
  count: number | undefined,
): string | undefined {
  const tree = bundles.get(ns)?.get(lang)
  if (tree === undefined) return undefined
  const path = key.split('.')
  if (count !== undefined) {
    const last = path[path.length - 1] ?? key
    const head = path.slice(0, -1)
    const exact = leafOf(tree, [...head, `${last}_${pluralCategory(lang, count)}`])
    if (exact !== undefined) return exact
    const other = leafOf(tree, [...head, `${last}_other`])
    if (other !== undefined) return other
  }
  return leafOf(tree, path)
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

/** Replace `{{name}}` placeholders; an unknown name is left visible. */
export function interpolate(message: string, vars: TranslationVars | undefined): string {
  if (vars === undefined) return message
  return message.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

/** Resolve a key in `lang`, then in English; an unknown key answers itself. */
export function translateAddonKey(
  ns: string,
  lang: string,
  key: string,
  vars?: TranslationVars,
): string {
  const rawCount = vars?.['count']
  const count = typeof rawCount === 'number' ? rawCount : undefined
  const message = lookup(ns, lang, key, count) ?? lookup(ns, FALLBACK_LANGUAGE, key, count) ?? key
  return interpolate(message, vars)
}
