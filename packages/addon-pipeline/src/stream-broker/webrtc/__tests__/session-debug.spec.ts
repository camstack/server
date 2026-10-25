import { describe, expect, it } from 'vitest'
import { projectSessionDebug, type SessionDebugInput } from '../session-debug.js'

const LIVE: SessionDebugInput = {
  sessionId: 's-1',
  observedAt: 1_700_000_000_000,
  session: {
    brokerId: '102/native:main',
    adaptive: true,
    sourceCodec: 'H265',
    negotiatedCodec: 'H264',
    needsTranscode: true,
    rtpPacketsSent: 123_456,
    trackMode: 'live',
  },
  servedTier: 'mid',
  origin: { ingestNodeId: 'unraid-agent', ingestIsRemote: true },
  brokerStats: {
    status: 'streaming',
    codec: 'H265',
    bitrateKbps: 2_048,
    inputFps: 15,
    uptimeMs: 60_000,
  },
  ladder: {
    lastDecision: {
      cause: 'stall',
      tier: 'mid',
      forcedTranscodeDown: false,
      lossRatio: 0.0123,
      clientKbps: 480,
      stalledForMs: 4_200,
      serverSending: true,
      at: 1_699_999_990_000,
    },
    failures: [
      ['high', 2],
      ['mid', 0],
    ],
    upgradeCount: 1,
    climbHold: null,
  },
}

describe('projectSessionDebug — a live session', () => {
  it('projects what the server decided', () => {
    const d = projectSessionDebug(LIVE)
    expect(d.sessionId).toBe('s-1')
    expect(d.alive).toBe(true)
    expect(d.observedAt).toBe(1_700_000_000_000)
    expect(d.brokerId).toBe('102/native:main')
    expect(d.camStreamId).toBe('native:main')
    expect(d.sourceKind).toBe('native')
    expect(d.adaptive).toBe(true)
    expect(d.servedTier).toBe('mid')
    expect(d.ingestNodeId).toBe('unraid-agent')
    expect(d.ingestIsRemote).toBe(true)
    expect(d.sourceCodec).toBe('H265')
    expect(d.negotiatedCodec).toBe('H264')
    expect(d.egressLeg).toBe('transcode')
    expect(d.brokerStatus).toBe('streaming')
    expect(d.brokerCodec).toBe('H265')
    expect(d.brokerBitrateKbps).toBe(2_048)
    expect(d.brokerInputFps).toBe(15)
    expect(d.brokerUptimeMs).toBe(60_000)
    expect(d.rtpPacketsSent).toBe(123_456)
    expect(d.trackMode).toBe('live')
    expect(d.lastDecision).toEqual(LIVE.ladder?.lastDecision)
    expect(d.tierFailures).toEqual([
      { tier: 'high', failures: 2 },
      { tier: 'mid', failures: 0 },
    ])
    expect(d.upgradeCount).toBe(1)
  })

  it('names a rung this hub BUILT as derived', () => {
    const d = projectSessionDebug({
      ...LIVE,
      session: { ...LIVE.session!, brokerId: '102/derived:sub-cropped' },
    })
    expect(d.camStreamId).toBe('derived:sub-cropped')
    expect(d.sourceKind).toBe('derived')
  })

  it('a source-byte-for-byte egress is `copy`, not `transcode`', () => {
    const d = projectSessionDebug({
      ...LIVE,
      session: { ...LIVE.session!, needsTranscode: false },
    })
    expect(d.egressLeg).toBe('copy')
  })

  it('a brokerId it cannot parse yields an UNKNOWN kind, not a guess', () => {
    const d = projectSessionDebug({
      ...LIVE,
      session: { ...LIVE.session!, brokerId: 'nonsense' },
    })
    expect(d.camStreamId).toBeNull()
    expect(d.sourceKind).toBe('unknown')
  })
})

