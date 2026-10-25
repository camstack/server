/**
 * The words the alarm tab puts on screen.
 *
 * Two of these encode a failure the tab exists to prevent:
 *  - a mode gated on by no rule must read as "arms nothing", not as an empty
 *    row that looks like a rendering glitch;
 *  - a cleared number box must not commit 0, because 0 on these three fields
 *    is a BEHAVIOUR (no delay / no limit), not a quantity.
 */
import type { NcAlarmConfig, NcAlarmModeCoverage, NcAlarmSettings } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alarmDeviceNamer } from '../alarm-nonblocking.helpers'
import {
  alarmModeLabel,
  alarmPollIntervalMs,
  alarmStateLabel,
  coverageIsEmpty,
  coverageSummary,
  delayLabel,
  exclusionPhaseLabel,
  modeDelayEdit,
  nonBlockingFor,
  openingsSummary,
  parseArmOutcome,
  parseDelayInput,
  skippedSummary,
} from '../notification-alarm.helpers'

const NAMES: ReadonlyMap<number, string> = new Map([
  [101, 'Cancello'],
  [102, 'Garage'],
])
/** The fleet answered and holds exactly these two. */
const NAME_OF = alarmDeviceNamer(NAMES, 'answered')

function coverage(over: Partial<NcAlarmModeCoverage>): NcAlarmModeCoverage {
  return {
    mode: 'away',
    ruleCount: 1,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [],
    skippedDevices: [],
    ...over,
  }
}

describe('delayLabel', () => {
  it('renders 0 as what it MEANS, never as a quantity', () => {
    // "0 s" leaves the operator guessing whether it is no delay or no limit.
    expect(delayLabel(0, 'until disarmed')).toBe('until disarmed')
    expect(delayLabel(0, 'fires immediately')).toBe('fires immediately')
  })

  it('reads in seconds below a minute and in minutes above', () => {
    expect(delayLabel(45, 'x')).toBe('45 s')
    expect(delayLabel(60, 'x')).toBe('1 min')
    expect(delayLabel(150, 'x')).toBe('2 min 30 s')
  })
})

describe('coverageSummary', () => {
  it('says a mode arms NOTHING, in those words', () => {
    // The operator arms Away, nothing is gated on it, and until now there was
    // no indication anywhere that the alarm did not do anything.
    const line = coverageSummary(coverage({ ruleCount: 0 }), NAME_OF)
    expect(line).toMatch(/arms nothing/i)
    expect(coverageIsEmpty(coverage({ ruleCount: 0 }))).toBe(true)
  })

  it('names the devices', () => {
    expect(coverageSummary(coverage({ ruleCount: 2, deviceIds: [101, 102] }), NAME_OF)).toBe(
      'Cancello, Garage',
    )
  })

  it('names a device the answered fleet lacks as removed, never drops it', () => {
    expect(coverageSummary(coverage({ deviceIds: [101, 999] }), NAME_OF)).toBe(
      'Cancello, Device #999 — removed',
    )
  })

  it('an unanswered fleet names by id only — no claim it is gone (D315)', () => {
    const pending = alarmDeviceNamer(new Map(), 'pending')
    expect(coverageSummary(coverage({ deviceIds: [999] }), pending)).toBe('Device #999')
  })

  it('says "every device" instead of printing a partial list', () => {
    const line = coverageSummary(coverage({ allDevices: true, deviceIds: [101] }), NAME_OF)
    expect(line).toMatch(/every device/i)
    expect(line).not.toContain('Cancello')
  })

  it('an all-devices mode whose rules EXCLUDE devices says "All devices except N" and names them (D641)', () => {
    const line = coverageSummary(
      coverage({ allDevices: true, allDevicesExcept: [102, 999] }),
      NAME_OF,
    )
    expect(line).toBe('All devices except 2: Garage, Device #999 — removed')
  })

  it('an unanswered fleet names an excluded device by id, never "removed" (D315)', () => {
    const pending = alarmDeviceNamer(new Map(), 'pending')
    expect(coverageSummary(coverage({ allDevices: true, allDevicesExcept: [102] }), pending)).toBe(
      'All devices except 1: Device #102',
    )
  })

  it('is not flagged empty when rules exist but name no device', () => {
    const row = coverage({ ruleCount: 1, deviceIds: [] })
    expect(coverageIsEmpty(row)).toBe(false)
    expect(coverageSummary(row, NAME_OF)).toMatch(/no device restriction/i)
  })
})

