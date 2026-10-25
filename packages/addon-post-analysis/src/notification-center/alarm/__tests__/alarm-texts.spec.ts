/**
 * EVERY key the alarm can freeze onto a row must exist in EVERY shipped locale.
 *
 * The catalog resolves an unknown key to the empty string — correct at runtime
 * (a notification with a hole beats a notification that throws) and invisible
 * everywhere else. `system.alarm-armed.body` was the fallback body of every arm
 * into a mode no rule was gated on, and it existed in NEITHER locale: the
 * operator's phone showed "Casa attivato" with an empty line under it, for
 * months, and nothing logged.
 *
 * The shipped-locale guard (`scripts/check-nc-text-catalog.ts`) cannot catch
 * this — the two files agreed perfectly about a key neither of them had. Only
 * the PRODUCER knows which keys it can emit, so the check lives next to it, and
 * the coverage-derived bodies are obtained by CALLING the builders rather than
 * by listing keys: a variant added to a builder with no sentence behind it
 * fails here.
 */

import { type AlarmArmMode, NC_ALARM_SYSTEM_EVENT_KINDS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { incomingFromAlarmTransition } from '../../event-intake.js'
import { NC_LANGUAGES, NC_TEXT_BUNDLES, NcTextCatalog } from '../../text-catalog.js'
import {
  buildArmAnnouncement,
  buildArmingAnnouncement,
  buildArmRefusedAnnouncement,
  type NcAlarmModeCoverage,
} from '../alarm-mode-coverage.js'
import type { NcAlarmTransition, NcAlarmTriggerSource } from '../alarm-transitions.js'

const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

const NAME = (id: number): string => `Device ${id}`

/** A rule that set the alarm off with a detection — the COMBINED row. */
const DETECTION_SOURCE: NcAlarmTriggerSource = {
  ruleId: 'r1',
  ruleName: 'Intrusione',
  deviceId: 102,
  recordId: 'ev-1',
  timestamp: 1_000,
  className: 'person',
}
/** A rule that set it off from a sensor — no class, the alarm's own sentence. */
const SENSOR_SOURCE: NcAlarmTriggerSource = {
  ruleId: 'r2',
  ruleName: 'Contatti',
  deviceId: 102,
  sourceDeviceId: 3243,
  recordId: 'sr-1',
  timestamp: 1_000,
}

/**
 * Every SHAPE of transition the panel can hand over, per kind — each variant
 * that selects a different title or body key. Keyed by kind so the test below
 * can prove no kind of `NC_ALARM_SYSTEM_EVENT_KINDS` is left without one.
 */
function sampleTransitions(): readonly NcAlarmTransition[] {
  const at = 1_000
  const out: NcAlarmTransition[] = []
  for (const mode of MODES) {
    const armed = `armed_${mode}` as const
    out.push(
      { kind: 'alarm-arming', state: 'arming', previous: 'disarmed', mode, seconds: 30, at },
      { kind: 'alarm-armed', state: armed, previous: 'arming', mode, at },
      {
        kind: 'alarm-arm-refused',
        state: 'disarmed',
        previous: 'disarmed',
        mode,
        at,
        refusalId: `refusal:900:${mode}:1000:1`,
        blocking: [{ deviceId: 3243, name: 'Finestra porch', state: 'open' }],
      },
      { kind: 'alarm-pending', state: 'pending', previous: armed, mode, seconds: 20, at },
      {
        kind: 'alarm-pending',
        state: 'pending',
        previous: armed,
        mode,
        seconds: 20,
        at,
        source: SENSOR_SOURCE,
      },
      { kind: 'alarm-rearmed', state: armed, previous: 'triggered', mode, at },
      { kind: 'alarm-check-failed', state: 'disarmed', previous: 'disarmed', mode, at },
    )
  }
  out.push(
    { kind: 'alarm-triggered', state: 'triggered', previous: 'pending', at },
    { kind: 'alarm-triggered', state: 'triggered', previous: 'pending', at, source: SENSOR_SOURCE },
    {
      kind: 'alarm-triggered',
      state: 'triggered',
      previous: 'pending',
      at,
      source: DETECTION_SOURCE,
    },
    { kind: 'alarm-disarmed', state: 'disarmed', previous: 'armed_away', at },
    { kind: 'alarm-disarmed', state: 'disarmed', previous: 'pending', at },
    { kind: 'alarm-disarmed', state: 'disarmed', previous: 'triggered', at },
    {
      kind: 'alarm-sensor-bypass',
      state: 'armed_away',
      previous: 'armed_away',
      at,
      sensor: { deviceId: 3243, event: 'ignored' },
    },
    {
      kind: 'alarm-sensor-bypass',
      state: 'armed_away',
      previous: 'armed_away',
      at,
      sensor: { deviceId: 3243, name: 'Finestra porch', event: 'lifted' },
    },
  )
  return out
}

/** One coverage row per SHAPE the derivation can produce. */
function coverageShapes(mode: AlarmArmMode): readonly NcAlarmModeCoverage[] {
  const base = {
    mode,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [],
    skippedDevices: [],
  } as const
  return [
    // Nothing is gated on the mode.
    { ...base, ruleCount: 0 },
    // Gated, unscoped — every device.
    { ...base, ruleCount: 1, allDevices: true },
    // Gated, unscoped, but every such rule excludes some devices (D641).
    { ...base, ruleCount: 1, allDevices: true, allDevicesExcept: [3] },
    // Gated, scoped to nothing in particular.
    { ...base, ruleCount: 2 },
    // Named devices, all armed.
    { ...base, ruleCount: 1, deviceIds: [1, 2] },
    // Named devices, some excluded.
    {
      ...base,
      ruleCount: 1,
      deviceIds: [1, 2],
      skippedDevices: [{ deviceId: 2, reason: 'muted' }],
    },
    // Named devices, ALL excluded.
    {
      ...base,
      ruleCount: 1,
      deviceIds: [1],
      skippedDevices: [{ deviceId: 1, reason: 'offline' }],
    },
  ]
}

/**
 * Every title/body key a row can carry — taken from `incomingFromAlarmTransition`
 * ITSELF, fed every shape of transition, so a variant the intake selects with
 * no sentence behind it fails here rather than on a phone.
 */
function producibleKeys(): readonly string[] {
  const keys = new Set<string>()
  for (const transition of sampleTransitions()) {
    const se = incomingFromAlarmTransition({
      transition,
      panelDeviceId: 900,
      lookup: () => undefined,
    }).subject.systemEvent
    if (se?.titleKey !== undefined) keys.add(se.titleKey)
    if (se?.bodyKey !== undefined) keys.add(se.bodyKey)
  }
  keys.add('alarm.device.unnamed')
  for (const mode of MODES) {
    for (const coverage of coverageShapes(mode)) {
      const armed = buildArmAnnouncement(coverage, NAME)
      const arming = buildArmingAnnouncement(coverage, 30, NAME)
      keys.add(armed.bodyKey)
      keys.add(arming.bodyKey)
      // Title keys the intake selects when these bodies are attached — including
      // the `.all` suffix for covered-everything modes (no finite Active count).
      const armedTitle = `system.alarm-armed.title.${mode}`
      const armingTitle = `system.alarm-arming.title.${mode}`
      keys.add(
        armed.titleKeySuffix !== undefined ? `${armedTitle}.${armed.titleKeySuffix}` : armedTitle,
      )
      keys.add(
        arming.titleKeySuffix !== undefined
          ? `${armingTitle}.${arming.titleKeySuffix}`
          : armingTitle,
      )
      // …and the same two sentences said by an arm that EXCLUDED something,
      // which selects a variant of its own in both builders.
      keys.add(buildArmAnnouncement(coverage, NAME, [1]).bodyKey)
      keys.add(buildArmingAnnouncement(coverage, 30, NAME, [1]).bodyKey)
    }
    keys.add(buildArmRefusedAnnouncement(mode, ['Finestra porch'], true).bodyKey)
    keys.add(buildArmRefusedAnnouncement(mode, ['Finestra porch'], false).bodyKey)
  }
  return [...keys].toSorted()
}

describe('the alarm text keys', () => {
  it('has a sample for EVERY alarm kind the schema declares', () => {
    const sampled = new Set<string>(sampleTransitions().map((t) => t.kind))
    expect(NC_ALARM_SYSTEM_EVENT_KINDS.filter((k) => !sampled.has(k))).toEqual([])
  })

  it('includes the mode titles, the defused disarm and both bypass bodies', () => {
    const keys = producibleKeys()
    for (const kind of ['alarm-pending', 'alarm-rearmed', 'alarm-check-failed']) {
      for (const mode of MODES) expect(keys).toContain(`system.${kind}.title.${mode}`)
    }
    expect(keys).toContain('system.alarm-disarmed.body.defused.pending')
    expect(keys).toContain('system.alarm-disarmed.body.defused.triggered')
    expect(keys).toContain('system.alarm-pending.body.rule')
    expect(keys).toContain('system.alarm-sensor-bypass.body.ignored')
    expect(keys).toContain('system.alarm-sensor-bypass.body.lifted')
    expect(keys).toContain('alarm.combined.title')
    // D706: a rule-caused trigger names the intrusion's locations.
    expect(keys).toContain('alarm.intrusion.body')
  })

  it.each(NC_LANGUAGES)('exist in %s, and none renders empty', (language) => {
    const bundle = NC_TEXT_BUNDLES[language]
    const missing = producibleKeys().filter((key) => bundle[key] === undefined)
    expect(missing).toEqual([])
  })

  it('render to a real sentence in every language', () => {
    // A key present but blank, or a plural map with no `other`, is the same
    // empty notification wearing a passing parity check.
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      for (const key of producibleKeys()) {
        // Only the name is supplied: `system.alarm-sensor-bypass.title` IS
        // the sensor's name, and every other key must still read as words.
        expect(
          catalog.text({ key, count: 2, vars: { deviceName: 'Finestra porch' } }).length,
          `${language}:${key}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('freezes the countdown the ARMING TITLE renders', () => {
    // The seconds moved out of the body and into the title, so the params have
    // to keep carrying them: a title key asking for `{{seconds}}` against a row
    // that froze none delivers "Inserimento Casa — s".
    const text = buildArmingAnnouncement(
      {
        mode: 'away',
        ruleCount: 1,
        allDevices: true,
        allDevicesExcept: [],
        deviceIds: [],
        skippedDevices: [],
      },
      30,
      NAME,
    )
    expect(text.textParams['seconds']).toBe('30')
    expect(text.titleKeySuffix).toBe('all')
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const title = catalog.text({
        key: 'system.alarm-arming.title.away.all',
        vars: text.textParams,
      })
      expect(title, language).toContain('30')
    }
  })

  it('puts active/skipped counts in the armed title for named coverage', () => {
    const text = buildArmAnnouncement(
      {
        mode: 'night',
        ruleCount: 1,
        allDevices: false,
        allDevicesExcept: [],
        deviceIds: [1, 2],
        skippedDevices: [{ deviceId: 2, reason: 'muted' }],
      },
      NAME,
    )
    expect(text.textParams['active']).toBe('1')
    expect(text.textParams['skipped']).toBe('1')
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const title = catalog.text({
        key: 'system.alarm-armed.title.night',
        vars: text.textParams,
      })
      expect(title, language).toMatch(/1/)
      expect(title.length, language).toBeGreaterThan(10)
    }
  })

  it('counts Arm-anyway bypasses in title skipped', () => {
    const text = buildArmAnnouncement(
      {
        mode: 'away',
        ruleCount: 1,
        allDevices: false,
        allDevicesExcept: [],
        deviceIds: [1, 2, 3],
        skippedDevices: [],
      },
      NAME,
      [2, 3],
    )
    expect(text.textParams['active']).toBe('1')
    expect(text.textParams['skipped']).toBe('2')
  })

  it('unions mute skipped and bypass without double-counting', () => {
    const text = buildArmAnnouncement(
      {
        mode: 'away',
        ruleCount: 1,
        allDevices: false,
        allDevicesExcept: [],
        deviceIds: [1, 2],
        skippedDevices: [{ deviceId: 2, reason: 'muted' }],
      },
      NAME,
      [2],
    )
    expect(text.textParams['active']).toBe('1')
    expect(text.textParams['skipped']).toBe('1')
  })

  it('says the refusal as a list, in both languages, and points at the button', () => {
    // The sentence an operator reads standing at the door: a header, WHICH
    // sensors are open as one bullet each (f74a47280), and the Arm anyway on
    // the last line — never a "repeat within N seconds", the second press that
    // bypassed is gone.
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const two = buildArmRefusedAnnouncement('home', ['Finestra porch', 'Porta retro'], true)
      const body = catalog.text({ key: two.bodyKey, count: two.textCount, vars: two.textParams })
      const lines = body.split('\n')
      expect(lines, language).toHaveLength(4)
      expect(lines.slice(1, 3), language).toEqual(['• Finestra porch', '• Porta retro'])
      expect(lines[3], language).toContain(catalog.text({ key: 'button.alarm.armAnyway' }))
      expect(two.textParams['seconds'], language).toBeUndefined()
    }
  })

  it('renders the COMBINED title in every language', () => {
    // The one title an alarm row can carry that is not `system.alarm-*`: the
    // severity marker over the camera name, shipped as `Alarm: {{deviceName}}`.
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const title = catalog.text({
        key: 'alarm.combined.title',
        vars: { deviceName: 'Front door' },
      })
      expect(title, language).toContain('Front door')
      expect(title.length, language).toBeGreaterThan('Front door'.length)
    }
  })
})

/**
 * A siren is an OPTIONAL action a rule may run — the alarm is a STATE. A sentence
 * that says "the siren ended" on a hub with no siren describes something that did
 * not happen (operator, 2026-10-06). Every alarm sentence names the state instead.
 */
describe('the alarm sentences describe the alarm state, never a siren', () => {
  it.each(NC_LANGUAGES)('%s: no alarm key mentions a siren', (language) => {
    const bundle = NC_TEXT_BUNDLES[language]
    const alarmKeys = Object.keys(bundle).filter(
      (key) => key.startsWith('system.alarm-') || key.startsWith('alarm.'),
    )
    const sirens = alarmKeys.filter((key) => /siren/i.test(JSON.stringify(bundle[key])))
    expect(sirens).toEqual([])
  })

  it('a disarm says whether the alarm had triggered or only the entry delay ran', () => {
    const bodyOf = (previous: 'pending' | 'triggered'): string | undefined =>
      incomingFromAlarmTransition({
        transition: { kind: 'alarm-disarmed', state: 'disarmed', previous, at: 1_000 },
        panelDeviceId: 900,
        lookup: () => undefined,
      }).subject.systemEvent?.bodyKey
    expect(bodyOf('pending')).toBe('system.alarm-disarmed.body.defused.pending')
    expect(bodyOf('triggered')).toBe('system.alarm-disarmed.body.defused.triggered')
  })
})
