import { describe, it, expect, vi } from 'vitest'
import {
  adaptiveHintsKey,
  createDownlinkProbe,
  measureDownlinkMbps,
  probeAfterFirstFrame,
  resolveProbeOrigin,
  waitForFirstFrame,
  ADAPTIVE_PROBE_MIN_MEASURED_BYTES,
  type ProbeBodyReader,
  ADAPTIVE_PROBE_PATH,
  suggestedAdaptiveTier,
  stripDownlinkForColdStart,
  shouldUpgradeAfterProbe,
  type AdaptiveHintsReport,
  handProbeToSession,
  type DownlinkProbeAnswer,
} from '../adaptive-downlink.js'

describe('suggestedAdaptiveTier', () => {
  it('includes mid in the ladder: 1 → low, 4 → mid, 20 → high', () => {
    expect(suggestedAdaptiveTier(1)).toBe('low')
    expect(suggestedAdaptiveTier(2.5)).toBe('mid')
    expect(suggestedAdaptiveTier(4)).toBe('mid')
    expect(suggestedAdaptiveTier(8)).toBe('high')
    expect(suggestedAdaptiveTier(20)).toBe('high')
  })
})

describe('cold-start adaptive hints', () => {
  it('strips a cached downlink so the first session starts on the lowest rung', () => {
    expect(
      stripDownlinkForColdStart({
        viewportWidth: 800,
        viewportHeight: 450,
        downlinkMbps: 20,
        prefersTier: 'low',
      }),
    ).toEqual({ viewportWidth: 800, viewportHeight: 450, prefersTier: 'low' })
  })

  it('upgrades after probe only when mid or high is justified', () => {
    expect(shouldUpgradeAfterProbe(1)).toBe(false)
    expect(shouldUpgradeAfterProbe(4)).toBe(true)
    expect(shouldUpgradeAfterProbe(20)).toBe(true)
  })
})

/** A controllable clock plus a body that delivers `chunks` bytes, one read each. */
function streamedProbe(opts: {
  readonly ttfbMs: number
  readonly chunks: readonly number[]
  readonly chunkMs: number
  /** Reject the read with this index (the deadline abort), if set. */
  readonly abortAtRead?: number
}) {
  let t = 0
  let reads = 0
  const reader: ProbeBodyReader = {
    read: async () => {
      if (opts.abortAtRead !== undefined && reads === opts.abortAtRead) {
        throw new DOMException('aborted', 'AbortError')
      }
      const size = opts.chunks[reads]
      reads += 1
      if (size === undefined) return { done: true }
      if (reads > 1) t += opts.chunkMs
      return { done: false, value: new Uint8Array(size) }
    },
    cancel: async () => {},
  }
  return {
    now: () => t,
    fetchImpl: async () => {
      // Everything up to the response headers: TCP, TLS, a busy hub's queue.
      t += opts.ttfbMs
      return {
        ok: true,
        body: { getReader: () => reader },
        arrayBuffer: async () => {
          throw new Error('a streamed probe must not buffer the whole body')
        },
      }
    },
  }
}

