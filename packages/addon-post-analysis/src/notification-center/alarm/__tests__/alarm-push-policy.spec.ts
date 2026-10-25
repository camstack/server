/**
 * D706, the pieces: the pure policy, the REAL panel's classification of a match, the
 * "watched again" switch and its duplicate check, the stock 30 s re-arm, and the words.
 */
import { NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../../dispatcher.js'
import type { NcOutboxEntry } from '../../outbox.js'
import type { NcRuleFireRef } from '../../rule-engine.js'
import { type NcLanguage, NcTextCatalog } from '../../text-catalog.js'
import { NcAlarmPanelDevice, type NcAlarmPublishReport } from '../alarm-panel-device.js'
import {
  alarmPushDecision,
  intrusionLocations,
  type NcAlarmMatchPhase,
} from '../alarm-push-policy.js'
import { DEFAULT_DELAYS } from '../alarm-state-machine.js'
import { makePanelContext, type NcTestLogLine } from './panel-test-context.js'

const T0 = Date.UTC(2026, 9, 5, 12, 10, 0)
const DOOR = 3243
const CAM = 101
const HEARD = { pending: true, triggered: true }

function ref(deviceId: number, trackId: string | undefined, extra: Partial<NcRuleFireRef> = {}) {
  const out: NcRuleFireRef = {
    ruleId: 'rule',
    ruleName: 'rule',
    deviceId,
    recordId: `rec-${trackId ?? deviceId}-${String(extra.timestamp ?? T0)}`,
    ...(trackId !== undefined ? { trackId } : {}),
    timestamp: T0,
    ...extra,
  }
  return out
}

describe('alarmPushDecision (pure)', () => {
  const away = 'away' as const
  const cases: readonly [string, NcAlarmMatchPhase, string][] = [
    ['no alarm phase', { kind: 'none' }, 'plain'],
    ['entry delay 0 — D126 combines it', { kind: 'triggers-now', mode: away }, 'plain'],
    ['starter', { kind: 'starts-entry-delay', mode: away }, 'suppress'],
    [
      'during the delay, mode silent',
      { kind: 'entry-delay', mode: away, notify: false },
      'suppress',
    ],
    [
      'during the delay, mode notifies',
      { kind: 'entry-delay', mode: away, notify: true },
      'intrusion',
    ],
    ['triggered', { kind: 'triggered', mode: away }, 'intrusion'],
    // D735: the sensor was open when the arm excluded it — the bypass logic speaks for it.
    ['the sensor is excluded by the arm', { kind: 'excluded', sensorDeviceId: DOOR }, 'suppress'],
  ]
  it.each(cases)('%s', (_name, phase, verdict) => {
    expect(alarmPushDecision(phase, HEARD).verdict.kind).toBe(verdict)
  })

  it('waives a suppression nobody would hear instead — and names it', () => {
    const starter = alarmPushDecision(
      { kind: 'starts-entry-delay', mode: 'away' },
      { pending: false, triggered: true },
    )
    expect(starter).toEqual({ verdict: { kind: 'plain' }, waived: 'alarm-entry-delay-started' })
    const follower = alarmPushDecision(
      { kind: 'entry-delay', mode: 'away', notify: false },
      { pending: true, triggered: false },
    )
    expect(follower).toEqual({ verdict: { kind: 'intrusion' }, waived: 'alarm-entry-delay' })
  })

  it('an EXCLUDED sensor is suppressed with its own reason, and never waived (D735)', () => {
    const phase: NcAlarmMatchPhase = { kind: 'excluded', sensorDeviceId: DOOR }
    // Nobody hears an alarm row for it — there is none, which is the point.
    for (const heard of [HEARD, { pending: false, triggered: false }]) {
      expect(alarmPushDecision(phase, heard)).toEqual({
        verdict: { kind: 'suppress', reason: 'alarm-sensor-excluded' },
      })
    }
  })

  it('a BYPASSED input is suppressed with its own reason, and never waived', () => {
    const phase: NcAlarmMatchPhase = { kind: 'bypassed', ruleId: 'r1', sensorDeviceId: DOOR }
    for (const heard of [HEARD, { pending: false, triggered: false }]) {
      expect(alarmPushDecision(phase, heard)).toEqual({
        verdict: { kind: 'suppress', reason: 'alarm-input-bypassed' },
      })
    }
  })

  it('names locations, falls back to the name, then the id — distinct, in order', () => {
    const known: Record<number, { location?: string | null; name?: string }> = {
      1: { location: 'Hall', name: 'Cam A' },
      2: { location: '  ', name: 'Porta' },
      3: { location: 'Hall', name: 'Cam B' },
    }
    expect(intrusionLocations([1, 2, 3, 4], (id) => known[id] ?? {})).toEqual([
      'Hall',
      'Porta',
      '4',
    ])
  })
})

interface PanelHarness {
  readonly panel: NcAlarmPanelDevice
  readonly logs: NcTestLogLine[]
  readonly reports: NcAlarmPublishReport[]
}

function buildPanel(config: Record<string, unknown>): PanelHarness {
  const logs: NcTestLogLine[] = []
  const reports: NcAlarmPublishReport[] = []
  const { ctx } = makePanelContext(config, logs)
  const panel = new NcAlarmPanelDevice(ctx)
  panel.setPublishHook((report) => reports.push(report))
  return { panel, logs, reports }
}

async function press(h: PanelHarness, source: NcRuleFireRef): Promise<NcAlarmMatchPhase> {
  const phase = h.panel.classifyRuleMatch(source)
  h.panel.triggerFromRule(source)
  return phase
}

describe('the panel classifies a match BEFORE it presses (D706)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('armed ⇒ starter; the same subject again ⇒ still the starter; another ⇒ entry delay; fired ⇒ triggered', async () => {
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 30, triggeredDurationSec: 30 })
    await h.panel.armWith('away')
    expect(await press(h, ref(CAM, 'trk-1'))).toEqual({ kind: 'starts-entry-delay', mode: 'away' })
    expect(h.panel.currentState()).toBe('pending')
    expect(await press(h, ref(CAM, 'trk-1'))).toEqual({ kind: 'starts-entry-delay', mode: 'away' })
    expect(await press(h, ref(CAM, 'trk-2'))).toEqual({
      kind: 'entry-delay',
      mode: 'away',
      notify: false,
    })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await press(h, ref(CAM, 'trk-3'))).toEqual({ kind: 'triggered', mode: 'away' })
    h.panel.stopCountdown()
  })

  it('reads the MODE its notify switch at the match', async () => {
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 30 })
    await h.panel.applySettings({ modeDelays: [{ mode: 'away', notifyDuringEntryDelay: true }] })
    await h.panel.armWith('away')
    await press(h, ref(CAM, 'trk-1'))
    expect(h.panel.classifyRuleMatch(ref(CAM, 'trk-2'))).toMatchObject({ notify: true })
    h.panel.stopCountdown()
  })

  it('entry delay 0 ⇒ triggers-now (the D126 combined row)', async () => {
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0 })
    await h.panel.armWith('home')
    expect(h.panel.classifyRuleMatch(ref(CAM, 'trk-1'))).toEqual({
      kind: 'triggers-now',
      mode: 'home',
    })
  })

  it('a press refused while TRIGGERED leaves no note for the next incident', async () => {
    const h = buildPanel({
      exitDelaySec: 0,
      entryDelaySec: 0,
      triggeredDurationSec: 10,
      postTriggeredAction: 'rearmAfter',
    })
    await h.panel.armWith('away')
    await press(h, ref(CAM, 'trk-1'))
    expect(h.panel.currentState()).toBe('triggered')
    await press(h, ref(CAM, 'trk-stale'))
    await vi.advanceTimersByTimeAsync(11_000)
    expect(h.panel.currentState()).toBe('armed_away')
    // The re-armed panel's next match is a STARTER, and the incident is about IT.
    expect(h.panel.classifyRuleMatch(ref(CAM, 'trk-new'))).toEqual({
      kind: 'triggers-now',
      mode: 'away',
    })
    await press(h, ref(CAM, 'trk-new'))
    const fired = h.reports.map((r) => r.transition).filter((t) => t?.kind === 'alarm-triggered')
    expect(fired.at(-1)?.source?.trackId).toBe('trk-new')
    h.panel.stopCountdown()
  })

  it('an excluded sensor that IS its own device (no sourceDeviceId) does not set the alarm off', async () => {
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0 })
    h.panel.setArmGuard({
      openings: async () => ({
        open: [
          { deviceId: DOOR, name: 'Porta', state: 'open', controllable: false, cap: 'contact' },
        ],
        unknown: [],
      }),
      secureOnArm: () => undefined,
      announceRefusal: () => undefined,
      announceCheckFailed: () => undefined,
    })
    await h.panel.applySettings({
      nonBlockingEdit: { mode: 'away', deviceId: DOOR, nonBlocking: true },
    })
    await h.panel.armWith('away')
    expect(h.panel.excludedDevices()).toEqual([DOOR])
    const own = ref(DOOR, undefined)
    expect(h.panel.classifyRuleMatch(own)).toEqual({ kind: 'excluded', sensorDeviceId: DOOR })
    await press(h, own)
    expect(h.panel.currentState()).toBe('armed_away')
  })
})

