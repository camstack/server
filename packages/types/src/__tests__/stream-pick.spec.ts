/**
 * The ONE stream ranking. See `camera/stream-pick.ts` for why it is one.
 */
import { describe, expect, it } from 'vitest'
import {
  compareToTarget,
  rankStreams,
  type PickCandidate,
  type PickRanking,
} from '../camera/stream-pick.js'

const SUB: PickCandidate = { camStreamId: 'native:sub', codec: 'h264', width: 640, height: 360 }
const MAIN: PickCandidate = { camStreamId: 'native:main', codec: 'h265', width: 2304, height: 1296 }
const MID_H264: PickCandidate = {
  camStreamId: 'native:mid',
  codec: 'h264',
  width: 1280,
  height: 720,
}

function ranking(over: Partial<PickRanking> = {}): PickRanking {
  return {
    acceptCodecs: ['h264'],
    allowTranscode: false,
    preferredProviders: ['native:'],
    resolutionPreference: 'highest',
    ...over,
  }
}

describe('rankStreams', () => {
  it('refuses a codec it cannot take, when transcoding was not asked for', () => {
    // The bypass question: "is there a stream I can forward untouched?"
    expect(rankStreams([MAIN], ranking())).toBeNull()
  })

  it('takes an unusable codec ONLY when the caller asked to transcode', () => {
    const picked = rankStreams([MAIN], ranking({ allowTranscode: true }))
    expect(picked?.candidate.camStreamId).toBe('native:main')
    expect(picked?.transcodes).toBe(true)
  })

  it('a passthrough always outranks a transcode, whatever the sizes', () => {
    // A transcode is a decode plus an encode for the life of the session.
    const picked = rankStreams([MAIN, MID_H264], ranking({ allowTranscode: true }))
    expect(picked?.candidate.camStreamId).toBe('native:mid')
    expect(picked?.transcodes).toBe(false)
  })

  it('with a TARGET, the smallest stream that reaches it wins', () => {
    // Pulling 1296 lines to draw 720 costs a decode and buys nothing.
    // Both native, so the provider term — which still comes FIRST, unchanged —
    // cannot decide it and the target rule is what is being tested.
    const h265_720: PickCandidate = { camStreamId: 'native:720', codec: 'h265', height: 720 }
    const picked = rankStreams(
      [MAIN, h265_720],
      ranking({ allowTranscode: true, targetHeight: 720 }),
    )
    expect(picked?.candidate.camStreamId).toBe('native:720')
  })

  it('PROVIDER still outranks the target — a native dial beats a relayed one', () => {
    // The pre-existing order is preserved on purpose: `targetHeight` refines
    // how the survivors of the provider preference are compared, it does not
    // overturn it.
    const relayedExact: PickCandidate = { camStreamId: 'rtsp:720', codec: 'h265', height: 720 }
    const picked = rankStreams(
      [relayedExact, MAIN],
      ranking({ allowTranscode: true, targetHeight: 720 }),
    )
    expect(picked?.candidate.camStreamId).toBe('native:main')
  })

  it('with a TARGET nothing reaches, the tallest wins', () => {
    const a: PickCandidate = { camStreamId: 'native:a', codec: 'h265', height: 500 }
    const b: PickCandidate = { camStreamId: 'native:b', codec: 'h265', height: 540 }
    const picked = rankStreams([a, b], ranking({ allowTranscode: true, targetHeight: 720 }))
    expect(picked?.candidate.camStreamId).toBe('native:b')
  })

  it('without a target, `highest` and `lowest` behave exactly as before', () => {
    const all = [SUB, MID_H264]
    expect(rankStreams(all, ranking())?.candidate.camStreamId).toBe('native:mid')
    expect(
      rankStreams(all, ranking({ resolutionPreference: 'lowest' }))?.candidate.camStreamId,
    ).toBe('native:sub')
  })

  it('provider preference beats resolution', () => {
    const relayed: PickCandidate = { camStreamId: 'rtsp:big', codec: 'h264', height: 2160 }
    const picked = rankStreams([relayed, MID_H264], ranking())
    expect(picked?.candidate.camStreamId).toBe('native:mid')
  })

  it('reads h265 and hevc as the same codec', () => {
    const hevc: PickCandidate = { camStreamId: 'native:h', codec: 'HEVC', height: 1080 }
    expect(rankStreams([hevc], ranking({ acceptCodecs: ['h265'] }))?.transcodes).toBe(false)
  })

  it('an UNKNOWN codec is not accepted — it is unknown, not compatible', () => {
    const mystery: PickCandidate = { camStreamId: 'native:m', height: 1080 }
    expect(rankStreams([mystery], ranking())).toBeNull()
    expect(rankStreams([mystery], ranking({ allowTranscode: true }))?.transcodes).toBe(true)
  })

  it('an empty acceptCodecs means every codec is usable, and nothing transcodes', () => {
    const picked = rankStreams([MAIN], ranking({ acceptCodecs: [] }))
    expect(picked?.transcodes).toBe(false)
  })
})

describe('compareToTarget — the ONE target rule', () => {
  const first = (a: number, b: number, target: number): number =>
    compareToTarget(a, b, target) < 0 ? a : b

  it('prefers at-or-above the target — the consumer downscales, never up', () => {
    expect(first(720, 480, 720)).toBe(720)
    expect(first(360, 1080, 720)).toBe(1080)
  })

  it('among those that reach it, the SMALLEST — the extra pixels are thrown away', () => {
    expect(first(1296, 720, 720)).toBe(720)
    expect(first(720, 1080, 720)).toBe(720)
  })

  it('when none reaches it, the LARGEST — as close as we can get', () => {
    expect(first(500, 540, 720)).toBe(540)
    expect(first(360, 240, 720)).toBe(360)
  })

  it('is a stable ordering — the same rule whatever the measure', () => {
    // The cap ranks by lines, the RTSP picker by pixels. Same sentence.
    const byPixels = [921_600, 2_985_984, 230_400].sort((a, b) => compareToTarget(a, b, 921_600))
    expect(byPixels[0]).toBe(921_600)
    expect(byPixels[1]).toBe(2_985_984)
    expect(byPixels[2]).toBe(230_400)
  })
})
