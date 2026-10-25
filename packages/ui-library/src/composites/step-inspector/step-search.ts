/**
 * The step matrix's filter (`/`): a step matches by its name, or by any of its
 * field labels — so a question about a knob ("face size", "person") finds the
 * step that owns it, and says which field it matched.
 */

export interface StepSearchRow {
  readonly addonId: string
  readonly name: string
  /** Every field label of the step, cluster-owned ones included. */
  readonly fieldLabels: readonly string[]
}

export interface StepSearchHit {
  readonly addonId: string
  /** The field label the query matched; absent for a name match. */
  readonly matchedField?: string
}

function matches(text: string, tokens: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return tokens.every((t) => lower.includes(t))
}

/** Steps matching `query` (all tokens in the name, or all in one field label). Empty query = all. */
export function searchSteps(
  rows: readonly StepSearchRow[],
  query: string,
): readonly StepSearchHit[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return rows.map((row) => ({ addonId: row.addonId }))
  const hits: StepSearchHit[] = []
  for (const row of rows) {
    if (matches(row.name, tokens)) {
      hits.push({ addonId: row.addonId })
      continue
    }
    const field = row.fieldLabels.find((l) => matches(l, tokens))
    if (field !== undefined) hits.push({ addonId: row.addonId, matchedField: field })
  }
  return hits
}
