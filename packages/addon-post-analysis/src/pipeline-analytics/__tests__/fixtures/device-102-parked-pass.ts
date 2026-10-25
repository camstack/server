/**
 * Device 102, 2026-09-08 — a moving car passing the two permanently parked
 * cars at the right edge of the frame (D410).
 *
 * Every box here is MEASURED on the live hub, not invented:
 *
 *  - the two registry entries are `zoneAnalytics.getCurrentSnapshot(102)`
 *    `.stationaryObjects` read at 21:36 UTC, with the reference boxes the
 *    registry was holding while the four operator-marked tracks died;
 *  - the trajectory is `pipelineAnalytics.getTrack` for
 *    `1a453f8c-3c83-4a17-aee3-1ef8a0102e81` (firstSeen 20:02:40.774 UTC),
 *    every stored position at its real timestamp;
 *  - the last stored box of the three other tracks the operator marked with
 *    the same note.
 *
 * The boxes the detector produced AFTER each track's last stored position were
 * suppressed by the stationary gate and therefore never stored anywhere. The
 * `PASS_AFTER_LAST_BOX` boxes are the trajectory's own last step (the delta
 * between its last two stored boxes) applied forward, and they were checked
 * against the recorded footage: at those instants the SUV's body covers first
 * the dark parked car (`ENTRY_DNRG309`) and then the silver one beside it,
 * before leaving the frame at the bottom-right. Frame 3840×2160.
 */
import type { BoundingBox } from '@camstack/types'
import type { StationaryEntry } from '../../pipeline/stationary/stationary-types.js'

export const FRAME_102 = { width: 3840, height: 2160 } as const

/** `c34bb95f-…` — plate DNRG309, parked since 06:36 UTC. */
export const ENTRY_DNRG309: StationaryEntry = {
  id: 'c34bb95f-baa5-48ab-add5-1cd1d770d6cc',
  deviceId: 102,
  className: 'vehicle',
  bbox: { x: 3001.2, y: 325.2, w: 453.6, h: 404.4 },
  frameWidth: FRAME_102.width,
  frameHeight: FRAME_102.height,
  firstSeenAt: 1788849394545,
  becameStationaryAt: 1788849395197,
  lastConfirmedAt: 1788903364173,
  label: 'DNRG309',
}

/** `cf95da64-…` — the silver car beside it, parked since 17:50 UTC. */
export const ENTRY_SILVER: StationaryEntry = {
  id: 'cf95da64-8061-47ef-9d76-f6f72c476f37',
  deviceId: 102,
  className: 'vehicle',
  bbox: { x: 3456, y: 649.2, w: 380.4, h: 416.4 },
  frameWidth: FRAME_102.width,
  frameHeight: FRAME_102.height,
  firstSeenAt: 1788889810307,
  becameStationaryAt: 1788889810427,
  lastConfirmedAt: 1788903364173,
}

export const ENTRIES_102: readonly StationaryEntry[] = [ENTRY_DNRG309, ENTRY_SILVER]

export interface StoredPosition {
  readonly timestamp: number
  readonly bbox: BoundingBox
  readonly score: number
}

/** Track `1a453f8c` — every stored position, ordered. 10 frames, 1705 ms. */
export const TRACK_1A453F8C: readonly StoredPosition[] = [
  { timestamp: 1788897760774, bbox: { x: 2082, y: 2.4, w: 562.8, h: 213.6 }, score: 0.6141 },
  { timestamp: 1788897760874, bbox: { x: 2142, y: 2.4, w: 516, h: 226.8 }, score: 0.713 },
  { timestamp: 1788897761341, bbox: { x: 2100, y: 1.2, w: 583.2, h: 247.2 }, score: 0.5558 },
  { timestamp: 1788897761420, bbox: { x: 2246.4, y: 4.8, w: 561.6, h: 343.2 }, score: 0.5296 },
  { timestamp: 1788897761687, bbox: { x: 2280, y: 3.6, w: 544.8, h: 361.2 }, score: 0.6067 },
  { timestamp: 1788897761849, bbox: { x: 2318.4, y: 7.2, w: 561.6, h: 398.4 }, score: 0.6159 },
  { timestamp: 1788897762016, bbox: { x: 2431.2, y: 43.2, w: 568.8, h: 482.4 }, score: 0.6563 },
  { timestamp: 1788897762145, bbox: { x: 2452.8, y: 46.8, w: 567.6, h: 511.2 }, score: 0.7439 },
  { timestamp: 1788897762301, bbox: { x: 2472, y: 66, w: 588, h: 537.6 }, score: 0.6811 },
  { timestamp: 1788897762479, bbox: { x: 2508, y: 115.2, w: 667.2, h: 586.8 }, score: 0.6631 },
]

/**
 * The SUV's next four boxes, extrapolated from the last stored step
 * (+36 / +49 on the origin, +115 / +98 on the far corner per 178 ms) — the
 * frames the footage shows it covering the parked cars and nothing stored.
 */
export const PASS_AFTER_LAST_BOX: readonly StoredPosition[] = [
  { timestamp: 1788897762657, bbox: { x: 2544, y: 164, w: 746, h: 636 }, score: 0.66 },
  { timestamp: 1788897762835, bbox: { x: 2580, y: 213, w: 825, h: 685 }, score: 0.66 },
  { timestamp: 1788897763013, bbox: { x: 2616, y: 262, w: 904, h: 734 }, score: 0.66 },
  { timestamp: 1788897763191, bbox: { x: 2652, y: 311, w: 983, h: 783 }, score: 0.66 },
]

/** Track `63c6e83d` (18:19 UTC): last stored box, and the next one by its own
 *  last step (+195 / +108 on the origin, +237 / +154 on the far corner). */
export const TRACK_63C6E83D_LAST: BoundingBox = { x: 2486.4, y: 108, w: 646.8, h: 440.4 }
export const TRACK_63C6E83D_NEXT: BoundingBox = { x: 2681, y: 216, w: 689, h: 486 }

/** Track `5e3f1f75` (18:31 UTC): last stored box, and the box eight of its
 *  last (83 ms) steps later. */
export const TRACK_5E3F1F75_LAST: BoundingBox = { x: 2412, y: 49.2, w: 709.2, h: 554.4 }
export const TRACK_5E3F1F75_NEXT: BoundingBox = { x: 2468, y: 57, w: 757, h: 659 }

/**
 * A box on the DNRG309 spot at the D275 leak signature: IoU 0.55 with the
 * reference (below `suppressIou`), centroid inside. The partial box the
 * detector emits for a large parked vehicle at night.
 */
export const DNRG309_PARTIAL_READ: BoundingBox = { x: 3001.2, y: 325.2, w: 453.6, h: 222.4 }
