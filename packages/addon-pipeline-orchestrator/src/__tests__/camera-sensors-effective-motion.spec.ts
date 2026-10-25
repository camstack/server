/**
 * D673's combining rule, as a truth table — the controller's ruling on Q1
 * (2026-10-01, spec C2): a Confirm sensor GATES the camera's own motion even
 * without a Replace sensor.
 *
 *   motion = A ∨ R ∨ (camera ∧ C) ∨ (camera ∧ no ready Replace ∧ no ready Confirm)
 *
 * cameraMotion: `always` (no ready Replace, no ready Confirm), `when-confirmed`
 * (a ready Confirm, with or without a ready Replace), `never` (a ready Replace,
 * no ready Confirm). The operator's original formula (2026-09-30) made a lone
 * Confirm a no-op; the ruling is reversible in one function.
 */
import type { CameraSensorMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  cameraOwnMotionRule,
  type EffectiveMotionInput,
  effectiveMotion,
  type SensorInputState,
  sensorActive,
} from '../camera-sensors/effective-motion.js'

const NOW = 1_790_000_000_000
const COOLDOWN = 30_000
const MAX_HOLD = 120_000

function sensor(mode: CameraSensorMode, over: Partial<SensorInputState> = {}): SensorInputState {
  return { mode, ready: true, high: false, lastRiseAt: null, lastFallAt: null, ...over }
}
const high = (mode: CameraSensorMode, ageMs = 1_000, over: Partial<SensorInputState> = {}) =>
  sensor(mode, { high: true, lastRiseAt: NOW - ageMs, ...over })
const camera = (ageMs: number | null, detected = true) =>
  ageMs === null ? null : { detected, atMs: NOW - ageMs }

function run(cam: ReturnType<typeof camera>, sensors: readonly SensorInputState[]) {
  const input: EffectiveMotionInput = {
    now: NOW,
    cooldownMs: COOLDOWN,
    maxHoldMs: MAX_HOLD,
    camera: cam,
    sensors,
  }
  return effectiveMotion(input)
}

describe('cameraOwnMotionRule — only READY sensors reshape the camera (C3)', () => {
  it.each([
    [[], 'always'],
    [[sensor('in-addition')], 'always'],
    [[sensor('confirm')], 'when-confirmed'],
    [[sensor('confirm', { ready: false })], 'always'],
    [[sensor('in-addition'), sensor('confirm')], 'when-confirmed'],
    [[sensor('replace')], 'never'],
    [[sensor('replace'), sensor('confirm')], 'when-confirmed'],
    [[sensor('replace', { ready: false })], 'always'],
    [[sensor('replace'), sensor('confirm', { ready: false })], 'never'],
  ] as const)('%j → %s', (sensors, expected) => {
    expect(cameraOwnMotionRule(sensors)).toBe(expected)
  })
})

describe('sensorActive (C4, C5)', () => {
  it('a high level counts only within maxSessionHoldMs of its last real rise', () => {
    expect(sensorActive(high('in-addition', 119_000), NOW, COOLDOWN, MAX_HOLD)).toBe(true)
    expect(sensorActive(high('in-addition', 120_000), NOW, COOLDOWN, MAX_HOLD)).toBe(false)
  })
  it('a level seeded high with no rise (a stale first sighting) never counts', () => {
    expect(
      sensorActive(sensor('replace', { high: true, lastRiseAt: null }), NOW, COOLDOWN, MAX_HOLD),
    ).toBe(false)
  })
  it('a Confirm sensor keeps counting for one cooldown after it fell; the other modes do not', () => {
    expect(
      sensorActive(sensor('confirm', { lastFallAt: NOW - 5_000 }), NOW, COOLDOWN, MAX_HOLD),
    ).toBe(true)
    expect(
      sensorActive(sensor('confirm', { lastFallAt: NOW - 31_000 }), NOW, COOLDOWN, MAX_HOLD),
    ).toBe(false)
    expect(
      sensorActive(sensor('in-addition', { lastFallAt: NOW - 5_000 }), NOW, COOLDOWN, MAX_HOLD),
    ).toBe(false)
  })
})

