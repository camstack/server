/**
 * The detail plane's geometry guard for faces (D662).
 *
 * The face detector is fed a PADDED crop of the person (`deriveDetailCropRect`,
 * D52), so it also sees the margin around the person — and on 2026-09-27 it
 * found faces there: a car wheel beside a person on camera 102 was buffered as
 * a face twice (0.51 and 0.81), its top 107 px ABOVE the person's own top edge.
 * A face is the person's only if its CENTRE lies inside the UNPADDED person box;
 * the padding exists to give the detector context, not to widen what counts.
 *
 * The centre, not the whole box: person detectors routinely put the top edge
 * at the forehead, so a real head straddles it. Its centre does not leave the
 * box; a subject beside the person does.
 *
 * The guard needs the padded crop's frame-space rect. The last rung of the
 * crop ladder — a tile the CALLER cut (`cropJpeg`) — has none: its mapping
 * anchor IS the parent box, so every face would map inside it. There the guard
 * cannot run, and `runDetailSubtree` says so rather than pass a vacuous check.
 */
import type { IScopedLogger } from '@camstack/types'

/** A `{x,y,w,h}` rectangle in frame pixels. */
export interface GeometryRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Is the centre of `face` inside `parent` (edges inclusive)? */
export function faceCentreInsideParent(face: GeometryRect, parent: GeometryRect): boolean {
  const cx = face.x + face.w / 2
  const cy = face.y + face.h / 2
  return cx >= parent.x && cx <= parent.x + parent.w && cy >= parent.y && cy <= parent.y + parent.h
}

/** One face the guard dropped, for the per-camera log. */
export interface FaceOutsideParentDrop {
  readonly deviceId: number
  readonly score: number
  readonly faceBbox: GeometryRect
  readonly parentBbox: GeometryRect
}

/** The log line, one name for both the throttled and the fallback path. */
export const FACE_GUARD_UNAVAILABLE_MESSAGE =
  'face geometry guard cannot run on a caller-cut tile — its padding is unknown, the faces pass unjudged'

export const FACE_OUTSIDE_PARENT_MESSAGE =
  'face dropped — its centre is outside the person box (it was found in the crop padding)'

/** The fields of a drop the log line carries. */
export function faceOutsideParentMeta(drop: FaceOutsideParentDrop): Record<string, unknown> {
  const round = (r: GeometryRect): GeometryRect => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.w),
    h: Math.round(r.h),
  })
  return {
    score: Number(drop.score.toFixed(4)),
    faceBbox: round(drop.faceBbox),
    parentBbox: round(drop.parentBbox),
  }
}

/** What {@link FaceOutsideParentLog} needs. */
export interface FaceOutsideParentLogOptions {
  readonly info: IScopedLogger['info']
  readonly now: () => number
  /** At most one line per camera per this window. */
  readonly intervalMs: number
  /**
   * Arm a one-shot flush — the runner passes an unref'd `setTimeout`. It is
   * what emits the drops held back in a window that no later drop closes.
   */
  readonly schedule: (flush: () => void, delayMs: number) => void
}

/** Default window: the dispatcher refreshes a face every second per track. */
export const FACE_OUTSIDE_PARENT_LOG_INTERVAL_MS = 60_000

/**
 * Per-camera, rate-limited announcement of dropped faces (D391: a branch that
 * drops work says so). The first drop on a camera is logged at once; drops
 * inside the window are held and emitted as ONE line carrying their count —
 * by the next drop after the window, or by a flush armed when the first one
 * was held, whichever comes first. Every drop is counted in exactly one line.
 */
export class FaceOutsideParentLog {
  private readonly lastLineAt = new Map<number, number>()
  private readonly heldBack = new Map<number, number>()
  private readonly flushArmed = new Set<number>()
  /** The latest held drop per camera — the example a flushed line shows. */
  private readonly lastHeld = new Map<number, FaceOutsideParentDrop>()

  constructor(private readonly opts: FaceOutsideParentLogOptions) {}

  record(drop: FaceOutsideParentDrop): void {
    const now = this.opts.now()
    const held = (this.heldBack.get(drop.deviceId) ?? 0) + 1
    const last = this.lastLineAt.get(drop.deviceId)
    if (last !== undefined && now - last < this.opts.intervalMs) {
      this.heldBack.set(drop.deviceId, held)
      this.lastHeld.set(drop.deviceId, drop)
      if (!this.flushArmed.has(drop.deviceId)) {
        this.flushArmed.add(drop.deviceId)
        this.opts.schedule(() => this.flush(drop.deviceId), last + this.opts.intervalMs - now)
      }
      return
    }
    this.emit(drop, held, now)
  }

  /** Emit what a window held back, if anything; a no-op once already said. */
  private flush(deviceId: number): void {
    this.flushArmed.delete(deviceId)
    const held = this.heldBack.get(deviceId) ?? 0
    const drop = this.lastHeld.get(deviceId)
    if (held === 0 || drop === undefined) return
    this.emit(drop, held, this.opts.now())
  }

  private emit(drop: FaceOutsideParentDrop, count: number, now: number): void {
    this.lastLineAt.set(drop.deviceId, now)
    this.heldBack.set(drop.deviceId, 0)
    this.flushArmed.delete(drop.deviceId)
    this.opts.info(FACE_OUTSIDE_PARENT_MESSAGE, {
      tags: { deviceId: drop.deviceId },
      meta: {
        ...faceOutsideParentMeta(drop),
        droppedSinceLastLine: count,
        windowMs: this.opts.intervalMs,
      },
    })
  }
}
