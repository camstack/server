import { describe, it, expect, vi } from 'vitest'
import { TimelineSession } from '../timeline-session'
import { parseControlMessage, ServerMessageSchema } from '../control-protocol'
import type { ClipPlaybackHandle } from '../timeline-session'

function makeSession() {
  const sent: string[] = []
  let gated = false
  return {
    sent,
    get gated() {
      return gated
    },
    setLiveFeedGate: (g: boolean) => {
      gated = g
    },
    pushRecordedAccessUnit: vi.fn(),
    requestKeyframe: vi.fn(),
    sendControl: (raw: string) => sent.push(raw),
  }
}

function fakeFeeder() {
  return {
    seek: vi.fn(async () => {}),
    setRate: vi.fn(),
    stepFrame: vi.fn(),
    beginScrub: vi.fn(),
    scrubTo: vi.fn(),
    scrubAck: vi.fn(),
    dispose: vi.fn(),
  }
}

const PLAY_CLIP = {
  t: 'playClip',
  deviceId: 107,
  clipId: 'native:reolink:onboard/abc',
  // NAMED. A message without it used to parse, and the read then resolved
  // in-process to this addon's own recorder provider — which has no file
  // behind an analytics visit and said so, on every onboard clip.
  provider: 'provider-reolink',
  offsetMs: 0,
  profile: 'low',
} as const

describe('the clip control message', () => {
  it('parses a clip handle plus a REQUIRED file-relative offset', () => {
    expect(parseControlMessage(JSON.stringify(PLAY_CLIP))).toEqual(PLAY_CLIP)
  })

  it('REFUSES a playClip that names no provider — the read would go to a sibling', () => {
    const { provider: _dropped, ...noProvider } = PLAY_CLIP
    expect(parseControlMessage(JSON.stringify(noProvider))).toBeNull()
  })

  it('REFUSES a playClip with no offset — an unstated position is not zero (D382)', () => {
    expect(
      parseControlMessage(JSON.stringify({ t: 'playClip', deviceId: 107, clipId: 'x' })),
    ).toBeNull()
  })

  it('REFUSES an empty clip id and a negative offset', () => {
    expect(parseControlMessage(JSON.stringify({ ...PLAY_CLIP, clipId: '' }))).toBeNull()
    expect(parseControlMessage(JSON.stringify({ ...PLAY_CLIP, offsetMs: -1 }))).toBeNull()
  })
})

