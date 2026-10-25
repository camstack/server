/**
 * D706: the per-mode alarm notification switches. Both default OFF, are stored on the mode's
 * entry like its delays, and travel as per-field edits (`null` clears).
 */
import { describe, expect, it } from 'vitest'
import type { NcAlarmSettings } from '../../capabilities/notification-rules.cap.js'
import {
  NcAlarmModeDelaysEditSchema,
  NcAlarmSettingsSchema,
} from '../../capabilities/notification-rules.cap.js'
import {
  alarmPatchLanded,
  applyModeDelaysEdits,
  NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
  resolveModeNotifyPolicy,
} from '../alarm-settings.js'

const BASE: NcAlarmSettings = {
  exitDelaySec: 30,
  entryDelaySec: 30,
  triggeredDurationSec: 30,
  announceTargets: [],
  nonBlocking: [],
  blocking: [],
  secureOnArmOff: [],
  modeDelays: [],
}

describe('resolveModeNotifyPolicy (D706)', () => {
  it('a mode that sets nothing has every switch OFF', () => {
    expect(resolveModeNotifyPolicy(BASE, 'away')).toEqual({
      notifyDuringEntryDelay: false,
      notifySensorRewatched: false,
      notifySensorIgnored: false,
    })
  })

  it('an answer from an older hub (no modeDelays) reads as off', () => {
    expect(resolveModeNotifyPolicy({}, 'night').notifyDuringEntryDelay).toBe(false)
  })

  it('reads the mode its own switches, never another mode', () => {
    const settings: NcAlarmSettings = {
      ...BASE,
      modeDelays: [{ mode: 'away', notifyDuringEntryDelay: true }],
    }
    expect(resolveModeNotifyPolicy(settings, 'away').notifyDuringEntryDelay).toBe(true)
    expect(resolveModeNotifyPolicy(settings, 'home').notifyDuringEntryDelay).toBe(false)
  })
})

describe('the switches as edits (D706)', () => {
  it('true sets, null clears, and a cleared-only entry is dropped', () => {
    const on = applyModeDelaysEdits([], [{ mode: 'away', notifySensorRewatched: true }])
    expect(on).toEqual([{ mode: 'away', notifySensorRewatched: true }])
    const off = applyModeDelaysEdits(on, [{ mode: 'away', notifySensorRewatched: null }])
    expect(off).toEqual([])
  })

  it('"notify ignored sensors" (D735) sets and clears like the others, and is read per mode', () => {
    const on = applyModeDelaysEdits([], [{ mode: 'night', notifySensorIgnored: true }])
    expect(on).toEqual([{ mode: 'night', notifySensorIgnored: true }])
    expect(resolveModeNotifyPolicy({ modeDelays: on }, 'night').notifySensorIgnored).toBe(true)
    expect(resolveModeNotifyPolicy({ modeDelays: on }, 'away').notifySensorIgnored).toBe(false)
    expect(applyModeDelaysEdits(on, [{ mode: 'night', notifySensorIgnored: null }])).toEqual([])
    expect(NcAlarmModeDelaysEditSchema.parse({ mode: 'night', notifySensorIgnored: true })).toEqual(
      { mode: 'night', notifySensorIgnored: true },
    )
  })

  it('an edit of one switch keeps the mode its delays', () => {
    const out = applyModeDelaysEdits(
      [{ mode: 'away', entryDelaySec: 30 }],
      [{ mode: 'away', notifyDuringEntryDelay: true }],
    )
    expect(out).toEqual([{ mode: 'away', entryDelaySec: 30, notifyDuringEntryDelay: true }])
  })

  it('a host that dropped the switch did not land the patch', () => {
    const patch = { modeDelays: [{ mode: 'away' as const, notifyDuringEntryDelay: true }] }
    expect(alarmPatchLanded(patch, BASE)).toBe(false)
    expect(
      alarmPatchLanded(patch, {
        ...BASE,
        modeDelays: [{ mode: 'away', notifyDuringEntryDelay: true }],
      }),
    ).toBe(true)
  })

  it('the schemas accept the switches and a stored blob without them', () => {
    expect(
      NcAlarmModeDelaysEditSchema.parse({ mode: 'home', notifyDuringEntryDelay: null }),
    ).toEqual({ mode: 'home', notifyDuringEntryDelay: null })
    const parsed = NcAlarmSettingsSchema.parse({ ...BASE, modeDelays: [{ mode: 'away' }] })
    expect(resolveModeNotifyPolicy(parsed, 'away').notifySensorRewatched).toBe(false)
  })
})

describe('the stock after-trigger duration (D706)', () => {
  it('is 30 seconds', () => {
    expect(NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC).toBe(30)
  })
})
