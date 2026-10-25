#!/usr/bin/env tsx
/**
 * Notification-Center text-catalog guard — the shipped locales must agree.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * The catalog resolves a key through `override → file[lang] → file[en]`, and
 * renders whatever it finds through a single-pass `{{var}}` substitution where
 * a missing name renders EMPTY. Both of those degrade silently, which is
 * correct at runtime and terrible as a development experience:
 *
 *   1. A key added to `en.json` and forgotten in `it.json` delivers the ENGLISH
 *      sentence to an Italian household. Nothing logs, nothing throws, and the
 *      only symptom is one notification in the wrong language — which reads
 *      exactly like an operator who set the language wrong.
 *   2. A key whose translation drops a placeholder (`{{deviceId}}`, `{{count}}`)
 *      delivers a sentence with a HOLE in it: "La camera è offline". A missing
 *      variable renders empty by design, so the notification goes out looking
 *      almost right.
 *   3. A plural map with a category the language does not have — `two` in
 *      Italian, `many` in English — is a variant `Intl.PluralRules` will never
 *      select. It is dead text that looks like coverage, and the count it was
 *      meant for silently falls through to `other`.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 * It does not compare source text — it runs the real `Intl` the catalog runs:
 *
 *   KEY PARITY        every key present in every shipped locale, both ways.
 *   PLACEHOLDER SETS  the `{{name}}` set of a key is IDENTICAL across locales
 *                     and across the plural variants of one value. (Identical,
 *                     not a subset: a placeholder present in one language and
 *                     absent in another means one of the two is missing a fact.)
 *   PLURAL CATEGORIES every category of a plural value is one that
 *                     `Intl.PluralRules(<that language>)` actually resolves,
 *                     and `other` is always present — it is the fallback the
 *                     catalog uses for a count-less lookup.
 *   NON-EMPTY         no blank value. A key that renders empty is a
 *                     notification with nothing in it.
 *
 * Usage: npx tsx scripts/check-nc-text-catalog.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NC_TEMPLATE_VARS } from '../packages/types/src/notification/template-vars.js'

const TEXTS_DIR = join(process.cwd(), 'packages/addon-post-analysis/src/notification-center/texts')

/** Must mirror `NC_LANGUAGES` — a locale added there and not here is unchecked. */
const LANGUAGES = ['en', 'it'] as const
type Language = (typeof LANGUAGES)[number]

/** The reference locale: the last link of the catalog's fallback chain. */
const REFERENCE: Language = 'en'

type TextValue = string | Record<string, string>
type Bundle = Record<string, TextValue>

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g

const problems: string[] = []

function fail(message: string): void {
  problems.push(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadBundle(language: Language): Bundle {
  const path = join(TEXTS_DIR, `${language}.json`)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) {
    fail(`${language}.json is not an object`)
    return {}
  }
  const bundle: Bundle = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      bundle[key] = value
      continue
    }
    if (!isRecord(value)) {
      fail(`${language}.json: "${key}" is neither a string nor a plural map`)
      continue
    }
    const variants: Record<string, string> = {}
    for (const [category, text] of Object.entries(value)) {
      if (typeof text !== 'string') {
        fail(`${language}.json: "${key}".${category} is not a string`)
        continue
      }
      variants[category] = text
    }
    bundle[key] = variants
  }
  return bundle
}

/** Every `{{name}}` in a value, across all its plural variants, as a set. */
function placeholdersOf(value: TextValue): ReadonlySet<string> {
  const texts = typeof value === 'string' ? [value] : Object.values(value)
  const names = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return names
}

function sorted(set: ReadonlySet<string>): string {
  return [...set].toSorted().join(', ')
}

const bundles = new Map<Language, Bundle>()
for (const language of LANGUAGES) bundles.set(language, loadBundle(language))

const reference = bundles.get(REFERENCE) ?? {}
const referenceKeys = Object.keys(reference).toSorted()

if (referenceKeys.length === 0) fail(`${REFERENCE}.json carries no keys at all`)

// ── Key parity, both directions ────────────────────────────────────────────
for (const language of LANGUAGES) {
  if (language === REFERENCE) continue
  const bundle = bundles.get(language) ?? {}
  for (const key of referenceKeys) {
    if (!(key in bundle))
      fail(`${language}.json is MISSING "${key}" (present in ${REFERENCE}.json)`)
  }
  for (const key of Object.keys(bundle)) {
    if (!(key in reference))
      fail(`${language}.json has EXTRA "${key}" (absent from ${REFERENCE}.json)`)
  }
}

// ── Per-key: placeholders, plural categories, non-emptiness ────────────────
for (const language of LANGUAGES) {
  const bundle = bundles.get(language) ?? {}
  const plural = new Intl.PluralRules(language)
  const allowed = new Set(plural.resolvedOptions().pluralCategories)

  for (const [key, value] of Object.entries(bundle)) {
    const texts = typeof value === 'string' ? [value] : Object.values(value)
    for (const text of texts) {
      if (text.trim().length === 0) fail(`${language}.json: "${key}" is blank`)
    }

    if (typeof value !== 'string') {
      const categories = Object.keys(value)
      if (categories.length === 0) fail(`${language}.json: "${key}" is an empty plural map`)
      if (!categories.includes('other')) {
        fail(
          `${language}.json: "${key}" has no "other" variant — it is the fallback for a count-less lookup`,
        )
      }
      for (const category of categories) {
        if (!allowed.has(category)) {
          fail(
            `${language}.json: "${key}" has plural category "${category}", which Intl.PluralRules('${language}') never selects (it resolves ${[...allowed].toSorted().join(', ')})`,
          )
        }
      }
      // A plural map whose variants disagree about placeholders renders one
      // count with a hole in it — the same defect as a bad translation, inside
      // a single locale.
      const perVariant = new Map<string, string>()
      for (const [category, text] of Object.entries(value)) {
        perVariant.set(category, sorted(placeholdersOf(text)))
      }
      const distinct = new Set(perVariant.values())
      if (distinct.size > 1) {
        const detail = [...perVariant].map(([c, p]) => `${c}: {${p}}`).join(' vs ')
        fail(`${language}.json: "${key}" plural variants disagree on placeholders — ${detail}`)
      }
    }

    if (language === REFERENCE) continue
    const referenceValue = reference[key]
    if (referenceValue === undefined) continue
    const mine = placeholdersOf(value)
    const theirs = placeholdersOf(referenceValue)
    if (sorted(mine) !== sorted(theirs)) {
      fail(
        `${language}.json: "${key}" placeholders {${sorted(mine)}} ≠ ${REFERENCE}.json {${sorted(theirs)}}`,
      )
    }
  }
}