describe('projectSessionDebug — absence is null, never zero (D393)', () => {
  it('a session this server has never heard of reports nothing measured', () => {
    const d = projectSessionDebug({
      sessionId: 'ghost',
      observedAt: 42,
      session: null,
      servedTier: null,
      origin: null,
      brokerStats: null,
      ladder: null,
    })
    expect(d.alive).toBe(false)
    expect(d.brokerId).toBeNull()
    expect(d.camStreamId).toBeNull()
    expect(d.sourceKind).toBe('unknown')
    expect(d.adaptive).toBe(false)
    expect(d.servedTier).toBeNull()
    expect(d.ingestNodeId).toBeNull()
    expect(d.ingestIsRemote).toBeNull()
    expect(d.sourceCodec).toBeNull()
    expect(d.negotiatedCodec).toBeNull()
    expect(d.egressLeg).toBe('unknown')
    expect(d.brokerStatus).toBeNull()
    expect(d.brokerBitrateKbps).toBeNull()
    expect(d.brokerInputFps).toBeNull()
    expect(d.brokerUptimeMs).toBeNull()
    expect(d.rtpPacketsSent).toBeNull()
    expect(d.trackMode).toBeNull()
    expect(d.lastDecision).toBeNull()
    expect(d.tierFailures).toEqual([])
    expect(d.upgradeCount).toBeNull()
  })

  it('an alive session whose ladder has never moved reports a null decision', () => {
    const d = projectSessionDebug({
      ...LIVE,
      ladder: { lastDecision: null, failures: [], upgradeCount: 0, climbHold: null },
    })
    expect(d.alive).toBe(true)
    expect(d.lastDecision).toBeNull()
    // Zero promotions is a MEASUREMENT here — the ladder is running.
    expect(d.upgradeCount).toBe(0)
    expect(d.tierFailures).toEqual([])
  })

  it('a non-adaptive session has no ladder at all — upgradeCount is null', () => {
    const d = projectSessionDebug({
      ...LIVE,
      session: { ...LIVE.session!, adaptive: false },
      ladder: null,
    })
    expect(d.adaptive).toBe(false)
    expect(d.upgradeCount).toBeNull()
    expect(d.lastDecision).toBeNull()
  })

  it('a broker reporting no codec reports null, not an empty string', () => {
    const d = projectSessionDebug({
      ...LIVE,
      brokerStats: { status: 'connecting', bitrateKbps: 0, inputFps: 0, uptimeMs: 0 },
    })
    expect(d.brokerCodec).toBeNull()
    // A measured 0 kbps on a connecting broker is a real reading.
    expect(d.brokerBitrateKbps).toBe(0)
  })

  it('an unresolved ingest owner is null, and never the local node by default', () => {
    const d = projectSessionDebug({
      ...LIVE,
      origin: { ingestNodeId: null, ingestIsRemote: null },
    })
    expect(d.ingestNodeId).toBeNull()
    expect(d.ingestIsRemote).toBeNull()
  })
})

describe('projectSessionDebug — the ladder decision', () => {
  it('keeps a 0 loss ratio as a measurement, distinct from an absent one', () => {
    const d = projectSessionDebug({
      ...LIVE,
      ladder: {
        lastDecision: {
          cause: 'healthy',
          tier: 'high',
          forcedTranscodeDown: false,
          lossRatio: 0,
          clientKbps: null,
          stalledForMs: 0,
          serverSending: true,
          at: 10,
        },
        failures: [],
        upgradeCount: 3,
        climbHold: null,
      },
    })
    expect(d.lastDecision?.lossRatio).toBe(0)
    expect(d.lastDecision?.clientKbps).toBeNull()
    expect(d.lastDecision?.cause).toBe('healthy')
  })

  it('an MTU-reduction move changed no rung — tier is null, not the current one', () => {
    const d = projectSessionDebug({
      ...LIVE,
      ladder: {
        lastDecision: {
          cause: 'loss',
          tier: null,
          forcedTranscodeDown: false,
          lossRatio: 0.2,
          clientKbps: 90,
          stalledForMs: 0,
          serverSending: true,
          at: 11,
        },
        failures: [],
        upgradeCount: 0,
        climbHold: null,
      },
    })
    expect(d.lastDecision?.tier).toBeNull()
  })
})

describe('projectSessionDebug — why the ladder is NOT moving', () => {
  it('carries the climb hold, so "held for a reason" never reads as "no ladder"', () => {
    const hold = {
      code: 'capacity' as const,
      nextTier: 'high' as const,
      deliveryRatio: 0.97,
      deliveryWindowMs: 4_000,
      climbDeliveryRatio: 0.9,
      capacityKbps: 480,
      probeKbps: null,
      nextTierKbps: 1_800,
      neededKbps: null,
      capacityMargin: 1.2,
      tryBlockedBy: null,
      retryInMs: null,
      lastRevert: null,
      trialForMs: null,
      trialMs: null,
      healthyForMs: 12_000,
      requiredHealthyMs: 4_000,
      since: 1_699_999_999_000,
      summary: 'held: delivery 0.97 over 4.0s ok, REMB 480 kbps < high 1800 kbps × 1.2',
    }
    const d = projectSessionDebug({
      ...LIVE,
      ladder: { lastDecision: null, failures: [], upgradeCount: 0, climbHold: hold },
    })
    expect(d.lastDecision).toBeNull()
    expect(d.climbHold).toEqual(hold)
  })

  it('no ladder ⇒ no hold (null), never an invented one', () => {
    expect(projectSessionDebug({ ...LIVE, ladder: null }).climbHold).toBeNull()
    expect(projectSessionDebug({ ...LIVE, session: null }).climbHold).toBeNull()
  })
})
