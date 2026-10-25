/**
 * The ONE declaration a surface draws a clip's controls from (D612).
 *
 * `clipTransport` used to say this per clip. It could not vary per clip: the
 * broker's `chooseClipPath` reads exactly two inputs — whether
 * `videoclips.dialClipStream` and `videoclips.readClipBytes` are wired — and
 * both are constants of the broker's own closure, with the `profile` it is
 * handed explicitly not read (D599). So the answer is a PROVIDER fact and it
 * is answered here, once, before a clip is even picked.
 *
 * What is pinned is the invariant that keeps this from becoming a lie:
 * a provider never composes an envelope, it returns one of the three spelled in
 * `CLIP_PLAYBACK_OPTIONS`. That is what makes "the declaration may not promise
 * something no clip can be given" structural rather than a discipline.
 */
import {
  CLIP_BROKER_PACED_RATES,
  CLIP_PLAYBACK_OPTIONS,
  CLIP_REALTIME_SOURCE_RATES,
  CLIP_STREAM_SOURCE_RATES,
  ClipPlaybackOptionsSchema,
} from '../capabilities/videoclips.cap.js'
import { describe, expect, it } from 'vitest'

describe('CLIP_PLAYBACK_OPTIONS', () => {
  it('offers only rates the broker can actually pace, and always 1', () => {
    // The defect: the viewer kept its own list, offered 8 and 16, the broker's
    // clamp turned them into 4, and no line anywhere said so. That every entry
    // SURVIVES the clamp is pinned where the clamp lives — the broker's
    // `control-protocol.spec` — because an addon may not import another.
    for (const envelope of Object.values(CLIP_PLAYBACK_OPTIONS)) {
      expect(envelope.rates).toContain(1)
      // 16 is not a pacer rate ANYWHERE (D621): the only real 16× is the
      // camera's own I-frame-only mode (D620), a different stream carrying
      // one frame per GOP and no sound — not this content delivered faster.
      expect(envelope.rates).not.toContain(16)
    }
  })

  it('gives 8 to the transports that HOLD the media, and to no other (D621)', () => {
    // 8 is the broker's pacer over bytes it already has. A `file` clip is
    // wholly in hand and the recorder's own footage is on local disk, so the
    // pacer's only cost is the 8× bitrate it pushes at.
    expect(CLIP_PLAYBACK_OPTIONS.file.rates).toContain(8)
    // A `stream` clip's supply is a socket. Measured on 592 (D620): with the
    // always-on `<ReplaySeek>` a Reolink replay arrives at 1.2–1.37×, so the
    // ladder it already declares is beyond it and 8 would be beyond it eight
    // times over. It does not widen until the supply does.
    expect(CLIP_PLAYBACK_OPTIONS.stream.rates).not.toContain(8)
    // A realtime-bound source arrives at 1.01×. Nothing above 1, ever.
    expect(CLIP_PLAYBACK_OPTIONS.realtimeStream.rates).not.toContain(8)
  })

  it('REFUSES an empty rate set — "no rates" is not a clip anyone can watch', () => {
    // Absence of the whole ANSWER means "the freedom you always had"; an
    // empty set would mean a clip that cannot be played at all, which is a
    // claim no transport here makes and no surface can draw.
    expect(
      ClipPlaybackOptionsSchema.safeParse({ ...CLIP_PLAYBACK_OPTIONS.stream, rates: [] }).success,
    ).toBe(false)
    expect(ClipPlaybackOptionsSchema.safeParse(CLIP_PLAYBACK_OPTIONS.stream).success).toBe(true)
  })

  it('is ascending, so a picker renders it without sorting', () => {
    expect([...CLIP_BROKER_PACED_RATES]).toEqual([...CLIP_BROKER_PACED_RATES].sort((a, b) => a - b))
  })

  it('says a STREAM clip is forward-only, unscrubbable and not steppable back', () => {
    // These are the three verbs `ClipStreamFeeder` refuses BY NAME. The
    // envelope exists so the control is disabled instead of offered and
    // undone under the operator's finger (D62).
    expect(CLIP_PLAYBACK_OPTIONS.stream).toMatchObject({
      transport: 'stream',
      seek: 'forward',
      stepBack: false,
      scrub: false,
    })
  })

  it('says a FILE clip is free — the index reaches anywhere in it', () => {
    expect(CLIP_PLAYBACK_OPTIONS.file).toMatchObject({
      transport: 'file',
      seek: 'free',
      stepBack: true,
      scrub: true,
    })
  })

  it('spells the rates ONCE per constraint — never per envelope', () => {
    // A second list is the second authority that produced the defect. Two
    // ladders exist because two SOURCES exist, not because three envelopes do.
    expect(CLIP_PLAYBACK_OPTIONS.file.rates).toBe(CLIP_BROKER_PACED_RATES)
    expect(CLIP_PLAYBACK_OPTIONS.stream.rates).toBe(CLIP_STREAM_SOURCE_RATES)
    expect(CLIP_PLAYBACK_OPTIONS.realtimeStream.rates).toBe(CLIP_REALTIME_SOURCE_RATES)
  })

  it('never offers a REALTIME-BOUND source a rate above the speed it arrives at', () => {
    // Measured on 1436, 2026-09-23: a Hikvision RTSP replay delivers 14.08 s
    // of media in 14.27 s of wall clock — 1.01× — where Reolink's cmd-5
    // transfer lands the same bytes at 49–62×. The pacer consumes `rate`
    // seconds of media per second while the socket supplies one, so any rate
    // above 1 drains a buffer that never held the rest of the clip. Offering
    // it is D612's defect exactly: a rate accepted and not delivered.
    expect(Math.max(...CLIP_REALTIME_SOURCE_RATES)).toBe(1)
    expect(CLIP_REALTIME_SOURCE_RATES).toContain(1)
    // Slower is free: a slower pacer only lets the buffer grow.
    expect(CLIP_REALTIME_SOURCE_RATES.every((rate) => rate <= 1)).toBe(true)
  })

  it('keeps every declared rate inside the domain the broker can pace', () => {
    // The broker's clamp is derived from {@link CLIP_BROKER_PACED_RATES}'s own
    // ends, and its spec pins that every entry survives it. This is the half
    // that can be pinned WITHOUT importing the broker: an entry outside the
    // widest ladder is a rate accepted and moved, the same lie one step later.
    const floor = Math.min(...CLIP_BROKER_PACED_RATES)
    const ceiling = Math.max(...CLIP_BROKER_PACED_RATES)
    for (const envelope of Object.values(CLIP_PLAYBACK_OPTIONS)) {
      for (const rate of envelope.rates) {
        expect(rate).toBeGreaterThanOrEqual(floor)
        expect(rate).toBeLessThanOrEqual(ceiling)
      }
      expect([...envelope.rates]).toEqual([...envelope.rates].sort((a, b) => a - b))
    }
  })

  it('never lets a NARROWER ladder offer something the widest one does not', () => {
    // Three ladders exist because three SUPPLY classes exist. They are subsets
    // of the broker's own domain, never competitors to it: a rate in one of
    // them that the pacer's clamp has never heard of is the D612 defect with
    // extra steps.
    const paced = new Set(CLIP_BROKER_PACED_RATES)
    for (const rate of CLIP_STREAM_SOURCE_RATES) expect(paced.has(rate)).toBe(true)
    for (const rate of CLIP_REALTIME_SOURCE_RATES) expect(paced.has(rate)).toBe(true)
  })
})