describe('effectiveMotion — the approved rule (C2)', () => {
  it('no sensors: the camera alone, heartbeat-only cameras bounded by the cooldown (D672 rule 8)', () => {
    expect(run(camera(1_000), [])).toMatchObject({
      high: true,
      support: ['camera'],
      cameraDropped: null,
    })
    expect(run(camera(31_000), [])).toMatchObject({ high: false, support: [], cameraDropped: null })
    expect(run(camera(1_000, false), []).high).toBe(false)
  })
  it('In addition: camera OR sensor', () => {
    expect(run(camera(null), [high('in-addition')])).toMatchObject({
      high: true,
      support: ['in-addition'],
    })
    expect(run(camera(1_000), [sensor('in-addition')])).toMatchObject({
      high: true,
      support: ['camera'],
    })
  })
  it('Replace: the sensor counts, the camera alone does not', () => {
    expect(run(camera(1_000), [sensor('replace')])).toMatchObject({
      high: false,
      cameraMotion: 'never',
      cameraDropped: 'replaced',
    })
    expect(run(camera(null), [high('replace')])).toMatchObject({ high: true, support: ['replace'] })
  })
  it('Replace that is not ready hands the camera back (D663 hand-back, C3)', () => {
    expect(run(camera(1_000), [sensor('replace', { ready: false })])).toMatchObject({
      high: true,
      support: ['camera'],
      cameraMotion: 'always',
    })
  })
  it('Replace + Confirm: camera AND confirm counts; camera alone is dropped as not confirmed', () => {
    expect(run(camera(1_000), [sensor('replace'), high('confirm')])).toMatchObject({
      high: true,
      support: ['camera-confirmed'],
      cameraMotion: 'when-confirmed',
    })
    expect(run(camera(1_000), [sensor('replace'), sensor('confirm')])).toMatchObject({
      high: false,
      cameraDropped: 'not-confirmed',
    })
    expect(
      run(camera(1_000), [sensor('replace'), sensor('confirm', { lastFallAt: NOW - 5_000 })]),
    ).toMatchObject({ high: true, support: ['camera-confirmed'] })
  })
  it('a Confirm sensor alone is not motion; the camera must be high too', () => {
    expect(run(camera(null), [sensor('replace'), high('confirm')])).toMatchObject({
      high: false,
      cameraDropped: null,
    })
  })
  it('Q1 ruling: a Confirm sensor GATES the camera even without a Replace sensor', () => {
    expect(run(camera(1_000), [sensor('confirm')])).toMatchObject({
      high: false,
      cameraMotion: 'when-confirmed',
      cameraDropped: 'not-confirmed',
    })
    expect(run(camera(1_000), [high('confirm')])).toMatchObject({
      high: true,
      support: ['camera-confirmed'],
      cameraMotion: 'when-confirmed',
      cameraDropped: null,
    })
    expect(run(camera(1_000), [sensor('confirm', { lastFallAt: NOW - 5_000 })])).toMatchObject({
      high: true,
      support: ['camera-confirmed'],
    })
    expect(run(camera(null), [high('confirm')])).toMatchObject({ high: false, cameraDropped: null })
  })
  it('a lone Confirm that is not ready hands the camera back (C3)', () => {
    expect(run(camera(1_000), [sensor('confirm', { ready: false })])).toMatchObject({
      high: true,
      support: ['camera'],
      cameraMotion: 'always',
    })
  })
  it('In addition + Confirm: the in-addition sensor still counts on its own; the camera needs the confirm', () => {
    expect(run(camera(1_000), [high('in-addition'), sensor('confirm')])).toMatchObject({
      high: true,
      support: ['in-addition'],
      cameraDropped: 'not-confirmed',
    })
  })
  it('a Confirm sensor that is not ready confirms nothing', () => {
    expect(
      run(camera(1_000), [sensor('replace'), high('confirm', 1_000, { ready: false })]),
    ).toMatchObject({ high: false, cameraDropped: 'replaced' })
  })
  it('the terms add up: a dropped camera beside an active In-addition sensor is still motion, and still said', () => {
    expect(run(camera(1_000), [sensor('replace'), high('in-addition')])).toMatchObject({
      high: true,
      support: ['in-addition'],
      cameraDropped: 'replaced',
    })
  })
  it('a stuck Replace sensor stops counting but still replaces (it is ready)', () => {
    expect(run(camera(1_000), [high('replace', 125_000)])).toMatchObject({
      high: false,
      cameraDropped: 'replaced',
    })
  })

  describe('effectiveMotion — the rows a wrong implementation could slip past (task 10 review)', () => {
    it('a stuck Confirm stops confirming but still gates the camera (C5, M1)', () => {
      expect(sensorActive(high('confirm', 120_000), NOW, COOLDOWN, MAX_HOLD)).toBe(false)
      expect(run(camera(1_000), [high('confirm', 125_000)])).toMatchObject({
        high: false,
        cameraMotion: 'when-confirmed',
        cameraDropped: 'not-confirmed',
      })
    })
    it('a camera that is low — stale or detected:false — is never reported dropped (C9, M2)', () => {
      expect(run(camera(31_000), [sensor('replace')])).toMatchObject({
        high: false,
        cameraDropped: null,
      })
      expect(run(camera(1_000, false), [sensor('confirm')])).toMatchObject({
        high: false,
        cameraDropped: null,
      })
    })
    it('windows are strict at their bounds: the camera cooldown and the Confirm post-fall window (L1)', () => {
      expect(run(camera(COOLDOWN), []).high).toBe(false)
      expect(run(camera(COOLDOWN - 1), []).high).toBe(true)
      expect(
        sensorActive(sensor('confirm', { lastFallAt: NOW - COOLDOWN }), NOW, COOLDOWN, MAX_HOLD),
      ).toBe(false)
      expect(
        sensorActive(
          sensor('confirm', { lastFallAt: NOW - COOLDOWN + 1 }),
          NOW,
          COOLDOWN,
          MAX_HOLD,
        ),
      ).toBe(true)
    })
    it('support names each term once, in order in-addition, replace, camera (L2)', () => {
      expect(
        run(camera(1_000), [
          high('in-addition'),
          high('in-addition'),
          high('replace'),
          high('confirm'),
        ]).support,
      ).toEqual(['in-addition', 'replace', 'camera-confirmed'])
    })
    it('an ACTIVE In-addition / Replace sensor counts whatever its readiness — readiness only reshapes the camera (L3)', () => {
      expect(run(camera(null), [high('replace', 1_000, { ready: false })])).toMatchObject({
        high: true,
        support: ['replace'],
      })
      expect(run(camera(null), [high('in-addition', 1_000, { ready: false })])).toMatchObject({
        high: true,
        support: ['in-addition'],
      })
    })
    it.each([
      [[sensor('replace', { ready: false }), sensor('confirm')], 'when-confirmed'],
      [[sensor('replace'), sensor('replace', { ready: false })], 'never'],
      [[sensor('confirm'), sensor('confirm', { ready: false })], 'when-confirmed'],
    ] as const)('the rule over mixed readiness (L4): %j → %s', (sensors, expected) => {
      expect(cameraOwnMotionRule(sensors)).toBe(expected)
    })
  })
})
