import { describe, expect, it } from 'vitest'
import {
  MOTION_SOURCE_LABELS,
  MotionEventSchema,
  MotionOnMotionChangedDataSchema,
  MotionSourceEnum,
  motionSourceLabel,
} from '../../capabilities/index.js'
import { RunnerCameraDeviceUIFields } from '../../capabilities/pipeline-runner.cap.js'
import {
  CameraSensorsConfigSchema,
  CameraSensorsStatusSchema,
  MAX_CAMERA_SENSORS,
  readMotionTriggeredBy,
} from '../camera-sensors.js'

const PIR = {
  addonId: 'provider-homeassistant',
  stableId:
    'ha:ha_001:dev:45269aa68c25b3951b36c83fdd1f87ce-binary_sensor.sensore_movimento_porch_motion',
}

describe('camera sensors config (D672, D673)', () => {
  it('a CS-1 row reads as in-addition sensors, and its envelope mode is dropped (C1)', () => {
    expect(CameraSensorsConfigSchema.parse({ mode: 'in-addition', sensors: [PIR] })).toEqual({
      sensors: [{ ...PIR, mode: 'in-addition' }],
    })
  })
  it.each([
    'in-addition',
    'confirm',
    'replace',
  ] as const)('accepts the per-sensor mode %s', (mode) => {
    expect(CameraSensorsConfigSchema.parse({ sensors: [{ ...PIR, mode }] }).sensors[0]?.mode).toBe(
      mode,
    )
  })
  it('refuses a mode that does not exist', () => {
    expect(
      CameraSensorsConfigSchema.safeParse({ sensors: [{ ...PIR, mode: 'sometimes' }] }).success,
    ).toBe(false)
  })
  it('refuses an empty list, a duplicate ref whatever its modes, and an oversized list', () => {
    expect(CameraSensorsConfigSchema.safeParse({ sensors: [] }).success).toBe(false)
    expect(
      CameraSensorsConfigSchema.safeParse({
        sensors: [
          { ...PIR, mode: 'replace' },
          { ...PIR, mode: 'confirm' },
        ],
      }).success,
    ).toBe(false)
    const many = Array.from({ length: MAX_CAMERA_SENSORS + 1 }, (_, i) => ({
      addonId: 'a',
      stableId: `s${i}`,
    }))
    expect(CameraSensorsConfigSchema.safeParse({ sensors: many }).success).toBe(false)
  })
  it('refuses a numeric id in place of a stable ref', () => {
    expect(CameraSensorsConfigSchema.safeParse({ sensors: [3299] }).success).toBe(false)
  })
})

describe('camera sensors status (D673)', () => {
  it('a CS-1 orchestrator`s status reads as in-addition attachments, with NO cameraMotion (D315: it does not say)', () => {
    const status = CameraSensorsStatusSchema.parse({
      state: 'configured',
      mode: 'in-addition',
      sensors: [{ ...PIR, state: 'ready', deviceId: 3299, name: 'PIR', caps: ['motion'] }],
    })
    expect(
      status.state === 'configured' ? [status.sensors[0]?.mode, status.cameraMotion] : null,
    ).toEqual(['in-addition', undefined])
  })
  it('a CS-2 status carries the per-sensor mode, cameraMotion and notEnforced', () => {
    const status = CameraSensorsStatusSchema.parse({
      state: 'configured',
      cameraMotion: 'never',
      notEnforced: 'provider-not-split',
      sensors: [
        { ...PIR, mode: 'replace', state: 'ready', deviceId: 3299, name: 'PIR', caps: ['motion'] },
      ],
    })
    expect(status).toMatchObject({
      cameraMotion: 'never',
      notEnforced: 'provider-not-split',
      sensors: [{ mode: 'replace' }],
    })
  })
})

describe('trigger provenance (D672)', () => {
  it('reads absent as the camera, not malformed', () => {
    expect(readMotionTriggeredBy(undefined)).toEqual({
      triggeredBy: { kind: 'camera' },
      malformed: false,
    })
  })
  it('reads a present-but-invalid value as the camera AND says so', () => {
    expect(readMotionTriggeredBy({ kind: 'sensor', deviceId: '3299' })).toEqual({
      triggeredBy: { kind: 'camera' },
      malformed: true,
    })
  })
  it('keeps a valid sensor trigger', () => {
    expect(readMotionTriggeredBy({ kind: 'sensor', deviceId: 3299 }).triggeredBy).toEqual({
      kind: 'sensor',
      deviceId: 3299,
    })
  })
  it('round-trips on the wire and on the row; a legacy payload still parses', () => {
    const wire = {
      deviceId: 103,
      detected: true,
      timestamp: 1,
      source: 'onboard',
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
    }
    expect(MotionOnMotionChangedDataSchema.parse(wire).triggeredBy).toEqual({
      kind: 'sensor',
      deviceId: 3299,
    })
    expect(
      MotionOnMotionChangedDataSchema.parse({ ...wire, triggeredBy: undefined }).triggeredBy,
    ).toBeUndefined()
    const row = {
      id: 1,
      deviceId: 103,
      timestamp: 1,
      kind: 'motion',
      regionCount: 0,
      durationMs: null,
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
    }
    expect(MotionEventSchema.parse(row).triggeredBy).toEqual({ kind: 'sensor', deviceId: 3299 })
  })
})

describe('the onboard motion source reads "Camera sensors" (D672)', () => {
  it('labels only the motion-source onboard as Camera sensors', () => {
    const field = RunnerCameraDeviceUIFields.find((f) => f.key === 'motionSources')
    const options = field && 'options' in field ? field.options : []
    expect(options).toContainEqual({
      value: 'onboard',
      label: 'Camera sensors',
      description: "The camera's own motion, plus any sensor attached to it",
    })
    // The root-detector pick is not a field of this list any more: it is the
    // first control of the Steps editor (one authority, one control).
    expect(RunnerCameraDeviceUIFields.find((f) => f.key === 'detectionSources')).toBeUndefined()
    expect(motionSourceLabel('newer-node-source')).toBe('newer-node-source')
    expect(motionSourceLabel('onboard')).toBe('Camera sensors')
  })

  it('keeps the operator-facing order and offers every motion source', () => {
    const field = RunnerCameraDeviceUIFields.find((f) => f.key === 'motionSources')
    const options = field && 'options' in field ? (field.options ?? []) : []
    expect(options.map((o) => o.value)).toEqual(['analyzer', 'onboard', 'device-activity'])
    expect([...options.map((o) => o.value)].sort()).toEqual([...MotionSourceEnum.options].sort())
    expect(options.map((o) => o.label)).toEqual(
      options.map((o) => MOTION_SOURCE_LABELS[MotionSourceEnum.parse(o.value)]),
    )
  })
})
