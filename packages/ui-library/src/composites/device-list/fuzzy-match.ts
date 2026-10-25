/**
 * fuzzy-match — case and separator-insensitive text search helper.
 *
 * Normalization rule: lowercase + strip all runs of hyphens, underscores and
 * whitespace entirely.  This makes `Tapparella kitchen` and `tapparella-kitchen`
 * both normalize to `tapparellakitchen`, so a substring match succeeds in
 * either direction.
 */

/**
 * Strips hyphens, underscores and whitespace runs from `s` and lowercases it.
 *
 * @example
 * normalizeForSearch('Tapparella kitchen') // 'tapparellakitchen'
 * normalizeForSearch('tapparella-kitchen') // 'tapparellakitchen'
 * normalizeForSearch('tapparella_kitchen') // 'tapparellakitchen'
 */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, '')
}

/**
 * Returns `true` when the normalized form of `target` contains the normalized
 * form of `query`.  An empty query always matches.
 *
 * @example
 * fuzzyMatch('Tapparella kitchen', 'tapparella-kitchen') // true
 * fuzzyMatch('tapparella kitchen', 'Tapparella-Kitchen') // true
 * fuzzyMatch('xyz', 'tapparella-kitchen')               // false
 */
export function fuzzyMatch(query: string, target: string): boolean {
  const nq = normalizeForSearch(query)
  if (nq === '') return true
  return normalizeForSearch(target).includes(nq)
}