describe('measureDownlinkMbps', () => {
  /**
   * REGRESSION (2026-09-25, hub .9 at ~80 % CPU). A 128 KiB blob timed from
   * request start read the LAN as 1.2–1.46 Mbps: the time was mostly waiting
   * for the first byte, which is latency, not bandwidth.
   */
  it('times the body from its FIRST byte — time-to-first-byte is latency, not bandwidth', async () => {
    const chunk = 64 * 1024
    const probe = streamedProbe({ ttfbMs: 700, chunks: new Array(16).fill(chunk), chunkMs: 10 })
    const mbps = await measureDownlinkMbps('http://192.168.10.9:4480', probe)
    // 15 chunks after the first, in 150 ms → (15 × 65536 × 8) / 150 / 1000.
    expect(mbps).toBeCloseTo((15 * chunk * 8) / 150 / 1000, 3)
    // …where timing from request start would have said ~9.9 Mbps.
    expect(mbps!).toBeGreaterThan(50)
  })

  it('a probe cut by its deadline still measures what DID arrive', async () => {
    const chunk = 64 * 1024
    const probe = streamedProbe({
      ttfbMs: 100,
      chunks: new Array(16).fill(chunk),
      chunkMs: 200,
      abortAtRead: 6,
    })
    const mbps = await measureDownlinkMbps('http://hub', probe)
    // 5 chunks after the first, over 1 000 ms: a slow link, measured — not unknown.
    expect(mbps).toBeCloseTo((5 * chunk * 8) / 1_000 / 1_000, 3)
  })

  it('too little body to time is UNKNOWN (null), never "slow"', async () => {
    const probe = streamedProbe({
      ttfbMs: 100,
      chunks: [16 * 1024, ADAPTIVE_PROBE_MIN_MEASURED_BYTES - 1],
      chunkMs: 500,
    })
    expect(await measureDownlinkMbps('http://hub', probe)).toBeNull()
  })

  it('without a streamed body, times from the response (headers), not from the request', async () => {
    let t = 0
    const bytes = 1024 * 1024
    const mbps = await measureDownlinkMbps('http://192.168.10.9:4480', {
      fetchImpl: async (url) => {
        expect(url).toBe(`http://192.168.10.9:4480${ADAPTIVE_PROBE_PATH}`)
        t += 700
        return {
          ok: true,
          arrayBuffer: async () => {
            t += 100
            return new ArrayBuffer(bytes)
          },
        }
      },
      now: () => t,
    })
    expect(mbps).toBeCloseTo((bytes * 8) / 100 / 1000, 3)
  })

  it('returns null when the probe fails', async () => {
    const mbps = await measureDownlinkMbps('https://hub.example', {
      fetchImpl: async () => {
        throw new Error('offline')
      },
      now: () => 0,
    })
    expect(mbps).toBeNull()
  })

  it('returns null on a non-OK answer — a 404 is not a slow link', async () => {
    const mbps = await measureDownlinkMbps('https://hub.example', {
      fetchImpl: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
      now: () => 0,
    })
    expect(mbps).toBeNull()
  })
})

describe('the probe waits for the first frame — it never competes with session setup', () => {
  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => void (t += ms) }
  }

  it('resolves "frame" once the video element has a decoded frame', async () => {
    const c = clock()
    let state = 0
    const outcome = await waitForFirstFrame({
      readyState: () => {
        if (c.now() >= 1_500) state = 2
        return state
      },
      signal: new AbortController().signal,
      ...c,
    })
    expect(outcome).toBe('frame')
    expect(c.now()).toBeGreaterThanOrEqual(1_500)
  })

  it('gives up with "timeout" when no frame ever decodes, and "aborted" when torn down', async () => {
    const c = clock()
    expect(
      await waitForFirstFrame({ readyState: () => 0, signal: new AbortController().signal, ...c }),
    ).toBe('timeout')
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await waitForFirstFrame({ readyState: () => 0, signal: ctrl.signal, ...clock() })).toBe(
      'aborted',
    )
  })

  it('measures only AFTER the first frame, and not at all when none arrived', async () => {
    const order: string[] = []
    const measured = await probeAfterFirstFrame({
      waitFrame: async () => {
        order.push('frame')
        return 'frame'
      },
      measure: async () => {
        order.push('measure')
        return 12
      },
    })
    expect(measured).toBe(12)
    expect(order).toEqual(['frame', 'measure'])

    let called = false
    const none = await probeAfterFirstFrame({
      waitFrame: async () => 'timeout',
      measure: async () => {
        called = true
        return 12
      },
    })
    expect(none).toBeUndefined()
    expect(called).toBe(false)
  })
})

