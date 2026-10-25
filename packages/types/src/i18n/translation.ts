/**
 * Server-side translation primitives (D863) - pure, zod only.
 *
 * A catalog is a FLAT `Record<key, string>` per (namespace, language). A
 * reference is `"<namespace>:<key>"`; the English text always travels next to
 * it (`label` beside `labelKey`), so a missing key or an unknown language is
 * the English text, never a blank or a raw key.
 */
import { z } from 'zod'
import { AppPageLangSchema } from '../auth/app-flow.js'

/** The languages a catalog may be written in. English is the mandatory base. */
export const CatalogLangSchema = AppPageLangSchema
export type CatalogLang = z.infer<typeof CatalogLangSchema>
export const CATALOG_LANGS: readonly CatalogLang[] = CatalogLangSchema.options
export const DEFAULT_CATALOG_LANG: CatalogLang = 'en'

/** One catalog file: flat key to text. A file of any other shape is rejected whole. */
export const CatalogFileSchema = z.record(z.string().min(1), z.string())
export type CatalogFile = z.infer<typeof CatalogFileSchema>

/** `{name}` placeholders in a catalog text. */
export type TranslationParams = Readonly<Record<string, string | number>>

/** Fills `{name}` placeholders; an unknown placeholder is left as written. */
export function interpolate(template: string, params?: TranslationParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** Splits `"ns:key"`; `null` when the reference has no namespace. */
export function splitTranslationRef(ref: string): { ns: string; key: string } | null {
  const at = ref.indexOf(':')
  if (at <= 0 || at === ref.length - 1) return null
  return { ns: ref.slice(0, at), key: ref.slice(at + 1) }
}

/** `(namespace, key) -> text in the request language`, or `undefined` when absent. */
export type CatalogLookup = (ns: string, key: string) => string | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface KeyedText {
  readonly keyField: string
  readonly textField: string
}

const KEYED_TEXTS: readonly KeyedText[] = [
  { keyField: 'labelKey', textField: 'label' },
  { keyField: 'descriptionKey', textField: 'description' },
  { keyField: 'titleKey', textField: 'title' },
]

/**
 * Returns `value` with every `labelKey` / `descriptionKey` / `titleKey` that
 * the catalog can resolve replaced into `label` / `description` / `title`.
 * Pure: the input is never mutated; a subtree with nothing to change is
 * returned as the SAME object. A key the catalog does not hold keeps the
 * English text that sits next to it.
 */
export function localizeConfigTree(value: unknown, lookup: CatalogLookup): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item: unknown) => {
      const out = localizeConfigTree(item, lookup)
      if (out !== item) changed = true
      return out
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const out = localizeConfigTree(v, lookup)
    if (out !== v) patch[k] = out
  }
  for (const { keyField, textField } of KEYED_TEXTS) {
    const ref = value[keyField]
    if (typeof ref !== 'string') continue
    const parts = splitTranslationRef(ref)
    const text = parts === null ? undefined : lookup(parts.ns, parts.key)
    if (text !== undefined) patch[textField] = text
  }
  return Object.keys(patch).length === 0 ? value : { ...value, ...patch }
}
