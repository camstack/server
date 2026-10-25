import { describe, it, expect } from 'vitest'
import { AdaptiveController, type LadderDecision } from '../adaptive-controller.js'
import { describeClimbHold } from '../climb-hold.js'
import type { CapacityEvidence } from '../climb-capacity.js'
import type { StallSample } from '../stall-tracker.js'
import { ADAPTIVE_CONFIG } from '../adaptive-config.js'

/** The production stall/climb numbers (ADAPTIVE_CONFIG). */
const STALL_CONFIG = {
  stallDeliveryRatio: ADAPTIVE_CONFIG.stallDeliveryRatio,
  recoverDeliveryRatio: ADAPTIVE_CONFIG.recoverDeliveryRatio,
  climbDeliveryRatio: ADAPTIVE_CONFIG.climbDeliveryRatio,
  stallConfirmMs: ADAPTIVE_CONFIG.stallConfirmMs,
  waitAfterChangeMs: ADAPTIVE_CONFIG.waitAfterChangeMs,
  climbCapacityMargin: ADAPTIVE_CONFIG.climbCapacityMargin,
  tryClimbDeliveryRatio: ADAPTIVE_CONFIG.tryClimbDeliveryRatio,
  tryClimbMaxLossRatio: ADAPTIVE_CONFIG.tryClimbMaxLossRatio,
  tryBackoffBaseMs: ADAPTIVE_CONFIG.tryBackoffBaseMs,
  tryBackoffMaxMs: ADAPTIVE_CONFIG.tryBackoffMaxMs,
  trialMs: ADAPTIVE_CONFIG.trialMs,
  trialMaxMs: ADAPTIVE_CONFIG.trialMaxMs,
  trialRevertRatio: ADAPTIVE_CONFIG.trialRevertRatio,
  trialRevertConsecutive: ADAPTIVE_CONFIG.trialRevertConsecutive,
  freezeDeliveryRatio: ADAPTIVE_CONFIG.freezeDeliveryRatio,
  freezeMinSentKbps: ADAPTIVE_CONFIG.freezeMinSentKbps,
} as const

/** A delivery window: the client received `received` of the `sent` kbps. */
function win(received: number, sent: number, serverSending = true): StallSample {
  return {
    delivery: { receivedKbps: received, sentKbps: sent, windowMs: 4_000 },
    recent: { receivedKbps: received, sentKbps: sent, windowMs: 2_000 },
    clientReporting: true,
    telemetryShared: false,
    serverSending,
  }
}

/** What a freeze looks like: the broker sends, nothing lands. */
const FROZEN = win(0, 800)

function makeController(
  overrides: Partial<ConstructorParameters<typeof AdaptiveController>[0]> = {},
) {
  const calls: string[] = []
  const reasons: string[] = []
  const decisions: LadderDecision[] = []
  const ctrl = new AdaptiveController({
    initialTier: 'high',
    config: {
      analyzeWindowMs: 15_000,
      minFailPercent: 0.05,
      waitAfterResetMs: 8_000,
      upgradeHealthyMs: 60_000,
      upgradeHealthyGrowthFactor: 3,
      maxProgressiveUpgradeHealthyMs: 300_000,
      minTimeBetweenChangesMs: 60_000,
      maxUpgradeBackoffMs: 900_000,
      ...STALL_CONFIG,
    },
    onSwitchTier: (tier, decision) => {
      calls.push(`tier:${tier}`)
      reasons.push(decision.cause)
      decisions.push(decision)
    },
    onReduceMtu: () => {
      calls.push('mtu')
    },
    onTranscodeDown: () => {
      calls.push('transcode')
    },
    ...overrides,
  })
  return { ctrl, calls, reasons, decisions }
}

