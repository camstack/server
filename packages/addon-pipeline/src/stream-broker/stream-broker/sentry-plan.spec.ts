import { describe, expect, it } from 'vitest'
import { LAZY_URL_SENTINEL, planPrestream } from './sentry-plan.js'

const LAZY = `${LAZY_URL_SENTINEL}640/native:main`

describe('planPrestream', () => {
  it('plans a fill for a LAZY source whose geometry and codec are known', () => {
    expect(planPrestream({ sourceUrl: LAZY, width: 2304, height: 1296, codec: 'h265' })).toEqual({
      plan: { width: 2304, height: 1296, codec: 'h265' },
    })
  })

  it('refuses a source that is not lazy — there is no gap to fill', () => {
    const out = planPrestream({
      sourceUrl: 'tcp://127.0.0.1:8554/x',
      width: 1280,
      height: 720,
      codec: 'h264',
    })
    expect(out).toEqual({ refusal: 'not-lazy' })
  })

  it('refuses a camera nobody has probed — a wrong SPS freezes the decoder', () => {
    // `stream-broker.ts` records the cost: a 1280x720 placeholder SPS prepended
    // to a camera's real IDR left Chrome frozen on the last placeholder frame
    // until the user restarted by hand.
    expect(
      planPrestream({ sourceUrl: LAZY, width: undefined, height: undefined, codec: 'h264' }),
    ).toEqual({ refusal: 'unknown-geometry' })
    expect(planPrestream({ sourceUrl: LAZY, width: 0, height: 0, codec: 'h264' })).toEqual({
      refusal: 'unknown-geometry',
    })
  })

  it('refuses an unknown codec rather than assuming h264', () => {
    // A sentry in the wrong codec is a stream the consumer cannot decode at
    // all, which is worse than the black screen it replaces.
    expect(planPrestream({ sourceUrl: LAZY, width: 1280, height: 720, codec: undefined })).toEqual({
      refusal: 'unknown-codec',
    })
    expect(planPrestream({ sourceUrl: LAZY, width: 1280, height: 720, codec: 'mjpeg' })).toEqual({
      refusal: 'unknown-codec',
    })
  })

  it('reads every spelling of h265 the vendors use', () => {
    for (const spelling of ['h265', 'HEVC', 'hvc1', 'hev1']) {
      expect(
        planPrestream({ sourceUrl: LAZY, width: 1280, height: 720, codec: spelling }),
      ).toMatchObject({ plan: { codec: 'h265' } })
    }
  })
})
