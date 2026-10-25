/**
 * Case- and diacritic-insensitive text normalization, shared by every
 * client-side search/filter in this package (see `global-search.ts`).
 *
 * Accented vs plain must match (e.g. Italian "Perche" against "Perché").
 * `String.prototype.normalize('NFD')` decomposes an accented character into
 * its base letter plus a combining mark; `\p{Mn}` (Unicode property escape
 * for "Mark, nonspacing") matches any such combining mark so we don't have
 * to hand-enumerate a codepoint range.
 */
const COMBINING_MARKS = /\p{Mn}/gu

export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim()
}