describe('"watched again" (D706)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function bypassedDoor(rewatched: boolean): Promise<PanelHarness> {
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 30 })
    h.panel.setArmGuard({
      openings: async () => ({
        open: [
          { deviceId: DOOR, name: 'Porta', state: 'open', controllable: false, cap: 'contact' },
        ],
        unknown: [],
      }),
      secureOnArm: () => undefined,
      announceRefusal: () => undefined,
      announceCheckFailed: () => undefined,
    })
    await h.panel.applySettings({
      nonBlockingEdit: { mode: 'away', deviceId: DOOR, nonBlocking: true },
      ...(rewatched ? { modeDelays: [{ mode: 'away', notifySensorRewatched: true }] } : {}),
    })
    await h.panel.armWith('away')
    h.panel.observeOpening(DOOR, 'secure')
    return h
  }

  const bypassReports = (h: PanelHarness) =>
    h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')

  it('OFF by default: lifted, logged with its reason, not announced', async () => {
    const h = await bypassedDoor(false)
    expect(h.panel.observeOpening(DOOR, 'open')).toBe('lifted')
    expect(bypassReports(h)).toEqual([])
    const line = h.logs.find((l) => l.message.includes('"watched again" not notified'))
    expect(line?.meta?.['reason']).toBe('rewatched-notify-off')
  })

  it('ON: announced when the sensor does NOT start the entry delay', async () => {
    const h = await bypassedDoor(true)
    h.panel.observeOpening(DOOR, 'open', Date.now(), { deferLiftAnnouncement: true })
    h.panel.announceLifted(DOOR)
    expect(bypassReports(h).map((r) => r.transition?.sensor)).toEqual([
      { deviceId: DOOR, event: 'lifted' },
    ])
  })

  it('ON: NOT announced when the same open starts the entry delay — its notification names it', async () => {
    const h = await bypassedDoor(true)
    h.panel.observeOpening(DOOR, 'open', Date.now(), { deferLiftAnnouncement: true })
    // The door's own rule presses the panel in the same evaluation…
    await press(h, ref(DOOR, undefined))
    expect(h.panel.currentState()).toBe('pending')
    // …and the deferred announcement then sees it.
    h.panel.announceLifted(DOOR)
    expect(bypassReports(h)).toEqual([])
    const line = h.logs.find((l) => l.message.includes('the same sensor started the entry delay'))
    expect(line?.deviceId).toBe(DOOR)
    expect(line?.meta?.['reason']).toBe('starts-entry-delay')
    h.panel.stopCountdown()
  })
})

