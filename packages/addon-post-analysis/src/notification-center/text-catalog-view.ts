/**
 * The text catalog, projected for an EDITOR — Phase 2's read model, pure.
 *
 * ## Why a second shape
 *
 * {@link NcTextCatalog} resolves ONE key and answers a finished string. That is
 * the right shape for a producer and the wrong one for an operator: an editor
 * has to show every key at once and, for each, WHICH layer answered — otherwise
 * "I changed that word" and "that word is the shipped one" look identical on
 * screen, and the operator's only way to tell them apart is to fire a
 * notification.
 *
 * So each row carries both the shipped text and the override, plus the layer
 * that won. Keeping `shipped` beside an override is not redundancy: it is the
 * only thing "reset to shipped" can reset TO, and the row is the only place the
 * client ever sees it.
 *
 * ## What this surface CANNOT show
 *
 * Layer 1 of the chain — the rule's own `template.title` / `template.body` — is
 * per-RULE, not per-key, and it outranks everything here. A key overridden on
 * this page still loses to a rule that wrote its own sentence, which is
 * correct (the operator typed that sentence into that rule) and is why the UI
 * says so rather than pretending the catalog is the last word.
 *
 * ## Plurals flatten, loudly
 *
 * A shipped value may be a CLDR plural map; an override is a single string
 * ({@link NcTextOverrides}). The row therefore flattens to the `other` variant
 * AND declares `pluralCategories`, so the surface can warn before an operator
 * replaces "person / people" with one sentence that will be printed for every
 * count.
 *
 * ## Placeholders come from the shipped text
 *
 * The `{{vars}}` a key may use are the PRODUCER's vocabulary — the dispatcher
 * decides what it hands in. Deriving the legend from the override instead would
 * shrink it the moment an operator dropped a variable, i.e. exactly when he
 * most needs to be told what he can put back.
 */

import { z } from 'zod'
import { templatePlaceholders } from './render-template.js'
import {
  NC_DEFAULT_LANGUAGE,
  NC_LANGUAGES,
  NC_TEXT_BUNDLES,
  type NcLanguage,
  NcLanguageSchema,
  type NcTextBundle,
  type NcTextOverrides,
  type NcTextValue,
} from './text-catalog.js'

/** Which layer answered a key. Layer 1 (the rule template) is per-rule and can
 *  never appear here — see the module note. */
const NcTextLayerSchema = z.enum(['override', 'shipped', 'fallback'])
export type NcTextLayer = z.infer<typeof NcTextLayerSchema>

const NcTextEntryViewSchema = z.object({
  key: z.string(),
  /** The shipped wording for this key, flattened to its `other` variant. */
  shipped: z.string(),
  /** WHICH file `shipped` came from — `en` here with `language: 'it'` means the
   *  Italian locale does not ship this key yet. */
  shippedLanguage: NcLanguageSchema,
  /** The operator's replacement, or null when the shipped text is in force. */
  override: z.string().nullable(),
  /** What the catalog would answer today (ignoring a rule's own template). */
  effective: z.string(),
  source: NcTextLayerSchema,
  /** `{{name}}`s the shipped text uses, first-appearance order. */
  placeholders: z.array(z.string()),
  /** CLDR categories the shipped value distinguishes; empty for a flat string.
   *  Non-empty means an override flattens the distinction. */
  pluralCategories: z.array(z.string()),
})
export type NcTextEntryView = z.infer<typeof NcTextEntryViewSchema>

export const NcTextCatalogViewSchema = z.object({
  /** The language being VIEWED — not necessarily the one the hub speaks. */
  language: NcLanguageSchema,
  /** The hub's language: what notifications are actually written in. */
  activeLanguage: NcLanguageSchema,
  languages: z.array(NcLanguageSchema),
  entries: z.array(NcTextEntryViewSchema),
})
export type NcTextCatalogView = z.infer<typeof NcTextCatalogViewSchema>

/**
 * One edit round. A value REPLACES the shipped text; `null` (and, per
 * {@link applyNcTextOverridePatch}, a blank string) resets the key.
 *
 * A patch and not the whole map on purpose: two admins on two browsers editing
 * different keys must not overwrite each other, and a wholesale PUT makes that
 * outcome the default one.
 */
export const NcTextOverridePatchSchema = z.record(z.string(), z.string().nullable())
export type NcTextOverridePatch = z.infer<typeof NcTextOverridePatchSchema>

export interface NcTextCatalogViewInput {
  readonly language: NcLanguage
  readonly activeLanguage: NcLanguage
  readonly overrides: NcTextOverrides
  /** Production always uses the shipped files; tests narrow this. */
  readonly bundles?: Readonly<Record<NcLanguage, NcTextBundle>>
}

