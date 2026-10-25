import { describe, it, expect } from 'vitest'
import {
  BROKER_PACED_RATES,
  clampPlaybackRate,
  parseControlMessage,
  serializeServerMessage,
} from '../control-protocol'
import { ServerMessageSchema } from '../control-protocol'

describe('parseControlMessage (host -> server)', () => {
  it('parses playRecorded', () => {
    expect(
      parseControlMessage(
        JSON.stringify({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' }),
      ),
    ).toEqual({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
  })
  it('parses seek and scrubCommit distinctly', () => {
    expect(parseControlMessage(JSON.stringify({ t: 'seek', epoch: 6000 }))).toEqual({
      t: 'seek',
      epoch: 6000,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'scrubCommit', epoch: 6000 }))).toEqual({
      t: 'scrubCommit',
      epoch: 6000,
    })
  })
  it('parses setRate, goLive, setProfile', () => {
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 0 }))).toEqual({
      t: 'setRate',
      rate: 0,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'goLive' }))).toEqual({ t: 'goLive' })
    expect(parseControlMessage(JSON.stringify({ t: 'setProfile', profile: 'high' }))).toEqual({
      t: 'setProfile',
      profile: 'high',
    })
  })
  it('parses float setRate within [0, 8]', () => {
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 0.5 }))).toEqual({
      t: 'setRate',
      rate: 0.5,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 2 }))).toEqual({
      t: 'setRate',
      rate: 2,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 4 }))).toEqual({
      t: 'setRate',
      rate: 4,
    })
    // 8 since D621: the pacer's own ceiling, not a camera's `<playSpeed>`.
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 8 }))).toEqual({
      t: 'setRate',
      rate: 8,
    })
  })
  it('parses stepFrame with dir 1 | -1 only', () => {
    expect(parseControlMessage(JSON.stringify({ t: 'stepFrame', dir: 1 }))).toEqual({
      t: 'stepFrame',
      dir: 1,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'stepFrame', dir: -1 }))).toEqual({
      t: 'stepFrame',
      dir: -1,
    })
    expect(parseControlMessage(JSON.stringify({ t: 'stepFrame', dir: 0 }))).toBeNull()
    expect(parseControlMessage(JSON.stringify({ t: 'stepFrame', dir: 2 }))).toBeNull()
    expect(parseControlMessage(JSON.stringify({ t: 'stepFrame' }))).toBeNull()
  })
  it('parses the experimental feeder-scrub kinds (scrubStart / scrubTo)', () => {
    expect(parseControlMessage(JSON.stringify({ t: 'scrubStart' }))).toEqual({ t: 'scrubStart' })
    expect(parseControlMessage(JSON.stringify({ t: 'scrubTo', epoch: 6000 }))).toEqual({
      t: 'scrubTo',
      epoch: 6000,
    })
    // scrubTo requires a numeric epoch.
    expect(parseControlMessage(JSON.stringify({ t: 'scrubTo' }))).toBeNull()
  })

  it('parses the OPTIONAL dragId on scrubStart and scrubCommit (C1) — additive, back-compat', () => {
    // A client that sends one is threaded through untouched.
    expect(parseControlMessage(JSON.stringify({ t: 'scrubStart', dragId: 'drag-abc' }))).toEqual({
      t: 'scrubStart',
      dragId: 'drag-abc',
    })
    expect(
      parseControlMessage(JSON.stringify({ t: 'scrubCommit', epoch: 7000, dragId: 'drag-abc' })),
    ).toEqual({ t: 'scrubCommit', epoch: 7000, dragId: 'drag-abc' })
    // A client that predates the field parses IDENTICALLY to before — no key
    // appears, dragId is not invented.
    expect(parseControlMessage(JSON.stringify({ t: 'scrubStart' }))).toEqual({ t: 'scrubStart' })
    expect(parseControlMessage(JSON.stringify({ t: 'scrubCommit', epoch: 7000 }))).toEqual({
      t: 'scrubCommit',
      epoch: 7000,
    })
    // A plain `seek` never carries a dragId — it is not part of the schema.
    expect(
      parseControlMessage(JSON.stringify({ t: 'seek', epoch: 7000, dragId: 'drag-abc' })),
    ).toEqual({ t: 'seek', epoch: 7000 })
  })

  it('scrubTo carries the OPTIONAL client mapping hint (mode + velocity)', () => {
    // The mapping is the one scrub phase the server cannot observe — velocity
    // lives in the gesture. Terse keys: this rides every pointer move.
    expect(
      parseControlMessage(JSON.stringify({ t: 'scrubTo', epoch: 6000, m: 'fine', v: 42.5 })),
    ).toEqual({ t: 'scrubTo', epoch: 6000, m: 'fine', v: 42.5 })
    // Additive + back-compat: a client that predates the hint still parses, and
    // the drag is attributed to an UNKNOWN mapping rather than a guessed one.
    expect(parseControlMessage(JSON.stringify({ t: 'scrubTo', epoch: 6000 }))).toEqual({
      t: 'scrubTo',
      epoch: 6000,
    })
    // A bogus mode is rejected outright — never coerced into a real one.
    expect(
      parseControlMessage(JSON.stringify({ t: 'scrubTo', epoch: 6000, m: 'turbo' })),
    ).toBeNull()
  })
  it('returns null on garbage', () => {
    expect(parseControlMessage('not json')).toBeNull()
    expect(parseControlMessage(JSON.stringify({ t: 'nope' }))).toBeNull()
    // 16 is the one number an operator WILL ask for and the one the pacer
    // cannot honestly give (D621): refused at the wire, not clamped in silence.
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 16 }))).toBeNull()
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: 9 }))).toBeNull() // > 8 rejected
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: -1 }))).toBeNull() // < 0 rejected
  })
})