// ── Every placeholder is a DECLARED variable ──────────────────────────────
//
// A shipped sentence naming a variable no producer supplies renders a gap on
// every phone, silently (a missing var renders EMPTY by design). The catalog
// in `@camstack/types` is the declared vocabulary; the parity specs prove the
// producers supply it. So a placeholder outside it is a bug in the text.
//
// SCOPE, named rather than silently skipped: this only checks keys the
// DISPATCHER renders as a title/body DEFAULT (`buildTemplateVars`,
// dispatcher.ts) — the six prefixes below. Other shipped keys are rendered
// by a DIFFERENT producer, with its OWN params, never the catalog:
//   - `detection.subject` / `.identity` / `.labelled` / `.plate` — composed
//     by `ncSubjectText` (text-compose.ts) from `{ classNoun, label }` and
//     folded into the dispatcher's `{{subject}}` before the one render pass.
//     `classNoun` is never a template variable.
//   - `class.*` — `ncClassNoun` (text-compose.ts), its own `{ name }`.
//   - `group.others.*` — the grouping composer, its own `{ count, classNoun }`.
//   - `alarm.*`, `button.*`, `action.*` — the alarm/button composers
//     (rule-engine.ts, action-buttons.ts, addon-update-buttons.ts,
//     server-update-buttons.ts), each with its own params.
//   - `snooze.*` — the snooze digest (snooze-digest.ts), its own
//     `{ scope, from, to, count, camera, rule, total, hours, minutes }`.
//   - `test.prefix` — the dispatcher's marker wrapper, `{ body }` only.
const DISPATCHER_TEXT_PREFIXES = [
  'detection.',
  'package.',
  'occupancy.',
  'system.',
  'timelapse.',
  'summary.',
]
// The one carve-out INSIDE a dispatcher prefix: these `detection.subject*`
// keys are not a dispatcher title/body default — they are fragments the
// SUBJECT composer renders on its own, from `{ classNoun, label }` (see the
// scope comment above).
const COMPOSER_OWN_VOCAB_KEYS = new Set([
  'detection.subject',
  'detection.subject.identity',
  'detection.subject.labelled',
  'detection.subject.plate',
])
// The STATE-SUMMARY composer (D647, `state-summary/state-summary.ts`) renders
// the `summary.line.*` and `summary.section.unavailable` fragments ITSELF, one
// per open item, before the dispatcher sees the result as a
// `summary<Section>` variable. A line's params are the instant event's
// `textParams` — the declared vocabulary, still checked below — plus ONE name
// the composer adds: `since` (`lineOf`), the worded time the state opened.
// `summary.section.unavailable` is filled with `{ section }` (`blockOf`),
// the section's own title. These are the only names allowed beyond the
// catalog, and only on the keys whose composer supplies them; every other
// placeholder in these keys is still held to the declared vocabulary.
const COMPOSER_EXTRA_VARS: readonly {
  readonly keyPrefix: string
  readonly names: readonly string[]
}[] = [
  { keyPrefix: 'summary.line.', names: ['since'] },
  { keyPrefix: 'summary.section.unavailable', names: ['section'] },
]
function composerExtraVars(key: string): ReadonlySet<string> {
  return new Set(
    COMPOSER_EXTRA_VARS.filter((c) => key.startsWith(c.keyPrefix)).flatMap((c) => c.names),
  )
}
const declared = new Set(NC_TEMPLATE_VARS.filter((d) => d.dynamic === undefined).map((d) => d.name))
const dynamicPrefixes = NC_TEMPLATE_VARS.flatMap((d) =>
  d.dynamic !== undefined ? [d.dynamic.prefix] : [],
)
for (const key of referenceKeys) {
  if (!DISPATCHER_TEXT_PREFIXES.some((p) => key.startsWith(p))) continue
  if (COMPOSER_OWN_VOCAB_KEYS.has(key)) continue
  const value = reference[key]
  if (value === undefined) continue
  const extra = composerExtraVars(key)
  for (const name of placeholdersOf(value)) {
    if (declared.has(name) || extra.has(name) || dynamicPrefixes.some((p) => name.startsWith(p)))
      continue
    fail(
      `${REFERENCE}.json: "${key}" names {{${name}}}, which no template variable declares (packages/types/src/notification/template-vars.ts)`,
    )
  }
}

if (problems.length > 0) {
  console.error('✖ NC text catalog guard failed:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    `\n${problems.length} problem(s). The catalog degrades SILENTLY on every one of these — an English sentence in an Italian notification, a hole where a camera id should be, or a plural variant nothing selects.`,
  )
  process.exit(1)
}

console.log(
  `✔ NC text catalog: ${referenceKeys.length} keys × ${LANGUAGES.length} locales — parity, placeholders and plural categories all agree`,
)
