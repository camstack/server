/**
 * The zoom setting exists, is configurable, is hidden — and does nothing yet.
 *
 * Operator's call (2026-09-18): *"per l'autotrack rendiamo lo zoom
 * configurabile, nascosto per ora, ci lavoriamo poi quando ne vedo il
 * bisogno"* [for autotrack let us make the zoom configurable, hidden for now, we will work on it later when I see the need]. So the number that will drive subject-size control has a home and
 * a persisted value before the control loop that reads it exists.
 *
 * The danger in exactly this shape is the one this repo names repeatedly: a
 * leftover that describes the right design reads as verification. These tests
 * pin the opposite — the setting is absent by default, it never reaches the
 * loop's tuning, and asking for it produces a REFUSAL that says what is
 * missing, not a silent no-op.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMERA_RECORD,
  loopConfigFor,
  parseCameraRecords,
  withCameraPatch,
  zoomRefusalFor,
} from '../autotrack-cameras.js'

describe('the hidden zoom setting', () => {
  it('is absent by default — nothing about zoom is assumed', () => {
    expect(DEFAULT_CAMERA_RECORD.zoom.targetSubjectFraction).toBeNull()
  })

  it('persists a target fraction and reads it back', () => {
    const records = parseCameraRecords({
      '1438': { enabled: true, zoom: { targetSubjectFraction: 0.5 } },
    })
    expect(records[1438]?.zoom.targetSubjectFraction).toBe(0.5)
  })

  it('clamps a nonsense fraction rather than carrying it into a control loop', () => {
    expect(
      parseCameraRecords({ '1': { zoom: { targetSubjectFraction: 4 } } })[1]?.zoom
        .targetSubjectFraction,
    ).toBe(1)
    expect(
      parseCameraRecords({ '1': { zoom: { targetSubjectFraction: -2 } } })[1]?.zoom
        .targetSubjectFraction,
    ).toBeNull()
    expect(
      parseCameraRecords({ '1': { zoom: { targetSubjectFraction: 'half' } } })[1]?.zoom
        .targetSubjectFraction,
    ).toBeNull()
  })

  it('is patchable without disturbing the rest of the record', () => {
    const before = parseCameraRecords({ '7': { enabled: true } })
    const after = withCameraPatch(before, 7, { zoom: { targetSubjectFraction: 0.35 } })
    expect(after[7]?.zoom.targetSubjectFraction).toBe(0.35)
    expect(after[7]?.enabled).toBe(true)
    expect(after[7]?.settings).toEqual(DEFAULT_CAMERA_RECORD.settings)
  })

  it('NEVER reaches the loop tuning — the control loop does not exist yet', () => {
    const config = loopConfigFor(DEFAULT_CAMERA_RECORD.settings)
    expect(Object.keys(config)).not.toContain('zoom')
    expect(JSON.stringify(config)).not.toContain('SubjectFraction')
  })

  it('REFUSES out loud when a camera asks for it', () => {
    expect(
      zoomRefusalFor({ ...DEFAULT_CAMERA_RECORD, zoom: { targetSubjectFraction: null } }),
    ).toBeNull()
    const refusal = zoomRefusalFor({
      ...DEFAULT_CAMERA_RECORD,
      zoom: { targetSubjectFraction: 0.5 },
    })
    expect(refusal).not.toBeNull()
    // It names the number it was given and what is missing — a setting that is
    // read and ignored in silence is indistinguishable from a broken one.
    expect(refusal).toContain('0.5')
    expect(refusal?.toLowerCase()).toContain('not implemented')
  })
})