describe('clampPlaybackRate', () => {
  it('maps non-positive and non-finite inputs to 0 (pause)', () => {
    expect(clampPlaybackRate(0)).toBe(0)
    expect(clampPlaybackRate(-1)).toBe(0)
    expect(clampPlaybackRate(Number.NaN)).toBe(0)
    expect(clampPlaybackRate(Number.POSITIVE_INFINITY)).toBe(0)
  })
  it('clamps the continuous domain into [0.25, 4]', () => {
    expect(clampPlaybackRate(0.1)).toBe(0.25)
    expect(clampPlaybackRate(0.25)).toBe(0.25)
    expect(clampPlaybackRate(1)).toBe(1)
    expect(clampPlaybackRate(3.7)).toBe(3.7)
    expect(clampPlaybackRate(4)).toBe(4)
    expect(clampPlaybackRate(8)).toBe(8)
    expect(clampPlaybackRate(9)).toBe(8)
    expect(clampPlaybackRate(16)).toBe(8)
  })
})

describe('serializeServerMessage (server -> host)', () => {
  it('serializes servedProfile — the tier actually playing, next to the one asked for', () => {
    expect(
      JSON.parse(serializeServerMessage({ t: 'servedProfile', profile: 'mid', requested: 'high' })),
    ).toEqual({ t: 'servedProfile', profile: 'mid', requested: 'high' })
  })

  it('serializes state and position round-trip', () => {
    expect(JSON.parse(serializeServerMessage({ t: 'state', state: 'playing' }))).toEqual({
      t: 'state',
      state: 'playing',
    })
    expect(JSON.parse(serializeServerMessage({ t: 'position', epochMs: 6000 }))).toEqual({
      t: 'position',
      epochMs: 6000,
    })
    expect(JSON.parse(serializeServerMessage({ t: 'liveProfile', profile: 'high' }))).toEqual({
      t: 'liveProfile',
      profile: 'high',
    })
  })
})

describe('control protocol — warm', () => {
  it('parses the timeline warm-up message (epoch + profile required)', async () => {
    const { parseControlMessage } = await import('../control-protocol')
    expect(parseControlMessage(JSON.stringify({ t: 'warm', epoch: 6000, profile: 'low' }))).toEqual(
      { t: 'warm', epoch: 6000, profile: 'low' },
    )
    expect(parseControlMessage(JSON.stringify({ t: 'warm', epoch: 6000 }))).toBeNull()
  })
})

describe('control protocol — scrubAck', () => {
  it('parses the receiver-credit ack', async () => {
    const { parseControlMessage } = await import('../control-protocol')
    expect(parseControlMessage(JSON.stringify({ t: 'scrubAck' }))).toEqual({ t: 'scrubAck' })
  })
})

describe('BROKER_PACED_RATES — the one authority on what a clip may be offered', () => {
  it('holds only rates the clamp leaves ALONE, and always holds 1', () => {
    // The defect this set exists to end: the viewer kept its own list, offered
    // 8 and 16, the clamp turned them into 4, and nothing said so. A set that
    // offers what the clamp then moves is that same lie one step later.
    expect(BROKER_PACED_RATES).toContain(1)
    for (const rate of BROKER_PACED_RATES) expect(clampPlaybackRate(rate)).toBe(rate)
  })

  it('carries 8 and REFUSES 16 — the pacer is the mechanism, not `<playSpeed>` (D621)', () => {
    // D620 measured what the old comment here asserted and it was false: a
    // Reolink `<playSpeed>` 1/2/4/8 delivers a byte-identical transfer, same
    // 594 access units and 39.855 s span. There is no camera rate to wire, so
    // 8 is simply the pacer's, over media it holds.
    expect(BROKER_PACED_RATES).toContain(8)
    // 16 is not a rate: the camera's `playSpeed 16` is an I-frame-only MODE
    // (10 access units for a whole clip, no audio), and the broker's honest
    // twin of that would drop whole GOPs rather than push 16× the bitrate.
    // Neither exists, so 16 is refused rather than offered and clamped to 8.
    expect(BROKER_PACED_RATES).not.toContain(16)
  })

  it('is the ONE place the clamp gets its ends from — they cannot drift apart', () => {
    // The clamp, the `setRate` bound and this ladder are one decision. They
    // used to be three literals, which is how 8 and 16 were offered while the
    // clamp quietly served 4. The ends are now READ from this array, so the
    // only way to move one is to move it.
    expect(clampPlaybackRate(Math.max(...BROKER_PACED_RATES) * 2)).toBe(
      Math.max(...BROKER_PACED_RATES),
    )
    expect(clampPlaybackRate(Math.min(...BROKER_PACED_RATES) / 2)).toBe(
      Math.min(...BROKER_PACED_RATES),
    )
    // And the wire agrees: the ceiling parses, one step past it does not.
    const ceiling = Math.max(...BROKER_PACED_RATES)
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: ceiling }))).not.toBeNull()
    expect(parseControlMessage(JSON.stringify({ t: 'setRate', rate: ceiling + 1 }))).toBeNull()
  })

  it('is ascending, so the viewer can render it in order without sorting', () => {
    const sorted = [...BROKER_PACED_RATES].sort((a, b) => a - b)
    expect([...BROKER_PACED_RATES]).toEqual(sorted)
  })
})

