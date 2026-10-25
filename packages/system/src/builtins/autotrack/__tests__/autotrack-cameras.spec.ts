/**
 * The per-camera record behind the autotrack switch.
 *
 * The emulated implementation sits behind the EXISTING `ptz-autotrack` switch
 * (D520, D62): binding it to a camera chooses this implementation, and
 * `setEnabled` is the one switch for the function. So this module owns exactly
 * two things — what is persisted per camera, and how the cap's cross-vendor
 * settings become this loop's tuning.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_AUTOTRACK_LOOP_CONFIG } from '../autotrack-config.js'
import {
  DEFAULT_CAMERA_RECORD,
  EMULATED_TARGET_OPTIONS,
  loopConfigFor,
  parseCameraRecords,
  statusFor,
  targetClassFor,
  withCameraPatch,
} from '../autotrack-cameras.js'

describe('parseCameraRecords', () => {
  it('reads nothing out of an empty or malformed blob rather than inventing a camera', () => {
    expect(parseCameraRecords(undefined)).toEqual({})
    expect(parseCameraRecords({})).toEqual({})
    expect(parseCameraRecords({ '1438': 'yes' })).toEqual({})
    expect(parseCameraRecords({ notANumber: { enabled: true } })).toEqual({})
  })

  it('keeps a camera the operator switched on, with its settings', () => {
    const parsed = parseCameraRecords({
      '1438': {
        enabled: true,
        settings: { targetType: 'vehicle', stopDelaySeconds: 20, disappearDelaySeconds: 30 },
      },
    })
    expect(parsed).toEqual({
      1438: {
        enabled: true,
        settings: { targetType: 'vehicle', stopDelaySeconds: 20, disappearDelaySeconds: 30 },
        // The hidden zoom setting is absent until somebody sets it.
        zoom: { targetSubjectFraction: null },
      },
    })
  })

  it('falls back to the default record for a partial one — never drops the camera', () => {
    // A camera the operator switched ON with a half-written settings blob must
    // stay ON: dropping it would silently disarm a function they armed.
    const parsed = parseCameraRecords({ '107': { enabled: true } })
    expect(parsed[107]?.enabled).toBe(true)
    expect(parsed[107]?.settings).toEqual(DEFAULT_CAMERA_RECORD.settings)
  })
})

describe('withCameraPatch', () => {
  it('returns a NEW map and leaves the previous one untouched', () => {
    const before = parseCameraRecords({ '1438': { enabled: false } })
    const after = withCameraPatch(before, 1438, { enabled: true })
    expect(after[1438]?.enabled).toBe(true)
    expect(before[1438]?.enabled).toBe(false)
  })

  it('creates the record for a camera that has none yet', () => {
    const after = withCameraPatch({}, 77, { enabled: true })
    expect(after[77]).toEqual({ ...DEFAULT_CAMERA_RECORD, enabled: true })
  })

  it('merges settings without discarding the ones not being written', () => {
    const after = withCameraPatch({}, 77, { settings: { targetType: 'animal' } })
    expect(after[77]?.settings.targetType).toBe('animal')
    expect(after[77]?.settings.disappearDelaySeconds).toBe(
      DEFAULT_CAMERA_RECORD.settings.disappearDelaySeconds,
    )
  })
})

describe('targetClassFor', () => {
  it('maps the cap’s target string onto a detection macro class', () => {
    expect(targetClassFor({ ...DEFAULT_CAMERA_RECORD.settings, targetType: 'vehicle' })).toBe(
      'vehicle',
    )
    expect(targetClassFor({ ...DEFAULT_CAMERA_RECORD.settings, targetType: 'animal' })).toBe(
      'animal',
    )
  })

  it('treats the camera-default empty string as PERSON, and says so by offering it', () => {
    expect(targetClassFor({ ...DEFAULT_CAMERA_RECORD.settings, targetType: '' })).toBe('person')
    expect(EMULATED_TARGET_OPTIONS.map((o) => o.value)).toEqual(['person', 'vehicle', 'animal'])
  })

  it('refuses a vendor string this pipeline cannot detect', () => {
    // `people` is Reolink's word. The emulated loop follows what the DETECTOR
    // emits, and inventing a mapping would make it silently follow the wrong
    // thing — or nothing, which looks identical.
    expect(targetClassFor({ ...DEFAULT_CAMERA_RECORD.settings, targetType: 'people' })).toBe(
      'person',
    )
  })
})

describe('loopConfigFor', () => {
  it('carries the operator’s disappear delay into the loop, in ms', () => {
    const config = loopConfigFor({
      ...DEFAULT_CAMERA_RECORD.settings,
      disappearDelaySeconds: 25,
    })
    expect(config.disappearDelayMs).toBe(25_000)
  })

  it('leaves every tuning constant D520 kept OUT of the settings alone', () => {
    const config = loopConfigFor(DEFAULT_CAMERA_RECORD.settings)
    expect(config.deadZoneFraction).toBe(DEFAULT_AUTOTRACK_LOOP_CONFIG.deadZoneFraction)
    expect(config.settleZoneFraction).toBe(DEFAULT_AUTOTRACK_LOOP_CONFIG.settleZoneFraction)
    expect(config.maxCommandsPerSecond).toBe(DEFAULT_AUTOTRACK_LOOP_CONFIG.maxCommandsPerSecond)
  })
})

describe('statusFor', () => {
  it('reports the switch and the settings the emulation is really using', () => {
    const status = statusFor(
      { enabled: true, settings: DEFAULT_CAMERA_RECORD.settings, zoom: DEFAULT_CAMERA_RECORD.zoom },
      1234,
    )
    expect(status.enabled).toBe(true)
    expect(status.lastChangedAt).toBe(1234)
    expect(status.currentSettings).toEqual(DEFAULT_CAMERA_RECORD.settings)
    // Honest about what THIS implementation can follow — not a vendor list.
    expect(status.supportedTargetTypes).toEqual(EMULATED_TARGET_OPTIONS)
  })
})
