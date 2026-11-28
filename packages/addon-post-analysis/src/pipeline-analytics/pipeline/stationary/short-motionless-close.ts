/**
 * What a closed track tells the phantom-cell memory (D547).
 *
 * A short, motionless close ARMS the cell it was born in (the confirmation
 * gate's bar rises there); a track that went somewhere CLEARS it; a track too
 * brief to judge (`SHORT_MOTIONLESS_MIN_LIFE_MS` / `_MIN_OBSERVATIONS`) does
 * neither — it is evidence of nothing — and says so (D391).
 *
 * Called for EVERY close, including a track a stationary promotion kept: the
 * store judges those as moving and logs nothing for them, so this line is the
 * only one that explains why a brief kept track left its cell untouched.
 */
import type { IScopedLogger } from '@dominevo/types'
import {
  netDisplacementPx,
  SHORT_MOTIONLESS_MIN_LIFE_MS,
  SHORT_MOTIONLESS_MIN_OBSERVATIONS,
  shortMotionlessVerdict,
} from '../../store/short-motionless.js'
import type { PhantomCellRegistry } from './phantom-cells.js'

/** Grid the spawn point is quantised to, so respawns whose boxes never repeat
 *  to the pixel still land in one cell. */
export const PHANTOM_CELL_PX = 32
/** How long a cell remembers its closes. */
export const PHANTOM_CELL_WINDOW_MS = 6 * 60 * 60_000

/** The closed track, as the close hook hands it over. */
export interface ShortMotionlessCloseTrack {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly totalDistance?: number
  readonly positions?: readonly { readonly x: number; readonly y: number }[]
}

export interface ShortMotionlessCloseDeps {
  /** The durable cell memory; `null` when it failed to construct. */
  readonly phantomCells: Pick<PhantomCellRegistry, 'noteMotionlessClose' | 'noteMovingClose'> | null
  /** The in-RAM per-cell close times (`repeatsInWindow`). */
  readonly cells: Map<string, number[]>
  readonly logger: IScopedLogger
  readonly now: number
}

export function noteShortMotionlessClose(
  track: ShortMotionlessCloseTrack,
  deps: ShortMotionlessCloseDeps,
): void {
  const first = track.positions?.[0]
  if (!first) return
  const { logger, now } = deps
  const lifeMs = track.lastSeen - track.firstSeen
  const moved = netDisplacementPx(track.positions ?? [])
  const observations = track.positions?.length ?? 0
  // Bounds: ≤25 s; person net ≤40 px (9310d1ff), vehicle net ≤8 px
  // (86918072 at 15 px must still list). Net, not walk.
  const verdict = shortMotionlessVerdict(lifeMs, moved, track.className, observations)
  if (verdict === 'too-brief') {
    logger.info('phantom cell untouched — track too brief to judge', {
      tags: { deviceId: track.deviceId },
      meta: {
        trackId: track.trackId,
        className: track.className,
        lifeMs,
        observations,
        movedPx: Math.round(moved * 10) / 10,
        minLifeMs: SHORT_MOTIONLESS_MIN_LIFE_MS,
        minObservations: SHORT_MOTIONLESS_MIN_OBSERVATIONS,
      },
    })
    return
  }
  if (verdict === 'moving') {
    // REACTIVATION. A track born here that GOES SOMEWHERE revokes the
    // scenery reading — the whole reason the memory is safe to hold. Fire and
    // forget: the close path must never wait on SQLite, and a lost clear
    // costs one more suppressed birth, not lost work.
    void deps.phantomCells
      ?.noteMovingClose({
        deviceId: track.deviceId,
        className: track.className,
        x: first.x,
        y: first.y,
      })
      .then((forgotten) => {
        if (!forgotten) return
        // A suppression that LIFTS silently is as hard to explain as one that
        // starts silently.
        logger.info('phantom cell cleared — a real subject moved through it', {
          tags: { deviceId: track.deviceId },
          meta: { trackId: track.trackId, className: track.className, lifeMs, movedPx: moved },
        })
      })
      .catch(() => undefined)
    return
  }
  // Quantise to a coarse grid so the same scenery lands in one cell across
  // respawns, whose boxes never repeat to the pixel.
  const cell = `${Math.round(first.x / PHANTOM_CELL_PX)},${Math.round(first.y / PHANTOM_CELL_PX)}`
  const key = `${track.deviceId}:${track.className}:${cell}`
  const seen = [
    ...(deps.cells.get(key)?.filter((t) => now - t < PHANTOM_CELL_WINDOW_MS) ?? []),
    now,
  ]
  deps.cells.set(key, seen)
  logger.info('short motionless track closed', {
    tags: { deviceId: track.deviceId },
    meta: {
      trackId: track.trackId,
      className: track.className,
      lifeMs,
      movedPx: Math.round(moved * 10) / 10,
      cell,
      // The number that matters: how many times THIS cell has done this
      // inside the window. A real subject standing still scores 1.
      repeatsInWindow: seen.length,
    },
  })
  void deps.phantomCells
    ?.noteMotionlessClose({
      deviceId: track.deviceId,
      className: track.className,
      trackId: track.trackId,
      x: first.x,
      y: first.y,
      now,
    })
    .then((result) => {
      if (!result.raised) return
      logger.info('phantom cell armed — spawn bar raised here', {
        tags: { deviceId: track.deviceId },
        meta: {
          trackId: track.trackId,
          className: track.className,
          cell: result.cell,
          closesInWindow: result.closesInWindow,
        },
      })
    })
    .catch(() => undefined)
}