describe('parseDelayInput', () => {
  it('refuses an EMPTY box rather than committing 0', () => {
    // Clearing the entry-delay field on the way to typing "45" would otherwise
    // arm an alarm that fires the instant the door opens.
    expect(parseDelayInput('', 600)).toBeNull()
    expect(parseDelayInput('   ', 600)).toBeNull()
  })

  it('accepts a whole number in range, including a deliberate 0', () => {
    expect(parseDelayInput('45', 600)).toBe(45)
    expect(parseDelayInput('0', 600)).toBe(0)
    expect(parseDelayInput('600', 600)).toBe(600)
  })

  it('refuses anything the cap would reject anyway', () => {
    expect(parseDelayInput('601', 600)).toBeNull()
    expect(parseDelayInput('-5', 600)).toBeNull()
    expect(parseDelayInput('4.5', 600)).toBeNull()
    expect(parseDelayInput('abc', 600)).toBeNull()
  })
})

describe('alarmModeLabel', () => {
  it('renders the modes a person recognises', () => {
    expect(alarmModeLabel('away')).toBe('Away')
    // Only the three a camstack panel OFFERS. A label for a mode it never
    // returns was a row that could not appear and made the tab look richer
    // than it is.
    expect(alarmModeLabel('night')).toBe('Night')
    expect(alarmModeLabel('custom_bypass')).toBe('custom_bypass')
  })

  it('falls through to the raw word for a mode it does not know', () => {
    // A provider may offer a mode this UI has never heard of; showing the raw
    // word beats showing nothing.
    expect(alarmModeLabel('armed_lockdown')).toBe('armed_lockdown')
  })
})

/**
 * The half of the coverage answer that makes it honest. "Away armed — 2
 * cameras" with one of them muted is a promise the panel cannot keep.
 */
describe('skippedSummary', () => {
  it('names each excluded device and the switch that excluded it', () => {
    expect(
      skippedSummary(
        [
          { deviceId: 102, reason: 'muted' },
          { deviceId: 101, reason: 'offline' },
        ],
        NAME_OF,
      ),
    ).toBe('2 excluded: Garage (notifications muted), Cancello (offline)')
  })

  it('never calls a switched-off device broken', () => {
    // D62: an off switch is REPORTED off. "detection off" is a choice; the word
    // this must never produce is a fault.
    expect(skippedSummary([{ deviceId: 102, reason: 'detection-off' }], NAME_OF)).toBe(
      '1 excluded: Garage (detection off)',
    )
  })

  it('says nothing at all when nothing is excluded', () => {
    expect(skippedSummary([], NAME_OF)).toBe('')
  })
})

type Live = NonNullable<NcAlarmConfig['live']>

const SETTINGS: NcAlarmSettings = {
  exitDelaySec: 30,
  entryDelaySec: 30,
  triggeredDurationSec: 0,
  announceTargets: [],
  nonBlocking: [
    { mode: 'home', deviceIds: [7] },
    { mode: 'away', deviceIds: [8, 9] },
  ],
  blocking: [],
  secureOnArmOff: [],
  modeDelays: [],
}

const LIVE: Live = {
  state: 'disarmed',
  targetMode: null,
  availableModes: ['home', 'away', 'night'],
  openings: [
    {
      mode: 'away',
      devices: [
        { deviceId: 8, name: 'Porch', state: 'open', blocking: true },
        { deviceId: 9, name: 'Bathroom', state: 'open', blocking: false },
        { deviceId: 10, name: 'Garage', state: 'unlocked', blocking: true },
      ],
      unknown: [11],
    },
    { mode: 'home', devices: [], unknown: [] },
  ],
  exclusions: [],
  bypassedInputs: [],
}

describe('non-blocking lists', () => {
  it("reads one mode's list, and an unlisted mode as none", () => {
    expect(nonBlockingFor(SETTINGS, 'away')).toEqual([8, 9])
    expect(nonBlockingFor(SETTINGS, 'night')).toEqual([])
  })
})

describe('openingsSummary', () => {
  it('counts blocking, non-blocking and unknown separately', () => {
    expect(openingsSummary(LIVE, 'away')).toEqual({ blocking: 2, nonBlocking: 1, unknown: 1 })
    expect(openingsSummary(LIVE, 'home')).toEqual({ blocking: 0, nonBlocking: 0, unknown: 0 })
  })

  it('is NULL — not zeroes — for a mode the hub did not answer about', () => {
    // "nothing open" and "not asked" are different facts (D315).
    expect(openingsSummary(LIVE, 'night')).toBeNull()
  })
})

