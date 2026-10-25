/**
 * How a settings surface re-groups an addon's schema WITHOUT the addon
 * knowing: keep only some fields, drop the section's own title (the surface
 * draws a card title of its own), or move a section onto another tab.
 *
 * It changes where a field is DRAWN, never where it is stored: the keys, their
 * scope and the save path are the addon's. Cluster → Settings uses it to put
 * the face encoder next to the face-matching knobs although two addons own
 * them; the node page uses it to show the decoder on the engine tab.
 */

export interface SectionShape {
  /** Keep only these top-level field keys (a section left empty is dropped). */
  readonly fieldKeys?: readonly string[]
  /** Strip each section's title and description. */
  readonly hideSectionChrome?: boolean
  /** `section.tab` → the tab it is shown on. */
  readonly tabAliases?: Readonly<Record<string, string>>
}

interface ShapeableSection<F> {
  readonly tab?: string
  readonly title: string
  readonly description?: string
  readonly fields: readonly F[]
}

/** The tab a section with `tab` is shown on. */
export function shownTab(tab: string | undefined, aliases?: SectionShape['tabAliases']): string {
  const id = tab ?? 'general'
  return aliases?.[id] ?? id
}

function keyOf(field: unknown): string | null {
  if (typeof field !== 'object' || field === null || !('key' in field)) return null
  return typeof field.key === 'string' ? field.key : null
}

export function shapeSections<F, S extends ShapeableSection<F>>(
  sections: readonly S[],
  shape: SectionShape,
): S[] {
  const keep = shape.fieldKeys !== undefined ? new Set(shape.fieldKeys) : null
  const out: S[] = []
  for (const section of sections) {
    const fields =
      keep === null
        ? section.fields
        : section.fields.filter((f) => {
            const key = keyOf(f)
            return key !== null && keep.has(key)
          })
    if (fields.length === 0) continue
    out.push({
      ...section,
      fields,
      ...(shape.tabAliases !== undefined ? { tab: shownTab(section.tab, shape.tabAliases) } : {}),
      ...(shape.hideSectionChrome === true ? { title: '', description: undefined } : {}),
    })
  }
  return out
}
