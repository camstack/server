/**
 * The hub's translation catalogs (D863).
 *
 * Core namespace `server` ships inside this package (`en.json` / `it.json`:
 * user-facing error texts + core schema labels). Every installed addon may add
 * `i18n/<lang>.json` in its package directory; its namespace is its addon id.
 * Every file is validated with zod; a broken file is logged and ignored, never
 * fatal - the English text that travels beside every key is the floor.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CATALOG_LANGS,
  CatalogFileSchema,
  DEFAULT_CATALOG_LANG,
  interpolate,
  splitTranslationRef,
  type CatalogFile,
  type CatalogLang,
  type CatalogLookup,
  type TranslationParams,
} from '@camstack/types'
import serverEn from './en.json'
import serverIt from './it.json'

/** The core namespace: user-facing error texts and core schema labels. */
export const SERVER_NAMESPACE = 'server'

/** `@camstack/addon-provider-reolink` -> `provider-reolink`; `@camstack/system` -> `system`. */
export function catalogNamespaceOf(packageName: string): string {
  return packageName.replace(/^@camstack\//, '').replace(/^addon-/, '')
}

export type CatalogWarn = (message: string) => void

export class CatalogRegistry {
  private readonly namespaces = new Map<string, Map<CatalogLang, CatalogFile>>()

  constructor(private readonly warn: CatalogWarn = () => undefined) {}

  /** Validates `raw` and installs it; returns false (after warning) when it is not a flat string map. */
  set(ns: string, lang: CatalogLang, raw: unknown, origin: string): boolean {
    const parsed = CatalogFileSchema.safeParse(raw)
    if (!parsed.success) {
      this.warn(`i18n catalog ignored (${origin}): ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      return false
    }
    const langs = this.namespaces.get(ns) ?? new Map<CatalogLang, CatalogFile>()
    langs.set(lang, parsed.data)
    this.namespaces.set(ns, langs)
    return true
  }

  /** Loads `<packageDir>/i18n/<lang>.json` for every language that has a file. */
  loadAddonDir(ns: string, packageDir: string): void {
    for (const lang of CATALOG_LANGS) {
      const file = path.join(packageDir, 'i18n', `${lang}.json`)
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue // an addon without a catalog for this language is normal
      }
      try {
        this.set(ns, lang, JSON.parse(text), file)
      } catch (err: unknown) {
        this.warn(
          `i18n catalog ignored (${file}): ${err instanceof Error ? err.message : 'bad JSON'}`,
        )
      }
    }
  }

  /** Drops a namespace (addon uninstalled or redeployed before a reload). */
  clear(ns: string): void {
    this.namespaces.delete(ns)
  }

  /** The text for `ns:key` in `lang`, or `undefined`. Never falls back across languages. */
  lookup(lang: CatalogLang, ns: string, key: string): string | undefined {
    return this.namespaces.get(ns)?.get(lang)?.[key]
  }

  /**
   * `t(ns, key, params, fallbackEnglish)` - the translation in `lang`, else
   * the English fallback (also interpolated). English is never looked up: the
   * fallback IS the English text.
   */
  t(
    lang: CatalogLang,
    ns: string,
    key: string,
    params: TranslationParams | undefined,
    fallbackEnglish: string,
  ): string {
    const text = lang === DEFAULT_CATALOG_LANG ? undefined : this.lookup(lang, ns, key)
    return interpolate(text ?? fallbackEnglish, params)
  }

  /** A lookup bound to one language, for `localizeConfigTree`. English never substitutes. */
  lookupFor(lang: CatalogLang): CatalogLookup {
    return (ns, key) => (lang === DEFAULT_CATALOG_LANG ? undefined : this.lookup(lang, ns, key))
  }

  /** `t` for a `"ns:key"` reference. */
  tRef(
    lang: CatalogLang,
    ref: string,
    params: TranslationParams | undefined,
    fallbackEnglish: string,
  ): string {
    const parts = splitTranslationRef(ref)
    return parts === null
      ? interpolate(fallbackEnglish, params)
      : this.t(lang, parts.ns, parts.key, params, fallbackEnglish)
  }
}

let shared: CatalogRegistry | null = null

/** A fresh registry holding the core `server` namespace (specs build their own). */
export function createCoreCatalogRegistry(warn?: CatalogWarn): CatalogRegistry {
  const registry = new CatalogRegistry(warn)
  registry.set(SERVER_NAMESPACE, 'en', serverEn, 'server/en.json')
  registry.set(SERVER_NAMESPACE, 'it', serverIt, 'server/it.json')
  return registry
}

/** The hub's one registry, core catalogs preloaded. */
export function getCatalogRegistry(warn?: CatalogWarn): CatalogRegistry {
  if (shared === null) shared = createCoreCatalogRegistry(warn)
  return shared
}

/** Spec hook: forget the shared registry. */
export function resetCatalogRegistryForTests(): void {
  shared = null
}
