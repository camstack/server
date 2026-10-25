/**
 * Zoom step arithmetic for Reolink Baichuan cameras.
 *
 * Baichuan has NO directional zoom: MSG_ID_PTZ_CONTROL (cmd 18) accepts
 * left/right/up/down and rejects anything else. Zoom lives on its own
 * absolute-position pair — MSG_ID_GET_ZOOM_FOCUS (294) reads
 * `{minPos,curPos,maxPos}`, MSG_ID_SET_ZOOM_FOCUS (295) drives to a
 * position — so a zoom press has to become a target position along the
 * camera's own travel. That translation is here, pure and testable;
 * `ReolinkCamera.runZoom` only does the I/O around it.
 */

/** The camera's reported zoom travel, as returned by `getZoomFocus`. */
export type ZoomTravel = {
  readonly minPos: number
  readonly curPos: number
  readonly maxPos: number
}

/**
 * Why a zoom press produced no movement — every one of these is a
 * DROPPED command and the caller must log it rather than return
 * silently, because the cap's return type cannot carry the refusal.
 */
export type ZoomRefusal = 'no-travel' | 'at-limit'

export type ZoomStepOutcome =
  | { readonly kind: 'move'; readonly target: number }
  | { readonly kind: 'refused'; readonly reason: ZoomRefusal }

/**
 * Fraction of total zoom travel moved by ONE press. ~8 presses to cross
 * the full range reads like a zoom rocker.
 */
export const ZOOM_STEP_FRACTION = 0.12

/** `zoomToFactor` expresses an absolute movePos as `factor * 1000`. */
export const ZOOM_FACTOR_SCALE = 1000

/**
 * Total attempts for ONE zoom set. A set issued while the lens is still
 * travelling from the previous press returns `response_code 400`, so a
 * single retry absorbs the overlap. Bounded — never a loop.
 */
export const ZOOM_SET_ATTEMPTS = 2

/** Pause before the retry above — long enough for the lens to settle. */
export const ZOOM_SET_RETRY_MS = 1500

/**
 * Resolve the absolute zoom position one press should drive to.
 *
 * Only the SIGN of `zoom` is read. Pan/tilt already discard their
 * magnitude, and the two clients disagree on it anyway — the viewer
 * sends ±0.2 per press while ui-library sends ±1 — so honouring
 * magnitude would make the same button travel different distances
 * depending on which app pressed it.
 */
export const resolveZoomStep = (travel: ZoomTravel, zoom: number): ZoomStepOutcome => {
  if (!Number.isFinite(travel.minPos) || !Number.isFinite(travel.maxPos)) {
    return { kind: 'refused', reason: 'no-travel' }
  }
  if (travel.maxPos <= travel.minPos) return { kind: 'refused', reason: 'no-travel' }

  const step = (travel.maxPos - travel.minPos) * ZOOM_STEP_FRACTION
  const raw = travel.curPos + Math.sign(zoom) * step
  const target = Math.round(Math.min(travel.maxPos, Math.max(travel.minPos, raw)))

  if (target === travel.curPos) return { kind: 'refused', reason: 'at-limit' }
  return { kind: 'move', target }
}