describe('resolveProbeOrigin — the probe must reach the HUB, not the page', () => {
  it('uses the hub serverUrl even when the page is a bundled file:// asset', () => {
    // The native viewer's exact shape: WKWebView loading the OTA embed asset.
    expect(
      resolveProbeOrigin('http://192.168.10.9:4480', 'file:///var/containers/Bundle/app'),
    ).toBe('http://192.168.10.9:4480')
  })

  it('prefers the HUB over a page origin that is merely a different host', () => {
    // An external iframe embed is served by someone else's site; the probe
    // must still measure the path to the hub, not to that site.
    expect(resolveProbeOrigin('https://hub.example', 'https://partner.example')).toBe(
      'https://hub.example',
    )
  })

  it('keeps a path prefix — a relay mounts the hub UNDER a path — and drops only the slash', () => {
    // The Home Assistant component reaches the hub through
    // `https://<ha>/api/camstack/p/<grant>/…`; `serverUrl` there is that whole
    // base (`hubOrigin()`), and `/adaptive-probe` exists only under it. The
    // bare origin would be HA itself. No caller passes a page path here: the
    // web viewer and the embed pass `window.location.origin`.
    expect(resolveProbeOrigin('https://ha.example/api/camstack/p/g1/', undefined)).toBe(
      'https://ha.example/api/camstack/p/g1',
    )
    expect(resolveProbeOrigin('https://hub.example/', undefined)).toBe('https://hub.example')
  })

  it('falls back to the page origin when serverUrl is unusable', () => {
    expect(resolveProbeOrigin('', 'https://hub.example')).toBe('https://hub.example')
    expect(resolveProbeOrigin(undefined, 'https://hub.example')).toBe('https://hub.example')
    expect(resolveProbeOrigin('/relative', 'https://hub.example')).toBe('https://hub.example')
  })

  it('returns null when NEITHER input is an http(s) origin, so no probe is attempted', () => {
    // Before the fix this case was `file://` and the caller happily fetched
    // `file:///adaptive-probe`, which no hub can answer — that failure is the
    // whole reason `downlinkMbps` never reached `pickAdaptiveTier` on native.
    expect(resolveProbeOrigin('file:///a/b.html', 'file:///a/b.html')).toBeNull()
    expect(resolveProbeOrigin(undefined, 'null')).toBeNull()
  })
})

describe('adaptiveHintsKey — one line per DECISION change, not per tick', () => {
  const base: AdaptiveHintsReport = {
    phase: 'cold-start',
    probeOrigin: 'http://192.168.10.9:4480',
    viewportWidth: 1290,
    viewportHeight: 726,
    devicePixelRatio: 3,
  }

  it('collapses two downlink measurements that pick the same rung', () => {
    // 9 and 40 Mbps are different numbers and the SAME decision (both `high`).
    expect(adaptiveHintsKey({ ...base, downlinkMbps: 9 })).toBe(
      adaptiveHintsKey({ ...base, downlinkMbps: 40 }),
    )
  })

  it('separates measurements that cross a rung boundary', () => {
    expect(adaptiveHintsKey({ ...base, downlinkMbps: 1 })).not.toBe(
      adaptiveHintsKey({ ...base, downlinkMbps: 4 }),
    )
    expect(adaptiveHintsKey({ ...base, downlinkMbps: 4 })).not.toBe(
      adaptiveHintsKey({ ...base, downlinkMbps: 9 }),
    )
  })

  it('separates "no downlink at all" from a measured low one', () => {
    // The distinction the operator's report turned on: never measured is not
    // the same as measured and slow.
    expect(adaptiveHintsKey(base)).not.toBe(adaptiveHintsKey({ ...base, downlinkMbps: 1 }))
  })

  it('separates an unreachable probe origin from a reachable one', () => {
    expect(adaptiveHintsKey({ ...base, probeOrigin: null })).not.toBe(adaptiveHintsKey(base))
  })

  it('separates a viewport change and a phase change', () => {
    expect(adaptiveHintsKey({ ...base, viewportWidth: 430 })).not.toBe(adaptiveHintsKey(base))
    expect(adaptiveHintsKey({ ...base, phase: 'probe-climb' })).not.toBe(adaptiveHintsKey(base))
  })
})