describe('TimelineSession — clip playback', () => {
  it('plays a clip through the SAME pointer: gates live, builds a clip feeder, seeks file-relative', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const handles: ClipPlaybackHandle[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: (args) => {
        handles.push(args.handle)
        return feeder
      },
    })

    await ts.handleControl({ ...PLAY_CLIP, offsetMs: 1_500 })

    expect(s.gated).toBe(true)
    expect(ts.currentMode).toBe('recorded')
    expect(handles).toEqual([
      // The provider reaches the feeder's handle, which is the whole point:
      // the byte read names it instead of letting the addon resolve to itself.
      {
        deviceId: 107,
        clipId: 'native:reolink:onboard/abc',
        provider: 'provider-reolink',
        profile: 'low',
      },
    ])
    expect(feeder.seek).toHaveBeenCalledWith(1_500)
    ts.dispose()
  })

  it('never consults the recorded profile ladder for a clip — a file has no tiers', async () => {
    const s = makeSession()
    const locate = vi.fn()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      locate,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => fakeFeeder(),
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'seek', epoch: 900 })
    expect(locate).not.toHaveBeenCalled()
    ts.dispose()
  })

  it('seek / scrubCommit / rate / step stay on the clip feeder and its own axis', async () => {
    const s = makeSession()
    const clipFeeder = fakeFeeder()
    const recorded = vi.fn(() => fakeFeeder())
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: recorded,
      makeClipFeeder: () => clipFeeder,
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'seek', epoch: 900 })
    await ts.handleControl({ t: 'scrubCommit', epoch: 1_200, dragId: 'd1' })
    await ts.handleControl({ t: 'setRate', rate: 0 })
    await ts.handleControl({ t: 'stepFrame', dir: 1 })

    expect(recorded).not.toHaveBeenCalled()
    expect(clipFeeder.seek).toHaveBeenNthCalledWith(1, 0)
    expect(clipFeeder.seek).toHaveBeenNthCalledWith(2, 900)
    expect(clipFeeder.seek).toHaveBeenNthCalledWith(3, 1_200, { dragId: 'd1' })
    expect(clipFeeder.setRate).toHaveBeenCalledWith(0)
    expect(clipFeeder.stepFrame).toHaveBeenCalledWith(1)
    ts.dispose()
  })

  it('a scrub started during a clip drags the CLIP, not a recorded feeder', async () => {
    const s = makeSession()
    const clipFeeder = fakeFeeder()
    const recorded = vi.fn(() => fakeFeeder())
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: recorded,
      makeClipFeeder: () => clipFeeder,
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'scrubStart', dragId: 'd1' })
    await ts.handleControl({ t: 'scrubTo', epoch: 700 })
    expect(recorded).not.toHaveBeenCalled()
    expect(clipFeeder.beginScrub).toHaveBeenCalledWith('d1')
    expect(clipFeeder.scrubTo).toHaveBeenCalledWith(700, undefined)
    ts.dispose()
  })

  it('GO_LIVE leaves the clip in one dispatch and forgets it — no mode it cannot leave (D570)', async () => {
    const s = makeSession()
    const clipFeeder = fakeFeeder()
    const recordedFeeder = fakeFeeder()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => recordedFeeder,
      makeClipFeeder: () => clipFeeder,
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'goLive' })

    expect(ts.currentMode).toBe('live')
    expect(s.gated).toBe(false)
    expect(clipFeeder.dispose).toHaveBeenCalled()

    // And the NEXT recorded tap is ordinary recorded playback, not the clip.
    await ts.handleControl({ t: 'playRecorded', deviceId: 107, epoch: 6_000, profile: 'mid' })
    expect(recordedFeeder.seek).toHaveBeenCalledWith(6_000, { travelFromMs: null })
    ts.dispose()
  })

  it('a SEEK after go-live is ordinary recorded playback — a stale clip pointer would eat it', async () => {
    // Without `goLive` clearing the clip, `this.clip` outlives the feeder it
    // named: the next plain `seek` takes the clip branch, finds no feeder and
    // drops the operator's tap with nothing to show for it.
    const s = makeSession()
    const recordedFeeder = fakeFeeder()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => recordedFeeder,
      makeClipFeeder: () => fakeFeeder(),
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'goLive' })
    await ts.handleControl({ t: 'seek', epoch: 6_000 })

    expect(ts.currentMode).toBe('recorded')
    expect(recordedFeeder.seek).toHaveBeenCalledWith(6_000, { travelFromMs: null })
    ts.dispose()
  })

  it('a clip seek with no feeder left is REFUSED out loud, never silently dropped', async () => {
    const s = makeSession()
    const onLog = vi.fn()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      onLog,
    })
    // No clip feeder wired ⇒ playClip refused ⇒ no clip pointer, so the seek
    // that follows is recorded playback and never a silent no-op.
    await ts.handleControl(PLAY_CLIP)
    onLog.mockClear()
    await ts.handleControl({ t: 'seek', epoch: 6_000 })
    expect(ts.currentMode).toBe('recorded')
    ts.dispose()
  })

  it('playRecorded after a clip returns to the recording source', async () => {
    const s = makeSession()
    const clipFeeder = fakeFeeder()
    const recordedFeeder = fakeFeeder()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => recordedFeeder,
      makeClipFeeder: () => clipFeeder,
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'playRecorded', deviceId: 107, epoch: 6_000, profile: 'mid' })
    expect(clipFeeder.dispose).toHaveBeenCalled()
    expect(recordedFeeder.seek).toHaveBeenCalledWith(6_000, { travelFromMs: null })
    ts.dispose()
  })

  it('a setProfile during a clip changes nothing and SAYS so — a file has no tier', async () => {
    const s = makeSession()
    const onLog = vi.fn()
    const clipFeeder = fakeFeeder()
    const recorded = vi.fn(() => fakeFeeder())
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: recorded,
      makeClipFeeder: () => clipFeeder,
      onLog,
    })
    await ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'setProfile', profile: 'high' })
    expect(recorded).not.toHaveBeenCalled()
    expect(clipFeeder.dispose).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining('clip'),
      expect.objectContaining({ deviceId: 107, clipId: PLAY_CLIP.clipId }),
    )
    ts.dispose()
  })

  it('REFUSES playClip when no clip byte source is wired — and never silently', async () => {
    const s = makeSession()
    const onLog = vi.fn()
    const recorded = vi.fn(() => fakeFeeder())
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: recorded,
      onLog,
    })
    await ts.handleControl(PLAY_CLIP)

    expect(recorded).not.toHaveBeenCalled()
    expect(s.gated).toBe(false)
    expect(ts.currentMode).toBe('live')
    expect(s.sent.map((raw) => JSON.parse(raw))).toContainEqual({ t: 'state', state: 'error' })
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining('clip'),
      expect.objectContaining({ deviceId: 107, clipId: PLAY_CLIP.clipId }),
    )
    ts.dispose()
  })

  it('carries the session rate onto a freshly built clip feeder', async () => {
    const s = makeSession()
    const clipFeeder = fakeFeeder()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => clipFeeder,
    })
    await ts.handleControl({ t: 'setRate', rate: 0 })
    await ts.handleControl(PLAY_CLIP)
    expect(clipFeeder.setRate).toHaveBeenCalledWith(0)
    ts.dispose()
  })

  it('a clip handle with no profile is passed through as null, not invented', async () => {
    const s = makeSession()
    const handles: ClipPlaybackHandle[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: (args) => {
        handles.push(args.handle)
        return fakeFeeder()
      },
    })
    await ts.handleControl({
      t: 'playClip',
      deviceId: 107,
      clipId: 'hksv/1',
      provider: 'provider-reolink',
      offsetMs: 0,
    })
    expect(handles[0]?.profile).toBeNull()
    ts.dispose()
  })
})

