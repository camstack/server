/**
 * The forward-only stream feeder (D597), driven by a scripted "camera" that
 * hands the real fragmented fixture over in pieces, on fake time.
 *
 * `clip-frag.mp4`: 30 frames at 15 fps (pts 0…1933 ms), keyframes at 0 and
 * 1000, two fragments, NO B-frames (`-bf 0`) — decode order is pts order,
 * which is what a Reolink camera's stream is. A fixture with B-frames
 * modelled a stream the camera never sends and made "the head" ambiguous.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROKER_PACED_RATES } from '../control-protocol'
import {
  createClipStreamFeeder,
  type ClipStreamDialAnswer,
  type ClipIncompleteReport,
  type ClipStreamHandlers,
  type ClipStreamOpened,
} from '../clip-stream-feeder'
import type { FeederStateTransition } from '../recorded-feeder'
import type { ClipPlaybackHandle } from '../timeline-session'

const FIXTURE = readFileSync(join(__dirname, 'fixtures/clip-frag.mp4'))

/** Byte offsets of the top-level `moof`s, read off the file rather than pinned. */
function fragmentStarts(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  let at = 0
  while (at + 8 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'moof') out.push(at)
    at += view.getUint32(at)
  }
  return out
}
const [, FRAGMENT_2_START = 0] = fragmentStarts(FIXTURE)
const HANDLE: ClipPlaybackHandle = {
  deviceId: 107,
  clipId: 'native:reolink:onboard:0:abc',
  provider: 'provider-reolink',
  profile: 'low',
}

interface Pushed {
  readonly ts: number
  readonly codec: string
  readonly bytes: number
  /** The first NAL type after the parameter sets — 5 (IDR) marks a keyframe. */
  readonly keyframe: boolean
}

function isIdr(annexB: Uint8Array): boolean {
  // The fused keyframe starts with SPS (7) PPS (8) then IDR (5); a delta
  // frame starts with a non-IDR slice (1). Walk the start codes.
  let at = 0
  while (at + 4 < annexB.length) {
    if (annexB[at] === 0 && annexB[at + 1] === 0 && annexB[at + 2] === 0 && annexB[at + 3] === 1) {
      const type = (annexB[at + 4] ?? 0) & 0x1f
      if (type === 5) return true
      if (type === 1) return false
      at += 4
    } else at += 1
  }
  return false
}

