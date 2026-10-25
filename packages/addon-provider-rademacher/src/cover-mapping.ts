import type { CoverState, CoverStatus } from '@camstack/types'

/**
 * Pure mapping from a Rademacher HomePilot roller-shutter snapshot to the
 * camstack `cover` cap status. Unit-tested in isolation — no I/O, no library
 * handles.
 *
 * ── Position semantics + INVERSION ────────────────────────────────────────
 * On the HomePilot wire, `Position` is inverted (`0` = fully open, `100` =
 * fully closed). The `@apocaliss92/noderademacher` `CoverDevice` getter already
 * normalizes this to the HA-style scale (`position` / `slatPosition`: `0` =
 * closed, `100` = open) — the SAME scale the camstack `cover` cap uses
 * (`position: 0 = fully closed, 100 = fully open`). So the library-normalized
 * value maps straight through.
 *
 * HOWEVER, a MINORITY of HomePilot units report an already-HA-oriented position
 * on the wire (HomePilot surfaces this as an `inverted_cover_position` sensor).
 * For those, the library's blanket `100 - raw` normalization lands BACKWARDS,
 * so the operator flags the device `invertPosition` and this mapping re-inverts
 * once (`100 - value`) to recover the correct camstack position. Tilt/slat
 * follows the same inversion. `toLibraryPosition` applies the symmetric
 * correction on the write path so `setPosition` targets the right end.
 */

/** Normalized (library-scale) snapshot of one HomePilot cover: `0` = closed,
 *  `100` = open. `null` fields are unknown / unsupported. */
export interface RademacherCoverSnapshot {
  /** Library-normalized position — `0` closed … `100` open, or `null`. */
  readonly position: number | null
  /** Library-normalized slat/tilt — `0` closed … `100` open, or `null`. */
  readonly tiltPosition: number | null
  /** Whether the device advertises slat-tilt control (SET_SLAT_POS_CMD). */
  readonly supportsTilt: boolean
  /** Whether the hub could read the device this cycle. */
  readonly online: boolean
}

/** Per-device mapping options. */
export interface CoverMappingOptions {
  /** Re-invert the library-normalized position + tilt (HomePilot units flagged
   *  inverted via the `inverted_cover_position` surface). */
  readonly invertPosition: boolean
}

/** Clamp a raw percentage to the cap's `0..100` integer domain. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Apply the optional per-device inversion to a normalized percentage. */
function applyInvert(value: number | null, invert: boolean): number | null {
  if (value === null) return null
  const clamped = clampPercent(value)
  return invert ? 100 - clamped : clamped
}

/**
 * Derive the cap's lifecycle {@link CoverState} from a (post-inversion)
 * position. HomePilot is a POLLED source with no transient direction signal, so
 * only the settled states are reported: `position <= 0` → `closed`, `> 0` →
 * `open`. A positionless / unknown reading resolves to `stopped`.
 */
export function coverStateForPosition(position: number | null): CoverState {
  if (position === null) return 'stopped'
  if (position <= 0) return 'closed'
  return 'open'
}

/**
 * Build the `cover` cap status slice from a normalized HomePilot snapshot,
 * applying the per-device inversion. `tiltPosition` stays `null` when the
 * device advertises no slat-tilt support (positional-only shutters).
 */
export function toCoverStatus(
  snapshot: RademacherCoverSnapshot,
  options: CoverMappingOptions,
  now: number,
): CoverStatus {
  const position = applyInvert(snapshot.position, options.invertPosition)
  const tiltPosition = snapshot.supportsTilt
    ? applyInvert(snapshot.tiltPosition, options.invertPosition)
    : null
  return {
    state: coverStateForPosition(position),
    position,
    tiltPosition,
    lastChangedAt: now,
  }
}

/**
 * Map a camstack cover position (`0` closed … `100` open, from a `setPosition`
 * mutation) to the value handed to the library's `CoverDevice.setPosition`
 * (also `0` closed … `100` open — the library re-inverts to the wire itself).
 * For a flagged-inverted unit the value is re-inverted once so the write
 * targets the same physical end the read reports. Symmetric with
 * {@link toCoverStatus}.
 */
export function toLibraryPosition(camPosition: number, invertPosition: boolean): number {
  const clamped = clampPercent(camPosition)
  return invertPosition ? 100 - clamped : clamped
}
