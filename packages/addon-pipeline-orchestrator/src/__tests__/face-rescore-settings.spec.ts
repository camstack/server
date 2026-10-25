/**
 * The cadence of the automatic face rescore (D866) is ONE cluster-wide knob on
 * the orchestrator's global settings, read by pipeline-analytics through the
 * hub-routed settings cap. These tests pin the key, the default, and the
 * meaning of 0 / small values — the reader and the writer share one definition.
 */
import { describe, expect, it } from 'vitest'
import {
  FACE_RESCORE_INTERVAL_KEY,
  FACE_RESCORE_SECTION_ID,
  pickFaceRescoreIntervalMinutes,
  readFaceRescoreIntervalMinutes,
} from '@camstack/types'
import { buildGlobalSettingsSections } from '../settings-ui-schemas.js'

describe('face rescore interval setting', () => {
  it('is a cluster-wide slider in the orchestrator schema, default 60, 0 allowed', () => {
    const section = buildGlobalSettingsSections({ fpsMinThresholdDefault: 0 }).find(
      (s) => s.id === FACE_RESCORE_SECTION_ID,
    )
    expect(section).toBeDefined()
    const field = section!.fields.find((f) => f.key === FACE_RESCORE_INTERVAL_KEY)
    expect(field).toMatchObject({ type: 'slider', min: 0, default: 60 })
  })

  it.each([
    [0, 0],
    [1, 10],
    [9, 10],
    [10, 10],
    [60, 60],
    [100_000, 1440],
    [undefined, 60],
    ['soon', 60],
    [-5, 60],
    [Number.NaN, 60],
  ])('reads %s as %s minutes', (stored, minutes) => {
    expect(readFaceRescoreIntervalMinutes(stored)).toBe(minutes)
  })

  it('picks the value out of a hydrated payload; a mid-boot (null) payload is the default', () => {
    const view = {
      sections: [
        {
          fields: [
            { key: 'other', value: 3 },
            { key: FACE_RESCORE_INTERVAL_KEY, value: 0 },
          ],
        },
      ],
    }
    expect(pickFaceRescoreIntervalMinutes(view)).toBe(0)
    expect(pickFaceRescoreIntervalMinutes(null)).toBe(60)
    expect(pickFaceRescoreIntervalMinutes({ sections: [] })).toBe(60)
  })
})
