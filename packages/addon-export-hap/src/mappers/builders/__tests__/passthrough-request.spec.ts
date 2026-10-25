/**
 * What HomeKit asks the SHARED picker for.
 *
 * The question is always the same one: *is there a stream I can forward
 * untouched to this controller?* Everything that makes it HomeKit's question
 * rather than Alexa's is in these four fields, and they are built here so the
 * answer is assertable without a broker.
 */
import { describe, expect, it } from 'vitest'

import { passthroughRequest } from '../passthrough-request.js'
import { TierVideoCodec } from '../../../multi-tier/video-stream-tiers.js'

describe('passthroughRequest', () => {
  /**
   * The classic HAP service renders H.264 and nothing else. Offering it HEVC
   * is a black picture with no error, which is why the codec list is not a
   * preference but the whole point of asking.
   */
  it('accepts only H.264 on the classic service', () => {
    const { requirements } = passthroughRequest({ negotiatedHeight: 720, multiTier: false })
    expect(requirements.acceptCodecs).toEqual(['h264'])
  })

  /**
   * Apple's multi-tier RTP service advertises `VideoCodecType 2 = H.265`, so a
   * session negotiated there may take the HEVC untouched — which is the entire
   * transcode this service exists to remove.
   */
  it('accepts H.265 too on the multi-tier service', () => {
    const { requirements } = passthroughRequest({ negotiatedHeight: 720, multiTier: true })
    expect(requirements.acceptCodecs).toContain('h264')
    expect(requirements.acceptCodecs).toContain('h265')
  })

  /**
   * `allowTranscode: false` makes this the BYPASS question. A `null` answer is
   * not a failure — it means "nothing can be forwarded", and the caller then
   * goes and transcodes knowing why.
   */
  it('asks the bypass question, not the best-stream question', () => {
    const { requirements } = passthroughRequest({ negotiatedHeight: 720, multiTier: false })
    expect(requirements.allowTranscode).toBe(false)
  })

  /**
   * An exporter may never open the camera's own url. A source with no broker
   * slot has no restream to dial, so naming one would be naming something
   * nothing can use.
   */
  it('refuses a source no broker slot serves', () => {
    const { requirements } = passthroughRequest({ negotiatedHeight: 720, multiTier: false })
    expect(requirements.requireProfileBound).toBe(true)
  })

  /**
   * The height the controller NEGOTIATED, which is the one we may deliver.
   * `targetHeight` orders by "the smallest stream at or above the target",
   * which is what stops a 4K slot being forwarded to a 720p request — the
   * overshoot iOS reported losing 52.7 % of.
   */
  it('targets the height the controller negotiated', () => {
    const { preferences } = passthroughRequest({ negotiatedHeight: 720, multiTier: false })
    expect(preferences.targetHeight).toBe(720)
  })

  /**
   * The ceiling is stated to the picker too, not only enforced afterwards.
   *
   * HomeKit enforces "never deliver more than was asked" in
   * `fitsRequestedResolution`, which decides copy-vs-transcode. The picker has
   * its own word for the same ceiling — `maxHeight` — and saying it in both
   * places makes them agree BY CONSTRUCTION. Saying it in only one made them
   * agree because I wrote both, which is the "agreeing by luck, not by
   * property" this repo has already paid for once.
   */
  it('states the ceiling to the picker, not only after it', () => {
    const { requirements } = passthroughRequest({ negotiatedHeight: 720, multiTier: false })
    expect(requirements.maxHeight).toBe(720)
  })

  /** A codec enum from the tier list maps onto the picker's vocabulary. */
  it('reads the multi-tier codec from the tier declaration', () => {
    const { requirements } = passthroughRequest({
      negotiatedHeight: 2160,
      multiTier: true,
      codec: TierVideoCodec.H265,
    })
    expect(requirements.acceptCodecs).toContain('h265')
  })
})
