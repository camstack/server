/**
 * What a mode arms is DERIVED, and every test here is about a way a stored
 * copy would have lied.
 *
 * The operator's question is "I pressed Away — what is actually watching?".
 * The only thing that makes the panel do anything is a rule gated on its
 * state, so the answer has to be recomputed from the rule set every time it is
 * asked. A list kept next to the mode would be right on the day it was written
 * and wrong the first time somebody disabled a rule.
 */

import type { AlarmArmMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NcTextCatalog } from '../../text-catalog.js'
import {
  alarmCoverageGap,
  alarmModeCoverage,
  armModeOf,
  buildArmAnnouncement,
  buildArmingAnnouncement,
  type NcAlarmGatingRule,
  type NcAlarmModeCoverage,
  shouldAnnounceArm,
} from '../alarm-mode-coverage.js'

const PANEL = 42
const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

/**
 * A rule as the derivation sees it — the `NcAlarmGatingRule` shape a real
 * `NcRule` satisfies structurally. `id` is carried only so a failing
 * assertion names something the reader can find.
 */
function rule(input: {
  id: string
  enabled?: boolean
  gate?: { deviceId: number; states: readonly string[] }
  devices?: readonly number[]
  exclude?: readonly number[]
}): NcAlarmGatingRule {
  return {
    enabled: input.enabled ?? true,
    conditions: {
      ...(input.gate !== undefined
        ? { deviceState: { deviceId: input.gate.deviceId, states: [...input.gate.states] } }
        : {}),
      ...(input.devices !== undefined ? { devices: [...input.devices] } : {}),
      ...(input.exclude !== undefined ? { devicesExclude: [...input.exclude] } : {}),
    },
  }
}

describe('alarmModeCoverage', () => {
  it('reports a mode nothing is gated on, rather than omitting it', () => {
    // "Night arms nothing" is the single most useful thing this can say. A
    // filtered list looks identical to one where night is covered.
    const coverage = alarmModeCoverage([], PANEL, MODES)
    expect(coverage.map((c) => c.mode)).toEqual(['home', 'away', 'night'])
    expect(coverage.every((c) => c.ruleCount === 0)).toBe(true)
  })

  it('collects the devices of every rule gated on the mode', () => {
    const rules = [
      rule({ id: 'a', gate: { deviceId: PANEL, states: ['armed_away'] }, devices: [3, 1] }),
      rule({ id: 'b', gate: { deviceId: PANEL, states: ['armed_away'] }, devices: [1, 7] }),
    ]
    const away = alarmModeCoverage(rules, PANEL, MODES).find((c) => c.mode === 'away')
    expect(away?.ruleCount).toBe(2)
    expect(away?.deviceIds).toEqual([1, 3, 7])
    expect(away?.allDevices).toBe(false)
  })

  it('IGNORES a disabled rule — it arms nothing', () => {
    // Counting it would report protection the operator switched off, which is
    // exactly the false assurance this surface exists to remove.
    const rules = [
      rule({
        id: 'off',
        enabled: false,
        gate: { deviceId: PANEL, states: ['armed_away'] },
        devices: [5],
      }),
    ]
    const away = alarmModeCoverage(rules, PANEL, MODES).find((c) => c.mode === 'away')
    expect(away?.ruleCount).toBe(0)
    expect(away?.deviceIds).toEqual([])
  })

  it('ignores a rule gated on a DIFFERENT device', () => {
    // Cap names and state words are shared across devices — `armed_away` on
    // somebody else's HA panel says nothing about this one.
    const rules = [
      rule({ id: 'other', gate: { deviceId: 99, states: ['armed_away'] }, devices: [5] }),
    ]
    expect(alarmModeCoverage(rules, PANEL, MODES).find((c) => c.mode === 'away')?.ruleCount).toBe(0)
  })

  it('ignores a rule with no device-state gate at all', () => {
    const rules = [rule({ id: 'ungated', devices: [5] })]
    expect(alarmModeCoverage(rules, PANEL, MODES).every((c) => c.ruleCount === 0)).toBe(true)
  })

  it('counts a rule gated on SEVERAL modes under each of them', () => {
    const rules = [
      rule({
        id: 'both',
        gate: { deviceId: PANEL, states: ['armed_away', 'armed_night'] },
        devices: [2],
      }),
    ]
    const coverage = alarmModeCoverage(rules, PANEL, MODES)
    expect(coverage.find((c) => c.mode === 'away')?.deviceIds).toEqual([2])
    expect(coverage.find((c) => c.mode === 'night')?.deviceIds).toEqual([2])
    expect(coverage.find((c) => c.mode === 'home')?.ruleCount).toBe(0)
  })

  it('an unscoped rule means EVERY device, and says so separately from the id list', () => {
    const rules = [
      rule({ id: 'all', gate: { deviceId: PANEL, states: ['armed_away'] } }),
      rule({ id: 'one', gate: { deviceId: PANEL, states: ['armed_away'] }, devices: [4] }),
    ]
    const away = alarmModeCoverage(rules, PANEL, MODES).find((c) => c.mode === 'away')
    expect(away?.allDevices).toBe(true)
    // The ids are a SUBSET, not the answer — rendering them as the answer
    // would understate what the mode covers.
    expect(away?.deviceIds).toEqual([4])
    expect(away?.allDevicesExcept).toEqual([])
  })
})

