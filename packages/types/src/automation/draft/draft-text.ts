/**
 * Text matching shared by the vocabulary slice and the few-shot picker:
 * lower-cased, accent-free word tokens, and a match that tolerates the
 * Italian/English inflections a description carries ("luci" ~ "luce").
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'when',
  'then',
  'with',
  'for',
  'from',
  'that',
  'this',
  'not',
  'are',
  'all',
  'del',
  'della',
  'dei',
  'delle',
  'nel',
  'nella',
  'con',
  'per',
  'che',
  'una',
  'uno',
  'gli',
  'alle',
  'allo',
  'sul',
  'sulla',
  'quando',
  'poi',
  'anche',
  'sono',
  'ogni',
  'tutte',
  'tutti',
])

const MIN_PREFIX = 4

export function tokenize(text: string): readonly string[] {
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const tokens = plain.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  return [...new Set(tokens)]
}

/** Equal, or one starts with the other and they share at least {@link MIN_PREFIX} characters. */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  return shorter.length >= MIN_PREFIX && longer.startsWith(shorter)
}

/** How many of `needles` match some token of `haystack`. */
export function overlap(needles: readonly string[], haystack: readonly string[]): number {
  let hits = 0
  for (const n of needles) {
    if (haystack.some((h) => tokensMatch(n, h))) hits += 1
  }
  return hits
}

/** Jaccard-like similarity of two texts, 0..1, over matched tokens. */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const hits = overlap(ta, tb)
  return hits / (ta.length + tb.length - hits)
}
