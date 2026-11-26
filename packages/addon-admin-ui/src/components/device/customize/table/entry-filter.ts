/**
 * The search and type filter of the device-entry lines of the Customize table
 * (linked devices, linked cameras, triggered-by): the entries an operator scans
 * by name, detail, type or id. Section, notice and every other line are never
 * filtered, so the table keeps its shape while the entries narrow.
 */
import type { DataTableFilterConfig } from '@camstack/ui-library'
import { isLinkedCameraLine } from '../kinds/LinkedCamerasRows'
import { isLinkedDeviceLine } from '../kinds/LinkedDevicesRows'
import { isTriggerLine } from '../triggers/useTriggeredBy'

/** What the search and the type chip read off one entry line. */
export interface EntryFacts {
  readonly name: string
  readonly detail: string
  readonly type: string | null
  readonly id: number
}

/** The facts of an entry line; null for every line that is not a device entry. */
export function entryFactsOf(line: { readonly kind: string }): EntryFacts | null {
  if (isLinkedDeviceLine(line) && line.kind === 'deviceEntry') {
    const { row } = line
    return { name: row.name ?? '', detail: row.detail ?? '', type: row.type, id: row.deviceId }
  }
  if (isTriggerLine(line) && line.kind === 'triggerEntry') {
    const { row } = line
    return { name: row.name ?? '', detail: row.detail ?? '', type: row.type, id: row.deviceId }
  }
  if (isLinkedCameraLine(line) && line.kind === 'cameraEntry') {
    const { camera } = line
    return { name: camera.name, detail: camera.location ?? '', type: camera.type, id: camera.id }
  }
  return null
}

export interface EntryFilterRow<L> {
  readonly line: L
  readonly facts: EntryFacts
}

/** The entry lines of `lines`, each with its facts. */
export function entryRowsOf<L extends { readonly kind: string }>(
  lines: readonly L[],
): readonly EntryFilterRow<L>[] {
  return lines.flatMap((line) => {
    const facts = entryFactsOf(line)
    return facts === null ? [] : [{ line, facts }]
  })
}

/** The filter config over entry rows; `typeLabel` turns a device type into the chip label. */
export function entryFilterConfig<L>(
  typeLabel: (type: string) => string,
): DataTableFilterConfig<EntryFilterRow<L>> {
  return {
    searchText: ({ facts }) => [facts.name, facts.detail, facts.type ?? '', String(facts.id)],
    facetValue: ({ facts }) => (facts.type === null ? '—' : typeLabel(facts.type)),
  }
}

/** `lines` without the entry lines the filter dropped (every other line stays, in order). */
export function withoutFilteredEntries<L extends { readonly kind: string }>(
  lines: readonly L[],
  kept: readonly { readonly line: object }[],
): readonly L[] {
  const keptLines = new Set<object>(kept.map((row) => row.line))
  return lines.filter((line) => entryFactsOf(line) === null || keptLines.has(line))
}