describe('alarmModeCoverage — rules that EXCLUDE devices (D641)', () => {
  const AWAY = { deviceId: PANEL, states: ['armed_away'] } as const
  const away = (rules: readonly NcAlarmGatingRule[]) =>
    alarmModeCoverage(rules, PANEL, MODES).find((c) => c.mode === 'away')

  it('"every device except the garage" is all devices, EXCEPT the garage', () => {
    const cov = away([rule({ id: 'x', gate: AWAY, exclude: [9, 3] })])
    expect(cov?.allDevices).toBe(true)
    expect(cov?.allDevicesExcept).toEqual([3, 9])
  })

  it('two excluding rules: a device is uncovered only if BOTH exclude it (intersection)', () => {
    const cov = away([
      rule({ id: 'a', gate: AWAY, exclude: [3, 9] }),
      rule({ id: 'b', gate: AWAY, exclude: [9, 11] }),
    ])
    expect(cov?.allDevicesExcept).toEqual([9])
  })

  it('an unscoped rule with no exclusion covers everything, whatever the others exclude', () => {
    const cov = away([
      rule({ id: 'a', gate: AWAY, exclude: [9] }),
      rule({ id: 'all', gate: AWAY }),
      rule({ id: 'b', gate: AWAY, exclude: [9] }),
    ])
    expect(cov?.allDevicesExcept).toEqual([])
  })

  it('a device a NAMED rule covers is not in the except-set', () => {
    const cov = away([
      rule({ id: 'x', gate: AWAY, exclude: [3, 9] }),
      rule({ id: 'garage', gate: AWAY, devices: [9] }),
    ])
    expect(cov?.allDevicesExcept).toEqual([3])
    expect(cov?.deviceIds).toEqual([9])
  })

  it('a named rule covers its list MINUS its own exclusions (legacy both)', () => {
    const cov = away([rule({ id: 'legacy', gate: AWAY, devices: [1, 2, 3], exclude: [2] })])
    expect(cov?.deviceIds).toEqual([1, 3])
    expect(cov?.allDevices).toBe(false)
    expect(cov?.allDevicesExcept).toEqual([])
  })
})

const EN = new NcTextCatalog()
const IT = new NcTextCatalog({ language: 'it' })

/** A coverage row, with the field the announcement never reads defaulted. */
function coverage(
  over: Partial<NcAlarmModeCoverage> & { mode: AlarmArmMode },
): NcAlarmModeCoverage {
  return {
    ruleCount: 0,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [],
    skippedDevices: [],
    ...over,
  }
}

/** What the row will actually SAY, rendered exactly as the dispatcher does:
 *  the key and the frozen params, through the catalog, in one language. */
function render(
  texts: NcTextCatalog,
  text: { bodyKey: string; textParams: Readonly<Record<string, string>>; textCount: number } | null,
): string | null {
  if (text === null) return null
  return texts.text({ key: text.bodyKey, count: text.textCount, vars: text.textParams })
}

