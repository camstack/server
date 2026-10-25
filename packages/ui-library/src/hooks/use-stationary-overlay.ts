/**
 * The census for one camera, normalised and ready for the overlay.
 *
 * The parked objects are NOT in the detection stream — when the evidence ledger
 * promotes one, the tracker is told to forget it — so an overlay that wants to
 * draw them has to ask the occupancy snapshot. This hook is that ask, in one
 * place, so every surface normalises the boxes the same way.
 *
 * Polled, not subscribed: a parked object changes on the scale of hours, and
 * the snapshot already carries an occupancy-changed announcement for the live
 * count. Absent (`undefined`) means NOT FETCHED — never "nothing is parked" —
 * which is what lets the overlay decline to draw an empty lot it has not
 * actually read.
 */
import { useQuery } from '@tanstack/react-query'
import type { StationaryOverlayBox } from '@camstack/types'

/**
 * The ONE route this hook needs.
 *
 * Deliberately NOT the device proxy. The proxy exposes only the caps BOUND to
 * a device, and `zone-analytics` is not one of them — on device 102 the
 * bindings are `pipeline-analytics` and `motion-zones`. Reading the census
 * through `dev?.zoneAnalytics?.…` therefore resolved to `undefined`, the hook
 * returned an empty census, and the overlay drew nothing while reporting
 * nothing: an unreachable cap was indistinguishable from an empty lot. The cap
 * ROUTE is mounted system-wide and takes the `deviceId` as input, which is how
 * every other caller reaches it.
 */
export interface UseStationaryOverlayTrpc {
  readonly zoneAnalytics: {
    readonly getCurrentSnapshot: {
      readonly query: (input: { deviceId: number }) => Promise<unknown>
    }
  }
}

/** How often the census is re-read. A parked car does not move in 30 s, and
 *  the frame-level count has its own push signal. */
const STATIONARY_POLL_MS = 30_000

interface SnapshotStationary {
  readonly id: string
  readonly className: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  readonly becameStationaryAt: number
  readonly label?: string
}

/**
 * Normalise one census row against the frame it was measured in.
 *
 * A row with no frame dims is DROPPED, not drawn at 0,0: an entry whose own
 * frame is unknown cannot be placed on this one, and a box pinned to the corner
 * reads as a real detection in the wrong place.
 */
export function toStationaryOverlayBox(row: SnapshotStationary): StationaryOverlayBox | null {
  if (!(row.frameWidth > 0) || !(row.frameHeight > 0)) return null
  return {
    id: row.id,
    className: row.className,
    x1: row.bbox.x / row.frameWidth,
    y1: row.bbox.y / row.frameHeight,
    x2: (row.bbox.x + row.bbox.w) / row.frameWidth,
    y2: (row.bbox.y + row.bbox.h) / row.frameHeight,
    becameStationaryAt: row.becameStationaryAt,
    ...(row.label !== undefined ? { label: row.label } : {}),
  }
}

export function useStationaryOverlay(
  trpc: UseStationaryOverlayTrpc,
  deviceId: number | null,
): readonly StationaryOverlayBox[] | undefined {
  const query = useQuery<readonly StationaryOverlayBox[]>({
    queryKey: ['zone-analytics', deviceId, 'stationaryOverlay'],
    enabled: deviceId !== null,
    refetchInterval: STATIONARY_POLL_MS,
    staleTime: STATIONARY_POLL_MS / 2,
    queryFn: async () => {
      const snap = (await trpc.zoneAnalytics.getCurrentSnapshot.query({
        deviceId: deviceId!,
      })) as { stationaryObjects?: readonly SnapshotStationary[] } | null
      const rows = snap?.stationaryObjects ?? []
      const out: StationaryOverlayBox[] = []
      for (const r of rows) {
        const box = toStationaryOverlayBox(r)
        if (box !== null) out.push(box)
      }
      return out
    },
  })
  // A FAILED read is not an empty lot. React Query surfaces the throw here, and
  // returning `undefined` keeps the overlay silent instead of drawing "nothing
  // is parked" over a camera whose census it could not read.
  return query.isError ? undefined : query.data
}
