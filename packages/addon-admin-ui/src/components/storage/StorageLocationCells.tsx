/**
 * The two cells the Storage table adds to the shared instance columns: the volume's capacity (with
 * CamStack's share and, for a draining location, how far it has got) and the location's one typed
 * state (D385). Both read the location behind the row; a row whose location is not in the list
 * yet draws nothing rather than a zero.
 */
import { Badge } from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import type { ReactElement } from 'react'
import type { PanelRow } from '../instances/instances-model'
import { DrainProgressLine } from './DrainProgressLine'
import { LocationCapacityBar } from './LocationCapacityBar'
import { locationModeChoice, resolveLocationMode } from './location-mode'
import { useStorageLocationFacts } from './use-storage-location-facts'

function CapacityCell({ row }: { readonly row: PanelRow }): ReactElement | null {
  const facts = useStorageLocationFacts()
  if (row.kind !== 'instance') return null
  const location = facts.locations.find((l) => l.id === row.id)
  if (location === undefined) return null
  const drain = facts.drainOf(location)
  return (
    <div className="min-w-48">
      <LocationCapacityBar
        location={location}
        ownedBytes={facts.ownedBytesById.get(location.id) ?? null}
      />
      {drain.kind !== 'idle' && <DrainProgressLine drain={drain} />}
    </div>
  )
}

function ModeCell({ row }: { readonly row: PanelRow }): ReactElement | null {
  const facts = useStorageLocationFacts()
  if (row.kind !== 'instance') return null
  const location = facts.locations.find((l) => l.id === row.id)
  if (location === undefined) return null
  const mode = resolveLocationMode(location)
  return (
    <Badge variant={mode === 'active' ? 'success' : mode === 'disabled' ? 'danger' : 'default'}>
      {locationModeChoice(mode).label}
    </Badge>
  )
}

export function storageColumns(labels: {
  readonly capacity: string
  readonly mode: string
}): readonly DataColumn<PanelRow>[] {
  return [
    {
      key: 'capacity',
      header: labels.capacity,
      notSortableReason: labels.capacity,
      render: (row) => <CapacityCell row={row} />,
    },
    {
      key: 'mode',
      header: labels.mode,
      nowrap: true,
      notSortableReason: labels.mode,
      render: (row) => <ModeCell row={row} />,
    },
  ]
}
