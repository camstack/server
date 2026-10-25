/**
 * The Texts tab's contract with the `nc.*` text-catalog bridge, narrowed by
 * hand.
 *
 * `addons.custom` is typed `z.unknown()` at the cap boundary — the per-action
 * schema lives in `addon-post-analysis` and this client never sees it. So the
 * reply is narrowed HERE, in one file, with type guards rather than casts: a
 * hub too old to serve the actions, or one that answered something unexpected,
 * yields `null` and the tab says so. A tab that rendered `undefined` into a
 * text box would invite an operator to save it.
 *
 * The other half is the DRAFT model. The table edits in place and saves in one
 * round, so the whole surface reduces to two pure questions:
 *
 *  - what is in the box for this key? (`draftValue`)
 *  - what has actually CHANGED, and what does the server need to be told?
 *    (`buildOverridePatch`)
 *
 * The second one carries the rule that matters: an override equal to the
 * shipped text — either blank, or the shipped sentence typed back in — is sent
 * as `null`, i.e. a RESET. Storing it instead would leave a row that claims to
 * be customised and behaves exactly like the shipped one, which is the state
 * where an operator cannot tell what he has actually changed.
 */

import type { NcTemplateVarDescriptor } from '@camstack/types'
import i18n from '../../i18n/index'

/** The addonId for `addons.custom` is the MANIFEST id, never the npm package. */
export const NC_ADDON_ID = 'pipeline-analytics'
export const NC_GET_TEXTS_ACTION = 'nc.getTexts'
export const NC_SET_LANGUAGE_ACTION = 'nc.setLanguage'
export const NC_SET_TEXT_OVERRIDES_ACTION = 'nc.setTextOverrides'

/** Mirrors `NC_LANGUAGES` in the addon. Two shipped locales today. */
export const TEXT_LANGUAGES = ['en', 'it'] as const
export type TextLanguage = (typeof TEXT_LANGUAGES)[number]

export const TEXT_LANGUAGE_LABELS: Readonly<Record<TextLanguage, string>> = {
  en: 'English',
  it: 'Italiano',
}

/** Which layer answered a key. The rule's own template — layer 1 of the chain —
 *  is per-rule and can never appear here. */
export type TextLayer = 'override' | 'shipped' | 'fallback'

export interface TextEntry {
  readonly key: string
  readonly shipped: string
  readonly shippedLanguage: TextLanguage
  readonly override: string | null
  readonly effective: string
  readonly source: TextLayer
  readonly placeholders: readonly string[]
  readonly pluralCategories: readonly string[]
}

export interface TextCatalog {
  readonly language: TextLanguage
  readonly activeLanguage: TextLanguage
  readonly languages: readonly TextLanguage[]
  readonly entries: readonly TextEntry[]
}

export function isTextLanguage(value: unknown): value is TextLanguage {
  return value === 'en' || value === 'it'
}

function isTextLayer(value: unknown): value is TextLayer {
  return value === 'override' || value === 'shipped' || value === 'fallback'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function parseEntry(raw: unknown): TextEntry | null {
  if (!isRecord(raw)) return null
  const { key, shipped, shippedLanguage, override, effective, source } = raw
  if (typeof key !== 'string' || key.length === 0) return null
  if (typeof shipped !== 'string' || typeof effective !== 'string') return null
  if (!isTextLanguage(shippedLanguage) || !isTextLayer(source)) return null
  if (override !== null && typeof override !== 'string') return null
  const placeholders = stringArray(raw['placeholders'])
  const pluralCategories = stringArray(raw['pluralCategories'])
  if (placeholders === null || pluralCategories === null) return null
  return {
    key,
    shipped,
    shippedLanguage,
    override,
    effective,
    source,
    placeholders,
    pluralCategories,
  }
}

/**
 * Narrow the bridge's answer. `null` on anything unexpected — including a hub
 * that has the actions but answered a shape this build does not know.
 */
export function parseTextCatalog(raw: unknown): TextCatalog | null {
  if (!isRecord(raw)) return null
  const { language, activeLanguage } = raw
  if (!isTextLanguage(language) || !isTextLanguage(activeLanguage)) return null
  const languagesRaw = stringArray(raw['languages'])
  if (languagesRaw === null || languagesRaw.length === 0) return null
  const languages: TextLanguage[] = []
  for (const candidate of languagesRaw) {
    // A locale this build does not know is SKIPPED, not fatal: a newer hub
    // shipping `de` must not blank the whole tab for an older admin bundle.
    if (isTextLanguage(candidate)) languages.push(candidate)
  }
  if (languages.length === 0) return null
  const entriesRaw = raw['entries']
  if (!Array.isArray(entriesRaw)) return null
  const entries: TextEntry[] = []
  for (const item of entriesRaw) {
    const entry = parseEntry(item)
    if (entry === null) return null
    entries.push(entry)
  }
  return { language, activeLanguage, languages, entries }
}

/** What the box for this key shows: the operator's draft if he has touched it,
 *  otherwise whatever is in force. */
export function draftValue(entry: TextEntry, drafts: ReadonlyMap<string, string>): string {
  return drafts.get(entry.key) ?? entry.override ?? entry.shipped
}

/**
 * What the operator has actually changed, resolved to the server's vocabulary.
 *
 * A draft that ends up equal to the shipped text — blank, or the shipped
 * sentence typed back in — is a RESET (`null`), never a stored copy. A draft
 * equal to what is already stored is not sent at all: an empty patch is how the
 * Save button knows it has nothing to do.
 */
export function buildOverridePatch(
  entries: readonly TextEntry[],
  drafts: ReadonlyMap<string, string>,
): Readonly<Record<string, string | null>> {
  const patch: Record<string, string | null> = {}
  for (const entry of entries) {
    const draft = drafts.get(entry.key)
    if (draft === undefined) continue
    const desired = draft.trim().length === 0 || draft === entry.shipped ? null : draft
    if (desired === entry.override) continue
    patch[entry.key] = desired
  }
  return patch
}

/** How many rows the Save button is about to write. */
export function countPendingEdits(
  entries: readonly TextEntry[],
  drafts: ReadonlyMap<string, string>,
): number {
  return Object.keys(buildOverridePatch(entries, drafts)).length
}

/**
 * Free-text search over key, shipped text and override.
 *
 * Every word must match somewhere, so `person zone` narrows rather than widens
 * — with 77 keys on one page, a search that ORs is a search that never gets
 * shorter than the list.
 */
export function filterTextEntries(
  entries: readonly TextEntry[],
  query: string,
): readonly TextEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length === 0) return entries
  return entries.filter((entry) => {
    const haystack = `${entry.key}\n${entry.shipped}\n${entry.override ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * The chips under a Texts box: the variables the producer supplies for THIS
 * key, from the hub (`entry.placeholders`). Built as descriptors so the same
 * picker renders them; no group or example is known here, so all sit under
 * one heading and the tooltip says only the name.
 */
export function textsKeyVars(entry: Pick<TextEntry, 'placeholders'>): NcTemplateVarDescriptor[] {
  return entry.placeholders.map((name) => ({
    name,
    label: name,
    example: `{{${name}}}`,
    group: 'rule',
    families: ['rule'],
  }))
}

/**
 * The warning a plural key needs BEFORE it is overridden — one text box cannot
 * express two forms, so an override is printed for every count.
 */
export function pluralWarning(entry: TextEntry): string | null {
  if (entry.pluralCategories.length === 0) return null
  return i18n.t('helpers.notificationTexts.pluralWarning', {
    categories: entry.pluralCategories.join(', '),
  })
}
