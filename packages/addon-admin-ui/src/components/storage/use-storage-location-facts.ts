/**
 * What the Storage table knows about a location beyond its instance record: the volume's capacity,
 * CamStack's own share of it, and how far a draining location has got. The three reads are the
 * ones the page always made; each cell asks for them, and react-query serves one request.
 */
import type { StorageLocation } from '@camstack/types'
import {
  useRecordingArchiveGetStorageUsage,
  useStorageListDrainProgress,
  useStorageListLocations,
} from '@camstack/ui-library'
import { useMemo } from 'react'
import {
  type DrainDisplay,
  describeDrain,
  isLocationDraining,
  toDrainProgressById,
} from './drain-progress'
import { ownedBytesByLocation } from './location-owned-usage'

export interface StorageLocationFacts {
  readonly locations: readonly StorageLocation[]
  readonly ownedBytesById: ReadonlyMap<string, number>
  /** The drain state of one location (`idle` for one that is not draining). */
  readonly drainOf: (location: StorageLocation) => DrainDisplay
}

const NO_LOCATIONS: readonly StorageLocation[] = []

export function useStorageLocationFacts(): StorageLocationFacts {
  const locationsQuery = useStorageListLocations({})
  const usage = useRecordingArchiveGetStorageUsage({}, { refetchOnWindowFocus: false })
  // A hub that does not know the method leaves this empty and the row says so: the figure is
  // withheld, never invented.
  const drain = useStorageListDrainProgress({}, { refetchOnWindowFocus: false })
  const locations = locationsQuery.data ?? NO_LOCATIONS
  const ownedBytesById = useMemo(
    () => ownedBytesByLocation(locations, usage.data?.locations),
    [locations, usage.data?.locations],
  )
  const drainById = useMemo(() => toDrainProgressById(drain.data), [drain.data])
  return useMemo(
    () => ({
      locations,
      ownedBytesById,
      drainOf: (location) =>
        describeDrain(isLocationDraining(location), drainById.get(location.id)),
    }),
    [locations, ownedBytesById, drainById],
  )
}
