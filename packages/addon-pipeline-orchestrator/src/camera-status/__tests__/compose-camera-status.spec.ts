/**
 * Unit tests for the pure `composeCameraStatus` composer.
 * TDD — written before the implementation exists.
 *
 * Covers:
 *  1. Full pipeline: all blocks populated (including cross-node detection≠decoder)
 *  2. Each stage individually null → only that block null, no throw
 *  3. Provisioning passthrough (installing/ready/failed+error)
 *  4. Reasons passthrough from assignment
 *  5. Empty/absent nested fields → safe defaults, no throw
 *  6. fetchedAt passthrough
 */
import { describe, it, expect } from 'vitest'
import type {
  CameraStatus,
  CameraDetectionPhase,
  CameraDetectionProvisioningState,
  CameraRecordingMode,
} from '@camstack/types'
import {
  composeCameraStatus,
  type ComposeInput,
  type SourceResult,
  type BrokerResult,
  type DecoderResult,
  type MotionResult,
  type DetectionResult,
  type AudioResult,
  type RecordingResult,
} from '../compose-camera-status.js'

// ── Fixture helpers ──────────────────────────────────────────────────────────

function baseAssignment(): Pick<
  ComposeInput,
  'detectionNodeId' | 'decoderNodeId' | 'audioNodeId' | 'sourceNodeId' | 'pinned' | 'reasons'
> {
  return {
    detectionNodeId: 'agent-node-1',
    decoderNodeId: 'agent-node-2',
    audioNodeId: 'agent-node-1',
    sourceNodeId: 'hub',
    pinned: { detection: true, decoder: false, audio: false },
    reasons: { detection: 'manual', decoder: 'co-located', audio: 'capacity' },
  }
}

function makeSourceResult(): SourceResult {
  return {
    streams: [
      { camStreamId: 'stream-a', codec: 'h264', width: 1920, height: 1080, fps: 30, kind: 'main' },
      { camStreamId: 'stream-b', codec: 'h264', width: 640, height: 360, fps: 15, kind: 'sub' },
    ],
  }
}

function makeBrokerResult(): BrokerResult {
  return {
    profiles: [
      {
        profile: 'main',
        status: 'active',
        codec: 'h264',
        width: 1920,
        height: 1080,
        subscribers: 2,
        inFps: 30,
      },
    ],
    webrtcSessions: 1,
    rtspRestream: true,
  }
}

function makeDecoderResult(): DecoderResult {
  return { nodeId: 'agent-node-2' }
}

function makeMotionResult(): MotionResult {
  return { enabled: true, fps: 5 }
}

function makeDetectionResult(
  phase: CameraDetectionPhase = 'active',
  provisioningState: CameraDetectionProvisioningState = 'ready',
): DetectionResult {
  return {
    nodeId: 'agent-node-1',
    engine: { backend: 'onnx', device: 'cpu' },
    phase,
    configuredFps: 10,
    actualFps: 9,
    queueDepth: 2,
    avgInferenceMs: 45,
    provisioning: { state: provisioningState },
  }
}

function makeAudioResult(): AudioResult {
  return { nodeId: 'agent-node-1', enabled: true }
}

function makeRecordingResult(mode: CameraRecordingMode = 'continuous'): RecordingResult {
  return { mode, active: true, storageBytes: 1_073_741_824 }
}

