import { NC_CONDITION_CATALOG } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  assertSupportedConditions,
  evaluateGate,
  OSD_SUPPORTED_CONDITIONS,
  unsupportedConditionKeys,
} from '../gate.js'

const NEVER = (): string | undefined => undefined

describe('OSD_SUPPORTED_CONDITIONS', () => {
  it('names only ids that exist in the shared notification catalog', () => {
    const known = new Set(NC_CONDITION_CATALOG.map((d) => d.id))
    for (const id of OSD_SUPPORTED_CONDITIONS) expect(known).toContain(id)
  })
})

describe('unsupportedConditionKeys', () => {
  it('is empty for no conditions at all', () => {
    expect(unsupportedConditionKeys(undefined)).toEqual([])
  })

  it('accepts the supported set', () => {
    expect(
      unsupportedConditionKeys({ devices: [1], deviceState: { deviceId: 2, states: ['on'] } }),
    ).toEqual([])
  })

  it('names a condition the overlay gate has no facts for', () => {
    expect(unsupportedConditionKeys({ classes: ['person'] })).toEqual(['classes'])
  })

  it('ignores an empty list — an absent group is not a condition', () => {
    expect(unsupportedConditionKeys({ classes: [] })).toEqual([])
  })
})

describe('assertSupportedConditions', () => {
  it('throws NAMING the offending condition, so the operator can fix it', () => {
    expect(() => assertSupportedConditions({ minConfidence: 0.7 })).toThrow(/minConfidence/)
  })

  it('lists what IS supported in the same message', () => {
    expect(() => assertSupportedConditions({ zonesExclude: ['a'] })).toThrow(/deviceState/)
  })

  it('passes a supported binding', () => {
    expect(() => assertSupportedConditions({ devices: [7] })).not.toThrow()
  })
})

describe('evaluateGate', () => {
  const AT = Date.UTC(2026, 7, 7, 9, 0, 0)

  it('is open with no schedule and no conditions', () => {
    expect(evaluateGate({ cameraDeviceId: 1, atMs: AT, deviceState: NEVER })).toEqual({
      open: true,
    })
  })

  it('closes outside the schedule and names it', () => {
    const result = evaluateGate({
      cameraDeviceId: 1,
      atMs: AT,
      // Friday 2026-08-07 is day 5; window is Monday only.
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 1439 }], timezone: 'UTC' },
      deviceState: NEVER,
    })
    expect(result).toEqual({ open: false, failedCondition: 'schedule' })
  })

  it('opens inside the schedule', () => {
    const result = evaluateGate({
      cameraDeviceId: 1,
      atMs: AT,
      schedule: { windows: [{ days: [5], startMinute: 480, endMinute: 1080 }], timezone: 'UTC' },
      deviceState: NEVER,
    })
    expect(result.open).toBe(true)
  })

  it('closes when the camera is out of the device scope', () => {
    expect(
      evaluateGate({
        cameraDeviceId: 9,
        atMs: AT,
        conditions: { devices: [1, 2] },
        deviceState: NEVER,
      }),
    ).toEqual({ open: false, failedCondition: 'devices' })
  })

  it('opens on a matching device state', () => {
    const result = evaluateGate({
      cameraDeviceId: 1,
      atMs: AT,
      conditions: { deviceState: { deviceId: 50, states: ['armed_away', 'armed_home'] } },
      deviceState: (id) => (id === 50 ? 'armed_away' : undefined),
    })
    expect(result.open).toBe(true)
  })

  it('fails CLOSED on an unreadable device — a state we cannot read is not a match', () => {
    const result = evaluateGate({
      cameraDeviceId: 1,
      atMs: AT,
      conditions: { deviceState: { deviceId: 50, states: ['armed_away'] } },
      deviceState: NEVER,
    })
    expect(result).toEqual({ open: false, failedCondition: 'deviceState' })
  })

  it('reports the FIRST failing group, schedule before conditions', () => {
    const result = evaluateGate({
      cameraDeviceId: 9,
      atMs: AT,
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 60 }], timezone: 'UTC' },
      conditions: { devices: [1] },
      deviceState: NEVER,
    })
    expect(result.failedCondition).toBe('schedule')
  })
})
