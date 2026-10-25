import { describe, it, expect, vi } from 'vitest'
import { TimelineSession } from '../timeline-session'

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

describe('TimelineSession', () => {
  it('starts in live mode (feed not gated)', () => {
    const s = makeSession()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => fakeFeeder() })
    expect(s.gated).toBe(false)
    ts.dispose()
  })

  it('playRecorded gates the live feed and seeks the feeder', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
    expect(s.gated).toBe(true)
    expect(feeder.seek).toHaveBeenCalledWith(6000, { travelFromMs: null })
    ts.dispose()
  })

  it('reports the effective live profile on the first control message', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      initialLiveProfile: 'high',
      makeFeeder: () => feeder,
    })
    await ts.handleControl({ t: 'warm', epoch: 6_000, profile: 'low' })
    await ts.handleControl({ t: 'warm', epoch: 7_000, profile: 'low' })
    expect(s.sent.map((raw) => JSON.parse(raw))).toEqual([{ t: 'liveProfile', profile: 'high' }])
    ts.dispose()
  })

  it('reuses the recorded feeder for same-profile seeks and rebuilds only on profile change', async () => {
    const s = makeSession()
    const feeders: Array<ReturnType<typeof fakeFeeder>> = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      makeFeeder: () => {
        const feeder = fakeFeeder()
        feeders.push(feeder)
        return feeder
      },
    })

    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'mid' })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 8_000, profile: 'mid' })
    expect(feeders).toHaveLength(1)
    expect(feeders[0]!.dispose).not.toHaveBeenCalled()
    expect(feeders[0]!.seek).toHaveBeenCalledTimes(2)

    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 9_000, profile: 'low' })
    expect(feeders).toHaveLength(2)
    expect(feeders[0]!.dispose).toHaveBeenCalledTimes(1)
    ts.dispose()
  })

  it('preserves pause while scrub low returns to the selected playback profile', async () => {
    const s = makeSession()
    const feeders: Array<ReturnType<typeof fakeFeeder>> = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      makeFeeder: () => {
        const feeder = fakeFeeder()
        feeders.push(feeder)
        return feeder
      },
    })

    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'mid' })
    await ts.handleControl({ t: 'setRate', rate: 0 })
    await ts.handleControl({ t: 'setProfile', profile: 'low' })
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 8_000, profile: 'mid' })

    expect(feeders).toHaveLength(3)
    expect(feeders[1]!.setRate).toHaveBeenCalledWith(0)
    expect(feeders[2]!.setRate).toHaveBeenCalledWith(0)
    expect(feeders[2]!.seek).toHaveBeenCalledWith(8_000, { travelFromMs: null })
    ts.dispose()
  })

  it('seek while live enters recorded mode and seeks', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'seek', epoch: 6000 })
    expect(s.gated).toBe(true)
    expect(feeder.seek).toHaveBeenCalledWith(6000, { travelFromMs: null })
    ts.dispose()
  })

  it('goLive disposes the feeder, ungates the feed, requests a keyframe, and reports state live', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
    await ts.handleControl({ t: 'goLive' })
    expect(s.gated).toBe(false)
    expect(feeder.dispose).toHaveBeenCalled()
    expect(s.requestKeyframe).toHaveBeenCalled()
    expect(s.sent.some((m) => JSON.parse(m).state === 'live')).toBe(true)
    ts.dispose()
  })

  it('setRate forwards to the feeder', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
    await ts.handleControl({ t: 'setRate', rate: 0 })
    expect(feeder.setRate).toHaveBeenCalledWith(0)
    ts.dispose()
  })

  it('setRate forwards float rates to the feeder unchanged', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
    await ts.handleControl({ t: 'setRate', rate: 2 })
    expect(feeder.setRate).toHaveBeenCalledWith(2)
    await ts.handleControl({ t: 'setRate', rate: 0.5 })
    expect(feeder.setRate).toHaveBeenCalledWith(0.5)
    ts.dispose()
  })

  it('stepFrame routes to the feeder in recorded mode and is ignored in live', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'stepFrame', dir: 1 }) // live mode → ignored
    expect(feeder.stepFrame).not.toHaveBeenCalled()
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6000, profile: 'mid' })
    await ts.handleControl({ t: 'stepFrame', dir: 1 })
    expect(feeder.stepFrame).toHaveBeenCalledWith(1)
    await ts.handleControl({ t: 'stepFrame', dir: -1 })
    expect(feeder.stepFrame).toHaveBeenCalledWith(-1)
    ts.dispose()
  })

  it('playRecorded hands the feeder the last emitted position as travel-from', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    ts._emitPosition(5_000) // the playhead the viewer last saw
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 500_000, profile: 'mid' })
    expect(feeder.seek).toHaveBeenCalledWith(500_000, { travelFromMs: 5_000 })
    ts.dispose()
  })

  it('scrubCommit passes NO travel-from — the drag already showed the travel', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart' })
    ts._emitPosition(5_000)
    await ts.handleControl({ t: 'scrubCommit', epoch: 500_000 })
    expect(feeder.seek).toHaveBeenCalledWith(500_000)
    ts.dispose()
  })

  it('goLive clears the travel-from — a later recorded entry does not animate from a stale point', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    ts._emitPosition(5_000)
    await ts.handleControl({ t: 'goLive' })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 500_000, profile: 'mid' })
    expect(feeder.seek).toHaveBeenCalledWith(500_000, { travelFromMs: null })
    ts.dispose()
  })

  it('warm pre-runs the fragment chain WITHOUT gating live or building a feeder', async () => {
    const s = makeSession()
    const warm = vi.fn()
    let feeders = 0
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      makeFeeder: () => {
        feeders += 1
        return fakeFeeder()
      },
      warm,
    })
    await ts.handleControl({ t: 'warm', epoch: 6000, profile: 'low' })
    expect(warm).toHaveBeenCalledWith('low', 6000)
    expect(s.gated).toBe(false) // the operator is still watching live
    expect(feeders).toBe(0) // warming never enters recorded mode
    expect(ts.currentMode).toBe('live')
    ts.dispose()
  })

  it('warm without a wired dep is a harmless no-op', async () => {
    const s = makeSession()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => fakeFeeder() })
    await ts.handleControl({ t: 'warm', epoch: 6000, profile: 'low' })
    expect(s.gated).toBe(false)
    ts.dispose()
  })

  it('scrubStart enters recorded mode and calls beginScrub', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart' })
    expect(s.gated).toBe(true)
    expect(feeder.beginScrub).toHaveBeenCalled()
    ts.dispose()
  })

  it('scrubTo forwards to the feeder in recorded mode and is ignored in live', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubTo', epoch: 6000 }) // live → ignored
    expect(feeder.scrubTo).not.toHaveBeenCalled()
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'scrubTo', epoch: 6000 })
    expect(feeder.scrubTo).toHaveBeenCalledWith(6000, undefined)
    ts.dispose()
  })

  it('scrubTo forwards the client MAPPING HINT to the feeder when present', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'scrubTo', epoch: 6000, m: 'fine', v: 42 })
    expect(feeder.scrubTo).toHaveBeenCalledWith(6000, { mode: 'fine', velocityPxPerS: 42 })
    // A HALF-reported hint is no hint: a mode without its velocity would put a
    // guessed number into the aggregate's percentiles.
    await ts.handleControl({ t: 'scrubTo', epoch: 7000, m: 'fine' })
    expect(feeder.scrubTo).toHaveBeenLastCalledWith(7000, undefined)
    ts.dispose()
  })

  it('scrubCommit still enters recorded + seeks (commit path unchanged)', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'scrubCommit', epoch: 7000 })
    expect(feeder.seek).toHaveBeenCalledWith(7000)
    ts.dispose()
  })

  it('scrubStart with a dragId passes it straight to beginScrub (C1)', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart', dragId: 'drag-xyz' })
    expect(feeder.beginScrub).toHaveBeenCalledWith('drag-xyz')
    ts.dispose()
  })

  it('scrubCommit with a dragId passes { dragId } to the commit seek, still with no travel-from (C1)', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart', dragId: 'drag-xyz' })
    await ts.handleControl({ t: 'scrubCommit', epoch: 7000, dragId: 'drag-xyz' })
    expect(feeder.seek).toHaveBeenCalledWith(7000, { dragId: 'drag-xyz' })
    ts.dispose()
  })

  it('goLive during scrub disposes the feeder and returns to live', async () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'goLive' })
    expect(feeder.dispose).toHaveBeenCalled()
    expect(s.gated).toBe(false)
    expect(s.sent.some((m) => JSON.parse(m).state === 'live')).toBe(true)
    ts.dispose()
  })

  it('forwards feeder state + position onto the control channel via emit seams', () => {
    const s = makeSession()
    const feeder = fakeFeeder()
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    ts._emitState('playing')
    ts._emitPosition(6000)
    const msgs = s.sent.map((m) => JSON.parse(m))
    expect(msgs).toEqual(
      expect.arrayContaining([
        { t: 'state', state: 'playing' },
        { t: 'position', epochMs: 6000 },
      ]),
    )
    ts.dispose()
  })
})