const NAME_OR_ID = (id: number): string =>
  new Map([
    [1, 'Front door'],
    [2, 'Garage'],
  ]).get(id) ?? `Device ${id}`

describe('buildArmAnnouncement', () => {
  it('freezes a KEY and the facts, never the sentence', () => {
    // The words are chosen at delivery, where the reader's language is known.
    // A row held behind an unreachable target for a day must still be
    // deliverable in the right language, and re-wordable.
    const text = buildArmAnnouncement(
      coverage({ mode: 'away', ruleCount: 2, deviceIds: [1, 2] }),
      NAME_OR_ID,
    )
    expect(text).toEqual({
      bodyKey: 'alarm.arm.body.devices',
      textCount: 2,
      textParams: {
        rules: '2',
        mode: 'away',
        devices: '2',
        names: '• Front door\n• Garage',
        active: '2',
        skipped: '0',
      },
    })
  })

  it('names the devices, because a person reads this standing at a door', () => {
    expect(
      render(
        EN,
        buildArmAnnouncement(
          coverage({ mode: 'away', ruleCount: 2, deviceIds: [1, 2] }),
          NAME_OR_ID,
        ),
      ),
    ).toBe('Active:\n• Front door\n• Garage')
  })

  it('falls back to a name the LOOKUP supplies rather than DROPPING a device', () => {
    // A silently shorter list understates what is armed — the one error this
    // message must not make. The placeholder is the caller's, and on the live
    // path it is a translated catalog key rather than an English literal.
    expect(
      render(
        EN,
        buildArmAnnouncement(
          coverage({ mode: 'home', ruleCount: 1, deviceIds: [1, 9] }),
          NAME_OR_ID,
        ),
      ),
    ).toBe('Active:\n• Front door\n• Device 9')
  })

  it('says "every device" instead of printing a subset', () => {
    expect(
      render(
        EN,
        buildArmAnnouncement(
          coverage({ mode: 'away', ruleCount: 1, allDevices: true, deviceIds: [4] }),
          NAME_OR_ID,
        ),
      ),
    ).toBe('Active: all devices')
  })

  it('keeps each device group on its OWN labelled line', () => {
    // The list is the message. A rule count in the middle of it is a number
    // nobody acts on, and it is what made this a paragraph.
    expect(
      render(
        EN,
        buildArmAnnouncement(coverage({ mode: 'home', ruleCount: 1, deviceIds: [1] }), NAME_OR_ID),
      ),
    ).toBe('Active:\n• Front door')
    expect(
      render(
        EN,
        buildArmAnnouncement(
          coverage({ mode: 'home', ruleCount: 3, allDevices: true }),
          NAME_OR_ID,
        ),
      ),
    ).toBe('Active: all devices')
    expect(
      render(EN, buildArmAnnouncement(coverage({ mode: 'home', ruleCount: 1 }), NAME_OR_ID)),
    ).toBe('Active: no device restriction')
  })

  it('says the same thing in Italian — from the SAME frozen row', () => {
    const text = buildArmAnnouncement(
      coverage({ mode: 'away', ruleCount: 2, deviceIds: [1, 2] }),
      (id) => (id === 1 ? 'Front door' : 'Garage'),
    )
    expect(render(IT, text)).toBe('Attivi:\n• Front door\n• Garage')
    expect(
      render(
        IT,
        buildArmAnnouncement(
          coverage({ mode: 'night', ruleCount: 1, allDevices: true }),
          NAME_OR_ID,
        ),
      ),
    ).toBe('Attivi: tutti i dispositivi')
  })

  /**
   * THE ARM THAT PROTECTS NOTHING.
   *
   * This used to return null and the caller logged a WARN nobody reads — so
   * the operator got "Casa attivato" with an EMPTY BODY (the fallback key
   * `system.alarm-armed.body` did not exist in either locale) and no way to
   * know the mode was gated on by nothing. Silence was chosen over a false
   * assurance; the third option — say so — is the one the operator asked for.
   */
  it('SAYS SO when the mode is gated on by no rule, rather than saying nothing', () => {
    const text = buildArmAnnouncement(coverage({ mode: 'night' }), NAME_OR_ID)
    expect(text.bodyKey).toBe('alarm.arm.body.uncovered')
    expect(render(EN, text)).toBe('Active: none — no rule uses this mode')
    expect(render(IT, text)).toBe('Attivi: nessuno — nessuna regola usa questa modalità')
  })

  it('says so when every device the mode names is EXCLUDED', () => {
    // "Away armed — 2 cameras" while both are muted is the same false
    // assurance wearing a number.
    const text = buildArmAnnouncement(
      coverage({
        mode: 'away',
        ruleCount: 1,
        deviceIds: [1, 2],
        skippedDevices: [
          { deviceId: 1, reason: 'muted' },
          { deviceId: 2, reason: 'offline' },
        ],
      }),
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arm.body.allSkipped')
    expect(render(EN, text)).toBe('Excluded:\n• Front door\n• Garage\nActive: none')
  })

  it('names the excluded devices ALONGSIDE the armed ones when only some are', () => {
    const text = buildArmAnnouncement(
      coverage({
        mode: 'away',
        ruleCount: 1,
        deviceIds: [1, 2],
        skippedDevices: [{ deviceId: 2, reason: 'detection-off' }],
      }),
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arm.body.devicesSkipped')
    // The count pluralises on what IS armed — the promise, not the exception.
    expect(text.textCount).toBe(1)
    expect(render(EN, text)).toBe('Excluded:\n• Garage\nActive:\n• Front door')
  })

  it('leaves an ALL-DEVICES mode alone — its exclusions are not the named ones', () => {
    // `skippedDevices` only ever probes the ids a rule wrote down. A mode that
    // covers every camera on the hub cannot be summarised by them.
    const text = buildArmAnnouncement(
      coverage({
        mode: 'away',
        ruleCount: 1,
        allDevices: true,
        deviceIds: [1],
        skippedDevices: [{ deviceId: 1, reason: 'muted' }],
      }),
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arm.body.allDevices')
  })

  it('an all-devices mode with EXCLUDED devices says so and names them (D641)', () => {
    const text = buildArmAnnouncement(
      coverage({ mode: 'away', ruleCount: 1, allDevices: true, allDevicesExcept: [3, 9] }),
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arm.body.allDevicesExcept')
    expect(text.textCount).toBe(2)
    expect(render(EN, text)).toBe('Active: all devices except\n• Device 3\n• Device 9')
    expect(render(IT, text)).toBe('Attivi: tutti i dispositivi tranne\n• Device 3\n• Device 9')
    // Excluded by the rules, not skipped by a switch: never "Excluded:".
    expect(render(EN, text)).not.toMatch(/Excluded:/)
  })
})

/**
 * The exit-delay sentence. Same coverage, asked 30 seconds earlier — which is
 * the whole point: an operator told "this mode protects nothing" WHILE the
 * countdown runs can still disarm and fix it.
 */
describe('buildArmingAnnouncement', () => {
  it('lists the Active devices — the countdown stays in the title params', () => {
    const text = buildArmingAnnouncement(
      coverage({ mode: 'away', ruleCount: 1, deviceIds: [1] }),
      30,
      NAME_OR_ID,
    )
    expect(text).toEqual({
      bodyKey: 'alarm.arming.body.devices',
      textCount: 30,
      textParams: {
        mode: 'away',
        seconds: '30',
        rules: '1',
        devices: '1',
        names: '• Front door',
        active: '1',
        skipped: '0',
      },
    })
    expect(render(EN, text)).toBe('Active:\n• Front door')
    expect(render(IT, text)).toBe('Attivi:\n• Front door')
  })

  it('lists Active and Skipped together on a partial exclusion', () => {
    const text = buildArmingAnnouncement(
      coverage({
        mode: 'away',
        ruleCount: 1,
        deviceIds: [1, 2],
        skippedDevices: [{ deviceId: 2, reason: 'muted' }],
      }),
      30,
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arming.body.devicesSkipped')
    expect(render(EN, text)).toBe('Excluded:\n• Garage\nActive:\n• Front door')
    expect(render(IT, text)).toBe('Esclusi:\n• Garage\nAttivi:\n• Front door')
  })

  it('warns WHILE THERE IS STILL TIME that the mode arms nothing', () => {
    const text = buildArmingAnnouncement(coverage({ mode: 'night' }), 30, NAME_OR_ID)
    expect(text.bodyKey).toBe('alarm.arming.body.uncovered')
    expect(render(EN, text)).toBe('Active: none — no rule uses this mode')
  })

  it('warns when every device the mode names is excluded', () => {
    const text = buildArmingAnnouncement(
      coverage({
        mode: 'away',
        ruleCount: 1,
        deviceIds: [1],
        skippedDevices: [{ deviceId: 1, reason: 'muted' }],
      }),
      30,
      NAME_OR_ID,
    )
    expect(text.bodyKey).toBe('alarm.arming.body.allSkipped')
    expect(render(EN, text)).toBe('Excluded:\n• Front door\nActive: none')
  })
})

describe('alarmCoverageGap', () => {
  it('is null for a mode that actually arms something', () => {
    expect(alarmCoverageGap(coverage({ mode: 'away', ruleCount: 1, deviceIds: [1] }))).toBeNull()
    expect(alarmCoverageGap(coverage({ mode: 'away', ruleCount: 1, allDevices: true }))).toBeNull()
    // Gated rules that name no device apply to whatever else they match — that
    // is a rule set, not a gap.
    expect(alarmCoverageGap(coverage({ mode: 'away', ruleCount: 2 }))).toBeNull()
  })

  it('reports a mode no enabled rule is gated on', () => {
    expect(alarmCoverageGap(coverage({ mode: 'night' }))).toBe('uncovered')
  })

  it('reports a mode whose every named device is excluded', () => {
    expect(
      alarmCoverageGap(
        coverage({
          mode: 'away',
          ruleCount: 1,
          deviceIds: [1],
          skippedDevices: [{ deviceId: 1, reason: 'offline' }],
        }),
      ),
    ).toBe('all-skipped')
  })

  it('is null when one of the named devices is still armed', () => {
    expect(
      alarmCoverageGap(
        coverage({
          mode: 'away',
          ruleCount: 1,
          deviceIds: [1, 2],
          skippedDevices: [{ deviceId: 1, reason: 'offline' }],
        }),
      ),
    ).toBeNull()
  })
})

describe('shouldAnnounceArm', () => {
  it('announces an arm from disarmed and from the exit delay', () => {
    expect(shouldAnnounceArm('disarmed', 'armed_away')).toBe(true)
    expect(shouldAnnounceArm('arming', 'armed_away')).toBe(true)
  })

  it('announces a MODE CHANGE — the covered devices just changed', () => {
    expect(shouldAnnounceArm('armed_home', 'armed_away')).toBe(true)
  })

  it('does NOT announce the panel re-arming itself after a siren', () => {
    // Sending "Away armed" seconds after the alarm notification, in the middle
    // of a break-in, would say nothing the operator does not already know.
    expect(shouldAnnounceArm('triggered', 'armed_away')).toBe(false)
  })

  it('does not announce the FIRST publish — a restart is not an arm', () => {
    // A hub rebooting while armed re-publishes `armed_away` and nobody armed
    // anything. Without this, every deploy sent an "Away armed" notification.
    expect(shouldAnnounceArm(null, 'armed_away')).toBe(false)
  })

  it('never announces a non-armed state', () => {
    expect(shouldAnnounceArm('armed_away', 'disarmed')).toBe(false)
    expect(shouldAnnounceArm('armed_away', 'triggered')).toBe(false)
    expect(shouldAnnounceArm('disarmed', 'arming')).toBe(false)
  })

  it('does not re-announce the same state on every tick', () => {
    // The panel publishes once a second while a delay runs.
    expect(shouldAnnounceArm('armed_away', 'armed_away')).toBe(false)
  })
})

describe('armModeOf', () => {
  it('extracts the mode from the state word', () => {
    expect(armModeOf('armed_night', MODES)).toBe('night')
  })

  it('is null for a mode this panel does not offer', () => {
    // `armed_vacation` is in the cap's vocabulary but not this panel's.
    expect(armModeOf('armed_vacation', MODES)).toBeNull()
    expect(armModeOf('pending', MODES)).toBeNull()
  })
})
