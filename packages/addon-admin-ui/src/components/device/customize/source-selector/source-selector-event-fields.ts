import type { WireableCatalog } from '../source-picker-model'
import { formatLiveValue, readPath } from '../source-picker-model'
import type { EventShape } from '../event/event-fit'
import { pulseFieldFits } from '../event/event-fit'
import { declarationSourceForField, scalarFieldOffers } from '../scalar/scalar-fit'
import {
  destinationSources,
  type SourceDestination,
  type SourceWireableField,
} from './source-selector-model'

export function wireableEventFields(
  destination: SourceDestination,
  catalog: WireableCatalog,
  shape: EventShape,
  snapshotAnswered: boolean,
  snapshot: Readonly<Record<string, Readonly<Record<string, unknown>>>> | null,
): readonly SourceWireableField[] {
  const sources = destinationSources(destination)
  if (sources.length === 0) return []
  const offers = scalarFieldOffers(catalog, snapshot).filter((row) => row.kind === 'boolean')
  const rows: SourceWireableField[] = []
  for (const offer of offers) {
    if (declarationSourceForField(sources, offer) === null) continue
    if (shape === 'pulse' && !pulseFieldFits(catalog, offer.cap, offer.path)) continue
    const value = snapshot === null ? undefined : readPath(snapshot[offer.cap], offer.path)
    rows.push({
      cap: offer.cap,
      path: offer.path,
      kind: 'boolean',
      unit: null,
      currentText: formatLiveValue(value, snapshotAnswered),
    })
  }
  return rows
}
