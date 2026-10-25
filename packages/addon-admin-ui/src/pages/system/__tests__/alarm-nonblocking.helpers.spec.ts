/**
 * Which devices a mode's non-blocking picker offers, and what every alarm line
 * calls a device.
 *
 * The picker offers OPENINGS only — a camera an intrusion rule names is
 * covered by the mode but can never refuse an arm, so a switch for it would do
 * nothing. Since D636 it offers EVERY opening of the household, not only the
 * ones the mode's rules cover: an opening no rule of the mode covers is listed
 * and MARKED ("never blocks") — listing it is harmless, and hiding it made the
 * operator go and author a rule just to see a window here. Which devices are
 * openings is one targeted, ids-only read (`listDeviceIdsByCaps`);
 * until it answers, and when it fails, nothing unknown is claimed (D315) and
 * nothing listed is dropped (D49).
 */
import type { NcAlarmConfig } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  alarmDeviceNamer,
  hubDeviceName,
  nonBlockingEmptyLine,
  nonBlockingOptions,
  refusalHeadline,
} from '../alarm-nonblocking.helpers'

type Live = NonNullable<NcAlarmConfig['live']>

// 8 open under away, 11 unreadable under away; 101 is a camera an away rule names.
const LIVE: Live = {
  state: 'disarmed',
  targetMode: null,
  availableModes: ['home', 'away'],
  openings: [
    {
      mode: 'away',
      devices: [{ deviceId: 8, name: 'Porch', state: 'open', blocking: true }],
      unknown: [11],
    },
    { mode: 'home', devices: [], unknown: [] },
  ],
  exclusions: [],
  bypassedInputs: [],
}

describe('nonBlockingOptions — every opening of the household', () => {
  it('offers every opening; the ones this mode does not cover are MARKED, not hidden', () => {
    const view = nonBlockingOptions({
      live: LIVE,
      listed: [],
      openingIds: new Set([12, 77]),
    })
    // 8 is open under away, 11 unreadable under away (an opening by
    // construction), 12 and 77 are bound to an opening cap.
    expect(view).toEqual({ ids: [8, 11, 12, 77], unresolved: false })
  })

  it('never offers a camera the mode covers', () => {
    const view = nonBlockingOptions({
      live: LIVE,
      listed: [],
      openingIds: new Set(),
    })
    expect(view.ids).not.toContain(101)
  })

  it('while the household scan is unknown: what the hub read, and it SAYS it is unresolved', () => {
    const view = nonBlockingOptions({ live: LIVE, listed: [], openingIds: null })
    expect(view).toEqual({ ids: [8, 11], unresolved: true })
  })

  it('keeps an already-listed id — even a camera — so it can be removed (D49)', () => {
    const view = nonBlockingOptions({
      live: LIVE,
      listed: [101],
      openingIds: new Set(),
    })
    expect(view.ids).toEqual([8, 11, 101])
  })

  it('a device open under ANOTHER mode is an opening here too', () => {
    const view = nonBlockingOptions({ live: LIVE, listed: [], openingIds: null })
    expect(view.ids).toContain(8)
  })
})

describe('nonBlockingEmptyLine', () => {
  it('says the household has no opening, and only once that is KNOWN', () => {
    expect(nonBlockingEmptyLine({ ids: [], unresolved: false })).toBe('no-opening')
    expect(nonBlockingEmptyLine({ ids: [], unresolved: true })).toBeNull()
    expect(nonBlockingEmptyLine({ ids: [3], unresolved: false })).toBeNull()
  })
})

describe('what a device is called', () => {
  const FLEET: ReadonlyMap<number, string> = new Map([[101, 'Cancello']])

  it('a device the answered fleet lacks is "Device #id — removed"', () => {
    expect(alarmDeviceNamer(FLEET, 'answered')(999)).toBe('Device #999 — removed')
  })

  it('an unanswered fleet claims nothing: "Device #id"', () => {
    expect(alarmDeviceNamer(FLEET, 'pending')(999)).toBe('Device #999')
    expect(alarmDeviceNamer(FLEET, 'failed')(999)).toBe('Device #999')
  })

  it('the fleet name, else the name the hub read it open under', () => {
    const openNames = new Map([[8, 'Porch']])
    const nameOf = alarmDeviceNamer(FLEET, 'answered', openNames)
    expect(nameOf(101)).toBe('Cancello')
    expect(nameOf(8)).toBe('Porch')
  })

  it('a hub row with no name is "Device #id", never blank', () => {
    expect(hubDeviceName({ deviceId: 7, name: '  ' })).toBe('Device #7')
    expect(hubDeviceName({ deviceId: 7, name: 'Porta' })).toBe('Porta')
  })
})

describe('refusalHeadline', () => {
  it('a refusal naming nothing has its own line — never "open: " and nothing', () => {
    expect(refusalHeadline(0)).toBe('Not armed — the hub refused without naming an open device.')
    expect(refusalHeadline(2)).toBe('Not armed — these are open:')
  })
})
