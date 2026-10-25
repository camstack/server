/**
 * icon-catalog — THE icon vocabulary (D854).
 *
 * Every place that picks or stores an icon — a device's display override, a
 * location, a site zone, a viewer accessory, an `icon` settings field — names
 * it by a key of this catalog and nothing else. There is no curated subset and
 * no second list: the catalog is every lucide icon that both surfaces can draw
 * (the admin UI's `lucide-react` and the viewer's `lucide-react-native`), the
 * intersection computed by `scripts/generate-icon-catalog.ts` into the
 * committed `icon-catalog.generated.ts`.
 *
 * Like the vocabularies it replaces, this module holds STRINGS only — no React,
 * no lucide import, no glyph. Each surface owns its glyph table (the web one
 * lives in `ui-library`, loaded lazily), and a test on each side pins that it
 * covers {@link ICON_KEYS}.
 *
 * ## What is persisted
 *
 * The canonical kebab-case lucide id ({@link IconKey}). Spellings that a lucide
 * package still accepts (`home` for `house`) and this repo's own legacy ones
 * (`gauge2`) RESOLVE ({@link canonicalIconKey}) so a stored value never goes
 * stale, but they are never OFFERED by search.
 *
 * ## Search
 *
 * Over the key, the Italian/English overlay in `icon-synonyms.ts`, any words
 * the caller adds, and lucide's English tags — in that order of weight.
 */
import { z } from 'zod'
import { ICON_ALIASES, ICON_CATEGORY_IDS, ICON_KEYS, ICON_META } from './icon-catalog.generated.js'
import { ICON_SYNONYMS, LEGACY_ICON_ALIASES } from './icon-synonyms.js'

export { ICON_CATALOG_SOURCE, ICON_KEYS, ICON_VIEWER_MODULES } from './icon-catalog.generated.js'

/** One catalog key — the kebab-case lucide id that is PERSISTED. */
export type IconKey = (typeof ICON_KEYS)[number]

/** One lucide category id. */
export type IconCategoryId = (typeof ICON_CATEGORY_IDS)[number]

/** One icon of the catalog. */
export interface IconEntry {
  readonly key: IconKey
  /** Lucide categories; the first is the primary one a picker files it under. */
  readonly categories: readonly IconCategoryId[]
  readonly primaryCategory: IconCategoryId
  /** Lucide's English search tags. */
  readonly tags: readonly string[]
  /** The hand-maintained Italian/English words (`icon-synonyms.ts`). */
  readonly synonyms: readonly string[]
}

const KEY_SET: ReadonlySet<string> = new Set<string>(ICON_KEYS)

const ALIAS_TO_KEY: ReadonlyMap<string, IconKey> = new Map<string, IconKey>([
  ...Object.entries(ICON_ALIASES),
  ...Object.entries(LEGACY_ICON_ALIASES),
])

/** Is this a canonical key of the catalog? (An alias is not — see {@link canonicalIconKey}.) */
export function isIconKey(value: unknown): value is IconKey {
  return typeof value === 'string' && KEY_SET.has(value)
}

/**
 * A stored value as a catalog key: the key itself, the key a still-accepted or
 * legacy spelling stands for, or `undefined` — never a guess.
 */
export function canonicalIconKey(value: unknown): IconKey | undefined {
  if (typeof value !== 'string') return undefined
  if (isIconKey(value)) return value
  return ALIAS_TO_KEY.get(value)
}

/**
 * A stored icon value as a catalog key: its canonical key when it is (or
 * aliases) one, `fallback` otherwise. For an `icon` settings field whose stored
 * value may predate the catalog (a free-text lucide name) — the field's default
 * is drawn rather than nothing.
 */
export function resolveIconKey<F extends string>(value: unknown, fallback: F): IconKey | F {
  return canonicalIconKey(value) ?? fallback
}

/**
 * Wire/storage schema for one icon key.
 *
 * Deliberately NOT a `z.enum` of the catalog: ~1,700 literals would be inlined
 * into every cap router, type and API-reference row that carries an icon. The
 * check is membership in the catalog and the type is {@link IconKey}.
 */
export const IconKeySchema = z.custom<IconKey>(isIconKey, 'Not an icon of the catalog')

// The schema is built FROM the type (a `z.custom` membership check), so the
// type cannot be `z.infer` of it; the bidirectional pin keeps them one shape.
type IconKeyInferred = z.infer<typeof IconKeySchema>
const _iconKeySchemaMatchesType = {} as IconKeyInferred satisfies IconKey
const _iconKeyTypeMatchesSchema = {} as IconKey satisfies IconKeyInferred
void _iconKeySchemaMatchesType
void _iconKeyTypeMatchesSchema

// ── Entries ─────────────────────────────────────────────────────────

