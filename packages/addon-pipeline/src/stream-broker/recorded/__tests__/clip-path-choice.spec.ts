/**
 * Which clip path a consumer gets: one decision, stated, never a fallthrough.
 *
 * Since D599 there is ONE transport for playback — the stream serves every
 * profile, and the dial's `served` says which twin it carries. The file path
 * is what a broker with no dial falls back to, not a second class of ask.
 * What is pinned here is that the decision does not read the PROFILE at all:
 * a branch on it would be this consumer second-guessing which twin the
 * provider can produce, which is the provider's own question.
 */
import { describe, expect, it, vi } from 'vitest'
import { chooseClipPath, createRefusedClipFeeder } from '../clip-path-choice'

describe('chooseClipPath', () => {
  it.each([
    [null, true, true, 'stream', 'stream-serves-every-profile'],
    ['low', true, true, 'stream', 'stream-serves-every-profile'],
    ['mid', true, true, 'stream', 'stream-serves-every-profile'],
    // The carve-out D599 removed: `high` is an ordinary ask on the stream.
    ['high', true, true, 'stream', 'stream-serves-every-profile'],
    ['high', true, false, 'stream', 'stream-serves-every-profile'],
    ['low', false, true, 'file', 'no-stream-dial-wired'],
    ['high', false, true, 'file', 'no-stream-dial-wired'],
    ['low', false, false, 'none', 'nothing-wired'],
    ['high', false, false, 'none', 'nothing-wired'],
  ] as const)('profile=%s dial=%s file=%s → %s (%s)', (profile, streamDialWired, fileReadWired, path, reason) => {
    expect(chooseClipPath({ profile, streamDialWired, fileReadWired })).toEqual({ path, reason })
  })

  it('gives the SAME answer for every profile, whatever is wired', () => {
    // The claim stated as one assertion rather than inferred from the table:
    // no profile may take a different transport from another.
    for (const streamDialWired of [true, false]) {
      for (const fileReadWired of [true, false]) {
        const answers = (['high', 'mid', 'low', null] as const).map((profile) =>
          JSON.stringify(chooseClipPath({ profile, streamDialWired, fileReadWired })),
        )
        expect(new Set(answers).size, `dial=${streamDialWired} file=${fileReadWired}`).toBe(1)
      }
    }
  })
})

describe('createRefusedClipFeeder', () => {
  it('reports `error` once on the first verb, logs every verb, and has no duration', async () => {
    const onState = vi.fn()
    const onLog = vi.fn()
    const feeder = createRefusedClipFeeder({
      handle: { deviceId: 107, clipId: 'c', provider: 'provider-reolink', profile: 'high' },
      reason: 'nothing-wired',
      onState,
      onLog,
    })
    await feeder.seek(0)
    feeder.stepFrame(1)
    feeder.beginScrub()
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState.mock.calls[0]?.[0]).toMatchObject({
      to: 'error',
      reason: 'refused:nothing-wired',
    })
    expect(onLog).toHaveBeenCalledTimes(3)
    expect(onLog.mock.calls[0]?.[1]).toMatchObject({ deviceId: 107, clipId: 'c', verb: 'seek' })
    expect(await feeder.durationMs?.()).toBeNull()
  })

  it('REFUSES setRate by name — a rate accepted and never applied is the same silence', () => {
    // `setRate` was the one driving verb here that returned `() => {}`. The
    // session calls it on every rebuild whose rate is not 1
    // (`enterRecorded`), so a clip nothing can serve used to take a rate
    // change and say nothing about it — D391's branch that accepts work and
    // produces none. `scrubTo`/`scrubAck` stay silent DELIBERATELY: they ride
    // every pointer move and `beginScrub` has already refused the gesture.
    const onLog = vi.fn()
    const feeder = createRefusedClipFeeder({
      handle: { deviceId: 107, clipId: 'c', provider: 'provider-reolink', profile: 'high' },
      reason: 'nothing-wired',
      onState: vi.fn(),
      onLog,
    })
    feeder.setRate(2)
    expect(onLog).toHaveBeenCalledTimes(1)
    expect(onLog.mock.calls[0]?.[1]).toMatchObject({ deviceId: 107, verb: 'setRate' })
    feeder.scrubTo(0)
    feeder.scrubAck()
    expect(onLog).toHaveBeenCalledTimes(1)
  })
})
