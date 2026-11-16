/**
 * Health digest (planning#572) — state snapshot in, findings out. Pure: no
 * clock, no I/O. A value that could not be read is null and never becomes 0.
 */
import { describe, expect, it } from 'vitest'
import {
  buildHealthDigest,
  HealthDigestKeeper,
  type CameraHealthState,
  type HealthDigestState,
} from '../health-digest.js'

const NOW = 10_000_000
const HOUR = 3_600_000

function cam(overrides: Partial<CameraHealthState> & { deviceId: number }): CameraHealthState {
  return { motion: null, metrics: null, ...overrides }
}

function state(overrides: Partial<HealthDigestState> = {}): HealthDigestState {
  return {
    now: NOW,
    cameras: [],
    motionEntries: 0,
    metricsEntries: 0,
    placement: [],
    unusableDevices: [],
    ...overrides,
  }
}

const QUIET_MOTION = {
  motionKnown: true,
  sessionsInWindow: 0,
  dutyInWindow: 0,
  lastDetectionAt: NOW - 60_000,
  lastFrameAt: NOW - 1000,
  belowFloorFrames: 0,
  framesSinceOutput: 0,
  trackedSince: NOW - 2 * HOUR,
}

describe('buildHealthDigest', () => {
  it('a healthy cluster has no findings', () => {
    const d = buildHealthDigest(state({ cameras: [cam({ deviceId: 1, motion: QUIET_MOTION })] }), 3)
    expect(d.findings).toEqual([])
    expect(d.camerasSeen).toBe(1)
    expect(d.tickMs).toBe(3)
  })

  it('many motion sessions and no detection becomes a camera finding with numbers', () => {
    const d = buildHealthDigest(
      state({
        cameras: [
          cam({
            deviceId: 7,
            motion: {
              ...QUIET_MOTION,
              sessionsInWindow: 55,
              dutyInWindow: 0.4,
              lastDetectionAt: null,
              framesSinceOutput: 300,
            },
          }),
        ],
      }),
      1,
    )
    const f = d.findings.find((x) => x.kind === 'motion-without-detections')
    expect(f).toBeDefined()
    expect(f?.subject).toEqual({ type: 'camera', deviceId: 7 })
    expect(f?.severity).toBe('warning')
    expect(f?.evidence).toMatchObject({ sessionsInWindow: 55, dutyInWindow: 0.4 })
    expect(f?.action.length).toBeGreaterThan(0)
  })

  it('frames the detector saw but the class floor dropped are their own finding', () => {
    const d = buildHealthDigest(
      state({
        cameras: [
          cam({
            deviceId: 8,
            motion: { ...QUIET_MOTION, belowFloorFrames: 40, lastDetectionAt: null },
          }),
        ],
      }),
      1,
    )
    const f = d.findings.find((x) => x.kind === 'detections-under-floor')
    expect(f?.evidence).toMatchObject({ belowFloorFrames: 40 })
    expect(d.findings.some((x) => x.kind === 'motion-without-detections')).toBe(false)
  })

  it('a camera whose motion source is unknown has no motion finding and a null duty', () => {
    const d = buildHealthDigest(
      state({
        cameras: [
          cam({
            deviceId: 9,
            motion: {
              ...QUIET_MOTION,
              motionKnown: false,
              dutyInWindow: null,
              sessionsInWindow: 99,
            },
          }),
        ],
      }),
      1,
    )
    expect(d.findings).toEqual([])
  })

  it('latency that allows less than the configured fps is flagged, critical below half', () => {
    const slow = (avg: number): HealthDigestState =>
      state({
        cameras: [
          cam({
            deviceId: 3,
            metrics: {
              phase: 'active',
              configuredFps: 10,
              actualFps: 4,
              avgInferenceTimeMs: avg,
              queueDepth: 0,
              droppedFrames: 0,
              lastSeen: NOW - 1000,
              droppedSincePreviousTick: 0,
            },
          }),
        ],
      })
    expect(buildHealthDigest(slow(50), 1).findings).toEqual([]) // 20 fps allowed
    const warn = buildHealthDigest(slow(125), 1).findings[0] // 8 fps allowed
    expect(warn?.kind).toBe('inference-too-slow')
    expect(warn?.severity).toBe('warning')
    expect(warn?.evidence).toMatchObject({ allowedFps: 8, configuredFps: 10 })
    expect(buildHealthDigest(slow(400), 1).findings[0]?.severity).toBe('critical') // 2.5 fps
  })

  it('an idle camera or a stale sample is not judged', () => {
    const base = {
      configuredFps: 10,
      actualFps: 0,
      avgInferenceTimeMs: 900,
      queueDepth: 5,
      droppedFrames: 9,
      droppedSincePreviousTick: 9,
    }
    const idle = state({
      cameras: [cam({ deviceId: 1, metrics: { ...base, phase: 'idle', lastSeen: NOW - 1000 } })],
    })
    const stale = state({
      cameras: [
        cam({ deviceId: 1, metrics: { ...base, phase: 'active', lastSeen: NOW - 20 * 60_000 } }),
      ],
    })
    expect(buildHealthDigest(idle, 1).findings).toEqual([])
    expect(buildHealthDigest(stale, 1).findings).toEqual([])
  })

  it('shedding with a backlog reads as a saturated worker', () => {
    const d = buildHealthDigest(
      state({
        cameras: [
          cam({
            deviceId: 4,
            metrics: {
              phase: 'active',
              configuredFps: 5,
              actualFps: 5,
              avgInferenceTimeMs: 20,
              queueDepth: 6,
              droppedFrames: 120,
              droppedSincePreviousTick: 30,
              lastSeen: NOW,
            },
          }),
        ],
      }),
      1,
    )
    const f = d.findings.find((x) => x.kind === 'frames-shed')
    expect(f?.evidence).toMatchObject({ droppedSincePreviousTick: 30, queueDepth: 6 })
  })

  it('an unusable inference device is a critical finding on that node and device', () => {
    const d = buildHealthDigest(
      state({
        placement: [
          {
            nodeId: 'agent-a',
            sessionsNow: 2,
            sessionsStarted: 5,
            observedShare: 0.5,
            peakSessions: 3,
            yieldsAway: 0,
            devices: [
              { deviceKey: 'openvino:GPU', sessionsNow: 2, sessionsStarted: 5, observedShare: 1 },
            ],
          },
        ],
        unusableDevices: [{ nodeId: 'agent-a', deviceKey: 'openvino:NPU' }],
      }),
      1,
    )
    const f = d.findings.find((x) => x.kind === 'inference-device-unusable')
    expect(f?.severity).toBe('critical')
    expect(f?.subject).toEqual({
      type: 'inference-device',
      nodeId: 'agent-a',
      deviceKey: 'openvino:NPU',
    })
    const node = d.nodes.find((n) => n.nodeId === 'agent-a')
    expect(node?.unusableDevices).toEqual(['openvino:NPU'])
    expect(node?.devices.map((x) => [x.deviceKey, x.usable])).toEqual([['openvino:GPU', true]])
  })

  it('a source that failed to read is reported null and its findings are not invented', () => {
    const d = buildHealthDigest(state({ placement: null, unusableDevices: null }), 1)
    expect(d.findings).toEqual([])
    expect(d.sources.filter((s) => s.entries === null).map((s) => s.source)).toEqual([
      'placement',
      'inference-device-usability',
    ])
  })

  it('a stale old drop with a current backlog is not shedding now', () => {
    const d = buildHealthDigest(
      state({
        cameras: [
          cam({
            deviceId: 4,
            metrics: {
              phase: 'active',
              configuredFps: 5,
              actualFps: 5,
              avgInferenceTimeMs: 20,
              queueDepth: 6,
              droppedFrames: 5000,
              droppedSincePreviousTick: 0,
              lastSeen: NOW,
            },
          }),
        ],
      }),
      1,
    )
    expect(d.findings.some((f) => f.kind === 'frames-shed')).toBe(false)
  })

  it('failed camera reads are null and the camera count is not reported as zero', () => {
    const d = buildHealthDigest(state({ motionEntries: null, metricsEntries: 3 }), 1)
    expect(d.camerasSeen).toBeNull()
    expect(d.sources.find((s) => s.source === 'motion')?.entries).toBeNull()
  })

  it('names the signals it does not cover', () => {
    const d = buildHealthDigest(state(), 1)
    expect(d.notCovered.join(' ')).toMatch(/decode/i)
  })
})

describe('HealthDigestKeeper', () => {
  it('keeps a bounded number of digests, newest first', () => {
    const k = new HealthDigestKeeper(3)
    for (let i = 1; i <= 5; i++) k.push(buildHealthDigest(state({ now: i }), i))
    expect(k.latest()?.tickMs).toBe(5)
    expect(k.recent(10).map((d) => d.tickMs)).toEqual([5, 4, 3])
  })

  it('has no latest before the first tick', () => {
    expect(new HealthDigestKeeper(3).latest()).toBeNull()
  })
})
