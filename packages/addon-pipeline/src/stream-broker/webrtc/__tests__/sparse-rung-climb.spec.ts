/**
 * Device 104, end to end through the pieces the broker wires every 2 s:
 * frames go into the session's SendHistory, the player's 2 s report goes into
 * the DeliveryMeter, the samples are built by `buildStallSample`, and the
 * controller decides. A tier change is what the server does: a NEW session
 * (fresh history, meter from `deliveryMeterStart`) and a NEW controller
 * carrying failures, promotions and the try-climb state.
 *
 * The CLIENT around a tier change is modelled as it really behaves (review
 * I1): the new session sends only once DTLS is up; the player swaps onto the
 * new PC only after its first decode (`swapDelayMs`); until then the 2 s
 * reporter reads the OLD, closed PC (0 kbps), and the first report after the
 * swap is 0 as well (its byte baseline was the old PC's).
 *
 * Live numbers (2026-09-25): `low` = native:sub 41 kbps between IDRs, IDR every
 * 4 021 ms; REMB 430–520 kbps (capped by what is sent); `mid` = slot-3.
 */
import { describe, it, expect } from 'vitest'
import { AdaptiveController, type Tier } from '../adaptive-controller.js'
import { ADAPTIVE_CONFIG, ADAPTIVE_DELIVERY_CONFIG } from '../adaptive-config.js'
import {
  DeliveryMeter,
  SendHistory,
  deliveryMeterStart,
  deliveryWindowMs,
} from '../delivery-meter.js'
import { buildStallSample } from '../stall-tracker.js'
import { HALL_SUB, framesBetween, type RungShape } from './sparse-rung-sim.js'

const TICK = 2_000
const SPAN = ADAPTIVE_DELIVERY_CONFIG.clientSampleSpanMs
/** Report latency client → hub (stamped on receipt). */
const REPORT_LATENCY_MS = 40
const REMB_KBPS = 480

/** A 1.8 Mbps 720p rung with the same 4 s GOP. */
const HALL_MID: RungShape = {
  pFrameKbps: 1_500,
  idrBytes: 150_000,
  idrIntervalMs: 4_021,
  fps: 25,
}

interface Scenario {
  /** `mid`'s measured bitrate as the broker would report it; null = never streamed. */
  readonly midKbps: number | null
  /** The viewer's probe, kbps; null = failed / never reported. */
  readonly probeKbps: number | null
  /** Fraction of each rung's bytes that land. */
  readonly delivered: Readonly<Record<Tier, number>>
  readonly seconds: number
  /** First decode on the new PC after a tier change, ms (0 = instantaneous). */
  readonly swapDelayMs?: number
  /** The client's getStats window closes this long before the hub tick. */
  readonly phaseMs?: number
  /** Total freeze from this moment on (all rungs deliver nothing), ms. */
  readonly freezeAtMs?: number
  readonly initialTier?: Tier
  readonly shapes?: Readonly<Record<Tier, RungShape>>
}

interface Move {
  readonly at: number
  readonly to: Tier
  readonly cause: string
  readonly trial: boolean
}

interface RunResult {
  readonly moves: readonly Move[]
  /** Hold codes seen, de-duplicated on change. */
  readonly holds: readonly string[]
  readonly last: AdaptiveController
}

const SHAPES: Readonly<Record<Tier, RungShape>> = {
  low: HALL_SUB,
  mid: HALL_MID,
  high: HALL_MID,
}

/** One server session and what its viewer's reporter sees of it. */
interface SimSession {
  readonly tier: Tier
  readonly history: SendHistory
  readonly meter: DeliveryMeter
  /** The new session puts RTP on the wire from here (DTLS up). */
  readonly sendsFrom: number
  /** The player swaps onto this session's PC here (first decode). */
  readonly swapAt: number
  sentUpTo: number
  postSwapReportSeen: boolean
}

