/**
 * The pure half of the unified System → Data record view: one row per declared
 * record kind (entry kinds included), the facet dimensions an operator filters
 * on, and the text the search matches. No React, no queries.
 */
import type { EntryKindInfo, StorageKind } from '@camstack/types'
import type { DataTableFacetGroupConfig } from '../data-table-filter'

/** One table row: a declared kind, plus the entry catalog's title when it is an entry kind. */
export interface DataRecordRow {
  readonly kind: StorageKind
  /** `null` when the kind is not an entry kind, or the entry catalog has not answered / lacks it. */
  readonly entryTitle: string | null
}

export type DataRecordType = 'entry' | 'record'
export type DataRecordContents = 'has-rows' | 'empty' | 'unknown'

export function dataRecordKey(kind: Pick<StorageKind, 'owner' | 'kind'>): string {
  return `${kind.owner}/${kind.kind}`
}

export function dataRecordType(kind: StorageKind): DataRecordType {
  return kind.entry ? 'entry' : 'record'
}

/** `unknown` is a kind whose count was not asked for or could not be read — never "empty". */
export function dataRecordContents(kind: StorageKind): DataRecordContents {
  if (kind.rows === null) return 'unknown'
  return kind.rows > 0 ? 'has-rows' : 'empty'
}

/**
 * Join the declared kinds with the entry catalog. A pending/failed catalog
 * (`undefined`) leaves titles `null`; it never changes which kinds are listed.
 */
export function buildDataRecordRows(
  kinds: readonly StorageKind[],
  entryKinds: readonly EntryKindInfo[] | undefined,
): readonly DataRecordRow[] {
  const titles = new Map<string, string>()
  for (const entry of entryKinds ?? []) titles.set(dataRecordKey(entry), entry.title)
  return kinds.map((kind) => ({
    kind,
    entryTitle: kind.entry ? (titles.get(dataRecordKey(kind)) ?? null) : null,
  }))
}

export const DATA_RECORD_FACET_GROUPS: readonly DataTableFacetGroupConfig<DataRecordRow>[] = [
  { id: 'kind', value: (row) => dataRecordKey(row.kind) },
  { id: 'owner', value: (row) => row.kind.owner },
  { id: 'type', value: (row) => dataRecordType(row.kind) },
  { id: 'database', value: (row) => row.kind.database },
  { id: 'class', value: (row) => row.kind.class },
  { id: 'state', value: (row) => row.kind.state },
  { id: 'contents', value: (row) => dataRecordContents(row.kind) },
]

export function dataRecordSearchText(row: DataRecordRow): readonly string[] {
  const { kind } = row
  return [kind.owner, kind.kind, kind.class, kind.database, kind.state, row.entryTitle ?? '']
}
