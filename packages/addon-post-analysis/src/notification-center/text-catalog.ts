/**
 * The notification centre's TEXT CATALOG — every word an operator can read,
 * in one place, in every language the hub ships.
 *
 * ## Why this exists
 *
 * Before it, the words were born wherever the data was: the default detection
 * body in `dispatcher.ts`, the system-event sentences in `event-intake.ts`
 * (frozen into a DURABLE outbox row at intake, so they could never be
 * re-worded), the timelapse body hard-coded in Italian, and two private
 * `plural()` helpers that each decided what a plural was. Six birth sites, one
 * of which was un-editable after the fact and one of which was monolingual.
 * Now there is one.
 *
 * ## The chain
 *
 * A single lookup resolves in this order, first hit wins:
 *
 *   1. the RULE's own template (`template.title` / `template.body`) — the
 *      operator wrote it, nothing may second-guess it;
 *   2. the hub OVERRIDE for the active language (Phase 2's edit surface writes
 *      these; they ship empty);
 *   3. the shipped file for the active language;
 *   4. the shipped ENGLISH file.
 *
 * Step 4 is the one worth defending: a locale that ships a key late must
 * degrade to an English sentence, never to an empty notification. The CI guard
 * (`scripts/check-nc-text-catalog.ts`) keeps the shipped files at parity so
 * step 4 is unreachable in practice — but "unreachable" is a property of
 * today's files, not of the code, and a chain missing its last link fails
 * silently and completely.
 *
 * ## Plurals
 *
 * A value is a plain string or a map of CLDR plural categories. The category is
 * chosen by `Intl.PluralRules` FOR THE RESOLVED LANGUAGE — not by `n === 1`,
 * which is what the two helpers this replaced did and what makes "1 intervalli
 * ripresi" a shipped sentence. A count-less lookup resolves `other`.
 *
 * ## The depth bound
 *
 * Composite variables (`{{subject}}`, `{{inZones}}`, `{{op}}`,
 * `{{detectionSummary}}`) are rendered FIRST, from their own fragment keys,
 * against the SCALAR variables only — and then injected into the final render
 * as plain strings. {@link renderTemplate} never re-scans a replacement, so
 * there is exactly one level of composition and it cannot grow: a fragment that
 * names another composite renders it empty, and a value that happens to look
 * like `{{camera}}` is printed, not substituted.
 */

import { z } from 'zod'
import { renderTemplate } from './render-template.js'
import enBundle from './texts/en.json' with { type: 'json' }
import itBundle from './texts/it.json' with { type: 'json' }

/** The languages the hub ships texts for. */
export const NC_LANGUAGES = ['en', 'it'] as const

export type NcLanguage = (typeof NC_LANGUAGES)[number]

/** THE language schema — the durable row, the bridge input and the edit
 *  surface's view all validate against this one, so a third language is added
 *  to `NC_LANGUAGES` and nowhere else. */
export const NcLanguageSchema = z.enum(NC_LANGUAGES)

/** The language a hub that has never been configured speaks — and the last
 *  link of the fallback chain. */
export const NC_DEFAULT_LANGUAGE: NcLanguage = 'en'

/**
 * One catalog entry: a finished sentence, or one sentence per CLDR plural
 * category. The category keys are validated against the language's own
 * `Intl.PluralRules` by the CI guard, so `it` cannot grow a `two` and `en`
 * cannot ship a `many` nothing will ever select.
 */
export type NcTextValue = string | Readonly<Record<string, string>>

export type NcTextBundle = Readonly<Record<string, NcTextValue>>

/**
 * Operator-authored replacements, per language. Flat strings only: an override
 * replaces a key for EVERY count, which is the honest shape for a single text
 * box and the reason a key whose plural distinction matters should be
 * overridden with a sentence that reads correctly either way.
 */
export type NcTextOverrides = Readonly<
  Partial<Record<NcLanguage, Readonly<Record<string, string>>>>
>

/** What the `notification-center:texts` document holds — nothing else. */
export interface NcTextSnapshot {
  readonly language: NcLanguage
  readonly overrides: NcTextOverrides
}

/**
 * Whether two snapshots say the same thing.
 *
 * ## Why this is a function and not `===`
 *
 * The reload guard in `reloadTexts()` used to be
 * `before.overrides === next.overrides`, and `next` comes from
 * `NcTextCatalogStore.load()`, which `parse()`s the row through zod on every
 * call. The right-hand side is therefore a NEW object on every tick by
 * construction: the comparison was `false` at byte-identical content, forever.
 * Measured on the live hub 2026-08-25: 58 "notification texts loaded" lines in
 * 30 minutes on a hub whose language had not changed, from a line whose own
 * docblock promises it fires on CHANGE only.
 *
 * The document is two levels deep and installation-small (at most one entry per
 * language, each a flat key→string map), so the comparison is written out
 * rather than reached for through a deep-equal dependency — and written out it
 * can state the direction that matters: a REMOVED key must not read as equal,
 * which a one-directional key walk would get wrong.
 */
export function ncTextSnapshotsEqual(a: NcTextSnapshot, b: NcTextSnapshot): boolean {
  if (a.language !== b.language) return false
  return overrideMapsEqual(a.overrides, b.overrides)
}

function overrideMapsEqual(a: NcTextOverrides, b: NcTextOverrides): boolean {
  const languages = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const language of languages) {
    const left = a[language as NcLanguage]
    const right = b[language as NcLanguage]
    if (left === undefined || right === undefined) {
      // A language present on one side only differs unless BOTH sides are
      // effectively empty — `{}` and absent say the same thing about a
      // document, and a writer that drops an emptied map must not read as a
      // change on every subsequent tick.
      if (Object.keys(left ?? right ?? {}).length > 0) return false
      continue
    }
    if (!flatMapsEqual(left, right)) return false
  }
  return true
}

