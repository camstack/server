/**
 * Alexa's source choice: ask the SHARED picker, then map its answer back to a
 * profile slot.
 *
 * The scoring itself is not here and must never come back here — it is
 * `cameraStreams.pickStream`, the one surface every consumer scores through.
 * This module is only the translation the egress primitive needs: the picker
 * answers with a `camStreamId`, `acquireEgressTranscode` takes a profile slot,
 * and something has to hold the two together.
 *
 * Amazon's numbers live here because they are ALEXA's requirement, not a
 * default anyone else should inherit — the repo's rule is that a threshold
 * belongs to whoever has the requirement. They come from the published RTC
 * interface: H.264 up to High 4.1, resolutions 480p to 1080p.
 */
import type { IScopedLogger, StreamBrokerClient } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** Amazon's documented floor. Below it the Echo is out of spec. */
export const ALEXA_MIN_LINES = 480
/** Amazon's documented ceiling. */
export const ALEXA_MAX_LINES = 1080
/**
 * What we aim to deliver. An Echo Show 8/10 panel is 1280x800, so 720 lines
 * fill it; 1080p at the same bitrate spends the budget on pixels the panel
 * cannot show and starves the ones it can.
 */
export const ALEXA_TARGET_LINES = 720

export type AlexaSlotsApi = Pick<StreamBrokerClient, 'listAllProfileSlots'>

export interface ProfileForStreamInput {
  readonly api: { readonly streamBroker: AlexaSlotsApi }
  readonly deviceId: number
  readonly camStreamId: string
  readonly logger?: IScopedLogger
}

/**
 * Which profile slot serves `camStreamId`, or `null` when none does — a read
 * that failed is `null` too, and the caller keeps its previous behaviour
 * rather than guessing a slot from an error (D393).
 */
export async function profileForCamStream(
  input: ProfileForStreamInput,
): Promise<'high' | 'mid' | 'low' | null> {
  try {
    const slots = await input.api.streamBroker.listAllProfileSlots.query()
    for (const slot of slots) {
      if (slot.deviceId !== input.deviceId) continue
      if (slot.sourceCamStreamId !== input.camStreamId) continue
      if (slot.profile === 'high' || slot.profile === 'mid' || slot.profile === 'low') {
        return slot.profile
      }
    }
    return null
  } catch (err) {
    input.logger?.warn('alexa rtc-session: could not read the profile slots', {
      tags: { deviceId: input.deviceId },
      meta: { error: errMsg(err) },
    })
    return null
  }
}