describe('the clip duration on the wire', () => {
  /**
   * The clip source has measured `durationMs` from the file's own index since
   * D575 and nobody has ever asked it — the viewer drew nothing, and the only
   * length it could have drawn is the camera's catalog row, which freezes
   * while a file is still growing (592: the same endTime for eight minutes).
   * The measure is reported once the clip's first seek has resolved, named
   * by clip, so a late report cannot be pinned on the next file.
   */
  const withDuration = (durationMs: () => Promise<number | null>) => ({
    ...fakeFeeder(),
    durationMs,
  })
  const sentMsgs = (s: ReturnType<typeof makeSession>) => s.sent.map((raw) => JSON.parse(raw))

  it('reports the measured duration after the clip is open, named by clip', async () => {
    const s = makeSession()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => withDuration(async () => 16_240),
    })
    await ts.handleControl(PLAY_CLIP)
    expect(sentMsgs(s)).toEqual([
      { t: 'clipDuration', clipId: 'native:reolink:onboard/abc', durationMs: 16_240 },
    ])
    ts.dispose()
  })

  it('a feeder that cannot measure reports nothing and SAYS so — never zero', async () => {
    const s = makeSession()
    const logs: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => fakeFeeder(),
      onLog: (msg) => logs.push(msg),
    })
    await ts.handleControl(PLAY_CLIP)
    expect(sentMsgs(s)).toEqual([])
    expect(logs.some((m) => m.includes('duration'))).toBe(true)
    ts.dispose()
  })

  it('a measure that answers NULL is logged as unknown, not sent, and never zero (D393)', async () => {
    // A streamed clip (D597) that was cut or left before it ended has no
    // length: the honest answer is `null`, and the viewer keeps what it draws.
    const s = makeSession()
    const logs: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => withDuration(async () => null),
      onLog: (msg) => logs.push(msg),
    })
    await ts.handleControl(PLAY_CLIP)
    expect(sentMsgs(s)).toEqual([])
    expect(logs.some((m) => m.includes('duration unknown'))).toBe(true)
    expect(ts.currentMode).toBe('recorded')
    ts.dispose()
  })

  it('a measure that rejects is logged, not sent, and the clip stays playable', async () => {
    const s = makeSession()
    const logs: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () =>
        withDuration(async () => {
          throw new Error('unindexable')
        }),
      onLog: (msg) => logs.push(msg),
    })
    await ts.handleControl(PLAY_CLIP)
    expect(sentMsgs(s)).toEqual([])
    expect(logs.some((m) => m.includes('duration'))).toBe(true)
    expect(ts.currentMode).toBe('recorded')
    ts.dispose()
  })

  it('a measure that lands after the clip was LEFT is dropped, not pinned on live', async () => {
    const s = makeSession()
    let release: (ms: number) => void = () => {}
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () =>
        withDuration(
          () =>
            new Promise((r) => {
              release = r
            }),
        ),
    })
    const opened = ts.handleControl(PLAY_CLIP)
    await ts.handleControl({ t: 'goLive' })
    release(9_000)
    await opened
    expect(sentMsgs(s).map((m) => m.t)).toEqual(['state'])
    ts.dispose()
  })
})

