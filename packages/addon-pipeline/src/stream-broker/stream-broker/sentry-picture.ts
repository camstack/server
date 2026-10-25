/**
 * The PICTURE the sentry shows: the camera's own last frame under a "Waking"
 * treatment, or — when there is none — a generated card carrying its name.
 *
 * ── Why a fallback exists at all ──────────────────────────────────────────
 * The snapshot cache is RAM-only. After a hub restart a sleeping battery camera
 * has no cached frame, and `getSnapshot` without `force` will not wake it to
 * make one (`force` is an OPERATOR signal — a background caller that sets it
 * wakes the camera it was trying not to disturb). So on exactly the cameras
 * this feature is for, "no picture" is a normal state, not an error. A card
 * saying WAKING with the camera's name is worse than the real frame and much
 * better than black — and it is what makes the broker servable inside Amazon's
 * six-second SDP deadline on a cold hub.
 *
 * ── Why the source is reported ────────────────────────────────────────────
 * The two look identical to a consumer and are very different to an operator:
 * one means the cache is warm, the other means it is cold. The caller logs
 * which was used, per camera.
 *
 * Pure input → bytes. No snapshot fetch, no device lookup, no I/O of its own —
 * the caller does both and hands the results in.
 */
import {
  renderCourtesyJpeg,
  renderCourtesyOverlayJpeg,
  type CourtesyReason,
} from '@camstack/system/addon-utils'
import { errMsg, type IScopedLogger } from '@camstack/types'

/** Which of the two the picture came from. Logged per camera, per wake. */
export type SentryPictureSource = 'cached-snapshot' | 'generated-card'

export interface SentryPicture {
  readonly jpeg: Buffer
  readonly source: SentryPictureSource
  /**
   * The state this picture DEPICTS.
   *
   * Returned, not only painted, because the operator's question about a stale
   * tile is always "what did we think the camera was doing", and a pixel
   * cannot be grepped.
   */
  readonly reason: CourtesyReason
}

export interface SentryPictureInput {
  /**
   * The camera's last cached snapshot, JPEG. `null` when the cache holds
   * nothing for it — which is the normal state of a sleeping battery camera
   * after a hub restart, not a fault.
   */
  readonly cachedJpeg: Buffer | null
  readonly deviceName: string
  /** Geometry for the GENERATED card. An overlay keeps the frame's own size. */
  readonly width: number
  readonly height: number
  readonly logger?: IScopedLogger
  readonly deviceId?: number
}

/**
 * Compose the picture.
 *
 * An overlay that cannot be rendered (a truncated or non-decodable cached
 * frame) falls through to the generated card rather than leaking an unlabelled
 * stale frame — the same call the snapshot wrapper's `stateImage` makes, for
 * the same reason.
 */
export async function composePrestreamPicture(input: SentryPictureInput): Promise<SentryPicture> {
  const tags = input.deviceId === undefined ? {} : { tags: { deviceId: input.deviceId } }
  // SLEEPING, not waking. Nothing here wakes anything: the caller never passes
  // `force` to the snapshot, deliberately — "a background caller that sets it
  // wakes the very camera the sentry exists so as not to disturb". The card
  // said `waking` in both branches, announcing an action this code is built to
  // avoid. `waking` is the truth only after a wake signal, when the camera
  // really is coming up, and that is a different picture at a different moment.
  const reason: CourtesyReason = 'sleeping'
  if (input.cachedJpeg !== null && input.cachedJpeg.length > 0) {
    try {
      const jpeg = await renderCourtesyOverlayJpeg(input.cachedJpeg, {
        deviceName: input.deviceName,
        reason,
      })
      return { jpeg, source: 'cached-snapshot', reason }
    } catch (err) {
      input.logger?.warn('sentry: cached frame could not be treated — using the card', {
        ...tags,
        meta: { error: errMsg(err) },
      })
    }
  }
  const jpeg = await renderCourtesyJpeg({
    deviceName: input.deviceName,
    reason,
    width: input.width,
    height: input.height,
  })
  return { jpeg, source: 'generated-card', reason }
}