describe('the stock after-trigger re-arm is 30 s (D706)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a panel with nothing stored re-arms 30 s after it triggers', async () => {
    expect(DEFAULT_DELAYS.triggeredDurationSec).toBe(NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC)
    const h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0 })
    expect(h.panel.settings().triggeredDurationSec).toBe(30)
    await h.panel.armWith('away')
    await press(h, ref(CAM, 'trk-1'))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(h.panel.currentState()).toBe('triggered')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.panel.currentState()).toBe('armed_away')
    h.panel.stopCountdown()
  })

  it('a STORED value is never rewritten — 10 stays 10', () => {
    const h = buildPanel({ triggeredDurationSec: 10, postTriggeredAction: 'rearmAfter' })
    expect(h.panel.settings().triggeredDurationSec).toBe(10)
  })

  it('the pre-D701 stock seed (0 + absent) migrates to the NEW stock value', () => {
    const h = buildPanel({ triggeredDurationSec: 0 })
    expect(h.panel.settings().triggeredDurationSec).toBe(30)
    expect(h.panel.settings().postTriggeredAction).toBe('rearmAfter')
  })
})

describe('the words (D706)', () => {
  function row(payload: Partial<NcOutboxEntry['payload']>): NcOutboxEntry {
    return {
      id: 'r',
      ruleId: 'rule-1',
      targetId: 'tgt-1',
      deviceId: CAM,
      recordKind: 'object-event',
      recordId: 'ev-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        ruleName: 'Persone in casa',
        delivery: 'immediate',
        priority: 3,
        media: 'none',
        subject: { deviceId: CAM, className: 'person', zones: [], timestamp: 1 },
        ...payload,
      },
    }
  }

  async function render(entry: NcOutboxEntry, language: NcLanguage) {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      texts: new NcTextCatalog({ language }),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'n', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Cam hallway',
    })
    await dispatcher.deliver(entry)
    return sends[0]?.notification
  }

  it('an intrusion push is titled with the locations, in English and in Italian', async () => {
    const intrusion = { alarmIntrusion: { locations: ['Hallway piano terra', 'Hall'] } }
    expect((await render(row(intrusion), 'en'))?.title).toBe(
      'Intrusion — Hallway piano terra, Hall',
    )
    const it = await render(row(intrusion), 'it')
    expect(it?.title).toBe('Intrusione — Hallway piano terra, Hall')
    // The body is the ordinary detection sentence.
    expect(it?.body).toBe('Persona su cam hallway')
  })

  it('the rule its own authored TITLE does not replace the intrusion title; a plain row keeps it', async () => {
    const template = { title: 'Qualcuno in casa' }
    expect(
      (await render(row({ template, alarmIntrusion: { locations: ['Hall'] } }), 'it'))?.title,
    ).toBe('Intrusione — Hall')
    expect((await render(row({ template }), 'it'))?.title).toBe('Qualcuno in casa')
  })

  it('a plain row is titled with the rule, as ever', async () => {
    expect((await render(row({}), 'en'))?.title).toBe('Persone in casa')
  })

  it('re-armed reads "Re-armed — <mode>" / "Riarmato — <mode>"', () => {
    expect(
      new NcTextCatalog({ language: 'en' }).text({ key: 'system.alarm-rearmed.title.away' }),
    ).toBe('Re-armed — away')
    expect(
      new NcTextCatalog({ language: 'it' }).text({ key: 'system.alarm-rearmed.title.away' }),
    ).toBe('Riarmato — Fuori')
  })
})
