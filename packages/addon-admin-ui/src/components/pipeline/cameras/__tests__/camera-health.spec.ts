import { describe, it, expect } from 'vitest'
import { cameraHealth } from '../camera-health'
import type { CameraStatus } from '@camstack/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<CameraStatus> = {}): CameraStatus {
  return {
    deviceId: 1,
    fetchedAt: 1000,
    switchedOff: [],
    degraded: [],
    assignment: {
      detectionNodeId: 'node-a',
      decoderNodeId: 'node-a',
      audioNodeId: null,
      sourceNodeId: null,
      pinned: { detection: false, decoder: false, audio: false },
      reasons: {},
    },
    source: {
      streams: [
        { camStreamId: 'main', codec: 'h264', width: 1920, height: 1080, fps: 15, kind: 'main' },
      ],
    },
    broker: {
      profiles: [
        {
          profile: 'high',
          status: 'active',
          codec: 'h264',
          width: 1920,
          height: 1080,
          subscribers: 2,
          inFps: 15,
        },
      ],
      webrtcSessions: 1,
      rtspRestream: false,
    },
    decoder: { nodeId: 'node-a' },
    motion: { enabled: true, fps: 10 },
    detection: {
      nodeId: 'node-a',
      engine: { backend: 'coreml', device: 'ane' },
      phase: 'active',
      configuredFps: 5,
      actualFps: 4.8,
      queueDepth: 2,
      avgInferenceMs: 12.5,
      provisioning: { state: 'ready' },
    },
    audio: { nodeId: 'node-a', enabled: true },
    recording: { mode: 'continuous', active: true, storageBytes: 1_048_576 },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cameraHealth', () => {
  // HEALTHY ─────────────────────────────────────────────────────────────────

  it('returns healthy when detection phase is active', () => {
    const status = makeStatus()
    expect(cameraHealth(status)).toBe('healthy')
  })

  it('returns healthy with provisioning state ready and phase active', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'active',
        configuredFps: 5,
        actualFps: 4.8,
        queueDepth: 0,
        avgInferenceMs: 10,
        provisioning: { state: 'ready' },
      },
    })
    expect(cameraHealth(status)).toBe('healthy')
  })

  // IDLE ────────────────────────────────────────────────────────────────────

  it('returns idle when detection phase is watching', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'watching',
        configuredFps: 5,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceMs: 0,
        provisioning: { state: 'ready' },
      },
    })
    expect(cameraHealth(status)).toBe('idle')
  })

  it('returns idle when detection phase is idle', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'idle',
        configuredFps: 5,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceMs: 0,
        provisioning: { state: 'ready' },
      },
    })
    expect(cameraHealth(status)).toBe('idle')
  })

  it('returns idle when assigned (detectionNodeId set) but detection block is null', () => {
    // Assignment in progress / node temporarily unreachable.
    const status = makeStatus({
      assignment: {
        detectionNodeId: 'node-a',
        decoderNodeId: 'node-a',
        audioNodeId: null,
        sourceNodeId: null,
        pinned: { detection: false, decoder: false, audio: false },
        reasons: {},
      },
      detection: null,
    })
    expect(cameraHealth(status)).toBe('idle')
  })

  it('returns idle when provisioning state is installing', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'idle',
        configuredFps: 5,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceMs: 0,
        provisioning: { state: 'installing' },
      },
    })
    expect(cameraHealth(status)).toBe('idle')
  })

  it('returns idle when provisioning state is verifying', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'idle',
        configuredFps: 5,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceMs: 0,
        provisioning: { state: 'verifying' },
      },
    })
    expect(cameraHealth(status)).toBe('idle')
  })

  // ERROR ───────────────────────────────────────────────────────────────────

  it('returns error when provisioning state is failed', () => {
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'idle',
        configuredFps: 5,
        actualFps: 0,
        queueDepth: 0,
        avgInferenceMs: 0,
        provisioning: { state: 'failed', error: 'Model load failed' },
      },
    })
    expect(cameraHealth(status)).toBe('error')
  })

  it('returns error when provisioning failed even if phase is active', () => {
    // Provisioning failure takes precedence over a stale active phase.
    const status = makeStatus({
      detection: {
        nodeId: 'node-a',
        engine: { backend: 'coreml', device: 'ane' },
        phase: 'active',
        configuredFps: 5,
        actualFps: 3,
        queueDepth: 0,
        avgInferenceMs: 10,
        provisioning: { state: 'failed', error: 'OOM' },
      },
    })
    expect(cameraHealth(status)).toBe('error')
  })

  it('returns error when camera is completely unassigned (no detectionNodeId, no detection block)', () => {
    const status = makeStatus({
      assignment: {
        detectionNodeId: null,
        decoderNodeId: null,
        audioNodeId: null,
        sourceNodeId: null,
        pinned: { detection: false, decoder: false, audio: false },
        reasons: {},
      },
      detection: null,
    })
    expect(cameraHealth(status)).toBe('error')
  })

  it('is IDLE, not error, for an ARMED on-motion camera between motion events', () => {
    // Same shape as the case above — no detection node, no detection block —
    // but the server now distinguishes them: this camera is armed and waiting.
    // Painting it red is the healthy-reads-as-broken inversion the status
    // markers exist to remove.
    const status = makeStatus({
      assignment: {
        detectionNodeId: null,
        decoderNodeId: null,
        audioNodeId: null,
        sourceNodeId: null,
        pinned: { detection: false, decoder: false, audio: false },
        reasons: { detection: 'armed:on-motion' },
      },
      detection: null,
    })
    expect(cameraHealth(status)).toBe('idle')
  })
})
