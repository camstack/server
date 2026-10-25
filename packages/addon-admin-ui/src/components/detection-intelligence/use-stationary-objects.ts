/**
 * useStationaryObjects — PARKED (stationary) objects for the Events page's
 * dedicated "Stationary" section. Reading the occupancy snapshot's additive
 * `stationaryObjects` field keeps parked cars/bikes OUT of the live event feed
 * (they never became key events) while still showing them to the operator.
 *
 * **One query for the whole selection, not one per camera.** This used to be a
 * `useQueries` fan-out: one React Query, one tRPC operation and one browser →
 * hub → post-analysis round trip PER CAMERA, every 15 seconds, to read a
 * `Map.get` in the owner. `zoneAnalytics.getCurrentSnapshotBatch` asks the same
 * question of the set in one call — the owner does exactly the per-device work
 * it did before, in the process that already holds the data.
 *
 * The poll STAYS. This is a live-status surface and an operator wanting it live
 * is right; what changed is the size of the question, not how often it is asked.
 *
 * **A camera that could not be read is counted, never shown as empty.** The
 * batch row carries `read: 'read' | 'unreadable'`, and only a row that was READ
 * contributes (or fails to contribute) parked objects. Collapsing the two would
 * render an unreachable camera exactly like a camera with nothing parked, which
 * is a definite claim nobody made.
 */
import type { StationaryObject } from '@camstack/types'
import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'

const POLL_MS = 15_000

export interface StationaryRow extends StationaryObject {
  readonly deviceId: number
}

export interface StationaryFeed {
  readonly rows: readonly StationaryRow[]
  readonly isLoading: boolean
  /** Cameras the owner could not answer for. Reported, never silently dropped. */
  readonly unreadableCount: number
}

/** What one batch answer yields once the unreadable rows are separated out. */
interface StationaryBatch {
  readonly rows: readonly StationaryRow[]
  readonly unreadableCount: number
}

const EMPTY: StationaryBatch = { rows: [], unreadableCount: 0 }

export function useStationaryObjects(deviceIds: readonly number[]): StationaryFeed {
  const system = useSystem()

  // An empty selection is a request for NOTHING, and is honoured as one — the
  // cap's `deviceIds.min(1)` has no spelling for "no cameras", and sending `[]`
  // to be answered with the fleet is the opposite of this change.
  const enabled = deviceIds.length > 0
  const key = [...deviceIds].sort((a, b) => a - b)

  const { data, isLoading } = useQuery({
    queryKey: ['stationary-objects', key] as const,
    enabled,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<StationaryBatch> => {
      const answer = await system.trpcClient.zoneAnalytics.getCurrentSnapshotBatch.query({
        deviceIds: key,
      })
      const rows: StationaryRow[] = []
      let unreadableCount = 0
      for (const row of answer) {
        if (row.read === 'unreadable') {
          unreadableCount++
          continue
        }
        for (const s of row.snapshot?.stationaryObjects ?? []) {
          rows.push({ ...s, deviceId: row.deviceId })
        }
      }
      return { rows, unreadableCount }
    },
  })

  const settled = data ?? EMPTY
  return {
    rows: settled.rows.toSorted((a, b) => b.becameStationaryAt - a.becameStationaryAt),
    isLoading: enabled && isLoading,
    unreadableCount: settled.unreadableCount,
  }
}