function newSession(
  tier: Tier,
  now: number,
  afterChange: boolean,
  swapDelayMs: number,
): SimSession {
  return {
    tier,
    history: new SendHistory(ADAPTIVE_DELIVERY_CONFIG.historySpanMs),
    meter: new DeliveryMeter(
      ADAPTIVE_DELIVERY_CONFIG,
      deliveryMeterStart(now, afterChange, ADAPTIVE_CONFIG.waitAfterChangeMs),
    ),
    sendsFrom: afterChange ? now + swapDelayMs / 2 : now,
    swapAt: afterChange ? now + swapDelayMs : now,
    sentUpTo: now,
    postSwapReportSeen: !afterChange,
  }
}

function run(sc: Scenario): RunResult {
  const shapes = sc.shapes ?? SHAPES
  const phase = sc.phaseMs ?? 700
  const swapDelay = sc.swapDelayMs ?? 0
  const moves: Move[] = []
  const holds: string[] = []
  const pendingSlot: { current: Move | null } = { current: null }
  const build = (tier: Tier, prev: AdaptiveController | null): AdaptiveController =>
    new AdaptiveController({
      initialTier: tier,
      config: ADAPTIVE_CONFIG,
      priorFailures: prev?.failureCounts,
      priorUpgradeCount: prev?.successfulUpgradeCount,
      tryClimb: prev?.tryClimbCarry,
      expectedTierKbps: (t) => (t === 'mid' ? sc.midKbps : t === 'high' ? 4_631 : 100),
      onSwitchTier: (to, decision) => {
        pendingSlot.current = { at: 0, to, cause: decision.cause, trial: decision.trial }
      },
      onReduceMtu: (decision) => {
        pendingSlot.current = {
          at: 0,
          to: 'low',
          cause: `mtu:${decision.cause}`,
          trial: false,
        }
      },
      onTranscodeDown: () => undefined,
    })
  let ctrl = build(sc.initialTier ?? 'low', null)
  let session = newSession(sc.initialTier ?? 'low', 0, false, swapDelay)
  for (let now = TICK; now <= sc.seconds * 1000; now += TICK) {
    const shape = shapes[session.tier]
    for (const f of framesBetween(shape, Math.max(session.sentUpTo, session.sendsFrom), now)) {
      session.history.record(f.bytes, f.at)
    }
    session.sentUpTo = now
    const clientAt = now - phase
    const windowStart = clientAt - SPAN
    let kbps: number
    if (clientAt <= session.swapAt) {
      kbps = 0 // the reporter still reads the old, closed PC
    } else if (!session.postSwapReportSeen) {
      session.postSwapReportSeen = true
      kbps = 0 // bytes − prev.bytes across the PC change, clamped
    } else {
      const frozen = sc.freezeAtMs !== undefined && windowStart >= sc.freezeAtMs
      const bytes = framesBetween(shape, Math.max(windowStart, session.sendsFrom), clientAt).reduce(
        (sum, f) => sum + f.bytes,
        0,
      )
      kbps = frozen ? 0 : Math.round((bytes * sc.delivered[session.tier] * 8) / SPAN)
    }
    if (windowStart >= 0) session.meter.observe(kbps, clientAt + REPORT_LATENCY_MS)
    ctrl.onThroughput(
      buildStallSample({
        delivery: session.meter.evaluate(
          session.history,
          deliveryWindowMs(shape.idrIntervalMs, ADAPTIVE_DELIVERY_CONFIG),
          now,
        ),
        recent: session.meter.evaluateNewest(session.history, now),
        clientReporting: session.meter.isReporting(now),
        serverSending: true,
        adaptiveSessionsOnDevice: 1,
      }),
      now,
    )
    ctrl.onLoss({ packetsLost: 0, highestSequence: now }, now)
    ctrl.onCapacity({ rembKbps: REMB_KBPS, probeKbps: sc.probeKbps, probeFresh: true })
    ctrl.onRtt(4, now)
    ctrl.tick(now)
    const code = ctrl.climbHold?.code ?? 'none'
    if (holds.at(-1) !== code) holds.push(code)
    const move = pendingSlot.current
    if (move !== null) {
      pendingSlot.current = null
      moves.push({ ...move, at: now })
      if (move.to !== session.tier) {
        session = newSession(move.to, now, true, swapDelay)
        ctrl = build(move.to, ctrl)
      }
    }
  }
  return { moves, holds, last: ctrl }
}