function flatMapsEqual(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a)
  // Both directions: a key removed since the previous load leaves every
  // surviving key equal, and a one-directional walk would call that unchanged.
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** The shipped files, keyed by language. Data, never mutated. */
export const NC_TEXT_BUNDLES: Readonly<Record<NcLanguage, NcTextBundle>> = {
  en: enBundle,
  it: itBundle,
}

export const NC_DEFAULT_TEXT_SNAPSHOT: NcTextSnapshot = {
  language: NC_DEFAULT_LANGUAGE,
  overrides: {},
}

/** One lookup. `template` is the rule's own text and outranks the catalog. */
export interface NcTextLookup {
  readonly key: string
  /** Selects the plural category. Absent ⇒ `other`. */
  readonly count?: number
  readonly vars?: Readonly<Record<string, string>>
  /** The rule's own template — wins over every catalog layer when non-blank. */
  readonly template?: string
}

export interface NcTextCatalogInit {
  readonly language?: NcLanguage
  readonly overrides?: NcTextOverrides
  /**
   * The bundles to resolve against. Production always uses the shipped files;
   * a test overrides this to exercise the English fallback, which the CI guard
   * makes unreachable through the shipped ones.
   */
  readonly bundles?: Readonly<Record<NcLanguage, NcTextBundle>>
}

const NO_VARS: Readonly<Record<string, string>> = {}

/** Narrow a bundle entry without a cast — a plural map is the object case. */
function isPluralMap(value: NcTextValue): value is Readonly<Record<string, string>> {
  return typeof value !== 'string'
}

export function isNcLanguage(value: unknown): value is NcLanguage {
  return typeof value === 'string' && (NC_LANGUAGES as readonly string[]).includes(value)
}

/**
 * The catalog, as every text producer sees it.
 *
 * Mutable in exactly one way — {@link NcTextCatalog.apply} swaps the whole
 * snapshot — because the hub language is a live setting and every producer
 * holds ONE catalog. Replacing the object wholesale (never editing it in place)
 * keeps a reader that captured `snapshot` looking at a consistent pair.
 */
export class NcTextCatalog {
  private current: NcTextSnapshot
  private readonly bundles: Readonly<Record<NcLanguage, NcTextBundle>>
  private readonly pluralRules = new Map<NcLanguage, Intl.PluralRules>()
  private readonly listFormats = new Map<NcLanguage, Intl.ListFormat>()

  constructor(init: NcTextCatalogInit = {}) {
    this.current = {
      language: init.language ?? NC_DEFAULT_LANGUAGE,
      overrides: init.overrides ?? {},
    }
    this.bundles = init.bundles ?? NC_TEXT_BUNDLES
  }

  get language(): NcLanguage {
    return this.current.language
  }

  get snapshot(): NcTextSnapshot {
    return this.current
  }

  /** Adopt a freshly loaded document. Idempotent; never partially applied. */
  apply(snapshot: NcTextSnapshot): void {
    this.current = snapshot
  }

  /** Whether ANY layer carries the key — used to fall back to `class.other`
   *  for a class no locale names, without rendering an empty noun first. */
  has(key: string): boolean {
    return this.raw(key) !== null
  }

  /**
   * The resolved TEMPLATE for a key, before rendering — override → language
   * file → English file. Null when nothing carries it.
   */
  raw(key: string, count?: number): string | null {
    const language = this.current.language
    const override = this.current.overrides[language]?.[key]
    if (override !== undefined) return override
    const own = this.variant(this.bundles[language][key], language, count)
    if (own !== null) return own
    if (language === NC_DEFAULT_LANGUAGE) return null
    return this.variant(this.bundles[NC_DEFAULT_LANGUAGE][key], NC_DEFAULT_LANGUAGE, count)
  }

  /**
   * The finished string. A rule template outranks the catalog; an unknown key
   * and a blank template both render EMPTY, matching {@link renderTemplate}'s
   * missing-var rule rather than inventing a second one.
   */
  text(lookup: NcTextLookup): string {
    const vars = lookup.vars ?? NO_VARS
    const fromTemplate = renderTemplate(lookup.template, vars)
    if (fromTemplate !== null) return fromTemplate
    const resolved = this.raw(lookup.key, lookup.count)
    if (resolved === null) return ''
    return renderTemplate(resolved, vars) ?? ''
  }

  /** `1 persona, 2 veicoli e 3 animali` — the language's own conjunction, so
   *  the sentence is not an English list wearing Italian words. */
  join(items: readonly string[]): string {
    if (items.length === 0) return ''
    return this.listFormat().format([...items])
  }

  private variant(
    value: NcTextValue | undefined,
    language: NcLanguage,
    count?: number,
  ): string | null {
    if (value === undefined) return null
    if (!isPluralMap(value)) return value
    const category = count === undefined ? 'other' : this.plural(language).select(count)
    return value[category] ?? value['other'] ?? null
  }

  private plural(language: NcLanguage): Intl.PluralRules {
    const held = this.pluralRules.get(language)
    if (held !== undefined) return held
    const made = new Intl.PluralRules(language)
    this.pluralRules.set(language, made)
    return made
  }

  private listFormat(): Intl.ListFormat {
    const language = this.current.language
    const held = this.listFormats.get(language)
    if (held !== undefined) return held
    const made = new Intl.ListFormat(language, { style: 'long', type: 'conjunction' })
    this.listFormats.set(language, made)
    return made
  }
}
