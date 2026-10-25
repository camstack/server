/**
 * D706 + D735: the mode card's three notification switches — all OFF by default, each one ONE
 * per-field edit (off CLEARS rather than storing `false`), IT + EN labels — and the stock
 * duration a "pick a timed action" fills in.
 */
import type { NcAlarmSettings } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en.json'
import it_ from '../../../i18n/it.json'
import { modeNotifyEdit, modePostTriggeredEdit } from '../notification-alarm.helpers'

const BASE: NcAlarmSettings = {
  exitDelaySec: 30,
  entryDelaySec: 30,
  triggeredDurationSec: 0,
  postTriggeredAction: 'doNothing',
  announceTargets: [],
  nonBlocking: [],
  blocking: [],
  secureOnArmOff: [],
  modeDelays: [],
}

describe('modeNotifyEdit', () => {
  it('turning a switch ON stores true for that mode only', () => {
    expect(modeNotifyEdit(BASE, 'away', 'notifyDuringEntryDelay', true)).toEqual({
      mode: 'away',
      notifyDuringEntryDelay: true,
    })
  })

  it('turning it OFF clears the stored value — off is the default', () => {
    const on: NcAlarmSettings = {
      ...BASE,
      modeDelays: [{ mode: 'away', notifySensorRewatched: true }],
    }
    expect(modeNotifyEdit(on, 'away', 'notifySensorRewatched', false)).toEqual({
      mode: 'away',
      notifySensorRewatched: null,
    })
  })

  it('"Notify ignored sensors" (D735) is one per-field edit like the others', () => {
    expect(modeNotifyEdit(BASE, 'night', 'notifySensorIgnored', true)).toEqual({
      mode: 'night',
      notifySensorIgnored: true,
    })
    const on: NcAlarmSettings = {
      ...BASE,
      modeDelays: [{ mode: 'night', notifySensorIgnored: true }],
    }
    expect(modeNotifyEdit(on, 'night', 'notifySensorIgnored', false)).toEqual({
      mode: 'night',
      notifySensorIgnored: null,
    })
    expect(modeNotifyEdit(BASE, 'night', 'notifySensorIgnored', false)).toBeNull()
  })

  it('sends nothing when the switch already says so', () => {
    expect(modeNotifyEdit(BASE, 'away', 'notifySensorRewatched', false)).toBeNull()
    const on: NcAlarmSettings = {
      ...BASE,
      modeDelays: [{ mode: 'home', notifyDuringEntryDelay: true }],
    }
    expect(modeNotifyEdit(on, 'home', 'notifyDuringEntryDelay', true)).toBeNull()
  })
})

describe('the stock after-trigger duration (D706)', () => {
  it('a timed action picked on a zero duration fills in 30 s', () => {
    expect(modePostTriggeredEdit(BASE, 'away', 'rearmAfter')).toEqual({
      mode: 'away',
      postTriggeredAction: 'rearmAfter',
      triggeredDurationSec: 30,
    })
  })
})

describe('labels', () => {
  it('exist in English and Italian', () => {
    for (const bundle of [en, it_]) {
      const block = bundle.notificationRules.alarmNotify
      for (const key of [
        'title',
        'duringEntryDelay',
        'duringEntryDelayHint',
        'rewatched',
        'rewatchedHint',
        'ignored',
        'ignoredHint',
      ] as const) {
        expect(block[key].length).toBeGreaterThan(0)
      }
    }
    expect(it_.notificationRules.alarmNotify.rewatched).toContain('di nuovo sorvegliato')
  })
})