const ALL_LAND = { low: 1, mid: 1, high: 1 } as const
const PHASES = [0, 500, 1_000, 1_500] as const

describe('device 104: 41 kbps rung, 4 s IDR, REMB 480 kbps', () => {
  it('probe 40 Mbps, mid bitrate UNKNOWN → climbs to mid on evidence (not a try)', () => {
    const { moves } = run({ midKbps: null, probeKbps: 40_000, delivered: ALL_LAND, seconds: 20 })
    expect(moves[0]).toMatchObject({ to: 'mid', cause: 'healthy', trial: false })
  })

  it('probe 40 Mbps, mid bitrate KNOWN 1.8 Mbps → climbs to mid on evidence', () => {
    const { moves } = run({ midKbps: 1_800, probeKbps: 40_000, delivered: ALL_LAND, seconds: 20 })
    expect(moves[0]).toMatchObject({ to: 'mid', cause: 'healthy', trial: false })
  })

  it('a probe that read SHORT (1.2 Mbps) holds: no try, however long (I4)', () => {
    const { moves, holds } = run({
      midKbps: 1_800,
      probeKbps: 1_200,
      delivered: ALL_LAND,
      seconds: 120,
    })
    expect(moves).toEqual([])
    expect(holds.at(-1)).toBe('capacity')
  })

  it('probe FAILED (unknown) → a try-climb after the healthy streak, kept when mid lands', () => {
    const { moves, last } = run({
      midKbps: 1_800,
      probeKbps: null,
      delivered: ALL_LAND,
      seconds: 60,
    })
    expect(moves[0]).toMatchObject({ to: 'mid', cause: 'healthy', trial: true })
    expect(moves[0]!.at).toBeGreaterThanOrEqual(10_000)
    expect(moves.filter((m) => m.cause === 'trial-revert')).toEqual([])
    expect(last.tryClimbCarry.failures).toBe(0)
  })

  /**
   * I1 (review): the first decode on the new PC takes 2–5 s (ICE, DTLS, an idle
   * slot-3 broker dialling RTSP, the first IDR). The old-PC zeros and the
   * post-swap zero fall inside the new session's sends; they reverted a mid
   * that was delivering 100 % in 3 of 4 phases at 3.5 s and 4 of 4 at 5 s.
   */
  it.each([
    2_500, 3_500, 5_000,
  ])('a mid swap %i ms after the re-offer, fully delivered, is never reverted', (swapDelayMs) => {
    for (const phaseMs of PHASES) {
      const { moves } = run({
        midKbps: 1_800,
        probeKbps: null,
        delivered: ALL_LAND,
        seconds: 90,
        swapDelayMs,
        phaseMs,
      })
      expect(moves[0], `phase ${String(phaseMs)}`).toMatchObject({ to: 'mid', trial: true })
      expect(
        moves.filter((m) => m.cause === 'trial-revert'),
        `phase ${String(phaseMs)}`,
      ).toEqual([])
    }
  })

  it('a try-climb that fails (mid lands 60 %) reverts to low, then backs off 30 s → 60 s', () => {
    const { moves, holds } = run({
      midKbps: 1_800,
      probeKbps: null,
      delivered: { low: 1, mid: 0.6, high: 0.6 },
      seconds: 260,
      swapDelayMs: 3_500,
    })
    const tries = moves.filter((m) => m.trial)
    const reverts = moves.filter((m) => m.cause === 'trial-revert')
    expect(tries.length).toBeGreaterThanOrEqual(3)
    expect(reverts.length).toBe(tries.length)
    for (const r of reverts) expect(r.to).toBe('low')
    // Each revert inside the tried rung's first window (the trial window).
    for (const [i, r] of reverts.entries()) {
      expect(r.at - tries[i]!.at).toBeLessThanOrEqual(ADAPTIVE_CONFIG.trialMs)
    }
    expect(tries[1]!.at - reverts[0]!.at).toBeGreaterThanOrEqual(30_000)
    expect(tries[2]!.at - reverts[1]!.at).toBeGreaterThanOrEqual(60_000)
    expect(holds).toContain('try-backoff')
  })

  it('a real stall (10 % landing on low) still walks the ladder down, never up', () => {
    const { moves } = run({
      midKbps: 1_800,
      probeKbps: 40_000,
      delivered: { low: 0.1, mid: 0.1, high: 0.1 },
      seconds: 30,
    })
    expect(moves[0]).toMatchObject({ cause: 'mtu:stall' })
  })
})