describe('parseArmOutcome', () => {
  it('reads a refusal with its id and blockers', () => {
    expect(
      parseArmOutcome({
        outcome: 'refused',
        refusalId: 'r1',
        blocking: [{ deviceId: 8, name: 'Porch', state: 'open' }],
      }),
    ).toEqual({
      outcome: 'refused',
      refusalId: 'r1',
      blocking: [{ deviceId: 8, name: 'Porch', state: 'open' }],
    })
  })

  it('reads armed/arming with the excluded devices, and rejected with its reason', () => {
    expect(parseArmOutcome({ outcome: 'arming', excluded: [] })).toEqual({
      outcome: 'arming',
      excluded: [],
    })
    expect(parseArmOutcome({ outcome: 'rejected', reason: 'stale' })).toEqual({
      outcome: 'rejected',
      reason: 'stale',
    })
  })

  it('returns null for anything else, never a guessed "armed"', () => {
    expect(parseArmOutcome(undefined)).toBeNull()
    expect(parseArmOutcome({ outcome: 'refused', blocking: [] })).toBeNull()
    expect(parseArmOutcome({ outcome: 'rejected', reason: 'bogus' })).toBeNull()
  })
})

describe('state words', () => {
  it('names the target mode while arming, pending or triggered', () => {
    expect(alarmStateLabel({ ...LIVE, state: 'arming', targetMode: 'away' })).toBe('Arming — Away')
    expect(alarmStateLabel({ ...LIVE, state: 'triggered', targetMode: 'night' })).toBe(
      'Triggered — Night',
    )
    expect(alarmStateLabel({ ...LIVE, state: 'armed_home', targetMode: 'home' })).toBe(
      'Armed — Home',
    )
    expect(alarmStateLabel(LIVE)).toBe('Disarmed')
  })

  it('polls fast only while something is happening', () => {
    expect(alarmPollIntervalMs('arming')).toBe(2000)
    expect(alarmPollIntervalMs('pending')).toBe(2000)
    expect(alarmPollIntervalMs('triggered')).toBe(2000)
    expect(alarmPollIntervalMs('armed_away')).toBe(15000)
    expect(alarmPollIntervalMs(undefined)).toBe(15000)
  })

  it('says which side of an exclusion a device is on', () => {
    expect(exclusionPhaseLabel('open')).toBe('ignored until it closes')
    expect(exclusionPhaseLabel('closed')).toBe('closed — monitored at next open')
  })
})

describe('modeDelayEdit — decided on the PRESENCE of the override, never on the value (plan M6)', () => {
  const BASE: NcAlarmSettings = {
    entryDelaySec: 30,
    exitDelaySec: 45,
    triggeredDurationSec: 120,
    announceArm: false,
    announceTargets: [],
    nonBlocking: [],
    blocking: [],
    secureOnArmOff: [],
    modeDelays: [{ mode: 'home', exitDelaySec: 45 }],
  }

  it('"Use default" on an override EQUAL to the global still clears it', () => {
    expect(modeDelayEdit(BASE, 'home', 'exitDelaySec', 'default')).toEqual({
      mode: 'home',
      exitDelaySec: null,
    })
  })
  it('"Use default" with no override sends nothing', () => {
    expect(modeDelayEdit(BASE, 'away', 'exitDelaySec', 'default')).toBeNull()
    expect(modeDelayEdit(BASE, 'home', 'entryDelaySec', 'default')).toBeNull()
  })
  it('typing the global value on a mode with no override still sets it', () => {
    expect(modeDelayEdit(BASE, 'away', 'exitDelaySec', 45)).toEqual({
      mode: 'away',
      exitDelaySec: 45,
    })
  })
  it('typing the stored override value sends nothing; a different one sends it', () => {
    expect(modeDelayEdit(BASE, 'home', 'exitDelaySec', 45)).toBeNull()
    expect(modeDelayEdit(BASE, 'home', 'exitDelaySec', 0)).toEqual({
      mode: 'home',
      exitDelaySec: 0,
    })
  })
  it('builds each of the three fields', () => {
    expect(modeDelayEdit(BASE, 'night', 'entryDelaySec', 10)).toEqual({
      mode: 'night',
      entryDelaySec: 10,
    })
    expect(modeDelayEdit(BASE, 'night', 'triggeredDurationSec', 0)).toEqual({
      mode: 'night',
      triggeredDurationSec: 0,
    })
  })
})