/** Narrow a bundle entry without a cast — a plural map is the object case. */
function isPluralMap(value: NcTextValue): value is Readonly<Record<string, string>> {
  return typeof value !== 'string'
}

/** A plural map's `other` variant is the one a single text box replaces. */
function flatten(value: NcTextValue): string {
  if (!isPluralMap(value)) return value
  return value['other'] ?? Object.values(value)[0] ?? ''
}

/** The union of every variant's placeholders — a plural whose `one` names a
 *  variable the `other` does not must still advertise it. */
function placeholdersOf(value: NcTextValue): readonly string[] {
  if (!isPluralMap(value)) return templatePlaceholders(value)
  const found: string[] = []
  for (const variant of Object.values(value)) {
    for (const name of templatePlaceholders(variant)) {
      if (!found.includes(name)) found.push(name)
    }
  }
  return found
}

function pluralCategoriesOf(value: NcTextValue): readonly string[] {
  return isPluralMap(value) ? Object.keys(value) : []
}

/**
 * Every key of every shipped bundle, in ENGLISH file order first.
 *
 * File order and not alphabetical: the shipped files are grouped by domain
 * (`detection.*`, then `class.*`, then `system.*`…), which is how an operator
 * scans them; sorting would interleave a class noun between two system
 * sentences for no gain. Keys only a non-English locale ships are appended so
 * nothing is invisible — the CI guard keeps that list empty in practice.
 */
function orderedKeys(bundles: Readonly<Record<NcLanguage, NcTextBundle>>): readonly string[] {
  const keys: string[] = [...Object.keys(bundles[NC_DEFAULT_LANGUAGE])]
  const seen = new Set(keys)
  for (const language of NC_LANGUAGES) {
    for (const key of Object.keys(bundles[language])) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/** The full edit-surface projection. Pure: same inputs, same view. */
export function buildNcTextCatalogView(input: NcTextCatalogViewInput): NcTextCatalogView {
  const bundles = input.bundles ?? NC_TEXT_BUNDLES
  const overrides = input.overrides[input.language] ?? {}
  const entries: NcTextEntryView[] = []

  for (const key of orderedKeys(bundles)) {
    const own = bundles[input.language][key]
    const shippedValue = own ?? bundles[NC_DEFAULT_LANGUAGE][key]
    // Unreachable through `orderedKeys` (the key came from a bundle), but a
    // chain missing its last link fails silently and completely — so it is
    // written down rather than assumed.
    if (shippedValue === undefined) continue
    const shipped = flatten(shippedValue)
    const override = overrides[key]
    entries.push({
      key,
      shipped,
      shippedLanguage: own === undefined ? NC_DEFAULT_LANGUAGE : input.language,
      override: override ?? null,
      effective: override ?? shipped,
      source: override !== undefined ? 'override' : own === undefined ? 'fallback' : 'shipped',
      placeholders: [...placeholdersOf(shippedValue)],
      pluralCategories: [...pluralCategoriesOf(shippedValue)],
    })
  }

  return {
    language: input.language,
    activeLanguage: input.activeLanguage,
    languages: [...NC_LANGUAGES],
    entries,
  }
}

/**
 * The keys no shipped locale carries.
 *
 * An override for such a key is dead weight — nothing looks it up, so it can
 * never render — and worse, it would sit in the table looking like a working
 * customisation. The writer refuses on any non-empty answer.
 */
export function unknownNcTextKeys(
  keys: readonly string[],
  bundles: Readonly<Record<NcLanguage, NcTextBundle>> = NC_TEXT_BUNDLES,
): readonly string[] {
  return keys.filter((key) =>
    NC_LANGUAGES.every((language) => bundles[language][key] === undefined),
  )
}

/**
 * Apply one patch to the override map. Never mutates its input.
 *
 * Two rules that look like details and are not:
 *
 *  - a BLANK value resets rather than storing an empty string. `renderTemplate`
 *    treats a blank template as absent, so a stored blank override is a row
 *    that claims to be customised and behaves exactly like the shipped text;
 *  - a non-blank value is stored VERBATIM, whitespace included.
 *    `detection.inZones` ships as `" in {{zones}}"` — its leading space is what
 *    keeps it off the word before it, and a helpful trim would glue every
 *    zone-carrying notification together.
 *
 * A language whose last override is reset loses its key entirely, so the
 * durable document stays the sparse map its schema describes.
 */
export function applyNcTextOverridePatch(
  current: NcTextOverrides,
  language: NcLanguage,
  patch: NcTextOverridePatch,
): NcTextOverrides {
  const next: Record<string, string> = { ...current[language] }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.trim().length === 0) {
      delete next[key]
      continue
    }
    next[key] = value
  }
  const { [language]: _replaced, ...rest } = current
  if (Object.keys(next).length === 0) return rest
  return { ...rest, [language]: next }
}
