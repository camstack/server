/**
 * Which slot HKSV records from — and the refusals, which matter more.
 *
 * Every refusal here is a camera that will NOT show a recording toggle. That is
 * the correct outcome and it is also the one a future reader will be tempted to
 * "fix", so each test names the measured cost of the alternative.
 */

import type { RtspEntryLike } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { MAX_RECORDING_HEIGHT, pickRecordingSource } from '../recording-source.js'

function entry(over: Partial<RtspEntryLike> & { profile: 'high' | 'mid' | 'low' }): RtspEntryLike {
  return {
    brokerId: `101/${over.profile}`,
    url: `rtsp://hub/${over.profile}`,
    mutedUrl: `rtsp://hub/${over.profile}/muted`,
    enabled: true,
    codec: 'h264',
    resolution: { width: 1280, height: 720 },
    ...over,
  }
}

const HIGH_4K = entry({
  profile: 'high',
  resolution: { width: 3840, height: 2160 },
})
const MID_720 = entry({
  profile: 'mid',
  resolution: { width: 1280, height: 720 },
})
const LOW_360 = entry({
  profile: 'low',
  resolution: { width: 640, height: 360 },
})

describe('pickRecordingSource', () => {
  it('takes the LARGEST slot at or below 1080p, not the largest slot', () => {
    // A 4K fragment measured 3.6 MB against 145 KB at 720p, and the prebuffer
    // holds fragments in the exporter's heap. iOS renders HKSV at 1080p anyway.
    const choice = pickRecordingSource([HIGH_4K, MID_720, LOW_360])
    expect(choice.ok && choice.source.profile).toBe('mid')
    expect(choice.ok && choice.source.height).toBeLessThanOrEqual(MAX_RECORDING_HEIGHT)
  })

  it('falls back to the SMALLEST oversized slot when every slot is above the ceiling', () => {
    const choice = pickRecordingSource([
      HIGH_4K,
      entry({ profile: 'mid', resolution: { width: 2560, height: 1440 } }),
    ])
    expect(choice.ok && choice.source.height).toBe(1440)
  })

  it('carries BOTH urls — the muted twin is what RecordingAudioActive=false uses', () => {
    const choice = pickRecordingSource([MID_720])
    expect(choice.ok && choice.source.url).toBe('rtsp://hub/mid')
    expect(choice.ok && choice.source.mutedUrl).toBe('rtsp://hub/mid/muted')
  })

  it('refuses an H.265-only camera — a permanent transcode costs 128x a copy', () => {
    const choice = pickRecordingSource([
      entry({
        profile: 'high',
        codec: 'hevc',
        resolution: { width: 3840, height: 2160 },
      }),
      entry({ profile: 'mid', codec: 'H.265' }),
    ])
    expect(choice).toEqual({ ok: false, refusal: 'no-h264-stream' })
  })

  it('normalises the four spellings of H.265 — a spelling must not read as H.264', () => {
    for (const codec of ['h265', 'hevc', 'hvc1', 'hev1', 'H.265', 'H-265']) {
      expect(pickRecordingSource([entry({ profile: 'mid', codec })])).toEqual({
        ok: false,
        refusal: 'no-h264-stream',
      })
    }
  })

  it('ignores DISABLED slots', () => {
    const choice = pickRecordingSource([
      entry({ profile: 'mid', enabled: false }),
      entry({ profile: 'low', resolution: { width: 640, height: 360 } }),
    ])
    expect(choice.ok && choice.source.profile).toBe('low')
  })

  it('refuses a camera with no enabled slot at all', () => {
    expect(pickRecordingSource([entry({ profile: 'mid', enabled: false })])).toEqual({
      ok: false,
      refusal: 'no-enabled-stream',
    })
    expect(pickRecordingSource([])).toEqual({
      ok: false,
      refusal: 'no-enabled-stream',
    })
  })

  it('refuses an H.265 camera by DEFAULT — the caller must ask for the expensive branch', () => {
    // The option is absent everywhere the answer is "copy or nothing", so the
    // permanent-encode branch can never be reached by forgetting a parameter.
    expect(pickRecordingSource([entry({ profile: 'mid', codec: 'hevc' })])).toEqual({
      ok: false,
      refusal: 'no-h264-stream',
    })
  })

  it('accepts an H.265 camera when the operator allows transcoding, and SAYS it transcodes', () => {
    const choice = pickRecordingSource(
      [entry({ profile: 'mid', codec: 'hevc' }), entry({ profile: 'low', codec: 'h265' })],
      { allowTranscode: true },
    )
    expect(choice.ok && choice.source.profile).toBe('mid')
    // The flag is on the SOURCE rather than inferred later from the codec: the
    // child that spawns off this decides between a 0.7 % copy and a permanent
    // encoder, and that decision may not be re-derived somewhere else.
    expect(choice.ok && choice.source.transcode).toBe(true)
  })

  it('still prefers a COPY when one exists, even with transcoding allowed', () => {
    // An H.264 low beside an H.265 high is not a reason to burn a core.
    const choice = pickRecordingSource(
      [
        entry({ profile: 'high', codec: 'hevc', resolution: { width: 2560, height: 1440 } }),
        LOW_360,
      ],
      { allowTranscode: true },
    )
    expect(choice.ok && choice.source.profile).toBe('low')
    expect(choice.ok && choice.source.transcode).toBe(false)
  })

  it('a copy says so explicitly — absence is not a claim', () => {
    const choice = pickRecordingSource([MID_720])
    expect(choice.ok && choice.source.transcode).toBe(false)
  })

  it('applies the same ceiling to the transcode branch — decode cost scales with the SOURCE', () => {
    const choice = pickRecordingSource(
      [
        entry({ profile: 'high', codec: 'hevc', resolution: { width: 3840, height: 2160 } }),
        entry({ profile: 'mid', codec: 'hevc', resolution: { width: 896, height: 512 } }),
      ],
      { allowTranscode: true },
    )
    // Decoding 4K is the expensive half of a transcode; the mid is 12x fewer
    // pixels for a clip iOS renders at 1080p regardless.
    expect(choice.ok && choice.source.height).toBe(512)
  })

  it('a camera with no enabled slot is still refused with transcoding allowed', () => {
    expect(pickRecordingSource([], { allowTranscode: true })).toEqual({
      ok: false,
      refusal: 'no-enabled-stream',
    })
  })

  it('refuses a slot with no declared resolution — nothing honest could be advertised', () => {
    const { resolution: _drop, ...noResolution } = entry({ profile: 'mid' })
    expect(pickRecordingSource([noResolution])).toEqual({
      ok: false,
      refusal: 'no-resolution',
    })
  })
})