describe('TimelineSession — scrubAck (receiver-credit pacing)', () => {
  it('routes scrubAck to the feeder in recorded mode and ignores it in live', async () => {
    const s = makeSession()
    const feeder = { ...fakeFeeder(), scrubAck: vi.fn() }
    const ts = new TimelineSession({ session: s, deviceId: 99, makeFeeder: () => feeder })
    await ts.handleControl({ t: 'scrubAck' }) // live mode → ignored
    expect(feeder.scrubAck).not.toHaveBeenCalled()
    await ts.handleControl({ t: 'scrubStart' })
    await ts.handleControl({ t: 'scrubAck' })
    expect(feeder.scrubAck).toHaveBeenCalledTimes(1)
    ts.dispose()
  })
})

describe('TimelineSession — setProfile idempotence (the mid-drag teardown storm)', () => {
  it('setProfile with an UNCHANGED profile in recorded mode does NOT rebuild the feeder', async () => {
    // Production 2026-08-02: the client re-sent setProfile on every host
    // scrubStart re-send (the documented storm the feeder's own beginScrub is
    // hardened against), and every re-send while recorded tore the feeder down
    // mid-drag — eight rebuild/rebase cycles per minute in Loki, and no pushed
    // frame survived long enough to render. The feeder's storm defense was
    // bypassed through this side door; close it for old clients too.
    const s = makeSession()
    let built = 0
    const feeders: Array<ReturnType<typeof fakeFeeder>> = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      makeFeeder: () => {
        built++
        const f = fakeFeeder()
        feeders.push(f)
        return f
      },
    })
    await ts.handleControl({ t: 'setProfile', profile: 'low' })
    await ts.handleControl({ t: 'scrubStart' }) // enters recorded, builds feeder 1
    expect(built).toBe(1)
    await ts.handleControl({ t: 'setProfile', profile: 'low' }) // storm re-send — must be a no-op
    expect(built).toBe(1)
    expect(feeders[0]!.dispose).not.toHaveBeenCalled()
    // A GENUINE profile change still rebuilds.
    await ts.handleControl({ t: 'setProfile', profile: 'mid' })
    expect(built).toBe(2)
    ts.dispose()
  })
})