describe('createDownlinkProbe — one probe in flight app-wide, and the cache (I5, I6)', () => {
  it('concurrent callers (a grid decoding together) share ONE in-flight probe', async () => {
    let calls = 0
    let release: (v: number) => void = () => undefined
    const probe = createDownlinkProbe({ now: () => 0, ttlMs: 30_000 })
    const measure = () => {
      calls += 1
      return new Promise<number | null>((resolve) => {
        release = resolve
      })
    }
    const a = probe.measured('http://hub', measure)
    const b = probe.measured('http://hub', measure)
    const c = probe.measured('http://hub', measure)
    release(42)
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42])
    expect(calls).toBe(1)
  })

  it('cached() never probes — the renegotiation path reads only what is cached (I5)', async () => {
    let t = 0
    const probe = createDownlinkProbe({ now: () => t, ttlMs: 30_000 })
    expect(probe.cached('http://hub')).toBeUndefined()
    await probe.measured('http://hub', async () => 12)
    expect(probe.cached('http://hub')).toBe(12)
    t = 30_001
    expect(probe.cached('http://hub')).toBeUndefined()
  })

  it('latest() is the newest reading whatever its value or age — the telemetry reports it (I4)', async () => {
    let t = 1_000
    const probe = createDownlinkProbe({ now: () => t, ttlMs: 30_000 })
    expect(probe.latest('http://hub')).toBeNull()
    await probe.measured('http://hub', async () => 1.2)
    t = 91_000
    expect(probe.latest('http://hub')).toEqual({ mbps: 1.2, ageMs: 90_000 })
    expect(probe.latest('http://other')).toBeNull()
  })

  it('a failed probe caches nothing and is retried by the next caller', async () => {
    const probe = createDownlinkProbe({ now: () => 0, ttlMs: 30_000 })
    expect(await probe.measured('http://hub', async () => null)).toBeUndefined()
    expect(await probe.measured('http://hub', async () => 9)).toBe(9)
  })
})

describe('a refused probe is SAID, once per origin (N3)', () => {
  it('measureDownlinkMbps reports the status of a refused probe, and still answers unknown', async () => {
    const refused: number[] = []
    const mbps = await measureDownlinkMbps('https://hub', {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      now: () => 0,
      onRefused: (status) => refused.push(status),
    })
    expect(mbps).toBeNull()
    expect(refused).toEqual([401])
  })

  it('the app-wide store lets a refusal through once per origin', () => {
    const probe = createDownlinkProbe({ now: () => 0, ttlMs: 30_000 })
    expect(probe.firstRefusal('https://hub', 401)).toBe(true)
    expect(probe.firstRefusal('https://hub', 401)).toBe(false)
    expect(probe.firstRefusal('https://other', 401)).toBe(true)
  })

  it('a refusal report is its own decision in the "once per change" key', () => {
    const base: AdaptiveHintsReport = { phase: 'cold-start', probeOrigin: 'https://hub' }
    expect(adaptiveHintsKey({ ...base, phase: 'probe-refused', probeStatus: 401 })).not.toBe(
      adaptiveHintsKey(base),
    )
  })
})

/**
 * D733 — the probe goes to the session it was measured on. Only a hub that
 * cannot take it leaves the player its legacy climb (a SECOND session).
 */
describe('handProbeToSession', () => {
  const switching: DownlinkProbeAnswer = { outcome: 'switching', tier: 'high', reason: 'downlink' }

  it('hands the measurement to the session and reports the answer', async () => {
    const apply = vi.fn(async () => switching)
    await expect(handProbeToSession(apply, 'sess-1', 11.1)).resolves.toEqual({
      kind: 'answered',
      answer: switching,
    })
    expect(apply).toHaveBeenCalledWith('sess-1', 11.1)
  })

  it('a HELD answer is still an answer — no reconnect for a rung the hub refused', async () => {
    const held: DownlinkProbeAnswer = { outcome: 'held', tier: 'low', reason: 'not-adaptive' }
    await expect(handProbeToSession(async () => held, 'sess-1', 50)).resolves.toEqual({
      kind: 'answered',
      answer: held,
    })
  })

  it('no host wiring: unsupported, the legacy climb runs', async () => {
    await expect(handProbeToSession(undefined, 'sess-1', 11)).resolves.toEqual({
      kind: 'unsupported',
      why: 'no-wiring',
    })
  })

  it('no session id yet: unsupported, and the hub is not called', async () => {
    const apply = vi.fn(async () => switching)
    await expect(handProbeToSession(apply, null, 11)).resolves.toEqual({
      kind: 'unsupported',
      why: 'no-session',
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('a hub that does not know the method (older server): unsupported', async () => {
    const apply = vi.fn(async (): Promise<DownlinkProbeAnswer> => {
      throw new Error('No procedure found on path "webrtcSession.applyDownlinkProbe"')
    })
    await expect(handProbeToSession(apply, 'sess-1', 11)).resolves.toEqual({
      kind: 'unsupported',
      why: 'call-failed',
    })
  })
})