function harness(
  options: {
    dial?: ClipStreamDialAnswer
    open?: ClipStreamOpened
    maxBufferedBytes?: number
    stallTimeoutMs?: number
    prerollMs?: number
    handle?: ClipPlaybackHandle
  } = {},
) {
  let handlers: ClipStreamHandlers | null = null
  const connection = { pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() }
  const pushed: Pushed[] = []
  const states: FeederStateTransition[] = []
  const positions: number[] = []
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
  const dial = vi.fn(
    async (): Promise<ClipStreamDialAnswer> =>
      options.dial ?? {
        kind: 'dialed',
        url: 'http://127.0.0.1:1/tok',
        expiresAtMs: Date.now() + 30_000,
      },
  )
  const open = vi.fn(async (_url: string, h: ClipStreamHandlers): Promise<ClipStreamOpened> => {
    handlers = h
    return options.open ?? { kind: 'open', connection }
  })
  const feeder = createClipStreamFeeder({
    handle: options.handle ?? HANDLE,
    dial,
    open,
    sink: {
      pushAccessUnit: (data, ts, codec) =>
        pushed.push({ ts, codec, bytes: data.byteLength, keyframe: isIdr(data) }),
    },
    onState: (t) => states.push(t),
    onPosition: (ms) => positions.push(ms),
    onLog: (msg, data) => logs.push({ msg, data }),
    ...(options.maxBufferedBytes !== undefined
      ? { maxBufferedBytes: options.maxBufferedBytes }
      : {}),
    ...(options.stallTimeoutMs !== undefined ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
    ...(options.prerollMs !== undefined ? { prerollMs: options.prerollMs } : {}),
    now: () => Date.now(),
  })
  const deliver = (from: number, to: number): void => {
    if (handlers === null) throw new Error('the stream is not open')
    handlers.onData(FIXTURE.subarray(from, to))
  }
  const end = (report: ClipIncompleteReport | null = null): void => handlers?.onEnd(report)
  const fail = (err: Error): void => handlers?.onError(err)
  const log = (msg: string) => logs.filter((l) => l.msg === msg)
  const stateNames = () => states.map((s) => s.to)
  return {
    feeder,
    deliver,
    end,
    fail,
    pushed,
    states,
    stateNames,
    positions,
    logs,
    log,
    dial,
    open,
    connection,
  }
}

/** Let the seek's awaits (dial, open) settle on fake time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('createClipStreamFeeder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('plays from the stream: the first frame lands on the FIRST fragment, before the end', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    // The audio ask travels on the DIAL (D600): this harness negotiates no
    // codec, so `none` is what the provider is told — explicitly, never by
    // omission, because the mux is spawned before the first byte.
    expect(h.dial).toHaveBeenCalledWith(HANDLE, 'none')
    expect(h.stateNames()).toEqual(['loading'])
    // Only the first fragment has arrived; the stream is still open.
    h.deliver(0, FRAGMENT_2_START)
    await seek
    expect(h.pushed.length).toBeGreaterThanOrEqual(1)
    expect(h.pushed[0]?.keyframe).toBe(true)
    expect(h.pushed[0]?.ts).toBe(0)
    expect(h.stateNames()).toEqual(['loading', 'playing'])
    const first = h.log('clip-stream:first-frame')[0]
    expect(first?.data).toMatchObject({ deviceId: 107, clipId: HANDLE.clipId, ptsMs: 0 })
    // Pacing: after 500 ms of wall time, ~8 frames at 15 fps are out, not 15.
    await vi.advanceTimersByTimeAsync(500)
    expect(h.pushed.length).toBeGreaterThanOrEqual(7)
    expect(h.pushed.length).toBeLessThanOrEqual(9)
    // The second fragment lands and the stream ends; playback runs to the end.
    h.deliver(FRAGMENT_2_START, FIXTURE.length)
    h.end()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.pushed.length).toBe(30)
    expect(h.stateNames().at(-1)).toBe('ended')
    // RTP stamps are monotonic and 90 kHz-spaced at 15 fps (6000 ticks).
    for (let i = 1; i < h.pushed.length; i++) {
      expect((h.pushed[i]?.ts ?? 0) - (h.pushed[i - 1]?.ts ?? 0)).toBeGreaterThan(0)
    }
    expect(h.positions.length).toBeGreaterThan(0)
    expect(h.log('clip-stream:ended')[0]?.data).toMatchObject({ samples: 30, durationMs: 2000 })
    h.feeder.dispose()
  })

  it('takes bytes that land BEFORE the open settles — Node flushes them on the tick before the continuation', async () => {
    // A fake opener that delivers the way `node:http` does: the body bytes
    // it already holds are emitted synchronously when the listener attaches,
    // before the returned promise's continuation runs. The first version of
    // this feeder dropped them as "not streaming yet" and every live stream
    // died `no-moov`; the fake above, which delivers only after `await`, had
    // kept the suite green.
    const connection = { pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() }
    const pushed: Pushed[] = []
    const states: string[] = []
    const logs: string[] = []
    const feeder = createClipStreamFeeder({
      handle: HANDLE,
      dial: async () => ({
        kind: 'dialed',
        url: 'http://127.0.0.1:1/tok',
        expiresAtMs: Date.now() + 30_000,
      }),
      open: async (_url, h) => {
        h.onData(FIXTURE)
        h.onEnd(null)
        return { kind: 'open', connection }
      },
      sink: {
        pushAccessUnit: (data, ts, codec) =>
          pushed.push({ ts, codec, bytes: data.byteLength, keyframe: isIdr(data) }),
      },
      onState: (t) => states.push(t.to),
      onPosition: () => {},
      onLog: (msg) => logs.push(msg),
      now: () => Date.now(),
    })
    await feeder.seek(0)
    expect(pushed.length).toBeGreaterThanOrEqual(1)
    expect(pushed[0]?.keyframe).toBe(true)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(pushed.length).toBe(30)
    expect(states.at(-1)).toBe('ended')
    expect(logs).not.toContain('clip-stream:cut')
    expect(await feeder.durationMs?.()).toBe(2000)
    feeder.dispose()
  })

  it('duration is UNKNOWN until the stream ends — null on a cut, never 0', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FRAGMENT_2_START)
    await seek
    let resolved: number | null | undefined
    void h.feeder.durationMs!().then((v) => {
      resolved = v
    })
    await settle()
    expect(resolved).toBeUndefined()
    h.deliver(FRAGMENT_2_START, FIXTURE.length)
    h.end()
    await settle()
    expect(resolved).toBe(2000)
    h.feeder.dispose()

    const cut = harness()
    const seek2 = cut.feeder.seek(0)
    await settle()
    cut.deliver(0, FRAGMENT_2_START)
    await seek2
    const late = cut.feeder.durationMs!()
    cut.fail(new Error('socket hang up'))
    expect(await late).toBeNull()
    expect(cut.stateNames().at(-1)).toBe('error')
    expect(cut.log('clip-stream:cut')[0]?.data).toMatchObject({
      reason: 'stream-failed',
      deviceId: 107,
    })
    expect(cut.connection.destroy).toHaveBeenCalled()
  })

  it('REFUSES a backward seek by name, keeps playing, and re-sends the head', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    await vi.advanceTimersByTimeAsync(600)
    const headBefore = h.pushed.length
    expect(headBefore).toBeGreaterThan(5)
    h.positions.length = 0
    await h.feeder.seek(100)
    const refused = h.log('clip-stream:seek-backward-refused')[0]
    expect(refused?.data).toMatchObject({ deviceId: 107, targetMs: 100 })
    expect(refused?.data['headMs']).toBeGreaterThan(100)
    // Nothing rewound: the position re-sent IS the head, and playback goes on.
    expect(h.positions).toEqual([refused?.data['headMs']])
    expect(h.stateNames()).toEqual(['loading', 'playing'])
    await vi.advanceTimersByTimeAsync(200)
    expect(h.pushed.length).toBeGreaterThan(headBefore)
    // "Back to the start" is a backward seek like any other.
    await h.feeder.seek(0)
    expect(h.log('clip-stream:seek-backward-refused').length).toBe(2)
    h.feeder.dispose()
  })

  it('honours a forward seek whose bytes have arrived: drops to the last keyframe, bursts to the target', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    await vi.advanceTimersByTimeAsync(300)
    const before = h.pushed.length
    await h.feeder.seek(1_200)
    const landed = h.log('clip-stream:seek-landed')[1]
    expect(landed?.data).toMatchObject({ targetMs: 1_200, landedMs: 1_200 })
    // The frames between the head and the keyframe at 1000 were dropped, not
    // decoded; the burst is keyframe(1000) + 200 ms of deltas = 4 frames.
    expect(landed?.data['droppedUnits']).toBeGreaterThan(0)
    expect(landed?.data['burstUnits']).toBe(4)
    const burst = h.pushed.slice(before)
    expect(burst[0]?.keyframe).toBe(true)
    expect(burst.length).toBe(4)
    expect(h.stateNames()).toEqual(['loading', 'playing', 'loading', 'playing'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.pushed.length).toBe(before + 4 + 11)
    expect(h.stateNames().at(-1)).toBe('ended')
    h.feeder.dispose()
  })

  it('a forward seek beyond what has arrived WAITS for the bytes and lands when they come', async () => {
    const h = harness()
    const seek = h.feeder.seek(1_400)
    await settle()
    // Only the first fragment (pts 0…933) has arrived: the target has not.
    h.deliver(0, FRAGMENT_2_START)
    await seek
    expect(h.pushed.length).toBe(0)
    expect(h.stateNames()).toEqual(['loading'])
    await vi.advanceTimersByTimeAsync(200)
    expect(h.pushed.length).toBe(0)
    h.deliver(FRAGMENT_2_START, FIXTURE.length)
    // Landed: the keyframe at 1000 and the deltas to 1400 burst, nothing before.
    const landed = h.log('clip-stream:seek-landed')[0]
    expect(landed?.data).toMatchObject({ targetMs: 1_400, landedMs: 1_400, burstUnits: 7 })
    expect(h.pushed[0]?.keyframe).toBe(true)
    expect(h.pushed.length).toBe(7)
    expect(h.stateNames()).toEqual(['loading', 'playing'])
    h.end()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.pushed.length).toBe(15)
    expect(h.stateNames().at(-1)).toBe('ended')
    h.feeder.dispose()
  })

  it('a provider refusal before the first byte is `error`, named, with no stream opened', async () => {
    const h = harness({
      dial: { kind: 'refused', code: 'sleeping', detail: 'a standalone battery camera' },
    })
    await h.feeder.seek(0)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.stateNames()).toEqual(['loading', 'error'])
    expect(h.log('clip-stream:refused')[0]?.data).toMatchObject({ code: 'sleeping', deviceId: 107 })
    expect(await h.feeder.durationMs!()).toBeNull()
  })

  it('a provider that predates the dial is `stream-unavailable`, with the deploy hint', async () => {
    const h = harness({
      dial: { kind: 'unavailable', detail: 'does not implement "dialClipStream"' },
    })
    await h.feeder.seek(0)
    expect(h.stateNames()).toEqual(['loading', 'error'])
    const refused = h.log('clip-stream:refused')[0]
    expect(refused?.data['code']).toBe('stream-unavailable')
    expect(String(refused?.data['hint'])).toContain('provider-reolink')
  })

  it('a status instead of bytes is a refusal in the provider’s own code', async () => {
    const h = harness({
      open: { kind: 'refused', status: 409, code: 'clip-in-progress', detail: 'still writing' },
    })
    await h.feeder.seek(0)
    expect(h.stateNames()).toEqual(['loading', 'error'])
    expect(h.log('clip-stream:refused')[0]?.data).toMatchObject({
      code: 'clip-in-progress',
      status: 409,
    })
  })

  it('cuts a stream that goes silent, by name (D447: a peer that never delivers)', async () => {
    const h = harness({ stallTimeoutMs: 2_000 })
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FRAGMENT_2_START)
    await seek
    await vi.advanceTimersByTimeAsync(2_100)
    expect(h.log('clip-stream:cut')[0]?.data).toMatchObject({ reason: 'stream-stalled' })
    expect(h.stateNames().at(-1)).toBe('error')
    expect(h.connection.destroy).toHaveBeenCalled()
  })

  it('pauses the socket above the byte bound and resumes once playback drains it (D447)', async () => {
    const h = harness({ maxBufferedBytes: 1_000 })
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    await seek
    expect(h.connection.pause).toHaveBeenCalledTimes(1)
    expect(h.log('clip-stream:backpressure-paused')[0]?.data['maxBytes']).toBe(1_000)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.connection.resume).toHaveBeenCalledTimes(1)
    h.feeder.dispose()
  })

  it('refuses step-backward and scrub by name; steps forward one frame while paused', async () => {
    const h = harness()
    h.feeder.setRate(0)
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    expect(h.stateNames()).toEqual(['loading', 'paused'])
    const burst = h.pushed.length
    h.feeder.stepFrame(-1)
    expect(h.log('clip-stream:step-backward-refused').length).toBe(1)
    expect(h.pushed.length).toBe(burst)
    h.feeder.stepFrame(1)
    expect(h.pushed.length).toBe(burst + 1)
    h.feeder.beginScrub('d1')
    h.feeder.scrubTo(0)
    h.feeder.scrubTo(0)
    expect(h.log('clip-stream:scrub-refused').length).toBe(1)
    expect(h.log('clip-stream:scrub-refused')[0]?.data).toMatchObject({
      dragId: 'd1',
      reason: 'forward-only',
    })
    // Resume: pacing continues from the head.
    h.feeder.setRate(1)
    expect(h.stateNames().at(-1)).toBe('playing')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.pushed.length).toBe(30)
    h.feeder.dispose()
  })

  it('dispose destroys the socket and logs the exit with the counts', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FRAGMENT_2_START)
    await seek
    h.feeder.dispose()
    expect(h.connection.destroy).toHaveBeenCalledTimes(1)
    expect(h.log('clip-stream:disposed')[0]?.data).toMatchObject({
      deviceId: 107,
      phaseBefore: 'streaming',
    })
    expect(await h.feeder.durationMs!()).toBeNull()
    // A seek after the exit is named, not silently swallowed.
    await h.feeder.seek(500)
    expect(h.log('clip-stream:seek-after-exit').length).toBe(1)
  })

  // The feeder's own `transport` declaration is GONE (D612): it could not
  // vary per clip, so it is answered once per provider by
  // `videoclips.getPlaybackOptions`. What stays here is the two things only
  // the feeder can prove — that the rate is really delivered, and that a rate
  // it cannot deliver is named.

  /**
   * Play the whole fixture out at `rate` and return the WALL milliseconds it
   * took — the only thing that can tell a rate that is delivered from a rate
   * that was accepted.
   *
   * The clip is 30 frames at 15 fps; `seek(0)` bursts the first, so 1933.3 ms
   * of media remain and an honest pacer empties them in `1933.3 / rate` ms.
   * Nothing here reads the feeder's own `rate`, and nothing compares a
   * constant to itself: a feeder that accepted 8 and paced 4 takes twice as
   * long and this measurement says so.
   */
  async function playOutWallMs(rate: number): Promise<number> {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    const startedAt = Date.now()
    h.feeder.setRate(rate)
    const expected = 1_933.3 / rate
    const step = Math.max(1, Math.round(expected / 250))
    while (h.pushed.length < 30 && Date.now() - startedAt < expected * 4 + 500) {
      await vi.advanceTimersByTimeAsync(step)
    }
    const elapsed = Date.now() - startedAt
    h.feeder.dispose()
    expect(h.pushed.length).toBe(30)
    return elapsed
  }

  it('DELIVERS every rate it declares — measured as wall time, not read back', async () => {
    // D620's own enforcement ask, and the one gate this area was missing: the
    // ladder, the clamp and the `setRate` bound agreeing with each other
    // proves nothing, because 8 and 16 were once offered, clamped to 4 and
    // agreed with in exactly that way. What the operator experiences is how
    // fast the picture moves, so that is what is asserted.
    //
    // 8 is in this loop since D621. It is the PACER's, not the camera's:
    // `<playSpeed>` turned out to buy supply and never speed (D620), so there
    // was never a second mechanism to wait for — only media in hand, which
    // this fixture has and a `file` clip has.
    for (const rate of BROKER_PACED_RATES) {
      const expected = 1_933.3 / rate
      const measured = await playOutWallMs(rate)
      // Generous on purpose: the pacer sleeps in ticks and the step used to
      // advance fake time is coarse. A rate silently served at half speed
      // misses this by 100%, which is the failure being guarded.
      expect(Math.abs(measured - expected) / expected, `rate ${rate}`).toBeLessThan(0.15)
    }
  })

  it('NAMES a rate it accepted and will not deliver — 16x is not 16x', async () => {
    // D391: a branch that accepts work and produces something else is the
    // same branch as one that drops it. 16 is the number the operator asks
    // for and the one the pacer cannot honestly give: the camera's real 16x
    // is an I-frame-only stream (10 access units for a whole clip, no audio,
    // D620), not this content delivered faster. The wire refuses it, and a
    // caller that reaches the feeder anyway is named rather than clamped in
    // silence.
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    h.feeder.setRate(16)
    const line = h.log('clip-stream:rate-not-delivered')
    expect(line.length).toBe(1)
    expect(line[0]?.data).toMatchObject({ deviceId: 107, requested: 16, applied: 8 })
    // Every rate that IS delivered says nothing — 8 included, now.
    h.feeder.setRate(8)
    h.feeder.setRate(2)
    h.feeder.setRate(0)
    expect(h.log('clip-stream:rate-not-delivered').length).toBe(1)
    h.feeder.dispose()
  })

  it('waits for a CUSHION before pacing a source that has not got one', async () => {
    // A pacer at rate 1 against a source arriving at 1× is two clocks of the
    // same speed with nothing between them: the queue never builds and the
    // first hiccup empties it. Measured live on 1436 — `starved` with
    // `headMs === arrivedMs`, exactly — 880 ms of media played and the viewer
    // fell back to live.
    const h = harness({ prerollMs: 5_000 })
    const seek = h.feeder.seek(0)
    await settle()
    // One fragment: some media, far less than the cushion, and NOT the end.
    h.deliver(0, FRAGMENT_2_START)
    await seek
    // The first frame paints immediately — that is the latency win, kept.
    const painted = h.pushed.length
    expect(painted).toBeGreaterThan(0)
    // But the clip does not start MOVING on a cushion that is not there.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.pushed.length).toBe(painted)
    // The stream ending is the one thing that makes the cushion unnecessary:
    // there is no more coming, so the rest plays out rather than hanging.
    h.end()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.pushed.length).toBeGreaterThan(painted)
    h.feeder.dispose()
  })

  it('charges NOTHING to a source that already holds more than the cushion', async () => {
    // Reolink lands a whole clip at 49–62× realtime. The cushion is a
    // shortfall, not a delay, so that path starts exactly as it always did —
    // this is the regression guard for every fast provider.
    const h = harness({ prerollMs: 500 })
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    await seek
    const painted = h.pushed.length
    // 30 frames at 15 fps is 2 000 ms of media, well over the cushion, so the
    // pacer runs at once and on its own schedule.
    await vi.advanceTimersByTimeAsync(400)
    expect(h.pushed.length).toBeGreaterThan(painted)
    h.feeder.dispose()
  })

  it('REBUILDS the cushion after a starve instead of sawtoothing', async () => {
    // Resuming on the first unit that arrives spends the cushion again
    // immediately and starves on the next hiccup. One rebuffer beats a
    // stutter, and the refill is named so it is not invisible.
    const h = harness({ prerollMs: 400 })
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FRAGMENT_2_START)
    await seek
    // Drain what arrived: the pacer runs out with the stream still live.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.log('clip-stream:starved').length).toBe(1)
    const drained = h.pushed.length
    // More media, and the cushion is back: it resumes, and says so.
    h.deliver(FRAGMENT_2_START, FIXTURE.length)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.log('clip-stream:refilled').length).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.pushed.length).toBeGreaterThan(drained)
    h.feeder.dispose()
  })

  it('SAYS SO when the pacer outruns what the stream has produced', async () => {
    // The Hikvision case, which D612 did not yet have: an RTSP replay arrives
    // at 1.01x (measured on 1436, 2026-09-23), so a pacer at 2x or 4x eats the
    // queue faster than the socket fills it, stops, and — before this line —
    // said nothing at all. The picture froze and the only evidence anywhere
    // was the PROVIDER's `peer-stalled` ten seconds later, which names the
    // wrong end of the pipe. One line per run, because at 1x against a
    // realtime source the queue legitimately empties between frames.
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    // A head, and NOT the end: the stream is still live with nothing more in
    // hand, which is exactly what a realtime source looks like.
    h.deliver(0, FRAGMENT_2_START)
    await seek
    h.feeder.setRate(4)
    await vi.advanceTimersByTimeAsync(2_000)
    const starved = h.log('clip-stream:starved')
    expect(starved.length).toBe(1)
    expect(starved[0]?.data).toMatchObject({ deviceId: 107, rate: 4 })
    // Bounded: a second starve adds no second line.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.log('clip-stream:starved').length).toBe(1)
    h.feeder.dispose()
  })

  it('says so when a `high` ask is served the sub copy (D599)', async () => {
    // `high` reaches the stream now instead of being refused, so this line is
    // the ONLY thing standing between the operator and a silent 33x
    // substitution. Refusing used to be the guard; this is.
    const h = harness({
      handle: { ...HANDLE, profile: 'high' },
      dial: {
        kind: 'dialed',
        url: 'http://127.0.0.1:1/tok',
        expiresAtMs: Date.now() + 30_000,
        served: 'low',
      },
    })
    const seek = h.feeder.seek(0)
    await settle()
    const line = h.log('clip stream: no main twin — streaming the sub copy for a `high` ask')
    expect(line.length).toBe(1)
    expect(line[0]?.data).toMatchObject({ deviceId: 107, asked: 'high', served: 'low' })
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    h.feeder.dispose()
  })

  it('says so when a CHEAPER ask is served the main copy (D605)', async () => {
    // The mirror image, and it is not symmetric with the downgrade: a source
    // that archives only its main copy — every Hikvision camera on this fleet
    // — answers `low` with `high` because that is the only media there is. It
    // is honest and unrefusable, and it costs roughly 33x the bytes, so a rule
    // that fires only downwards makes exactly that cost invisible.
    for (const profile of ['low', 'mid'] as const) {
      const h = harness({
        handle: { ...HANDLE, profile },
        dial: {
          kind: 'dialed',
          url: 'http://127.0.0.1:1/tok',
          expiresAtMs: Date.now() + 30_000,
          served: 'high',
        },
      })
      const seek = h.feeder.seek(0)
      await settle()
      const line = h.log('clip stream: only the main copy exists — serving it for a cheaper ask')
      expect(line.length, profile).toBe(1)
      expect(line[0]?.data).toMatchObject({ deviceId: 107, asked: profile, served: 'high' })
      // And it is NOT the downgrade line: a surface reading one as the other
      // would call an upgrade a fault.
      expect(
        h.log('clip stream: no main twin — streaming the sub copy for a `high` ask').length,
      ).toBe(0)
      h.deliver(0, FIXTURE.length)
      h.end()
      await seek
      h.feeder.dispose()
    }
  })

  it('stays QUIET about an upgrade when `high` was what was asked', async () => {
    // An ask that got what it asked for is not news, and an ABSENT ask stated
    // nothing for a line to be about (D382).
    const HANDLE_NO_PROFILE: ClipPlaybackHandle = { ...HANDLE, profile: null }
    for (const profile of ['high', null] as const) {
      const h = harness({
        handle: profile === null ? HANDLE_NO_PROFILE : { ...HANDLE, profile },
        dial: {
          kind: 'dialed',
          url: 'http://127.0.0.1:1/tok',
          expiresAtMs: Date.now() + 30_000,
          served: 'high',
        },
      })
      const seek = h.feeder.seek(0)
      await settle()
      expect(
        h.log('clip stream: only the main copy exists — serving it for a cheaper ask').length,
        String(profile),
      ).toBe(0)
      h.deliver(0, FIXTURE.length)
      h.end()
      await seek
      h.feeder.dispose()
    }
  })

  it('stays QUIET when the twin it got is the twin the profile maps to', async () => {
    // `mid` maps onto the sub twin by design, so a line on any difference
    // would fire on every ordinary clip and mean nothing. Only a downgrade
    // from `high` is news.
    for (const profile of ['mid', 'low'] as const) {
      const h = harness({
        handle: { ...HANDLE, profile },
        dial: {
          kind: 'dialed',
          url: 'http://127.0.0.1:1/tok',
          expiresAtMs: Date.now() + 30_000,
          served: 'low',
        },
      })
      const seek = h.feeder.seek(0)
      await settle()
      expect(
        h.log('clip stream: no main twin — streaming the sub copy for a `high` ask').length,
        profile,
      ).toBe(0)
      h.deliver(0, FIXTURE.length)
      h.end()
      await seek
      h.feeder.dispose()
    }
  })

  it('a seek after the clip has played out is refused: nothing ahead, nothing kept behind', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    h.end()
    await seek
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.stateNames().at(-1)).toBe('ended')
    await h.feeder.seek(1_933)
    expect(h.log('clip-stream:seek-at-end').length).toBe(1)
    h.feeder.dispose()
  })

  /**
   * A feeder disposed WHILE IT IS OPENING must abandon the request, not the
   * answer to it.
   *
   * Measured on the hub 2026-09-23: the viewer's adaptive ladder re-offered
   * the WebRTC session mid-clip, the old coordinator was disposed
   * (`clip-stream:disposed`, `phaseBefore: "opening"`, 18:17:51.470) — and the
   * provider only saw the socket go at 18:18:10.443, exactly
   * `CLIP_STREAM_HEADERS_TIMEOUT_MS` after the dial. Nineteen seconds of a
   * strictly-serial per-host lane spent on a peer that had already gone, and
   * sixteen queued requests behind it all drained with `waitedMs` ≈ 29 998.
   *
   * So the contract is the SIGNAL, not the promise: `open()` is handed an
   * `AbortSignal` that fires the moment the feeder is torn down, whether or
   * not the opener has answered.
   */
  it('dispose while opening ABORTS the request — the opener is signalled, not awaited', async () => {
    let signalled: string | null = null
    let seen: AbortSignal | null = null
    const feeder = createClipStreamFeeder({
      handle: HANDLE,
      dial: async () => ({
        kind: 'dialed',
        url: 'http://127.0.0.1:1/tok',
        expiresAtMs: Date.now() + 30_000,
      }),
      // A provider that has queued this request behind fifteen others: it
      // will not answer for thirty seconds, which is the whole defect.
      open: (_url, _handlers, signal) => {
        seen = signal
        signal.addEventListener('abort', () => {
          signalled = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
        })
        return new Promise<ClipStreamOpened>(() => undefined)
      },
      sink: { pushAccessUnit: () => undefined },
      onState: () => undefined,
      onPosition: () => undefined,
      now: () => Date.now(),
    })
    void feeder.seek(0)
    await settle()
    expect(seen).not.toBeNull()
    expect(signalled).toBeNull()
    feeder.dispose()
    expect(signalled).toBe('clip-stream-abandoned')
  })

  it('an open that answers AFTER the feeder was disposed is destroyed, and SAID (D391)', async () => {
    const connection = { pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() }
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const openDeferred: { resolve: (value: ClipStreamOpened) => void } = {
      resolve: () => {},
    }
    const feeder = createClipStreamFeeder({
      handle: HANDLE,
      dial: async () => ({
        kind: 'dialed',
        url: 'http://127.0.0.1:1/tok',
        expiresAtMs: Date.now() + 30_000,
      }),
      open: () =>
        new Promise<ClipStreamOpened>((resolve) => {
          openDeferred.resolve = resolve
        }),
      sink: { pushAccessUnit: () => undefined },
      onState: () => undefined,
      onPosition: () => undefined,
      onLog: (msg, data) => logs.push({ msg, data }),
      now: () => Date.now(),
    })
    void feeder.seek(0)
    await settle()
    feeder.dispose()
    openDeferred.resolve({ kind: 'open', connection })
    await settle()
    expect(connection.destroy).toHaveBeenCalledTimes(1)
    const abandoned = logs.filter((l) => l.msg === 'clip-stream:open-abandoned')
    expect(abandoned.length).toBe(1)
    expect(abandoned[0]?.data).toMatchObject({ deviceId: 107, phase: 'disposed', opened: 'open' })
  })
})