describe('AdaptiveController', () => {
  it('downgrades high→mid→low on sustained loss, respecting reset-wait between changes', () => {
    const { ctrl, calls } = makeController()
    // high → mid
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, 0)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 2000 }, 1000)
    ctrl.tick(1000)
    expect(calls).toContain('tier:mid')
    // after reset-wait (8s) + new loss → mid → low
    ctrl.onLoss({ packetsLost: 0, highestSequence: 3000 }, 9_500)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 4000 }, 10_000)
    ctrl.tick(10_000)
    expect(calls).toContain('tier:low')
  })

  it('at low tier reduces MTU, then transcodes down on continued loss', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, 0)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 2000 }, 1000)
    ctrl.tick(1000)
    expect(calls).toEqual(['mtu'])
    ctrl.onLoss({ packetsLost: 0, highestSequence: 3000 }, 9_500)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 4000 }, 10_000)
    ctrl.tick(10_000)
    expect(calls).toEqual(['mtu', 'transcode'])
  })

  it('upgrades a tier after sustained MEASURED health and hysteresis', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    // The session clock starts at the FIRST tick, so arm it, then stay healthy
    // (with real receiver samples) past upgradeHealthyMs.
    ctrl.tick(0)
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, 59_000)
    ctrl.onLoss({ packetsLost: 0, highestSequence: 2000 }, 60_000)
    ctrl.tick(60_500)
    expect(calls).toContain('tier:mid')
  })

  it('ramps promotion confidence across recreated sessions and caps it', () => {
    const config = {
      analyzeWindowMs: 15_000,
      minFailPercent: 0.05,
      waitAfterResetMs: 1_000,
      upgradeHealthyMs: 4_000,
      upgradeHealthyGrowthFactor: 3,
      maxProgressiveUpgradeHealthyMs: 30_000,
      minTimeBetweenChangesMs: 4_000,
      maxUpgradeBackoffMs: 900_000,
      ...STALL_CONFIG,
    }
    const first = makeController({ initialTier: 'low', config })
    first.ctrl.tick(0)
    first.ctrl.onLoss({ packetsLost: 0, highestSequence: 0 }, 1)
    first.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, 4_000)
    first.ctrl.tick(4_000)
    expect(first.calls).toEqual(['tier:mid'])
    expect(first.ctrl.successfulUpgradeCount).toBe(1)

    const second = makeController({
      initialTier: 'mid',
      config,
      priorUpgradeCount: first.ctrl.successfulUpgradeCount,
    })
    second.ctrl.tick(10_000)
    second.ctrl.onLoss({ packetsLost: 0, highestSequence: 0 }, 10_001)
    second.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, 21_999)
    second.ctrl.tick(21_999)
    expect(second.calls).toEqual([])
    second.ctrl.onLoss({ packetsLost: 0, highestSequence: 2_000 }, 22_000)
    second.ctrl.tick(22_000)
    expect(second.calls).toEqual(['tier:high'])
    expect(second.ctrl.successfulUpgradeCount).toBe(2)

    const capped = makeController({
      initialTier: 'mid',
      config,
      priorUpgradeCount: 5,
    })
    capped.ctrl.tick(30_000)
    capped.ctrl.onLoss({ packetsLost: 0, highestSequence: 0 }, 30_001)
    capped.ctrl.onLoss({ packetsLost: 0, highestSequence: 500 }, 40_000)
    capped.ctrl.tick(40_000)
    capped.ctrl.onLoss({ packetsLost: 0, highestSequence: 750 }, 50_000)
    capped.ctrl.tick(50_000)
    capped.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, 59_999)
    capped.ctrl.tick(59_999)
    expect(capped.calls).toEqual([])
    capped.ctrl.onLoss({ packetsLost: 0, highestSequence: 2_000 }, 60_000)
    capped.ctrl.tick(60_000)
    expect(capped.calls).toEqual(['tier:high'])
  })

  /**
   * REGRESSION (2026-08-03, operator: remote sessions "tende a selezionare il
   * più alto" [tends to select the highest]). The controller is ticked with `Date.now()`, not a zero-based
   * clock. With `healthySince`/`lastChangeAt` initialised to 0, the very first
   * tick reads "healthy since the unix epoch" AND takes the `lastChangeAt === 0`
   * escape hatch — so a session started on `low` climbed a rung on its FIRST
   * 2-second tick, having observed no loss samples at all. Because a tier
   * switch destroys and recreates the session (and with it the controller),
   * each rung re-armed the same free upgrade: low → mid → high in seconds,
   * which is indistinguishable from ignoring the remote `prefersTier:'low'`
   * bias entirely.
   */
  it('does not climb on the first tick when no loss sample was ever observed (wall-clock start)', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    const t0 = Date.now()
    ctrl.tick(t0 + 2_000)
    expect(calls).toEqual([])
    expect(ctrl.currentTier).toBe('low')
  })

  it('requires upgradeHealthyMs of observed health from session start before the first climb', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    const t0 = Date.now()
    ctrl.tick(t0) // arms the session clock
    for (let t = 1_000; t <= 61_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.tick(t0 + t)
      if (t < 60_000) expect(calls).toEqual([])
    }
    expect(calls).toEqual(['tier:mid'])
  })

  /**
   * Silence is not health. A link so bad that RTCP never arrives produces a
   * loss ratio of 0 by construction, which the old ladder read as "healthy"
   * and climbed on. An upgrade spends bandwidth; it needs positive evidence
   * that the bandwidth exists.
   */
  it('never climbs on silence — an upgrade needs receiver feedback in the window', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    const t0 = Date.now()
    // Real feedback early, then the receiver goes quiet. Ticking for ten
    // minutes must not produce a climb on the strength of stale samples.
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, t0)
    ctrl.onLoss({ packetsLost: 0, highestSequence: 2000 }, t0 + 1_000)
    for (let t = 0; t <= 600_000; t += 2_000) ctrl.tick(t0 + t)
    expect(calls).toEqual([])
    expect(ctrl.currentTier).toBe('low')
  })

  /**
   * The ladder's memory has to survive the rung change. A tier switch is a
   * close-and-recreate re-offer, so the server rebuilds the controller with
   * `priorFailures`; without that memory a link that cannot carry `high`
   * re-attempted it every 60 s for the whole session — climb, stutter,
   * downgrade, climb.
   */
  it('carries the measured failure of a tier out through failureCounts', () => {
    const { ctrl } = makeController() // starts at high
    ctrl.tick(0)
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, 1_000)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 2000 }, 2_000)
    ctrl.tick(2_000)
    expect(ctrl.currentTier).toBe('mid')
    expect(Object.fromEntries(ctrl.failureCounts)).toEqual({ high: 1 })
  })

  it('backs off exponentially before re-attempting a tier that already failed', () => {
    const { ctrl, calls } = makeController({
      initialTier: 'mid',
      priorFailures: new Map([['high', 1]]),
    })
    const t0 = Date.now()
    ctrl.tick(t0)
    // Healthy, with real feedback, for well past the plain 60s hysteresis.
    for (let t = 1_000; t <= 119_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.tick(t0 + t)
    }
    expect(calls).toEqual([]) // one prior failure ⇒ 120s, not 60s
    for (let t = 120_000; t <= 122_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.tick(t0 + t)
    }
    expect(calls).toEqual(['tier:high'])
  })

  /**
   * D42 put recorded playback and scrub on the same track as live, with a
   * moving source pointer. While the pointer is off live the ladder must be
   * frozen — a tier switch disposes the TimelineSession and its feeder.
   */
  it('suspend() holds the climb clock so recorded time never accumulates into an upgrade', () => {
    const { ctrl, calls } = makeController({ initialTier: 'low' })
    const t0 = Date.now()
    ctrl.tick(t0)
    for (let t = 1_000; t <= 300_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.suspend(t0 + t)
    }
    expect(calls).toEqual([])
    // Back on live: the clock restarts from the moment of return.
    for (let t = 301_000; t <= 359_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.tick(t0 + t)
    }
    expect(calls).toEqual([])
    for (let t = 360_000; t <= 362_000; t += 1_000) {
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 + t }, t0 + t)
      ctrl.tick(t0 + t)
    }
    expect(calls).toEqual(['tier:mid'])
  })

  it('does not flap: no change within minTimeBetweenChangesMs of the last change', () => {
    const { ctrl, calls } = makeController()
    ctrl.onLoss({ packetsLost: 0, highestSequence: 1000 }, 0)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 2000 }, 1000)
    ctrl.tick(1000) // tier:mid
    const after = calls.length
    ctrl.onLoss({ packetsLost: 0, highestSequence: 3000 }, 2000)
    ctrl.onLoss({ packetsLost: 100, highestSequence: 4000 }, 3000)
    ctrl.tick(3000) // still within reset-wait → ignored
    expect(calls.length).toBe(after)
  })

  // ────────────────────────────────────────────────────────────────────────
  // MEASURED STALL (2026-09-15, operator: "Camera cortile" 637 freezes
  // on a phone outside the LAN and never falls back to low).
  //
  // The tier was being chosen from `hints.downlinkMbps` — a ONE-SHOT HTTP
  // burst measured against the hub's reverse proxy at connect time, on a path
  // the WebRTC media does not take. Twelve hours of hub logs show every
  // `tier decision` line with `prefersTier:null` and not one
  // `adaptive: scheduling renegotiation`: this ladder never moved. The reason
  // it never moved is that its only failure signal was packet LOSS, and 48 h
  // of `webrtc loss` lines all read `hasReceiverReport=false` — while the
  // client-loss fallback derives loss as Δlost / (Δlost + Δreceived), which is
  // 0 when NOTHING arrives. A frozen stream therefore reported perfect health
  // and the ladder's only possible reply to a freeze was to CLIMB.
  // ────────────────────────────────────────────────────────────────────────

  it('forces a tier DOWN on a measured stall even while loss reports perfect health', () => {
    const { ctrl, calls, reasons, decisions } = makeController() // high
    const t0 = Date.now()
    ctrl.tick(t0)
    let now = t0
    for (let i = 0; i < 6; i += 1) {
      now += 2_000
      // Exactly what a freeze produces: the client sees zero bytes, so its
      // derived loss is 0 %, and the broker is still putting RTP on the wire.
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * (i + 1) }, now)
      ctrl.onThroughput(FROZEN, now)
      ctrl.tick(now)
    }
    expect(calls).toEqual(['tier:mid'])
    expect(reasons).toEqual(['stall'])
    expect(ctrl.currentTier).toBe('mid')
    // The downgrade must carry the measurement it rests on.
    expect(decisions[0]?.stall.clientKbps).toBe(0)
    expect(decisions[0]?.stall.serverSending).toBe(true)
    expect(decisions[0]?.stall.stalledForMs).toBeGreaterThanOrEqual(6_000)
    expect(decisions[0]?.lossRatio).toBe(0)
  })

  it('never climbs while a stall is building, however healthy the loss window looks', () => {
    const { ctrl, calls } = makeController({
      initialTier: 'low',
      config: {
        analyzeWindowMs: 15_000,
        minFailPercent: 0.05,
        waitAfterResetMs: 8_000,
        upgradeHealthyMs: 4_000,
        upgradeHealthyGrowthFactor: 3,
        maxProgressiveUpgradeHealthyMs: 30_000,
        minTimeBetweenChangesMs: 4_000,
        maxUpgradeBackoffMs: 900_000,
        ...STALL_CONFIG,
      },
    })
    const t0 = Date.now()
    ctrl.tick(t0)
    // Ten seconds of silence at the BOTTOM rung, with a spotless loss window
    // (0 % loss is what a stream receiving nothing reports) and plenty of
    // elapsed time for the 4 s promotion hysteresis. The only upward move
    // available is low → mid, and the ladder must refuse it and instead take
    // the cheapest downward step it has left.
    for (let i = 1; i <= 5; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(FROZEN, now)
      ctrl.tick(now)
    }
    expect(calls).not.toContain('tier:mid')
    expect(ctrl.currentTier).toBe('low')
    expect(calls).toContain('mtu')
  })

  it('a borderline link inside the dead band neither downgrades nor oscillates', () => {
    const { ctrl, calls } = makeController({ initialTier: 'mid' })
    const t0 = Date.now()
    ctrl.tick(t0)
    // 40 % landing for two minutes: above the stall ratio (25 %), below the
    // recovery ratio (50 %). Poor, but arriving — the ladder must hold the rung.
    for (let i = 1; i <= 60; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(win(400, 1_000), now)
      ctrl.tick(now)
    }
    expect(calls).toEqual([])
    expect(ctrl.currentTier).toBe('mid')
  })

  it('does not downgrade when the broker is not sending — an idle feed is not a freeze', () => {
    const { ctrl, calls } = makeController() // high
    const t0 = Date.now()
    ctrl.tick(t0)
    for (let i = 1; i <= 20; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onThroughput(win(0, 0, false), now)
      ctrl.tick(now)
    }
    expect(calls).toEqual([])
    expect(ctrl.currentTier).toBe('high')
  })

  it('a stalled tier is remembered, so it is not re-attempted on the plain hysteresis', () => {
    const { ctrl } = makeController() // high
    const t0 = Date.now()
    ctrl.tick(t0)
    for (let i = 1; i <= 4; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onThroughput(FROZEN, now)
      ctrl.tick(now)
    }
    expect(ctrl.currentTier).toBe('mid')
    expect(Object.fromEntries(ctrl.failureCounts)).toEqual({ high: 1 })
  })

  it('a recovered link climbs again — a stall downgrade is not a one-way door', () => {
    const config = {
      analyzeWindowMs: 15_000,
      minFailPercent: 0.05,
      waitAfterResetMs: 1_000,
      upgradeHealthyMs: 4_000,
      upgradeHealthyGrowthFactor: 1,
      maxProgressiveUpgradeHealthyMs: 30_000,
      minTimeBetweenChangesMs: 4_000,
      maxUpgradeBackoffMs: 900_000,
      ...STALL_CONFIG,
    }
    const { ctrl, calls, reasons } = makeController({ initialTier: 'mid', config })
    const t0 = Date.now()
    ctrl.tick(t0)
    // Stall down to low.
    for (let i = 1; i <= 4; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onThroughput(FROZEN, now)
      ctrl.tick(now)
    }
    expect(ctrl.currentTier).toBe('low')
    // The link comes back. Past the change blackout (8 s) plus the healthy
    // window, a promotion must be possible again.
    for (let i = 5; i <= 40; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(win(2_500, 2_500), now)
      ctrl.tick(now)
    }
    // Down once on the stall, then back up on measured health. (With a flat
    // growth factor and a 4 s hysteresis it keeps climbing past mid — the
    // point is that the FIRST move after the stall is a promotion, not that
    // it stops at one rung.)
    expect(calls[0]).toBe('tier:low')
    expect(reasons[0]).toBe('stall')
    expect(calls[1]).toBe('tier:mid')
    expect(reasons[1]).toBe('healthy')
  })

  // ────────────────────────────────────────────────────────────────────────
  // CLIMB ON A SPARSE RUNG (2026-09-25, device 104 "Camera hall").
  //
  // The `low` rung was a 41 kbps sub stream with an IDR every ~4 s, so the
  // client's 2 s windows alternated ~250 / ~40 kbps. The old climb gate asked
  // the LAST window to clear an absolute 128 kbps: every P-only window reset
  // the healthy clock, the 4 s streak never formed, and the ladder "never
  // moved" for the whole session. What a climb needs to know is whether what
  // was SENT landed — and whether the link has room for the next rung.
  // ────────────────────────────────────────────────────────────────────────

  /** Production timings, a rung map for mid/high, and a healthy loss feed. */
  function ladder(
    initialTier: 'low' | 'mid' | 'high',
    rungs: Record<'mid' | 'high', number | null>,
  ) {
    return makeController({
      initialTier,
      config: ADAPTIVE_CONFIG,
      expectedTierKbps: (tier) => (tier === 'low' ? 41 : rungs[tier]),
    })
  }

  /** Feed `n` healthy 2 s ticks with the given capacity evidence; returns the clock. */
  function feedHealthy(
    ctrl: AdaptiveController,
    t0: number,
    from: number,
    n: number,
    capacity: CapacityEvidence,
    delivery: StallSample = win(97, 100),
    rttMs: number | null = null,
  ): number {
    let now = t0
    for (let i = from; i < from + n; i += 1) {
      now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(delivery, now)
      ctrl.onCapacity(capacity)
      ctrl.onRtt(rttMs, now)
      ctrl.tick(now)
    }
    return now
  }

  it('promotes a sparse rung whose 2 s windows alternate [250, 40] kbps when it all lands and REMB has room', () => {
    const { ctrl, calls, reasons, decisions } = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    for (let i = 1; i <= 6; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(i % 2 === 0 ? win(250, 252) : win(40, 41), now)
      ctrl.onCapacity({ rembKbps: 5_000, probeKbps: null, probeFresh: false })
      ctrl.tick(now)
    }
    expect(calls).toEqual(['tier:mid'])
    expect(reasons).toEqual(['healthy'])
    // Evidence cleared the bar: a CONFIRMED climb, not a try.
    expect(decisions[0]?.trial).toBe(false)
  })

  it('a probe that clears the next rung climbs even though REMB is capped by the rung (480 kbps)', () => {
    for (const mid of [1_800, null]) {
      const { ctrl, calls, decisions } = ladder('low', { mid, high: 4_600 })
      const t0 = Date.now()
      ctrl.tick(t0)
      feedHealthy(ctrl, t0, 1, 3, { rembKbps: 480, probeKbps: 40_000, probeFresh: true })
      expect(calls).toEqual(['tier:mid'])
      expect(decisions[0]?.trial).toBe(false)
    }
  })

  it('a MEASURED probe below the next rung holds on capacity, and says why', () => {
    const { ctrl, calls } = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    feedHealthy(ctrl, t0, 1, 20, { rembKbps: 480, probeKbps: 1_400, probeFresh: true })
    expect(calls).toEqual([])
    expect(ctrl.climbHold?.code).toBe('capacity')
    expect(describeClimbHold(ctrl.climbHold!)).toBe(
      'held: probe 1400 kbps, REMB 480 kbps < mid needs 2160 kbps (1800 × 1.2)',
    )
  })

  it('NO capacity evidence (probe missing) on a clean path: a TRY-climb after the healthy streak', () => {
    const { ctrl, calls, decisions } = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    feedHealthy(ctrl, t0, 1, 2, { rembKbps: 480, probeKbps: null, probeFresh: false })
    expect(calls).toEqual([]) // the streak comes first
    expect(ctrl.climbHold?.code).toBe('warming')
    feedHealthy(ctrl, t0, 3, 1, { rembKbps: 480, probeKbps: null, probeFresh: false })
    expect(calls).toEqual(['tier:mid'])
    expect(decisions[0]?.trial).toBe(true)
    expect(ctrl.tryClimbCarry.trialFrom).toBe('low')
  })

  it('a try needs a CLEAN path: delivery ≥ 0.95, loss < 1 %, RTT stable — else it holds and names the blocker', () => {
    const t0 = Date.now()
    const short = ladder('low', { mid: 1_800, high: 4_600 })
    short.ctrl.tick(t0)
    feedHealthy(
      short.ctrl,
      t0,
      1,
      10,
      { rembKbps: 480, probeKbps: null, probeFresh: false },
      win(93, 100),
    )
    expect(short.calls).toEqual([])
    expect(short.ctrl.climbHold?.code).toBe('try-unclean')
    expect(describeClimbHold(short.ctrl.climbHold!)).toBe(
      'held: no capacity evidence for mid (REMB 480 kbps, no probe); not clean enough to try: delivery 0.93 < 0.95',
    )

    const jitter = ladder('low', { mid: 1_800, high: 4_600 })
    jitter.ctrl.tick(t0)
    let now = t0
    for (let i = 1; i <= 10; i += 1) {
      now = feedHealthy(
        jitter.ctrl,
        t0,
        i,
        1,
        { rembKbps: 480, probeKbps: null, probeFresh: false },
        win(99, 100),
        20 * i * i,
      )
    }
    expect(jitter.calls).toEqual([])
    expect(jitter.ctrl.climbHold?.tryBlockedBy).toBe('rtt')

    const lossy = ladder('low', { mid: 1_800, high: 4_600 })
    lossy.ctrl.tick(t0)
    for (let i = 1; i <= 10; i += 1) {
      now = t0 + i * 2_000
      // 2 % loss: under the 5 % failing bar, over the 1 % try bar.
      lossy.ctrl.onLoss({ packetsLost: 20 * i, highestSequence: 1_000 * i }, now)
      lossy.ctrl.onThroughput(win(99, 100), now)
      lossy.ctrl.onCapacity({ rembKbps: 480, probeKbps: null, probeFresh: false })
      lossy.ctrl.tick(now)
    }
    expect(lossy.calls).toEqual([])
    expect(lossy.ctrl.climbHold?.tryBlockedBy).toBe('loss')
  })

  it('a try that fails (delivery drops on the new rung) REVERTS within its first window and backs off 30 s', () => {
    // The re-offer builds a NEW controller on mid, carrying the try.
    const { ctrl, calls, reasons } = makeController({
      initialTier: 'mid',
      config: ADAPTIVE_CONFIG,
      tryClimb: { failures: 0, notBefore: 0, lastRevert: null, trialFrom: 'low' },
    })
    const t0 = Date.now()
    ctrl.tick(t0)
    // First evaluations: the new session is not measured yet — a trial hold.
    expect(ctrl.climbHold?.code).toBe('trial')
    let now = t0
    for (let i = 1; i <= 6 && calls.length === 0; i += 1) {
      now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(win(600, 1_000), now) // 0.6 landed
      ctrl.tick(now)
    }
    expect(calls).toEqual(['tier:low'])
    expect(reasons).toEqual(['trial-revert'])
    const carry = ctrl.tryClimbCarry
    expect(carry.failures).toBe(1)
    expect(carry.notBefore).toBe(now + 30_000)
    expect(carry.lastRevert).toEqual({ tier: 'mid', deliveryRatio: 0.6, stalled: false, at: now })
    expect(carry.trialFrom).toBeNull()
  })

  it('back on the lower rung, the next try waits out the backoff and says so; the backoff doubles and caps at 10 min', () => {
    const t0 = Date.now()
    const { ctrl, calls } = makeController({
      initialTier: 'low',
      config: ADAPTIVE_CONFIG,
      expectedTierKbps: (tier) => (tier === 'mid' ? 1_800 : null),
      tryClimb: {
        failures: 1,
        notBefore: t0 + 30_000,
        lastRevert: { tier: 'mid', deliveryRatio: 0.6, stalled: false, at: t0 },
        trialFrom: null,
      },
    })
    ctrl.tick(t0)
    feedHealthy(ctrl, t0, 1, 5, { rembKbps: 480, probeKbps: null, probeFresh: false })
    expect(calls).toEqual([])
    expect(ctrl.climbHold?.code).toBe('try-backoff')
    expect(describeClimbHold(ctrl.climbHold!)).toBe(
      'held: tried mid, reverted: delivery 0.60; next try in 20.0s',
    )
    // Past the backoff the streak is already there: it tries again, at 30 s.
    feedHealthy(ctrl, t0, 6, 9, { rembKbps: 480, probeKbps: null, probeFresh: false })
    expect(calls).toEqual([])
    feedHealthy(ctrl, t0, 15, 1, { rembKbps: 480, probeKbps: null, probeFresh: false })
    expect(calls).toEqual(['tier:mid'])

    // Doubling, capped.
    const at = (failures: number) =>
      new AdaptiveController({
        initialTier: 'mid',
        config: ADAPTIVE_CONFIG,
        tryClimb: { failures, notBefore: 0, lastRevert: null, trialFrom: 'low' },
        onSwitchTier: () => undefined,
        onReduceMtu: () => undefined,
        onTranscodeDown: () => undefined,
      })
    const backoffAfter = (failures: number): number => {
      const c = at(failures)
      c.tick(0)
      for (let i = 1; i <= 6; i += 1) {
        c.onThroughput(FROZEN, i * 2_000)
        c.tick(i * 2_000)
      }
      return c.tryClimbCarry.notBefore - c.tryClimbCarry.lastRevert!.at
    }
    expect(backoffAfter(0)).toBe(30_000)
    expect(backoffAfter(1)).toBe(60_000)
    expect(backoffAfter(2)).toBe(120_000)
    expect(backoffAfter(9)).toBe(600_000)
  })

  it('a try that holds for its whole trial window is kept, and clears the backoff', () => {
    const { ctrl, calls } = makeController({
      initialTier: 'mid',
      config: ADAPTIVE_CONFIG,
      tryClimb: {
        failures: 2,
        notBefore: 0,
        lastRevert: { tier: 'mid', deliveryRatio: 0.6, stalled: false, at: 0 },
        trialFrom: 'low',
      },
    })
    const t0 = Date.now()
    ctrl.tick(t0)
    // 22 s: past the 20 s trial, and short of the next streak.
    for (let i = 1; i <= 11; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 * i }, now)
      ctrl.onThroughput(win(98, 100), now)
      ctrl.tick(now)
    }
    expect(calls).toEqual([])
    expect(ctrl.tryClimbCarry).toEqual({
      failures: 0,
      notBefore: 0,
      lastRevert: null,
      trialFrom: null,
    })
  })

  it('a SHORT probe keeps holding however old it is; only a newer probe replaces it (I4)', () => {
    const { ctrl, calls } = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    feedHealthy(ctrl, t0, 1, 60, { rembKbps: 480, probeKbps: 1_400, probeFresh: false })
    expect(calls).toEqual([])
    expect(ctrl.climbHold?.code).toBe('capacity')
    // …while a stale GOOD probe is no longer evidence: it is a try (unknown).
    const stale = ladder('low', { mid: 1_800, high: 4_600 })
    stale.ctrl.tick(t0)
    feedHealthy(stale.ctrl, t0, 1, 3, { rembKbps: 480, probeKbps: 40_000, probeFresh: false })
    expect(stale.decisions[0]?.trial).toBe(true)
  })

  it("shared device telemetry refuses a try (the record may be another viewer's) — I2", () => {
    const { ctrl, calls } = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    const shared: StallSample = {
      delivery: null,
      recent: null,
      clientReporting: false,
      telemetryShared: true,
      serverSending: true,
    }
    feedHealthy(ctrl, t0, 1, 20, { rembKbps: 480, probeKbps: null, probeFresh: false }, shared)
    expect(calls).toEqual([])
    expect(ctrl.climbHold?.code).toBe('try-unclean')
    expect(ctrl.climbHold?.tryBlockedBy).toBe('shared-telemetry')
    // Evidence still climbs: REMB is this session's own.
    feedHealthy(ctrl, t0, 21, 1, { rembKbps: 5_000, probeKbps: null, probeFresh: false }, shared)
    expect(calls).toEqual(['tier:mid'])
  })

  it('a "trial" that landed back on the rung it came from is not a trial (m13)', () => {
    const { ctrl } = makeController({
      initialTier: 'low',
      config: ADAPTIVE_CONFIG,
      tryClimb: { failures: 0, notBefore: 0, lastRevert: null, trialFrom: 'low' },
    })
    ctrl.tick(Date.now())
    expect(ctrl.climbHold?.code).not.toBe('trial')
    expect(ctrl.tryClimbCarry.trialFrom).toBeNull()
  })

  it('recorded playback restarts a running trial — time off live never keeps it (m14)', () => {
    const { ctrl, calls } = makeController({
      initialTier: 'mid',
      config: ADAPTIVE_CONFIG,
      tryClimb: { failures: 0, notBefore: 0, lastRevert: null, trialFrom: 'low' },
    })
    const t0 = Date.now()
    ctrl.tick(t0)
    for (let i = 1; i <= 20; i += 1) ctrl.suspend(t0 + i * 2_000)
    // Back on live at 42 s: a lost rung must still be caught — the trial is
    // judged afresh, not "kept" on the 40 s that passed.
    for (let i = 21; i <= 23; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onThroughput(win(500, 1_000), now)
      ctrl.tick(now)
    }
    expect(calls).toEqual(['tier:low'])
  })

  it('names every hold: delivery short, no feedback, warming, and none at the top rung', () => {
    const short = ladder('low', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    short.ctrl.tick(t0)
    short.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, t0 + 1_000)
    short.ctrl.onLoss({ packetsLost: 0, highestSequence: 2_000 }, t0 + 2_000)
    short.ctrl.onThroughput(win(80, 100), t0 + 2_000)
    short.ctrl.tick(t0 + 2_000)
    expect(short.ctrl.climbHold?.code).toBe('delivery')
    expect(describeClimbHold(short.ctrl.climbHold!)).toBe('held: delivery 0.80 over 4.0s < 0.90')

    const silent = ladder('low', { mid: 1_800, high: 4_600 })
    silent.ctrl.tick(t0)
    silent.ctrl.tick(t0 + 2_000)
    expect(silent.ctrl.climbHold?.code).toBe('no-evidence')

    const warming = ladder('low', { mid: 1_800, high: 4_600 })
    warming.ctrl.tick(t0)
    warming.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, t0 + 1_000)
    warming.ctrl.onLoss({ packetsLost: 0, highestSequence: 2_000 }, t0 + 2_000)
    warming.ctrl.onThroughput(win(100, 100), t0 + 2_000)
    warming.ctrl.tick(t0 + 2_000)
    expect(warming.ctrl.climbHold?.code).toBe('warming')
    expect(describeClimbHold(warming.ctrl.climbHold!)).toBe(
      'climbing: healthy 2.0s of 4.0s before mid',
    )

    const top = ladder('high', { mid: 1_800, high: 4_600 })
    top.ctrl.tick(t0)
    top.ctrl.onLoss({ packetsLost: 0, highestSequence: 1_000 }, t0 + 1_000)
    top.ctrl.onLoss({ packetsLost: 0, highestSequence: 2_000 }, t0 + 2_000)
    top.ctrl.tick(t0 + 2_000)
    expect(top.ctrl.climbHold).toBeNull()
  })

  it('a real stall still demotes, and a building one is named as the hold', () => {
    const { ctrl, calls, reasons } = ladder('mid', { mid: 1_800, high: 4_600 })
    const t0 = Date.now()
    ctrl.tick(t0)
    ctrl.onThroughput(FROZEN, t0 + 2_000)
    ctrl.tick(t0 + 2_000)
    expect(ctrl.climbHold?.code).toBe('stall-building')
    for (let i = 2; i <= 5; i += 1) {
      const now = t0 + i * 2_000
      ctrl.onThroughput(FROZEN, now)
      ctrl.tick(now)
    }
    expect(calls).toEqual(['tier:low'])
    expect(reasons).toEqual(['stall'])
  })

  it('suspend() is a named hold too', () => {
    const { ctrl } = ladder('low', { mid: 1_800, high: 4_600 })
    ctrl.suspend(Date.now())
    expect(ctrl.climbHold?.code).toBe('suspended')
  })
})