const ENTRIES: readonly IconEntry[] = ICON_KEYS.map((key, index) => {
  const [categoryIndexes, tags] = ICON_META[index] ?? [[], []]
  const categories = categoryIndexes.flatMap((i) => {
    const id = ICON_CATEGORY_IDS[i]
    return id === undefined ? [] : [id]
  })
  return {
    key,
    categories,
    primaryCategory: categories[0] ?? ICON_CATEGORY_IDS[0],
    tags,
    synonyms: ICON_SYNONYMS[key] ?? [],
  }
})

const ENTRY_BY_KEY: ReadonlyMap<string, IconEntry> = new Map(ENTRIES.map((e) => [e.key, e]))

/** The entry for a canonical key, or `undefined`. */
export function iconEntry(key: string): IconEntry | undefined {
  return ENTRY_BY_KEY.get(key)
}

/** Every entry, in key order. */
export const ICON_ENTRIES: readonly IconEntry[] = ENTRIES

// ── Categories ──────────────────────────────────────────────────────

/** Categories a picker offers first: the ones this product's icons mostly live in. */
const LEADING_CATEGORIES: readonly IconCategoryId[] = [
  'devices',
  'home',
  'security',
  'buildings',
  'connectivity',
  'multimedia',
  'nature',
  'weather',
  'transportation',
  'animals',
]

const PRIMARY_CATEGORIES: ReadonlySet<IconCategoryId> = new Set(
  ENTRIES.map((e) => e.primaryCategory),
)

/**
 * The categories a picker files icons under, in picker order: the leading ones,
 * then the rest alphabetically. Only categories that are some icon's PRIMARY
 * one — a category lucide lists only as a secondary has no section of its own.
 */
export const ICON_CATEGORIES: readonly IconCategoryId[] = [
  ...LEADING_CATEGORIES,
  ...ICON_CATEGORY_IDS.filter((c) => !LEADING_CATEGORIES.includes(c)),
].filter((c) => PRIMARY_CATEGORIES.has(c))

/** The icons filed under a category as their PRIMARY one, in key order. */
export function iconsInCategory(category: IconCategoryId): readonly IconEntry[] {
  return ENTRIES.filter((e) => e.primaryCategory === category)
}

// ── Search ──────────────────────────────────────────────────────────

/** One search result: the entry, and how strongly it matched. */
export interface IconHit {
  readonly entry: IconEntry
  readonly score: number
}

function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .trim()
}

/** Does `needle` appear in `haystack` in order, though not adjacently? */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/**
 * How well one word answers the query. 0 = not at all. An exact word beats a
 * prefix, a prefix beats a word STARTING inside the phrase, and a loose
 * subsequence comes last because it matches almost anything.
 */
function scoreWord(query: string, word: string, loose: boolean): number {
  if (word === query) return 100
  if (word.startsWith(query)) return 80
  if (word.split(' ').some((w) => w.startsWith(query))) return 60
  if (word.includes(query)) return 40
  if (loose && isSubsequence(query, word)) return 15
  return 0
}

interface SearchWords {
  readonly key: string
  readonly synonyms: readonly string[]
  readonly tags: readonly string[]
}

const WORDS_CACHE = new Map<IconKey, SearchWords>()

/** Normalised once per entry — search runs on every keystroke over ~1,700 entries. */
function wordsOf(entry: IconEntry): SearchWords {
  const cached = WORDS_CACHE.get(entry.key)
  if (cached !== undefined) return cached
  const built: SearchWords = {
    key: normalise(entry.key),
    synonyms: entry.synonyms.map(normalise),
    tags: entry.tags.map(normalise),
  }
  WORDS_CACHE.set(entry.key, built)
  return built
}

/**
 * Rank the catalog against a free-text query.
 *
 * An empty query returns the WHOLE catalog in key order, because a picker's
 * resting state is the full list. `extraWords` lets a caller add the words IT
 * can translate without this module knowing what a locale is; they score like a
 * synonym. The key outranks a synonym, a synonym outranks a lucide tag, and
 * ties keep key order so the list does not reshuffle between keystrokes.
 */
export function searchIcons(
  query: string,
  extraWords?: ReadonlyMap<string, readonly string[]>,
): readonly IconHit[] {
  const q = normalise(query)
  if (q.length === 0) return ENTRIES.map((entry) => ({ entry, score: 0 }))
  const hits: IconHit[] = []
  for (const entry of ENTRIES) {
    const words = wordsOf(entry)
    const keyScore = scoreWord(q, words.key, true)
    let best = keyScore > 0 ? keyScore + 2 : 0
    for (const word of [...words.synonyms, ...(extraWords?.get(entry.key) ?? []).map(normalise)]) {
      const score = scoreWord(q, word, true)
      if (score > 0 && score + 1 > best) best = score + 1
    }
    for (const word of words.tags) {
      const score = scoreWord(q, word, false)
      if (score > best) best = score
    }
    if (best > 0) hits.push({ entry, score: best })
  }
  return hits.toSorted((a, b) => b.score - a.score)
}

/** A readable label derived from a lucide category id (`food-beverage` → `Food beverage`). */
export function iconCategoryLabel(category: IconCategoryId): string {
  const spaced = category.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