function fullInput(): ComposeInput {
  return {
    deviceId: 42,
    fetchedAt: 1_700_000_000_000,
    switchedOff: [],
    cameraSensors: { state: 'not-configured' },
    degraded: [],
    ...baseAssignment(),
    sourceResult: makeSourceResult(),
    brokerResult: makeBrokerResult(),
    decoderResult: makeDecoderResult(),
    motionResult: makeMotionResult(),
    detectionResult: makeDetectionResult(),
    audioResult: makeAudioResult(),
    recordingResult: makeRecordingResult(),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('composeCameraStatus', () => {
  describe('full pipeline — all stages present', () => {
    it('returns a CameraStatus with deviceId and fetchedAt set', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.deviceId).toBe(42)
      expect(result.fetchedAt).toBe(1_700_000_000_000)
    })

    it('builds assignment block from local data', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.assignment.detectionNodeId).toBe('agent-node-1')
      expect(result.assignment.decoderNodeId).toBe('agent-node-2')
      expect(result.assignment.audioNodeId).toBe('agent-node-1')
      expect(result.assignment.sourceNodeId).toBe('hub')
      expect(result.assignment.pinned).toEqual({
        detection: true,
        decoder: false,
        audio: false,
      })
      expect(result.assignment.reasons).toEqual({
        detection: 'manual',
        decoder: 'co-located',
        audio: 'capacity',
      })
    })

    it('surfaces cross-node fields: detection nodeId ≠ decoder nodeId', () => {
      const result = composeCameraStatus(fullInput())
      // assignment block contains both node IDs
      expect(result.assignment.detectionNodeId).toBe('agent-node-1')
      expect(result.assignment.decoderNodeId).toBe('agent-node-2')
      // decoder block carries its own nodeId
      expect(result.decoder?.nodeId).toBe('agent-node-2')
      // detection block carries its own nodeId
      expect(result.detection?.nodeId).toBe('agent-node-1')
    })

    it('maps source streams correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.source.streams).toHaveLength(2)
      expect(result.source.streams[0]).toEqual({
        camStreamId: 'stream-a',
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 30,
        kind: 'main',
      })
    })

    it('maps broker block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.broker).not.toBeNull()
      expect(result.broker?.webrtcSessions).toBe(1)
      expect(result.broker?.rtspRestream).toBe(true)
      expect(result.broker?.profiles).toHaveLength(1)
      expect(result.broker?.profiles[0]?.subscribers).toBe(2)
    })

    it('maps decoder block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.decoder).not.toBeNull()
      // WHERE decode runs, and nothing else: the shared-memory counters,
      // session count and formats were never read (constant 0 / []) and are
      // gone from the contract rather than served as zeros.
      expect(result.decoder).toEqual({ nodeId: 'agent-node-2' })
    })

    it('maps motion block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.motion).not.toBeNull()
      expect(result.motion?.enabled).toBe(true)
      expect(result.motion?.fps).toBe(5)
    })

    it('maps detection block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.detection).not.toBeNull()
      expect(result.detection?.nodeId).toBe('agent-node-1')
      expect(result.detection?.engine).toEqual({ backend: 'onnx', device: 'cpu' })
      expect(result.detection?.phase).toBe('active')
      expect(result.detection?.configuredFps).toBe(10)
      expect(result.detection?.actualFps).toBe(9)
      expect(result.detection?.queueDepth).toBe(2)
      expect(result.detection?.avgInferenceMs).toBe(45)
      expect(result.detection?.provisioning.state).toBe('ready')
    })

    it('maps audio block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.audio).not.toBeNull()
      expect(result.audio?.nodeId).toBe('agent-node-1')
      expect(result.audio?.enabled).toBe(true)
    })

    it('maps recording block correctly', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.recording).not.toBeNull()
      expect(result.recording?.mode).toBe('continuous')
      expect(result.recording?.active).toBe(true)
      expect(result.recording?.storageBytes).toBe(1_073_741_824)
    })
  })

  describe('graceful degradation — each stage individually null', () => {
    it('returns null broker when brokerResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), brokerResult: null })
      expect(result.broker).toBeNull()
      // other blocks still populated
      expect(result.decoder).not.toBeNull()
      expect(result.detection).not.toBeNull()
    })

    it('returns null decoder when decoderResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), decoderResult: null })
      expect(result.decoder).toBeNull()
      expect(result.broker).not.toBeNull()
    })

    it('returns null motion when motionResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), motionResult: null })
      expect(result.motion).toBeNull()
      expect(result.detection).not.toBeNull()
    })

    it('returns null detection when detectionResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), detectionResult: null })
      expect(result.detection).toBeNull()
      expect(result.motion).not.toBeNull()
    })

    it('returns null audio when audioResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), audioResult: null })
      expect(result.audio).toBeNull()
      expect(result.recording).not.toBeNull()
    })

    it('returns null recording when recordingResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), recordingResult: null })
      expect(result.recording).toBeNull()
      expect(result.audio).not.toBeNull()
    })

    it('defaults source to empty streams when sourceResult is null', () => {
      const result = composeCameraStatus({ ...fullInput(), sourceResult: null })
      expect(result.source).toEqual({ streams: [] })
      // other blocks still populated
      expect(result.broker).not.toBeNull()
    })

    it('does not throw when ALL optional stages are null', () => {
      const minimalInput: ComposeInput = {
        deviceId: 1,
        fetchedAt: 0,
        switchedOff: [],
        cameraSensors: { state: 'not-configured' },
        degraded: [],
        detectionNodeId: null,
        decoderNodeId: null,
        audioNodeId: null,
        sourceNodeId: null,
        pinned: { detection: false, decoder: false, audio: false },
        reasons: {},
        sourceResult: null,
        brokerResult: null,
        decoderResult: null,
        motionResult: null,
        detectionResult: null,
        audioResult: null,
        recordingResult: null,
      }
      expect(() => composeCameraStatus(minimalInput)).not.toThrow()
      const result = composeCameraStatus(minimalInput)
      expect(result.broker).toBeNull()
      expect(result.decoder).toBeNull()
      expect(result.motion).toBeNull()
      expect(result.detection).toBeNull()
      expect(result.audio).toBeNull()
      expect(result.recording).toBeNull()
      expect(result.source).toEqual({ streams: [] })
      // Every block above is null and NOTHING was cut short — that pairing is
      // the whole point of the marker: these nulls mean "there is nothing
      // here", and a consumer can tell because `degraded` is empty.
      expect(result.degraded).toEqual([])
    })

    it('carries the degraded stages through verbatim — it never decides them', () => {
      const degraded = [
        { stage: 'switches', reason: 'timeout', elapsedMs: 3_000 },
        { stage: 'recording', reason: 'partial', elapsedMs: 42 },
      ] as const
      const result = composeCameraStatus({ ...fullInput(), degraded })
      expect(result.degraded).toEqual(degraded)
    })
  })

  describe('provisioning state passthrough', () => {
    it('passes through installing state', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('idle', 'installing'),
      })
      expect(result.detection?.provisioning.state).toBe('installing')
      expect(result.detection?.provisioning.error).toBeUndefined()
    })

    it('passes through verifying state', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('idle', 'verifying'),
      })
      expect(result.detection?.provisioning.state).toBe('verifying')
    })

    it('passes through ready state', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('active', 'ready'),
      })
      expect(result.detection?.provisioning.state).toBe('ready')
    })

    it('passes through failed state with error string', () => {
      const detectionWithError: DetectionResult = {
        ...makeDetectionResult('idle', 'failed'),
        provisioning: { state: 'failed', error: 'model download timed out' },
      }
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: detectionWithError,
      })
      expect(result.detection?.provisioning.state).toBe('failed')
      expect(result.detection?.provisioning.error).toBe('model download timed out')
    })

    it('passes through idle provisioning state', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('idle', 'idle'),
      })
      expect(result.detection?.provisioning.state).toBe('idle')
    })
  })

  describe('reasons passthrough from assignment', () => {
    it('passes all three reasons through', () => {
      const result = composeCameraStatus(fullInput())
      expect(result.assignment.reasons.detection).toBe('manual')
      expect(result.assignment.reasons.decoder).toBe('co-located')
      expect(result.assignment.reasons.audio).toBe('capacity')
    })

    it('allows partial reasons (only detection present)', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        reasons: { detection: 'manual' },
      })
      expect(result.assignment.reasons.detection).toBe('manual')
      expect(result.assignment.reasons.decoder).toBeUndefined()
      expect(result.assignment.reasons.audio).toBeUndefined()
    })

    it('allows empty reasons object', () => {
      const result = composeCameraStatus({ ...fullInput(), reasons: {} })
      expect(result.assignment.reasons).toEqual({})
    })
  })

  describe('assignment null node IDs', () => {
    it('allows null detectionNodeId', () => {
      const result = composeCameraStatus({ ...fullInput(), detectionNodeId: null })
      expect(result.assignment.detectionNodeId).toBeNull()
    })

    it('allows null decoderNodeId', () => {
      const result = composeCameraStatus({ ...fullInput(), decoderNodeId: null })
      expect(result.assignment.decoderNodeId).toBeNull()
    })

    it('allows null audioNodeId', () => {
      const result = composeCameraStatus({ ...fullInput(), audioNodeId: null })
      expect(result.assignment.audioNodeId).toBeNull()
    })
  })

  describe('empty/absent nested fields — safe defaults, no throw', () => {
    it('defaults broker profiles to empty array when profiles absent', () => {
      const brokerWithNoProfiles: BrokerResult = {
        profiles: [],
        webrtcSessions: 0,
        rtspRestream: false,
      }
      const result = composeCameraStatus({ ...fullInput(), brokerResult: brokerWithNoProfiles })
      expect(result.broker?.profiles).toEqual([])
    })

    it('defaults broker numeric fields to 0 when 0', () => {
      const brokerZero: BrokerResult = {
        profiles: [],
        webrtcSessions: 0,
        rtspRestream: false,
      }
      const result = composeCameraStatus({ ...fullInput(), brokerResult: brokerZero })
      expect(result.broker?.webrtcSessions).toBe(0)
    })

    it('does not throw when source streams is empty', () => {
      const emptySource: SourceResult = { streams: [] }
      expect(() => composeCameraStatus({ ...fullInput(), sourceResult: emptySource })).not.toThrow()
      const result = composeCameraStatus({ ...fullInput(), sourceResult: emptySource })
      expect(result.source.streams).toEqual([])
    })
  })

  describe('fetchedAt passthrough', () => {
    it('stamps fetchedAt exactly as provided', () => {
      const ts = 1_719_000_000_123
      const result = composeCameraStatus({ ...fullInput(), fetchedAt: ts })
      expect(result.fetchedAt).toBe(ts)
    })

    it('stamps fetchedAt = 0 when 0 is passed', () => {
      const result = composeCameraStatus({ ...fullInput(), fetchedAt: 0 })
      expect(result.fetchedAt).toBe(0)
    })
  })

  describe('detection phase passthrough', () => {
    it('passes through phase: idle', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('idle'),
      })
      expect(result.detection?.phase).toBe('idle')
    })

    it('passes through phase: watching', () => {
      const result = composeCameraStatus({
        ...fullInput(),
        detectionResult: makeDetectionResult('watching'),
      })
      expect(result.detection?.phase).toBe('watching')
    })
  })

  describe('output is a plain object (no mutation of input)', () => {
    it('does not modify the input object', () => {
      const input = fullInput()
      const inputCopy = JSON.parse(JSON.stringify(input)) as ComposeInput
      composeCameraStatus(input)
      expect(input).toEqual(inputCopy)
    })
  })

  describe('output schema validity', () => {
    it('output satisfies CameraStatus shape', () => {
      const result: CameraStatus = composeCameraStatus(fullInput())
      // If TypeScript compiles, this shape is satisfied.
      // Runtime check: verify all top-level keys are present.
      expect(Object.keys(result)).toEqual(
        expect.arrayContaining([
          'deviceId',
          'assignment',
          'source',
          'broker',
          'decoder',
          'motion',
          'detection',
          'audio',
          'recording',
          'fetchedAt',
        ]),
      )
    })
  })
})