/**
 * D623. A camera that hangs up a third of the way through a clip and a clip
 * that really is short look identical on a timeline, and for one release the
 * Amcrest provider reported the first as `complete`. The provider now says so
 * in an HTTP trailer; this is the hop that must not lose it.
 */
describe('what the provider says after the last byte', () => {
  it('carries a short-serve report through to the caller, and logs it per camera', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    await seek
    h.end({ code: 'stream-short', reason: 'the camera ended this replay early: 4.3 s of 45.0 s' })

    const report = await h.feeder.incomplete!()
    expect(report).toEqual({
      code: 'stream-short',
      reason: 'the camera ended this replay early: 4.3 s of 45.0 s',
    })
    expect(h.log('clip-stream:incomplete')).toHaveLength(1)
    h.feeder.dispose()
  })

  it('answers null for a whole stream — the absence is the statement', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FIXTURE.length)
    await seek
    h.end()
    expect(await h.feeder.incomplete!()).toBeNull()
    // Nothing to say, and nothing said: a whole clip must not put a line on
    // the log per playback.
    expect(h.log('clip-stream:incomplete')).toHaveLength(0)
    h.feeder.dispose()
  })

  /**
   * A cut already announces itself as `state: error`. Filing a second,
   * different complaint for the same event would report one fault twice — and
   * a waiter that never settles would hold `playClip` open for ever.
   */
  it('settles null on a cut rather than leaving the caller waiting', async () => {
    const h = harness()
    const seek = h.feeder.seek(0)
    await settle()
    h.deliver(0, FRAGMENT_2_START)
    await seek
    const pending = h.feeder.incomplete!()
    h.fail(new Error('the socket died'))
    expect(await pending).toBeNull()
    h.feeder.dispose()
  })
})