describe('TimelineSession — recorded profile fallback', () => {
  it('playRecorded falls back to a profile that has footage at that epoch', async () => {
    const s = makeSession()
    const built: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      locate: async ({ profile }) =>
        profile === 'high'
          ? { kind: 'segment', startMs: 6_000, durMs: 4_000, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null, prevEndMs: null },
      makeFeeder: (profile) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'mid' })
    expect(built).toEqual(['high'])
    ts.dispose()
  })

  it('a tap into a GAP resolves to a profile the camera actually records, not the requested one', async () => {
    // Live failure, camera 1438: the session default profile is `mid`, which NO
    // camera on this cluster records. A tap at an instant with no segment in any
    // profile used to fall back to `mid` — a profile with no footage ANYWHERE, so
    // the feeder's snap-to-nearest had nothing to snap to and a recoverable gap
    // was reported as "no recording at all".
    const s = makeSession()
    const built: string[] = []
    const locate = vi.fn(async ({ profile }: { profile: string }) =>
      profile === 'mid'
        ? { kind: 'gap' as const, nearestEdgeMs: null }
        : { kind: 'gap' as const, nearestEdgeMs: 1_000 },
    )
    const ts = new TimelineSession({
      session: s,
      deviceId: 1438,
      locate,
      makeFeeder: (profile: string) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 1438, epoch: 6_000, profile: 'mid' })
    expect(built).toEqual(['high'])
    ts.dispose()
  })

  it('a tier whose footage is a day away does NOT win: the seek falls to the tier that can play, and says so', async () => {
    // The disk-swap case: High deleted for the old range but still recording
    // on the new disk. `locate('high')` answers a gap whose nearest edge is
    // the first segment after the swap — hours ahead — which the feeder could
    // never snap to (SNAP_MAX_DISTANCE_MS). Mid covers the instant.
    const s = makeSession()
    const built: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      locate: async ({ profile }) =>
        profile === 'high'
          ? { kind: 'gap', nearestEdgeMs: 6_000 + 6 * 3_600_000, prevEndMs: null }
          : profile === 'mid'
            ? { kind: 'segment', startMs: 5_000, durMs: 4_000, bytes: 3 }
            : { kind: 'gap', nearestEdgeMs: null, prevEndMs: null },
      makeFeeder: (profile) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'high' })
    expect(built).toEqual(['mid'])
    // Never a silent switch: the client is told what it is watching.
    expect(s.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      t: 'servedProfile',
      profile: 'mid',
      requested: 'high',
    })
    ts.dispose()
  })

  it('a NEAR gap on the requested tier still wins — the low scrub pin does not regress', async () => {
    const s = makeSession()
    const built: string[] = []
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      locate: async ({ profile }) =>
        profile === 'low'
          ? { kind: 'gap', nearestEdgeMs: 6_000 + 30_000, prevEndMs: null }
          : { kind: 'segment', startMs: 5_000, durMs: 4_000, bytes: 3 },
      makeFeeder: (profile) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'low' })
    expect(built).toEqual(['low'])
    expect(s.sent.map((raw) => JSON.parse(raw)).some((m) => m.t === 'servedProfile')).toBe(false)
    ts.dispose()
  })

  it('the served tier is reported once per change, and again when the request is honoured again', async () => {
    const s = makeSession()
    let highCovers = false
    const ts = new TimelineSession({
      session: s,
      deviceId: 99,
      locate: async ({ profile }) =>
        profile === 'high'
          ? highCovers
            ? { kind: 'segment', startMs: 0, durMs: 100_000_000, bytes: 3 }
            : { kind: 'gap', nearestEdgeMs: 99_000_000, prevEndMs: null }
          : { kind: 'segment', startMs: 0, durMs: 100_000_000, bytes: 3 },
      makeFeeder: () => fakeFeeder(),
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 99, epoch: 6_000, profile: 'high' })
    await ts.handleControl({ t: 'seek', epoch: 7_000 })
    highCovers = true
    await ts.handleControl({ t: 'seek', epoch: 8_000 })
    const served = s.sent.map((raw) => JSON.parse(raw)).filter((m) => m.t === 'servedProfile')
    expect(served).toEqual([
      { t: 'servedProfile', profile: 'mid', requested: 'high' },
      { t: 'servedProfile', profile: 'high', requested: 'high' },
    ])
    ts.dispose()
  })

  it('a REJECTING locate never kills the tap — the session still enters recorded', async () => {
    // 585f5ea22 moved the profile resolve BEFORE enterRecorded: a locate that
    // rejects (recorder cap down, deadline) threw out of handleControl before
    // the gate was set — the tap did NOTHING, silently, exactly when the
    // recorder was struggling. A fallible read may cost the fallback, never
    // the mode flip (D49).
    const s = makeSession()
    const built: string[] = []
    const locate = vi.fn(async () => {
      throw new Error('recorder cap deadline')
    })
    const ts = new TimelineSession({
      session: s,
      deviceId: 1438,
      locate,
      makeFeeder: (profile: string) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 1438, epoch: 6_000, profile: 'mid' })
    expect(s.gated).toBe(true)
    expect(built).toEqual(['mid'])
    ts.dispose()
  })

  it('a tap into a gap with NO footage in any profile still reports the requested profile', async () => {
    const s = makeSession()
    const built: string[] = []
    const locate = vi.fn(async () => ({ kind: 'gap' as const, nearestEdgeMs: null }))
    const ts = new TimelineSession({
      session: s,
      deviceId: 1438,
      locate,
      makeFeeder: (profile: string) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 1438, epoch: 6_000, profile: 'mid' })
    expect(built).toEqual(['mid'])
    ts.dispose()
  })

  it('a gap on the REQUESTED tier never demotes it to a tier that happens to have a segment', async () => {
    // The scrub is pinned to `low` by the client, and every D163 pre-cache
    // behaviour is gated on `deps.profile === 'low'` by exact string equality:
    // the ±15 min entry warm, the whole-segment read, and the 48 MB fragment
    // budget (2 MB for any other profile). `profileSearchOrder` puts `high`
    // BEFORE `low`, so a `low` gap at the tap instant used to hand the drag a
    // `high` feeder — silently turning all three off and putting the drag back
    // on 3-seek GOP reads over ~5 MB segments.
    //
    // A `nearestEdgeMs` on the REQUESTED tier already proves that tier records,
    // which is precisely what snap-to-nearest needs (the reason D-gap fallback
    // exists at all). There is no reason left to change tier.
    const s = makeSession()
    const built: string[] = []
    const locate = vi.fn(async ({ profile }: { profile: string }) =>
      profile === 'low'
        ? { kind: 'gap' as const, nearestEdgeMs: 5_000 }
        : { kind: 'segment' as const, startMs: 6_000, durMs: 4_000, bytes: 3 },
    )
    const ts = new TimelineSession({
      session: s,
      deviceId: 102,
      locate,
      makeFeeder: (profile: string) => {
        built.push(profile)
        return fakeFeeder()
      },
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 102, epoch: 6_000, profile: 'low' })
    expect(built).toEqual(['low'])
    ts.dispose()
  })

  it('the requested tier answering first costs ONE locate, not the whole ladder', async () => {
    // `seek` and `scrubCommit` route through `playAt` since 585f5ea22, so every
    // finger-release now pays whatever this loop costs. locate is a cap RPC
    // (measured 1-8 s on cold footage); walking three tiers to re-confirm a pin
    // the caller already holds is latency the operator feels as a slow commit.
    const s = makeSession()
    const locate = vi.fn(async () => ({
      kind: 'segment' as const,
      startMs: 6_000,
      durMs: 4_000,
      bytes: 3,
    }))
    const ts = new TimelineSession({
      session: s,
      deviceId: 102,
      locate,
      makeFeeder: () => fakeFeeder(),
    })
    await ts.handleControl({ t: 'playRecorded', deviceId: 102, epoch: 6_000, profile: 'low' })
    expect(locate).toHaveBeenCalledTimes(1)
    ts.dispose()
  })
})