describe('clipAudio — silence always names its cause (D391, D621)', () => {
  it('carries a RATE reason, and the rate itself', () => {
    // The operator: *"L'audio non serve in velocità non 1x!!!"* [audio is not needed at speeds other than 1x!!!] — so the
    // broker drops it, and has since D600. What it could not do was SAY so:
    // a clip silent at 2× and a clip silent because the stream broke were the
    // same `carried: false`. Multiplying the rates multiplies that.
    const raw = serializeServerMessage({
      t: 'clipAudio',
      clipId: 'native:reolink:onboard/abc',
      carried: false,
      reason: 'rate',
      rate: 2,
    })
    expect(JSON.parse(raw)).toEqual({
      t: 'clipAudio',
      clipId: 'native:reolink:onboard/abc',
      carried: false,
      reason: 'rate',
      rate: 2,
    })
  })

  it('REFUSES a rate silence that does not name the rate', () => {
    // "No sound because of the rate" without the rate is the same unanswerable
    // message it replaces. The pairing is structural, not a convention: the
    // serializer parses on the way out, so this throws rather than shipping.
    expect(() =>
      serializeServerMessage({
        t: 'clipAudio',
        clipId: 'c',
        carried: false,
        reason: 'rate',
      } as never),
    ).toThrow()
  })

  it('REFUSES a rate on any OTHER reason — it would read as a rate silence', () => {
    expect(() =>
      serializeServerMessage({
        t: 'clipAudio',
        clipId: 'c',
        carried: false,
        reason: 'no-audio-track',
        rate: 2,
      } as never),
    ).toThrow()
  })

  it('leaves every pre-existing reason exactly as it was', () => {
    for (const reason of [
      'not-negotiated',
      'not-offered',
      'no-audio-track',
      'unsupported-codec',
      'codec-mismatch',
      'stream-failed',
    ] as const) {
      expect(
        ServerMessageSchema.safeParse({ t: 'clipAudio', clipId: 'c', carried: false, reason })
          .success,
      ).toBe(true)
    }
  })
})

describe('clipTransport — removed (D612)', () => {
  it('is no longer a server message: the per-clip channel is gone', () => {
    // It could not vary per clip. `chooseClipPath` reads only whether the
    // dial and the file read are wired — both provider-level — so the one
    // authority is `videoclips.getPlaybackOptions`. Two channels that can
    // disagree are worse than one (D62).
    expect(
      ServerMessageSchema.safeParse({
        t: 'clipTransport',
        clipId: 'c',
        seek: 'forward',
        stepBack: false,
      }).success,
    ).toBe(false)
  })
})

describe('clipIncomplete — a truncated serve is a statement, not a retry (D623)', () => {
  it('carries the two codes a viewer can act on, and refuses anything else', () => {
    for (const code of ['stream-short', 'stream-empty']) {
      expect(
        ServerMessageSchema.safeParse({ t: 'clipIncomplete', clipId: 'c', code, reason: 'why' })
          .success,
      ).toBe(true)
    }
    // "We could not check" is a provider diagnostic and stays in its log: it
    // is not something to put on a screen, and a schema that accepted it would
    // let one leak there.
    expect(
      ServerMessageSchema.safeParse({
        t: 'clipIncomplete',
        clipId: 'c',
        code: 'completeness-unverified',
        reason: 'why',
      }).success,
    ).toBe(false)
  })

  it('refuses a report with no clip and one with no sentence', () => {
    expect(
      ServerMessageSchema.safeParse({
        t: 'clipIncomplete',
        clipId: '',
        code: 'stream-short',
        reason: 'why',
      }).success,
    ).toBe(false)
    // A complaint with no words is a badge the operator cannot act on.
    expect(
      ServerMessageSchema.safeParse({
        t: 'clipIncomplete',
        clipId: 'c',
        code: 'stream-short',
        reason: '',
      }).success,
    ).toBe(false)
  })
})
