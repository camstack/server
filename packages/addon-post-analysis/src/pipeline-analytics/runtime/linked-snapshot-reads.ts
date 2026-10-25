/**
 * The two CAPTURE-FREE snapshot reads the linked-camera shelf is given
 * (`notification-center/linked-stills.ts`, ADR 0632):
 *
 *  - which cameras must not be dialled — the wrapper's state reason
 *    (`sleeping`, `disabled`, …), off `snapshot.getDebugState`;
 *  - how old the frame a capture returned really is — the cached frame's
 *    instant, off the cache-only `snapshot.getSnapshotOverview`, in one batch.
 *
 * Neither ever captures: a capture wakes a battery camera. A read that throws
 * propagates, and the shelf keeps the tile (D49).
 */
import type { NcLinkedSnapshotState } from '../../notification-center/linked-stills.js'

/** The part of `snapshot.getDebugState`'s answer these reads use. */
export interface SnapshotDebugStateRead {
  readonly state: NcLinkedSnapshotState
}

/** The part of one `snapshot.getSnapshotOverview` row these reads use. */
export interface SnapshotOverviewRowRead {
  readonly deviceId: number
  readonly lastCapturedAt: number | null
}

/** Type aliases, not interfaces: the tRPC client's inputs carry an index
 *  signature, which only an object-literal type satisfies implicitly. */
export type SnapshotDeviceInput = {
  readonly deviceId: number
}

export type SnapshotDevicesInput = {
  readonly deviceIds: number[]
}

/** The `snapshot` cap client, narrowed to the two capture-free methods. */
export interface LinkedSnapshotReadClient {
  readonly getDebugState: {
    readonly query: (input: SnapshotDeviceInput) => Promise<SnapshotDebugStateRead>
  }
  readonly getSnapshotOverview: {
    readonly query: (input: SnapshotDevicesInput) => Promise<readonly SnapshotOverviewRowRead[]>
  }
}

export interface LinkedSnapshotReads {
  readonly getSnapshotState: (deviceId: number) => Promise<NcLinkedSnapshotState>
  readonly getFrameCapturedAt: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, number | null>>
}

export function buildLinkedSnapshotReads(snapshot: LinkedSnapshotReadClient): LinkedSnapshotReads {
  return {
    getSnapshotState: async (deviceId) => {
      const debug = await snapshot.getDebugState.query({ deviceId })
      return { reason: debug.state.reason }
    },
    getFrameCapturedAt: async (deviceIds) => {
      // The batch refuses an empty list (`min(1)`): nothing to ask is no call.
      if (deviceIds.length === 0) return new Map()
      const rows = await snapshot.getSnapshotOverview.query({ deviceIds: [...deviceIds] })
      return new Map(rows.map((r) => [r.deviceId, r.lastCapturedAt]))
    },
  }
}