describe('what the viewer is told ABOUT the clip it is playing', () => {
  /** The parsed server messages of one kind, in order. */
  function messagesOfKind(sent: readonly string[], t: string): readonly Record<string, unknown>[] {
    return sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((m) => m['t'] === t)
  }

  async function play(
    feeder: Record<string, unknown>,
  ): Promise<{ readonly sent: readonly string[] }> {
    const s = makeSession()
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => feeder as never,
    })
    await ts.handleControl({ ...PLAY_CLIP, offsetMs: 0 })
    // The duration and audio reports are awaited inside `playClip`; the
    // transport one is synchronous. A tick settles anything left pending.
    await new Promise((r) => setTimeout(r, 0))
    return { sent: s.sent }
  }

  // The three `clipTransport` tests that were here are GONE with the message
  // (D612): the broker's transport choice reads only provider-level wiring, so
  // a per-clip declaration carried a value that could not vary. The one
  // authority is `videoclips.getPlaybackOptions`, pinned in
  // `videoclips-playback-options.spec.ts`.
  it('sends NO clipTransport message — the per-clip channel is gone (D612)', async () => {
    const { sent } = await play({
      ...fakeFeeder(),
      audio: async () => ({ carried: true, codec: 'opus', reason: null, detail: null }),
    })
    for (const raw of sent) expect(JSON.parse(raw).t).not.toBe('clipTransport')
  })

  /**
   * D623. The Amcrest camera hangs up a third of the way through a replay and
   * its mux exits 0, so a truncated clip and a short recording were the same
   * picture. The provider now names it; this is the message that puts it where
   * the operator already reads a stream error. Never a retry — *"Se cade la
   * sessione cade non fa niente"* [If the session drops, it drops, nothing happens].
   */
  it('tells the operator when the clip did not arrive whole, with the provider’s own words', async () => {
    const { sent } = await play({
      ...fakeFeeder(),
      incomplete: async () => ({
        code: 'stream-short',
        reason: 'the camera ended this replay early: 4.3 s of 45.0 s',
      }),
    })
    expect(messagesOfKind(sent, 'clipIncomplete')).toEqual([
      {
        t: 'clipIncomplete',
        clipId: PLAY_CLIP.clipId,
        code: 'stream-short',
        reason: 'the camera ended this replay early: 4.3 s of 45.0 s',
      },
    ])
  })

  it('says NOTHING about a clip that arrived whole, or one no feeder can ask about', async () => {
    const whole = await play({ ...fakeFeeder(), incomplete: async () => null })
    expect(messagesOfKind(whole.sent, 'clipIncomplete')).toEqual([])
    // A file-backed feeder has no provider to ask. Absence of the method is
    // absence of an answer, never a claim that the clip was whole.
    const cannot = await play({ ...fakeFeeder() })
    expect(messagesOfKind(cannot.sent, 'clipIncomplete')).toEqual([])
  })

  it('reports the clip AUDIO, and names why there is none', async () => {
    // The `clipAudio` message had no coverage at all: silence reaching the
    // operator unexplained is the one thing it exists to prevent.
    const { sent } = await play({
      ...fakeFeeder(),
      audio: async () => ({ carried: false, codec: null, reason: 'no-audio-track', detail: null }),
    })
    expect(messagesOfKind(sent, 'clipAudio')).toEqual([
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: false, reason: 'no-audio-track' },
    ])
  })

  it('reports audio that IS carried, with its codec', async () => {
    const { sent } = await play({
      ...fakeFeeder(),
      audio: async () => ({ carried: true, codec: 'opus', reason: null, detail: null }),
    })
    expect(messagesOfKind(sent, 'clipAudio')).toEqual([
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: true, codec: 'opus' },
    ])
  })

  it('tells the viewer when the RATE is why it went silent, and when it comes back', async () => {
    // The operator's rule — *"L'audio non serve in velocità non 1x!!!"* [audio is not needed at speeds other than 1x!!!] — has
    // been the live behaviour since D600: `pushNextAudio` drops every frame at
    // any rate but 1×. What was missing is the TELLING. Silence at 2× and
    // silence because the stream broke were the same `carried: false`, which
    // is the D391 defect widening the rate ladder would have multiplied.
    const s = makeSession()
    const audioListeners: Array<(r: Record<string, unknown>) => void> = []
    const feeder = {
      ...fakeFeeder(),
      audio: async () => ({ carried: true, codec: 'opus', reason: null, detail: null }),
      watchAudio: (cb: (r: Record<string, unknown>) => void) => {
        audioListeners.push(cb)
      },
    }
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () => feeder as never,
    })
    await ts.handleControl({ ...PLAY_CLIP, offsetMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(messagesOfKind(s.sent, 'clipAudio')).toEqual([
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: true, codec: 'opus' },
    ])

    // The feeder is the authority on the drop, so it is the authority on the
    // telling: the session forwards what it is handed, it does not decide.
    const listener = audioListeners[0]
    if (listener === undefined) throw new Error('expected clip audio listener')
    listener({ carried: false, codec: null, reason: 'rate', rate: 2 })
    listener({ carried: true, codec: 'opus', reason: null })
    expect(messagesOfKind(s.sent, 'clipAudio')).toEqual([
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: true, codec: 'opus' },
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: false, reason: 'rate', rate: 2 },
      { t: 'clipAudio', clipId: PLAY_CLIP.clipId, carried: true, codec: 'opus' },
    ])
    ts.dispose()
  })

  it('never pins a late audio change on the clip that came NEXT', async () => {
    // Same discipline as the settle report: a feeder whose listener fires
    // after the pointer has left names a clip nobody is playing, and the
    // viewer would mute the wrong one.
    const s = makeSession()
    const audioListeners: Array<(r: Record<string, unknown>) => void> = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 107,
      makeFeeder: () => fakeFeeder(),
      makeClipFeeder: () =>
        ({
          ...fakeFeeder(),
          audio: async () => ({ carried: true, codec: 'opus', reason: null, detail: null }),
          watchAudio: (cb: (r: Record<string, unknown>) => void) => {
            audioListeners.push(cb)
          },
        }) as never,
    })
    await ts.handleControl({ ...PLAY_CLIP, offsetMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    const stale = audioListeners[0]
    await ts.handleControl({ ...PLAY_CLIP, clipId: 'native:reolink:onboard/def', offsetMs: 0 })
    await new Promise((r) => setTimeout(r, 0))
    const before = messagesOfKind(s.sent, 'clipAudio').length
    if (stale !== undefined) stale({ carried: false, codec: null, reason: 'rate', rate: 4 })
    expect(messagesOfKind(s.sent, 'clipAudio')).toHaveLength(before)
    ts.dispose()
  })

  it('every message it sends about a clip is a valid SERVER message', async () => {
    // `serializeServerMessage` parses on the way out, so an invalid one
    // throws rather than reaching the wire — this asserts the round trip and,
    // with it, that nothing here is being sent through some other path that
    // skips the schema.
    const { sent } = await play({
      ...fakeFeeder(),
      audio: async () => ({ carried: true, codec: 'pcmu', reason: null, detail: null }),
    })
    expect(sent.length).toBeGreaterThan(0)
    for (const raw of sent) {
      expect(ServerMessageSchema.safeParse(JSON.parse(raw)).success, raw).toBe(true)
    }
  })
})
