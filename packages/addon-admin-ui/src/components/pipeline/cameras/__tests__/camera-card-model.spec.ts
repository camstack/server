import { describe, it, expect } from 'vitest'
import type { CameraStatus, PipelineStepInputOutput } from '@camstack/types'
import {
  cameraSensorsSummary,
  deriveCameraProblems,
  extractOrchestratorCameraSettings,
  flattenPipelineSteps,
} from '../camera-card-model'

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
      sourceNodeId: 'hub',
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
          status: 'streaming',
          codec: 'h264',
          width: 1920,
          height: 1080,
          subscribers: 2,
          inFps: 15,
        },
      ],
      webrtcSessions: 1,
      rtspRestream: true,
    },
    decoder: { nodeId: 'node-a' },
    motion: { enabled: true, fps: 4 },
    detection: {
      nodeId: 'node-a',
      engine: { backend: 'coreml', device: 'ane' },
      phase: 'active',
      configuredFps: 5,
      actualFps: 4.8,
      queueDepth: 0,
      avgInferenceMs: 12,
      provisioning: { state: 'ready' },
    },
    audio: null,
    recording: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// deriveCameraProblems
// ---------------------------------------------------------------------------

describe('deriveCameraProblems', () => {
  it('returns no problems for a healthy camera', () => {
    expect(deriveCameraProblems(makeStatus())).toEqual([])
  })

  it('says so when a stage could not be READ, instead of drawing a conclusion from it', () => {
    // A camera whose switch read timed out arrives with `switchedOff: []` —
    // which, taken at face value, says "the operator turned nothing off" and
    // paints a switched-OFF camera as broken (D62). The card must show the
    // gap as a gap: a warning, not an error, and never silence.
    const problems = deriveCameraProblems(
      makeStatus({
        recording: null,
        degraded: [
          { stage: 'switches', reason: 'timeout', elapsedMs: 3000 },
          { stage: 'recording', reason: 'error', elapsedMs: 12 },
        ],
      }),
    )
    const unreadable = problems.find((p) => p.code === 'status-unreadable')
    expect(unreadable).toBeDefined()
    expect(unreadable?.severity).toBe('warning')
    expect(unreadable?.message).toContain('switches')
    expect(unreadable?.message).toContain('recording')
  })

  it('flags the cross-node black-hole signature (active phase, 0 fps) as an error', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      detection: { ...status.detection!, actualFps: 0 },
    })
    expect(problems.some((p) => p.code === 'detection-black-hole' && p.severity === 'error')).toBe(
      true,
    )
  })

  it('does NOT flag 0 fps when the phase is watching (idle detector is fine)', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      detection: { ...status.detection!, phase: 'watching', actualFps: 0 },
    })
    expect(problems.some((p) => p.code === 'detection-black-hole')).toBe(false)
  })

  it('raises no decoder stall from the decoder block — it carries no frame counter', () => {
    // The shared-memory frame plane is gone (frames live in RAM in the
    // RetainedFrameStore); its counters were a constant 0 and raised "decode
    // path stalled" on every active camera. The decoder block is now WHERE
    // decode runs and nothing else; a stall is read from the frames that
    // actually reach the detector (`detection-black-hole`).
    const problems = deriveCameraProblems(makeStatus({ decoder: { nodeId: 'node-a' } }))
    expect(problems).toEqual([])
  })

  it('reads a stalled decode path from the frames delivered to the detector', () => {
    const status = makeStatus({ decoder: { nodeId: 'node-a' } })
    const problems = deriveCameraProblems({
      ...status,
      detection: { ...status.detection!, actualFps: 0 },
    })
    expect(problems.map((p) => p.code)).toEqual(['detection-black-hole'])
  })

  it('flags provisioning failed with the error detail', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      detection: {
        ...status.detection!,
        provisioning: { state: 'failed', error: 'model download failed' },
      },
    })
    const failure = problems.find((p) => p.code === 'provisioning-failed')
    expect(failure?.severity).toBe('error')
    expect(failure?.message).toContain('model download failed')
  })

  it('flags an unassigned camera as a warning', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      assignment: { ...status.assignment, detectionNodeId: null },
      detection: null,
    })
    expect(problems.some((p) => p.code === 'unassigned' && p.severity === 'warning')).toBe(true)
  })

  it('does NOT call an ARMED on-motion camera unassigned — waiting is not a problem', () => {
    // An `on-motion` camera between motion events has no detection node and no
    // detection block, exactly like a camera nobody ever dispatched. The server
    // now says which it is (`reasons.detection: 'armed:on-motion'`); reporting
    // "no pipeline is running for this camera" against that is the same
    // healthy-reads-as-broken inversion, one surface up.
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      assignment: {
        ...status.assignment,
        detectionNodeId: null,
        reasons: { detection: 'armed:on-motion' },
      },
      detection: null,
    })
    expect(problems.some((p) => p.code === 'unassigned')).toBe(false)
  })

  it('flags a streaming broker profile with 0 in-fps as a warning', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      broker: {
        ...status.broker!,
        profiles: [{ ...status.broker!.profiles[0]!, inFps: 0 }],
      },
    })
    expect(problems.some((p) => p.code === 'broker-stalled' && p.severity === 'warning')).toBe(true)
  })

  it('raises no stall from a broker profile whose in-fps is unknown', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      broker: {
        ...status.broker!,
        profiles: [{ ...status.broker!.profiles[0]!, inFps: null }],
      },
    })
    expect(problems.some((p) => p.code === 'broker-stalled')).toBe(false)
  })

  it('orders errors before warnings', () => {
    const status = makeStatus()
    const problems = deriveCameraProblems({
      ...status,
      detection: { ...status.detection!, actualFps: 0 },
      broker: {
        ...status.broker!,
        profiles: [{ ...status.broker!.profiles[0]!, inFps: 0 }],
      },
    })
    expect(problems.length).toBeGreaterThanOrEqual(2)
    expect(problems[0]!.severity).toBe('error')
    expect(problems[problems.length - 1]!.severity).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// extractOrchestratorCameraSettings
// ---------------------------------------------------------------------------

describe('extractOrchestratorCameraSettings', () => {
  const schema = {
    sections: [
      {
        id: 'motion-tuning',
        fields: [
          {
            key: 'motionSources',
            type: 'multiselect',
            value: ['analyzer', 'onboard'],
            default: ['analyzer'],
          },
          { key: 'motionFps', type: 'slider', value: null, default: 4 },
          { key: 'motionCooldownMs', type: 'slider', value: 45000, default: 30000 },
          { key: 'motionStreamProfile', type: 'select', value: 'low', default: 'low' },
        ],
      },
      {
        id: 'pipeline-object-detection',
        fields: [
          { key: 'detectionMode', type: 'select', value: 'always-on', default: 'on-motion' },
          { key: 'detectionStreamProfile', type: 'select', value: 'high', default: 'high' },
          { key: 'detectionFps', type: 'slider', value: 0, default: 0 },
        ],
      },
      {
        id: 'cluster-assignment',
        fields: [
          { key: 'pipelineNodeId', type: 'select', value: 'node-b', default: 'auto' },
          { key: 'decoderNodeId', type: 'select', value: 'auto', default: 'auto' },
          { key: 'audioNodeId', type: 'select', value: 'auto', default: 'auto' },
        ],
      },
    ],
  }

  it('extracts values and falls back to defaults for null values', () => {
    const settings = extractOrchestratorCameraSettings(schema)
    expect(settings.detectionMode).toBe('always-on')
    expect(settings.motionSources).toEqual(['analyzer', 'onboard'])
    expect(settings.motionFps).toBe(4) // null value → default
    expect(settings.motionCooldownMs).toBe(45000)
    expect(settings.pipelineNodeId).toBe('node-b')
    expect(settings.detectionFps).toBe(0)
  })

  it('reports keys whose value differs from the default as overridden', () => {
    const settings = extractOrchestratorCameraSettings(schema)
    expect(settings.overriddenKeys.has('detectionMode')).toBe(true)
    expect(settings.overriddenKeys.has('motionSources')).toBe(true)
    expect(settings.overriddenKeys.has('motionCooldownMs')).toBe(true)
    expect(settings.overriddenKeys.has('pipelineNodeId')).toBe(true)
    // Matching / null values are NOT overrides.
    expect(settings.overriddenKeys.has('detectionStreamProfile')).toBe(false)
    expect(settings.overriddenKeys.has('detectionFps')).toBe(false)
    expect(settings.overriddenKeys.has('motionFps')).toBe(false)
    expect(settings.overriddenKeys.has('decoderNodeId')).toBe(false)
  })

  it('walks group and sub-tabs containers', () => {
    const nested = {
      sections: [
        {
          id: 's',
          fields: [
            {
              type: 'group',
              fields: [
                { key: 'detectionMode', type: 'select', value: 'disabled', default: 'on-motion' },
              ],
            },
            {
              type: 'sub-tabs',
              tabs: [
                {
                  id: 't',
                  fields: [
                    { key: 'audioMode', type: 'select', value: 'always-on', default: 'always-on' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const settings = extractOrchestratorCameraSettings(nested)
    expect(settings.detectionMode).toBe('disabled')
    expect(settings.audioMode).toBe('always-on')
  })

  it('returns the empty placeholder for null / malformed payloads', () => {
    for (const payload of [null, undefined, 42, 'x', { sections: 'nope' }]) {
      const settings = extractOrchestratorCameraSettings(payload)
      expect(settings.detectionMode).toBeNull()
      expect(settings.motionSources).toEqual([])
      expect(settings.overriddenKeys.size).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// flattenPipelineSteps
// ---------------------------------------------------------------------------

describe('flattenPipelineSteps', () => {
  it('flattens a nested step tree with depth annotations', () => {
    const steps: readonly PipelineStepInputOutput[] = [
      {
        addonId: 'object-detection',
        modelId: 'yolov9s',
        enabled: true,
        children: [
          { addonId: 'face-recognition', modelId: 'scrfd', enabled: true },
          { addonId: 'plate-recognition', enabled: false },
        ],
      },
    ]
    const flat = flattenPipelineSteps(steps)
    expect(flat).toEqual([
      { addonId: 'object-detection', modelId: 'yolov9s', enabled: true, depth: 0 },
      { addonId: 'face-recognition', modelId: 'scrfd', enabled: true, depth: 1 },
      { addonId: 'plate-recognition', modelId: null, enabled: false, depth: 1 },
    ])
  })

  it('returns an empty list for no steps', () => {
    expect(flattenPipelineSteps([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Camera sensors (D672)
// ---------------------------------------------------------------------------

const PIR_REF = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:porch-pir',
  mode: 'in-addition',
} as const

describe('camera sensors — problems and summary (D672)', () => {
  it('names an offline attached sensor as a warning', () => {
    const problems = deriveCameraProblems(
      makeStatus({
        cameraSensors: {
          state: 'configured',
          sensors: [
            { ...PIR_REF, state: 'offline', deviceId: 3299, name: 'Motion', reason: 'offline' },
          ],
        },
      }),
    )
    expect(problems).toContainEqual({
      code: 'camera-sensor-offline',
      severity: 'warning',
      message: 'Camera sensor Motion (#3299) is offline',
    })
  })

  it('a READY sensor that can never fire is a warning, naming why (D672, review M-3)', () => {
    const ready = {
      ...PIR_REF,
      state: 'ready' as const,
      deviceId: 3299,
      name: 'Motion',
      caps: ['motion'],
    }
    const forCameraWith = (notForwarded?: 'onboard-not-listed' | 'no-active-detection') =>
      deriveCameraProblems(
        makeStatus({
          cameraSensors: {
            state: 'configured',
            sensors: [ready],
            ...(notForwarded !== undefined ? { notForwarded } : {}),
          },
        }),
      ).filter((p) => p.code === 'camera-sensors-not-forwarded')
    expect(forCameraWith()).toEqual([])
    expect(forCameraWith('onboard-not-listed')).toEqual([
      {
        code: 'camera-sensors-not-forwarded',
        severity: 'warning',
        message:
          'Camera sensors are attached but never fire: add "Camera sensors" (onboard) to this camera\'s motion sources',
      },
    ])
    expect(forCameraWith('no-active-detection')).toEqual([
      {
        code: 'camera-sensors-not-forwarded',
        severity: 'warning',
        message: 'Camera sensors are attached but never fire: this camera has no active detection',
      },
    ])
  })

  it('names every other attachment fault, one warning each', () => {
    const problems = deriveCameraProblems(
      makeStatus({
        cameraSensors: {
          state: 'configured',
          sensors: [
            { ...PIR_REF, state: 'ready', deviceId: 3299, name: 'Motion', caps: ['motion'] },
            {
              addonId: 'ha-x',
              stableId: 'ha:gone',
              mode: 'in-addition',
              state: 'missing',
              reason: 'not found',
            },
            {
              addonId: 'provider-reolink',
              stableId: 'cam-2',
              mode: 'in-addition',
              state: 'unsupported',
              deviceId: 12,
              name: 'Garage',
              reason: 'a camera is never an input',
            },
            {
              addonId: 'ha-y',
              stableId: 'ha:unk',
              mode: 'in-addition',
              state: 'unreadable',
              reason: 'listAll timed out',
            },
            {
              addonId: 'ha-z',
              stableId: 'ha:off',
              mode: 'in-addition',
              state: 'offline',
              deviceId: 77,
              name: 'Door',
              reason: 'disabled',
            },
          ],
        },
      }),
    )
    expect(problems).toEqual([
      {
        code: 'camera-sensor-missing',
        severity: 'warning',
        message: 'Camera sensor ha-x/ha:gone is missing',
      },
      {
        code: 'camera-sensor-unsupported',
        severity: 'warning',
        message: 'Camera sensor Garage (#12) cannot drive motion: a camera is never an input',
      },
      {
        code: 'camera-sensor-unreadable',
        severity: 'warning',
        message: 'Camera sensor ha-y/ha:unk is unreadable: listAll timed out',
      },
      {
        code: 'camera-sensor-offline',
        severity: 'warning',
        message: 'Camera sensor Door (#77) is disabled',
      },
    ])
  })

  it('a mapping that could not be read is a warning', () => {
    expect(
      deriveCameraProblems(
        makeStatus({ cameraSensors: { state: 'unreadable', reason: 'settings read failed' } }),
      ),
    ).toEqual([
      {
        code: 'camera-sensors-unreadable',
        severity: 'warning',
        message: 'Camera sensors unreadable: settings read failed',
      },
    ])
  })

  it('the boot window is not a problem; an older node is not a problem', () => {
    expect(
      deriveCameraProblems(
        makeStatus({
          cameraSensors: { state: 'unreadable', reason: 'camera sensor mappings not loaded' },
        }),
      ),
    ).toEqual([])
    expect(deriveCameraProblems(makeStatus())).toEqual([])
  })

  it('summary distinguishes none attached, unknown and unavailable', () => {
    expect(cameraSensorsSummary({ state: 'not-configured' })).toBe('none attached')
    expect(cameraSensorsSummary(undefined)).toBe('status unavailable from this node')
    expect(cameraSensorsSummary({ state: 'unreadable', reason: 'x' })).toBe('unknown — x')
  })

  it('summary names each sensor`s mode; in addition says nothing extra (D673)', () => {
    expect(
      cameraSensorsSummary({
        state: 'configured',
        sensors: [
          { ...PIR_REF, mode: 'confirm', state: 'ready', deviceId: 1, name: 'A', caps: ['motion'] },
          {
            ...PIR_REF,
            mode: 'replace',
            state: 'offline',
            deviceId: 2,
            name: 'B',
            reason: 'offline',
          },
          { ...PIR_REF, state: 'ready', deviceId: 3, name: 'C', caps: ['motion'] },
          { ...PIR_REF, mode: 'confirm', state: 'missing', reason: 'gone' },
        ],
      }),
    ).toBe(
      'A (#1) · confirm, B (#2) — offline · replace, C (#3), provider-homeassistant/ha:porch-pir — missing · confirm',
    )
  })

  it('a provider that cannot split its motion is a warning; no warning when notEnforced is absent (D673 C13)', () => {
    const forCameraWith = (notEnforced?: 'provider-not-split') =>
      deriveCameraProblems(
        makeStatus({
          cameraSensors: {
            state: 'configured',
            sensors: [{ ...PIR_REF, state: 'ready', deviceId: 1, name: 'A', caps: ['motion'] }],
            cameraMotion: 'never',
            ...(notEnforced !== undefined ? { notEnforced } : {}),
          },
        }),
      ).filter((p) => p.code === 'camera-sensors-not-enforced')
    expect(forCameraWith()).toEqual([])
    expect(forCameraWith('provider-not-split')).toEqual([
      {
        code: 'camera-sensors-not-enforced',
        severity: 'warning',
        message:
          "Confirm / Replace cannot suppress this camera's own motion until its provider is updated",
      },
    ])
  })

  it('summary names each attachment', () => {
    expect(
      cameraSensorsSummary({
        state: 'configured',
        sensors: [
          { ...PIR_REF, state: 'ready', deviceId: 3299, name: 'Motion', caps: ['motion'] },
          { ...PIR_REF, state: 'offline', deviceId: 3, name: 'Door', reason: 'offline' },
          { ...PIR_REF, state: 'unsupported', deviceId: 4, name: 'Cam', reason: 'camera' },
          {
            addonId: 'ha-x',
            stableId: 'ha:gone',
            mode: 'in-addition',
            state: 'missing',
            reason: 'gone',
          },
        ],
      }),
    ).toBe('Motion (#3299), Door (#3) — offline, Cam (#4) — unsupported, ha-x/ha:gone — missing')
  })
})