/**
 * I3 (review): a stall used to START only on a whole ≥ 1-GOP window below
 * 25 %, so a total freeze took 12–18 s to demote. It now starts on the newest
 * 2 s report. Measured here: 8–10 s at every GOP (2–10 s) and phase — the old
 * absolute floor's 8–10 s (one fully frozen report must be seen, then the 6 s
 * confirm).
 */
describe('freeze → first downgrade, on `high`', () => {
  it.each([2_000, 4_000, 8_000, 10_000])('GOP %i ms: within 10 s at every phase', (gop) => {
    const shape: RungShape = { pFrameKbps: 4_000, idrBytes: 250_000, idrIntervalMs: gop, fps: 25 }
    for (const phaseMs of PHASES) {
      const freezeAtMs = 60_000
      const { moves } = run({
        midKbps: 1_800,
        probeKbps: 40_000,
        delivered: ALL_LAND,
        seconds: 100,
        phaseMs,
        freezeAtMs,
        initialTier: 'high',
        shapes: { low: shape, mid: shape, high: shape },
      })
      const down = moves.find((m) => m.at > freezeAtMs)
      expect(down, `phase ${String(phaseMs)}`).toMatchObject({ to: 'mid', cause: 'stall' })
      expect(down!.at - freezeAtMs, `phase ${String(phaseMs)}`).toBeLessThanOrEqual(10_000)
    }
  })
})

/**
 * I2 (review): two viewers of the camera on this broker, one on `high`, one on
 * `low`. The device record holds whichever wrote last — here always the low
 * viewer (41 kbps). Read as its own, the high session saw 41 of 4 631 kbps and
 * walked high → mid → low on a healthy picture.
 */
describe('two adaptive sessions of one camera (high + low) sharing the device record', () => {
  it("neither demotes on the other's numbers, and neither tries a rung", () => {
    const high = new AdaptiveController({
      initialTier: 'high',
      config: ADAPTIVE_CONFIG,
      onSwitchTier: (to) => moves.push(`high→${to}`),
      onReduceMtu: () => moves.push('high:mtu'),
      onTranscodeDown: () => undefined,
    })
    const low = new AdaptiveController({
      initialTier: 'low',
      config: ADAPTIVE_CONFIG,
      expectedTierKbps: (t) => (t === 'mid' ? 1_800 : 4_631),
      onSwitchTier: (to) => moves.push(`low→${to}`),
      onReduceMtu: () => moves.push('low:mtu'),
      onTranscodeDown: () => undefined,
    })
    const moves: string[] = []
    // What each session's meter produces from the SHARED record: the low
    // viewer's report against each session's own sends.
    const lowViewerKbps = 41
    for (let now = TICK; now <= 120_000; now += TICK) {
      for (const [ctrl, sentKbps] of [
        [high, 4_631],
        [low, 41],
      ] as const) {
        ctrl.onThroughput(
          buildStallSample({
            delivery: { receivedKbps: lowViewerKbps, sentKbps, windowMs: 4_000 },
            recent: { receivedKbps: lowViewerKbps, sentKbps, windowMs: SPAN },
            clientReporting: true,
            serverSending: true,
            adaptiveSessionsOnDevice: 2,
          }),
          now,
        )
        ctrl.onLoss({ packetsLost: 0, highestSequence: now }, now)
        ctrl.onCapacity({ rembKbps: REMB_KBPS, probeKbps: null, probeFresh: false })
        ctrl.tick(now)
      }
    }
    expect(moves).toEqual([])
    expect(low.climbHold?.tryBlockedBy).toBe('shared-telemetry')
  })
})
