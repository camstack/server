/** Reading the bracketed lists of the NC mirror guard (`scripts/check-nc-mirrors-in-sync.ts`). */

export interface ListSource {
  readonly path: string
  /** The list starts at the first `[` after this marker. */
  readonly marker: string
}

/**
 * Comments out of the way before a list is read as text: an enum documented
 * member by member (`NcSystemEventKindSchema`) carries apostrophes and
 * brackets in its comments, and a reader that saw them would read the prose.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The string literals of the bracketed list after `marker`, or an error line. */
export function literals(
  src: string,
  source: ListSource,
  allowEmpty = false,
): readonly string[] | string {
  const at = src.indexOf(source.marker)
  if (at === -1) return `${source.path}: \`${source.marker}\` not found`
  const code = stripComments(src.slice(at + source.marker.length))
  // The one legitimate empty list is the literal `= []` right after the marker
  // (a held-back list whose every viewer OTA is installed). Anything else that
  // reads as empty — a list the read missed, an unparseable declaration — errors.
  if (allowEmpty && /^\s*\[\s*\]/.test(code)) return []
  const open = code.indexOf('[')
  const close = open === -1 ? -1 : code.indexOf(']', open)
  if (open === -1 || close === -1) return `${source.path}: no [...] list after \`${source.marker}\``
  const items = [...code.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  if (items.length === 0)
    return `${source.path}: the list after \`${source.marker}\` is empty — the read is broken`
  return items
}
