/**
 * The alarm, as notifications — end to end through the real centre.
 *
 * The one property every test here defends: **one incident, one notification.**
 * A rule matches an intruder, its action sequence presses the panel, the panel
 * goes off — and what the operator receives is ONE push with the alarm's words
 * and that rule's photograph, not one push saying "person at the gate" followed
 * by a second saying "alarm". The join that makes that possible is fragile in
 * exactly two places, and both are exercised here rather than mocked:
 *
 *  - the ATTRIBUTION travels rule → action runner → the panel's `triggerFromRule`,
 *    the match IN the call (D735 — never parked in a slot for the cap to read), and
 *  - the alarm event travels panel → system-event intake → outbox.
 *
 * The panel here is the port the real device satisfies, holding the real
 * `NcAlarmAttribution`. A `DeviceContext` would add a kernel and nothing else:
 * every line of the join under test lives on this side of that interface.
 */
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import {
  type AlarmArmMode,
  DeviceType,
  NcRuleInputSchema,
  type ObjectEvent,
  type SensorEvent,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcAlarmExclusions } from '../alarm/alarm-exclusions.js'
import type { NcAlarmOpening } from '../alarm/alarm-openings.js'
import { NcAlarmAttribution, type NcAlarmTransition } from '../alarm/alarm-transitions.js'
import type { NcTargetRef } from '../dispatcher.js'
import { type NcAlarmPanelPort, NotificationCenter } from '../index.js'
import { type NcOutboxEntry } from '../outbox.js'
import { resolvePruneWindows } from '../prune-windows.js'
import type { NcRuleFireRef } from '../rule-engine.js'
import { NcTextCatalog } from '../text-catalog.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeTestObjectEvent } from '../../__tests__/support/events.js'

const PANEL_ID = 1023
const CAMERA_ID = 102
const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  { id: 'tgt-tablet', addonId: 'notifiers', name: 'tablet', kind: 'ntfy', enabled: true },
]

/**
 * The panel, as the centre sees it — plus the two test affordances the real
 * device gets from its cap provider and its publish tick.
 */
interface FakePanel extends NcAlarmPanelPort {
  /** Every press `triggerFromRule` received, as the panel claimed it — the join under test. */
  readonly presses: (NcRuleFireRef | null)[]
  readonly announceTargets: string[]
  announceArm: boolean
  /** What the real panel's exclusions would hold — see `NcAlarmExclusions`. */
  readonly excluded: number[]
  /** A REAL two-phase exclusion set, fed by `observeOpening` — the lift under test. */
  readonly exclusions: NcAlarmExclusions
}

function makePanel(): FakePanel {
  const attribution = new NcAlarmAttribution()
  const announceTargets: string[] = []
  const excluded: number[] = []
  const exclusions = new NcAlarmExclusions()
  const panel: FakePanel = {
    deviceId: PANEL_ID,
    announceArm: false,
    announceTargets,
    excluded,
    exclusions,
    excludedDevices: () => [...excluded, ...exclusions.list()],
    observeOpening: (deviceId, reading, now) => {
      const change = exclusions.observe(deviceId, reading, now ?? 0)
      return change === 'rearmed' ? 'lifted' : change
    },
    classifyRuleMatch: () => ({ kind: 'none' }),
    announceLifted: () => undefined,
    armWith: async () => ({ outcome: 'armed', excluded: [] }),
    armAnyway: async () => ({ outcome: 'rejected', reason: 'unknown-refusal' }),
    exclusionPhases: () => [],
    forgetExcluded: (deviceId) => {
      exclusions.forget(deviceId)
    },
    bypassInput: () => ({ outcome: 'refused', reason: 'disarmed' }),
    inputBypasses: () => [],
    pruneInputBypasses: () => undefined,
    currentState: () => 'disarmed',
    currentTarget: () => 'disarmed',
    disarm: async () => undefined,
    settings: () => ({
      exitDelaySec: 30,
      entryDelaySec: 20,
      triggeredDurationSec: 0,
      announceArm: panel.announceArm,
      announceTargets: [...announceTargets],
      modeDelays: [],
      nonBlocking: [],
      blocking: [],
      secureOnArmOff: [],
    }),
    applySettings: async () => panel.settings(),
    profilesView: () => ({
      activeId: 'default',
      items: [{ id: 'default', name: 'Default', isDefault: true }],
    }),
    createProfile: async () => {
      throw new Error('alarm profiles not wired in this fake')
    },
    renameProfile: async () => {
      throw new Error('alarm profiles not wired in this fake')
    },
    deleteProfile: async () => {
      throw new Error('alarm profiles not wired in this fake')
    },
    activateProfile: async () => {
      throw new Error('alarm profiles not wired in this fake')
    },
    availableModes: () => MODES,
    presses: [],
    triggerFromRule: (source) => {
      attribution.claim(source)
      panel.presses.push(attribution.current())
      return 'accepted'
    },
  }
  return panel
}

interface Harness {
  readonly center: NotificationCenter
  readonly panel: FakePanel
  readonly store: ReturnType<typeof makeFakeSettingsStore>
  /** Every actuation the centre made: the actuator's, and each press of the LOCAL panel's
   *  trigger (which never reaches the actuator — D735). */
  readonly actuations: { deviceId: number; cap: string; method: string }[]
  /** What the panel's trigger claimed, per press — the join under test. */
  readonly claimed: (NcRuleFireRef | null)[]
  rows(): NcOutboxEntry[]
}

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

async function makeHarness(
  /** What `readDeviceOpenings` answers — the openings the arm guard reads. */
  openings: ReadonlyMap<number, NcAlarmOpening> = new Map(),
  /** The mirror's reads, and how often the rule-reload tick runs. */
  mirror: {
    readonly readDeviceStates?: (ids: readonly number[]) => Promise<ReadonlyMap<number, string>>
    readonly reloadMs?: number
  } = {},
): Promise<Harness> {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const panel = makePanel()
  const actuations: { deviceId: number; cap: string; method: string }[] = []
  const claimed = panel.presses
  const press = panel.triggerFromRule
  panel.triggerFromRule = (source) => {
    actuations.push({ deviceId: PANEL_ID, cap: 'alarm-panel', method: 'trigger' })
    return press(source)
  }
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => resolvePruneWindows({}),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Cancello',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: CAMERA_ID, type: DeviceType.Camera, name: 'Cancello', isCamera: true },
      { deviceId: PANEL_ID, type: DeviceType.AlarmPanel, name: 'Alarm', isCamera: false },
    ],
    isCapDeviceScoped: () => true,
    // Any OTHER device's actuation. A press of the local panel's trigger never lands
    // here: the centre calls `triggerFromRule` with the match instead.
    actuate: async ({ deviceId, cap, method }) => {
      actuations.push({ deviceId, cap, method })
    },
    readDeviceOpenings: async (ids) => new Map([...openings].filter(([id]) => ids.includes(id))),
    ...(mirror.readDeviceStates !== undefined ? { readDeviceStates: mirror.readDeviceStates } : {}),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: mirror.reloadMs ?? 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  center.setAlarmPanel(panel)
  return {
    center,
    panel,
    store,
    actuations,
    claimed,
    rows: () =>
      [...(ncTable(world, 'outbox')?.entries() ?? [])].map(([id, data]) => ({
        ...(data as unknown as NcOutboxEntry),
        id,
      })),
  }
}

/** The detection rule: notifies with a photo AND presses the panel. */
async function makeIntrusionRule(
  center: NotificationCenter,
  targetIds: readonly string[] = ['tgt-phone'],
): Promise<string> {
  const { rule } = await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Intrusione',
      delivery: 'immediate',
      conditions: { classes: ['person'] },
      targets: targetIds.map((targetId) => ({ targetId })),
      media: { attach: 'best', gif: true },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      actions: {
        onTrigger: [
          {
            kind: 'do',
            action: {
              kind: 'cap',
              deviceId: PANEL_ID,
              cap: 'alarm-panel',
              method: 'trigger',
              args: {},
            },
          },
        ],
      },
    }),
  })
  return rule.id
}

/** The alarm rule: "tell me when the alarm goes off". */
async function makeAlarmRule(
  center: NotificationCenter,
  targetIds: readonly string[] = ['tgt-phone'],
  kinds: readonly string[] = ['alarm-triggered'],
): Promise<string> {
  const { rule } = await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Allarme',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: [...kinds] } },
      targets: targetIds.map((targetId) => ({ targetId })),
      throttle: { cooldownSec: 0, scope: 'rule' },
    }),
  })
  return rule.id
}

const ALARM_EV = {
  default: 70_001,
  armed: 70_002,
  disarmed: 70_003,
  one: 70_004,
  two: 70_005,
  cat: 70_006,
} as const

function objectEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return makeTestObjectEvent({
    id: ALARM_EV.default,
    deviceId: CAMERA_ID,
    trackId: 'trk-1',
    timestamp: 1_000,
    zones: [],
    ...overrides,
  })
}

/** The panel publishing a transition, as the real device's hook does. */
function publish(center: NotificationCenter, transition: NcAlarmTransition): void {
  const target =
    transition.state === 'disarmed' ? 'disarmed' : (`armed_${transition.mode ?? 'away'}` as const)
  center.onAlarmPublish({ state: transition.state, target, transition })
}

function triggered(source?: NcRuleFireRef): NcAlarmTransition {
  return {
    kind: 'alarm-triggered',
    state: 'triggered',
    previous: 'pending',
    at: 2_000,
    ...(source !== undefined ? { source } : {}),
  }
}

describe('the zone overlay names only the zone(s) this event triggered', () => {
  it('a rule on two zones, a subject in one: the row freezes that one to draw (prod 101)', async () => {
    const h = await makeHarness()
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Animale su Aiuola o Uscio',
        delivery: 'immediate',
        conditions: { classes: ['person'], zones: { ids: ['zone-aiuola', 'zone-uscio'] } },
        targets: [{ targetId: 'tgt-phone' }],
        media: { image: 'scene-boxes', showTriggerZone: true },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    h.center.onObjectEventPersisted(objectEvent({ zones: ['zone-uscio'] }))
    await vi.waitFor(() => expect(h.rows()).toHaveLength(1))
    const row = h.rows()[0]
    expect(row?.payload.mediaShowTriggerZone).toBe(true)
    // The still ladder keeps reading every zone the rule names…
    expect(row?.payload.triggerZoneIds).toEqual(['zone-aiuola', 'zone-uscio'])
    // …the picture outlines only the one the subject was in.
    expect(row?.payload.matchedZoneIds).toEqual(['zone-uscio'])
  })
})

describe('the COMBINED alarm notification', () => {
  it('keeps the SOURCE rule’s zones: the PLACE filter and the zone overlay survive the alarm (D897)', async () => {
    const h = await makeHarness()
    const { rule } = await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Intrusione Uscio',
        delivery: 'immediate',
        conditions: { classes: ['person'], zones: { ids: ['zone-uscio'] } },
        targets: [{ targetId: 'tgt-phone' }],
        media: { image: 'scene-boxes', showTriggerZone: true, showSubjectPath: true },
        throttle: { cooldownSec: 0, scope: 'rule-device' },
        actions: {
          onTrigger: [
            {
              kind: 'do',
              action: {
                kind: 'cap',
                deviceId: PANEL_ID,
                cap: 'alarm-panel',
                method: 'trigger',
                args: {},
              },
            },
          ],
        },
      }),
    })
    await makeAlarmRule(h.center)
    h.center.onObjectEventPersisted(objectEvent({ zones: ['zone-uscio'] }))
    await vi.waitFor(() => expect(h.claimed).toHaveLength(1))
    publish(h.center, triggered(h.claimed[0] ?? undefined))
    await vi.waitFor(() => {
      expect(h.rows()[0]?.payload.subject.systemEvent?.kind).toBe('alarm-triggered')
    })
    const row = h.rows()[0]
    expect(row?.payload.subject.systemEvent?.alarmSource?.ruleId).toBe(rule.id)
    expect(row?.payload.mediaImage).toBe('scene-boxes')
    // The system rule that says "the alarm went off" has no zone; the rule whose
    // pictures the row carries does — and those are the zones frozen.
    expect(row?.payload.triggerZoneIds).toEqual(['zone-uscio'])
    expect(row?.payload.matchedZoneIds).toEqual(['zone-uscio'])
    expect(row?.payload.mediaShowTriggerZone).toBe(true)
    // D903: the subject-path flag is frozen beside it.
    expect(row?.payload.mediaShowSubjectPath).toBe(true)
  })

  it('delivers ONE row carrying the alarm words and the rule’s media', async () => {
    const h = await makeHarness()
    const ruleId = await makeIntrusionRule(h.center)
    await makeAlarmRule(h.center)

    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
      expect(h.rows()).toHaveLength(1)
    })
    // THE JOIN. The attribution travelled rule → runner → `actuate` → panel,
    // and the panel is now holding the detection that pressed it. Nothing in
    // the cap call carried it: `alarm-panel.trigger` takes only a device id.
    const source = h.claimed[0]
    expect(source).toMatchObject({
      ruleId,
      ruleName: 'Intrusione',
      deviceId: CAMERA_ID,
      recordId: String(ALARM_EV.default),
      trackId: 'trk-1',
      eventId: String(ALARM_EV.default),
    })

    // The entry delay elapses and the siren sounds, carrying that rule.
    publish(h.center, triggered(source ?? undefined))

    await vi.waitFor(() => {
      const rows = h.rows()
      // ONE row, not two: the detection row was superseded by the alarm's.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload.subject.systemEvent?.kind).toBe('alarm-triggered')
    })
    const row = h.rows()[0]
    expect(row?.recordKind).toBe('system-event')
    // The alarm's SEVERITY over the camera (`Allarme: Cancello`); the body names
    // WHERE the intrusion went (D706) — the location, else the name, of each device.
    expect(row?.payload.subject.systemEvent?.titleKey).toBe('alarm.combined.title')
    expect(row?.payload.subject.systemEvent?.bodyKey).toBe('alarm.intrusion.body')
    expect(row?.payload.subject.systemEvent?.textParams).toMatchObject({
      rule: 'Intrusione',
      deviceName: 'Cancello',
      locations: 'Cancello',
    })
    // The detection vocabulary the body renders from, frozen on the fire ref.
    expect(row?.payload.subject.systemEvent?.alarmSource?.className).toBe('person')
    // …and the triggering rule's MEDIA POLICY and owners.
    expect(row?.payload.media).toBe('best')
    expect(row?.payload.mediaGif).toBe(true)
    expect(row?.payload.subject.trackId).toBe('trk-1')
    expect(row?.payload.subject.eventId).toBe(String(ALARM_EV.default))
    expect(row?.payload.subject.systemEvent?.alarmSource?.ruleId).toBe(ruleId)
  })

  it('a target reached by the intrusion rule and an alarm rule gets exactly ONE combined row', async () => {
    const h = await makeHarness()
    const alarmRuleId = await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    const ruleId = await makeIntrusionRule(h.center, ['tgt-phone'])
    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
      expect(h.rows()).toHaveLength(1)
    })
    publish(h.center, triggered(h.claimed[0] ?? undefined))
    await vi.waitFor(() => {
      const kinds = h.rows().map((r) => r.payload.subject.systemEvent?.kind)
      expect(kinds).toEqual(['alarm-triggered'])
    })
    const row = h.rows()[0]
    expect(row?.targetId).toBe('tgt-phone')
    expect(row?.ruleId).toBe(alarmRuleId)
    expect(row?.payload.subject.systemEvent?.titleKey).toBe('alarm.combined.title')
    expect(row?.payload.media).toBe('best')
    expect(row?.payload.mediaGif).toBe(true)
    expect(row?.payload.subject.trackId).toBe('trk-1')
    expect(row?.payload.subject.eventId).toBe(String(ALARM_EV.default))
    expect(row?.payload.subject.systemEvent?.alarmSource?.ruleId).toBe(ruleId)
  })

  it('leaves the detection row alone for a target the alarm never reached', async () => {
    // Two audiences, deliberately configured that way. Superseding the tablet's
    // detection row because the phone got an alarm would silence somebody the
    // alarm rule never addressed.
    const h = await makeHarness()
    const ruleId = await makeIntrusionRule(h.center, ['tgt-phone', 'tgt-tablet'])
    await makeAlarmRule(h.center, ['tgt-phone'])

    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(2)
    })
    publish(
      h.center,
      triggered({
        ruleId,
        ruleName: 'Intrusione',
        deviceId: CAMERA_ID,
        recordId: String(ALARM_EV.default),
        trackId: 'trk-1',
        timestamp: 1_000,
      }),
    )
    await vi.waitFor(() => {
      const rows = h.rows()
      expect(rows).toHaveLength(2)
      // The tablet keeps its detection notification; the phone gets the alarm.
      expect(rows.filter((r) => r.targetId === 'tgt-tablet')[0]?.recordKind).toBe('object-event')
      expect(rows.filter((r) => r.targetId === 'tgt-phone')[0]?.recordKind).toBe('system-event')
    })
  })

  it('a MANUAL trigger is a plain alarm — no rule, no picture', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center)
    publish(h.center, triggered())
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const row = h.rows()[0]
    expect(row?.payload.subject.systemEvent?.bodyKey).toBe('system.alarm-triggered.body')
    expect(row?.payload.media).toBe('none')
    expect(row?.payload.subject.trackId).toBeUndefined()
    expect(row?.payload.subject.systemEvent?.alarmSource).toBeUndefined()
    // Addressed to the panel itself, since nothing else was involved.
    expect(row?.deviceId).toBe(PANEL_ID)
  })

  it('an ENTRY-DELAY announcement carries the triggering rule’s pictures', async () => {
    // The first alarm push the operator sees while the countdown runs. Without
    // the source on `alarm-pending`, the siren was text-only even when the
    // sensor already owned a snapshot.
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-pending'])
    const ruleId = await makeIntrusionRule(h.center, ['tgt-tablet'])
    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
    })
    const source = h.claimed[0]
    expect(source).toMatchObject({ ruleId, trackId: 'trk-1' })
    publish(h.center, {
      kind: 'alarm-pending',
      state: 'pending',
      previous: 'armed_night',
      at: 1_500,
      seconds: 20,
      ...(source !== null ? { source } : {}),
    })
    await vi.waitFor(() => {
      const rows = h.rows().filter((r) => r.payload.subject.systemEvent?.kind === 'alarm-pending')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload.media).toBe('best')
      expect(rows[0]?.payload.subject.trackId).toBe('trk-1')
      expect(rows[0]?.payload.subject.systemEvent?.alarmSource?.ruleId).toBe(ruleId)
      // The camera that set it off — not the panel — so the still ladder has a home.
      expect(rows[0]?.deviceId).toBe(CAMERA_ID)
      expect(rows[0]?.payload.subject.deviceId).toBe(CAMERA_ID)
    })
  })
})

describe('the incident MOSAIC on the combined row (D705)', () => {
  it('a triggered alarm whose entry delay saw two subjects carries both as one group, and withdraws both rows', async () => {
    const h = await makeHarness()
    await makeIntrusionRule(h.center)
    const alarmRuleId = await makeAlarmRule(h.center)
    h.center.onObjectEventPersisted(objectEvent())
    h.center.onObjectEventPersisted(
      objectEvent({ id: 2, trackId: 'trk-2', deviceId: CAMERA_ID, timestamp: 1_500 }),
    )
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(2)
      expect(h.rows()).toHaveLength(2)
    })
    const [source, follower] = h.claimed
    if (source === null || source === undefined || follower === null || follower === undefined) {
      throw new Error('both matches should have left a fire ref')
    }
    publish(h.center, { ...triggered(source), followers: [follower] })
    await vi.waitFor(() => {
      // ONE row: the source's AND the follower's pending detection rows are gone.
      const kinds = h.rows().map((r) => r.payload.subject.systemEvent?.kind)
      expect(kinds).toEqual(['alarm-triggered'])
    })
    const row = h.rows()[0]
    expect(row?.ruleId).toBe(alarmRuleId)
    // The words are still the SOURCE's combined sentence…
    expect(row?.payload.subject.systemEvent?.titleKey).toBe('alarm.combined.title')
    expect(row?.payload.subject.trackId).toBe('trk-1')
    // …and the picture is the incident: the D692 group the dispatcher tiles.
    expect(row?.payload.group).toMatchObject({
      version: 2,
      openedAt: source.timestamp,
      closeReason: 'deadline',
      members: [
        {
          trackId: 'trk-1',
          className: 'person',
          eventId: String(ALARM_EV.default),
          eventDeviceId: CAMERA_ID,
        },
        { trackId: 'trk-2', className: 'person', eventId: '2', eventDeviceId: CAMERA_ID },
      ],
    })
    expect(row?.payload.subject.systemEvent?.alarmFollowers?.map((f) => f.trackId)).toEqual([
      'trk-2',
    ])
  })

  it('a triggered alarm with ONE subject writes no group — the D126 row byte for byte', async () => {
    const h = await makeHarness()
    await makeIntrusionRule(h.center)
    await makeAlarmRule(h.center)
    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
    })
    publish(h.center, triggered(h.claimed[0] ?? undefined))
    await vi.waitFor(() => {
      expect(h.rows().map((r) => r.payload.subject.systemEvent?.kind)).toEqual(['alarm-triggered'])
    })
    expect(h.rows()[0]?.payload).not.toHaveProperty('group')
    expect(h.rows()[0]?.payload.subject.systemEvent).not.toHaveProperty('alarmFollowers')
  })
})

describe('arm and disarm', () => {
  it('an ARM notifies the rule that asked, and says what it covers', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-armed'])
    // One enabled rule gated on `armed_away`, scoped to the camera.
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'gate away',
        delivery: 'immediate',
        conditions: {
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
          devices: [CAMERA_ID],
        },
        targets: [{ targetId: 'tgt-phone' }],
      }),
    })
    publish(h.center, {
      kind: 'alarm-armed',
      state: 'armed_away',
      previous: 'arming',
      mode: 'away',
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const se = h.rows()[0]?.payload.subject.systemEvent
    expect(se?.kind).toBe('alarm-armed')
    expect(se?.titleKey).toBe('system.alarm-armed.title.away')
    // The mode's coverage, frozen as a key + the counts it pluralises on.
    expect(se?.bodyKey).toBe('alarm.arm.body.devices')
    expect(se?.textCount).toBe(1)
    expect(se?.textParams).toMatchObject({ names: '• Cancello', devices: '1', rules: '1' })
  })

  it('an alarm rule delivers once per target — no panel announce path doubles it', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone', 'tgt-tablet'], ['alarm-armed'])
    publish(h.center, {
      kind: 'alarm-armed',
      state: 'armed_away',
      previous: 'disarmed',
      mode: 'away',
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(2)
    })
    const rows = h.rows()
    expect(rows.filter((r) => r.targetId === 'tgt-phone')).toHaveLength(1)
    expect(rows.filter((r) => r.targetId === 'tgt-tablet')).toHaveLength(1)
    expect(rows.every((r) => r.ruleId !== 'nc-alarm-announce')).toBe(true)
  })

  it('SAYS a mode no enabled rule is gated on arms nothing', async () => {
    // This used to send nothing at all — "Night armed" followed by an unwatched
    // night is a false assurance, so the announcement was suppressed. But the
    // `alarm-armed` EVENT went out regardless, under a fallback body key that
    // existed in neither locale: the operator's rule delivered a title with an
    // empty line under it. The third option is the one the operator asked for.
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-armed'])
    publish(h.center, {
      kind: 'alarm-armed',
      state: 'armed_night',
      previous: 'disarmed',
      mode: 'night',
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const se = h.rows()[0]?.payload.subject.systemEvent
    expect(se?.bodyKey).toBe('alarm.arm.body.uncovered')
    // Rendered, not just keyed — the empty-body bug was invisible in the key.
    expect(new NcTextCatalog().text({ key: se?.bodyKey ?? '', count: se?.textCount })).not.toBe('')
  })

  /**
   * THE EXIT DELAY, end to end. The operator's report: "non arriva un messaggio
   * quando l'allarme sta in arming" [no message arrives when the alarm is in arming]. Nothing covered the window between
   * pressing Arm and being armed — the panel published `arming` once a second
   * for thirty seconds and produced not one event.
   */
  it('an ARMING notifies at the START of the exit delay, with Active devices named', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arming'])
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'gate away',
        delivery: 'immediate',
        conditions: {
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
          devices: [CAMERA_ID],
        },
        targets: [{ targetId: 'tgt-phone' }],
      }),
    })
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'away',
      seconds: 30,
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const se = h.rows()[0]?.payload.subject.systemEvent
    expect(se?.kind).toBe('alarm-arming')
    expect(se?.titleKey).toBe('system.alarm-arming.title.away')
    expect(se?.bodyKey).toBe('alarm.arming.body.devices')
    expect(se?.textParams).toMatchObject({ seconds: '30', names: '• Cancello', devices: '1' })
    expect(se?.textCount).toBe(30)
  })

  it('an ARMING with a muted covered device lists Active and Skipped', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arming'])
    const otherCam = 108
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'gate away',
        delivery: 'immediate',
        conditions: {
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
          devices: [CAMERA_ID, otherCam],
        },
        targets: [{ targetId: 'tgt-phone' }],
      }),
    })
    // Mute is the centre's own switch — answered before the directory is
    // consulted — so 618 need not be mirrored to count as Skipped.
    await h.center.buildProvider().setDeviceMuted({ deviceId: otherCam, muted: true })
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'away',
      seconds: 30,
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const se = h.rows()[0]?.payload.subject.systemEvent
    expect(se?.bodyKey).toBe('alarm.arming.body.devicesSkipped')
    expect(se?.textParams).toMatchObject({
      names: '• Cancello',
      skippedNames: '• Device 108',
      seconds: '30',
    })
  })

  it('an ARMING into a mode that watches nothing says so WHILE it can be cancelled', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arming'])
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'night',
      seconds: 30,
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    expect(h.rows()[0]?.payload.subject.systemEvent?.bodyKey).toBe('alarm.arming.body.uncovered')
  })

  it('shows an arming row in history under its OWN kind (the hub closure knows it)', async () => {
    // The downgrade to `alarm-armed` is gone: @camstack/server 1.2.379
    // (@camstack/types 1.2.249), installed on every node, carries every alarm
    // kind in `NcSystemEventKindSchema`.
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arming'])
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'away',
      seconds: 30,
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const { entries } = await h.center.buildProvider().getHistory({ filter: { limit: 10 } })
    expect(entries[0]?.subject.systemEvent?.kind).toBe('alarm-arming')
    // No rule is gated on `armed_away` in this harness, so the body is the
    // list line that says so. The countdown is in the TITLE.
    expect(entries[0]?.subject.systemEvent?.body).toBe('Active: none — no rule uses this mode')
    expect(entries[0]?.subject.systemEvent?.title).toBe('Arming away — 30s (0 active, 0 skipped)')
  })

  it('an arming rule reaches its targets (panel announce is gone)', async () => {
    const h = await makeHarness()
    const ruleId = await makeAlarmRule(h.center, ['tgt-tablet'], ['alarm-arming'])
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'away',
      seconds: 30,
      at: 3_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const row = h.rows()[0]
    expect(row?.targetId).toBe('tgt-tablet')
    expect(row?.ruleId).toBe(ruleId)

    expect(row?.payload.subject.systemEvent?.kind).toBe('alarm-arming')
  })

  it('a DISARM is its own notification', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-disarmed'])
    publish(h.center, {
      kind: 'alarm-disarmed',
      state: 'disarmed',
      previous: 'pending',
      at: 4_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    expect(h.rows()[0]?.payload.subject.systemEvent?.titleKey).toBe('system.alarm-disarmed.title')
  })
})

describe('the gate the panel feeds', () => {
  it('answers the new state IMMEDIATELY, without waiting for the reload tick', async () => {
    const h = await makeHarness()
    // A rule gated on `armed_away`, so the panel is watched at all.
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'gate away',
        delivery: 'immediate',
        conditions: {
          classes: ['person'],
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
        },
        targets: [{ targetId: 'tgt-phone' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    h.center.onAlarmPublish({ state: 'armed_away', target: 'armed_away', transition: null })
    h.center.onObjectEventPersisted(objectEvent({ id: ALARM_EV.armed }))
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })

    // Disarm. No reload tick runs; the very next event must NOT fire.
    h.center.onAlarmPublish({ state: 'disarmed', target: 'disarmed', transition: null })
    h.center.onObjectEventPersisted(objectEvent({ id: ALARM_EV.disarmed, trackId: 'trk-2' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.rows()).toHaveLength(1)
  })

  /**
   * D630: `armed_away` also covers the panel's own `pending` and `triggered`
   * while the target is `armed_away` — an intruder keeps being reported through
   * the entry delay and the siren. Never while arming, never for another mode.
   */
  it('a rule gated on armed_away keeps firing through pending and triggered of AWAY only', async () => {
    const h = await makeHarness()
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'intruder while away',
        delivery: 'immediate',
        conditions: {
          classes: ['person'],
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
        },
        targets: [{ targetId: 'tgt-phone' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
    let n = 0
    const fire = (): void => {
      n += 1
      h.center.onObjectEventPersisted(objectEvent({ id: 71_000 + n, trackId: `trk-${n}` }))
    }

    h.center.onAlarmPublish({ state: 'pending', target: 'armed_away', transition: null })
    fire()
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    h.center.onAlarmPublish({ state: 'triggered', target: 'armed_away', transition: null })
    fire()
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(2)
    })

    // Another mode's entry delay and siren: not this rule's business.
    h.center.onAlarmPublish({ state: 'pending', target: 'armed_night', transition: null })
    fire()
    h.center.onAlarmPublish({ state: 'triggered', target: 'armed_night', transition: null })
    fire()
    // Arming towards away: people are still leaving.
    h.center.onAlarmPublish({ state: 'arming', target: 'armed_away', transition: null })
    fire()
    h.center.onAlarmPublish({ state: 'disarmed', target: 'disarmed', transition: null })
    fire()
    await settle()
    expect(h.rows()).toHaveLength(2)
  })
})

/**
 * G3: the cooldown is a budget for NOTIFICATIONS.
 *
 * It was also, silently, a budget for physical actions — the `continue` that
 * suppressed the second notification skipped the action runner with it, so a
 * second intruder inside the window did not arm the alarm, did not open the
 * gate and did not sound the siren. The sequence runner's own `minDelaySec`
 * exists precisely because "how often may this gate physically move" is a
 * different question, and it was unreachable.
 */
describe('a cooling rule still ACTUATES', () => {
  it('two events inside the cooldown: one notification, two sequence runs', async () => {
    const h = await makeHarness()
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Intrusione',
        delivery: 'immediate',
        conditions: { classes: ['person'] },
        targets: [{ targetId: 'tgt-phone' }],
        // A minute of silence per camera — and nothing at all about the alarm.
        throttle: { cooldownSec: 60, scope: 'rule-device' },
        actions: {
          onTrigger: [
            {
              kind: 'do',
              action: {
                kind: 'cap',
                deviceId: PANEL_ID,
                cap: 'alarm-panel',
                method: 'trigger',
                args: {},
              },
            },
          ],
        },
      }),
    })

    h.center.onObjectEventPersisted(objectEvent({ id: ALARM_EV.one, trackId: 'trk-1' }))
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
      expect(h.actuations).toHaveLength(1)
    })

    // A second person, seconds later. The notification is rightly suppressed.
    h.center.onObjectEventPersisted(objectEvent({ id: ALARM_EV.two, trackId: 'trk-2' }))
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(2)
    })
    expect(h.rows()).toHaveLength(1)
  })

  it('a rule that did NOT match actuates nothing', async () => {
    // The gate that must stay: moving the runner above the cooldown must not
    // have moved it above the MATCH.
    const h = await makeHarness()
    await makeIntrusionRule(h.center)
    h.center.onObjectEventPersisted(objectEvent({ id: ALARM_EV.cat, className: 'cat' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.actuations).toEqual([])
  })

  it('a rule gated on armed_* auto-triggers the panel with no onTrigger sequence (D701)', async () => {
    const h = await makeHarness()
    await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Allarme notte — persona',
        delivery: 'immediate',
        conditions: {
          classes: ['person'],
          deviceState: { deviceId: PANEL_ID, states: ['armed_night'] },
        },
        targets: [{ targetId: 'tgt-phone' }],
        throttle: { cooldownSec: 0, scope: 'rule-device' },
      }),
    })
    h.center.onAlarmPublish({ state: 'armed_night', target: 'armed_night', transition: null })
    h.center.onObjectEventPersisted(objectEvent())
    await vi.waitFor(() => {
      expect(h.actuations).toEqual([{ deviceId: PANEL_ID, cap: 'alarm-panel', method: 'trigger' }])
    })
    // No siren switch — only the panel.
    expect(h.actuations.every((a) => a.cap === 'alarm-panel')).toBe(true)
  })
})

/**
 * ARM BLOCKING — the refusal, end to end through the ordinary notification
 * path, and the contact set it is derived from.
 *
 * The unit halves are pinned in `alarm-arm-guard.spec.ts` and
 * `alarm-arm-refusal.spec.ts`. What is left, and what this file is for, is the
 * join: the centre derives the contacts from the SAME rules coverage reads,
 * reads their state through the one authority, and the refusal comes out as a
 * durable row a phone can render.
 */
describe('arm blocking on open contacts', () => {
  const PORCH = 3243
  const RETRO = 3272

  /** The operator's live rule: contacts, gated on `armed_home`. */
  async function makeContactRule(
    center: NotificationCenter,
    devices: readonly number[] = [PORCH, RETRO],
  ): Promise<void> {
    await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: '[TEST] Intrusione Home — contatti',
        delivery: 'device-event',
        conditions: {
          deviceState: { deviceId: PANEL_ID, states: ['armed_home'] },
          devices: [...devices],
          sensorKinds: ['contact'],
        },
        targets: [{ targetId: 'tgt-phone' }],
      }),
    })
  }

  const open = (state: string): NcAlarmOpening => ({
    kind: 'reading',
    reading: 'open',
    state,
    cap: 'contact',
  })
  const secure = (state: string): NcAlarmOpening => ({
    kind: 'reading',
    reading: 'secure',
    state,
    cap: 'contact',
  })
  const GARAGE = 4001

  it('reports the covered devices that read OPEN — covers and locks too', async () => {
    const h = await makeHarness(
      new Map<number, NcAlarmOpening>([
        [PORCH, open('open')],
        [RETRO, secure('closed')],
        [GARAGE, open('stopped')],
        [CAMERA_ID, { kind: 'not-opening' }],
      ]),
    )
    await makeContactRule(h.center, [PORCH, RETRO, GARAGE, CAMERA_ID])
    const result = await h.center.alarmArmGuard().openings('home')
    expect(result.open.map((d) => [d.deviceId, d.state])).toEqual([
      [PORCH, 'open'],
      [GARAGE, 'stopped'],
    ])
    // The camera an intrusion rule names is not an opening: no part, no word.
    expect(result.unknown).toEqual([])
  })

  it('an unreadable or unknown device is UNKNOWN — never open, never secure', async () => {
    const h = await makeHarness(
      new Map<number, NcAlarmOpening>([
        [PORCH, open('open')],
        [RETRO, { kind: 'unknown', cap: 'cover', raw: 'ajar' }],
        // GARAGE absent — its read failed.
      ]),
    )
    await makeContactRule(h.center, [PORCH, RETRO, GARAGE])
    const result = await h.center.alarmArmGuard().openings('home')
    expect(result.open.map((d) => d.deviceId)).toEqual([PORCH])
    expect(result.unknown).toEqual([RETRO, GARAGE])
  })

  it('blocks nothing for a mode no rule is gated on', async () => {
    const h = await makeHarness(new Map([[PORCH, open('open')]]))
    await makeContactRule(h.center)
    expect(await h.center.alarmArmGuard().openings('away')).toEqual({ open: [], unknown: [] })
  })

  it('THROWS when nothing could be read, so the panel arms and says so', async () => {
    const h = await makeHarness(new Map())
    await makeContactRule(h.center)
    await expect(h.center.alarmArmGuard().openings('home')).rejects.toThrow(/could be read/)
  })

  it('delivers the refusal as a durable row via an alarm rule', async () => {
    const h = await makeHarness(new Map([[PORCH, open('open')]]))
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    const refusalId = `refusal:${String(PANEL_ID)}:home:4000:1`
    h.center.alarmArmGuard().announceRefusal({
      refusal: {
        id: refusalId,
        mode: 'home',
        blockingIds: [PORCH],
        blocking: [{ deviceId: PORCH, name: 'Finestra porch', state: 'open', controllable: false }],
        at: 4_000,
        panelChangedAt: 0,
      },
      blocking: [{ deviceId: PORCH, name: 'Finestra porch', state: 'open', controllable: false }],
      state: 'armed_night',
      at: 4_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const row = h.rows()[0]
    expect(row?.targetId).toBe('tgt-phone')
    const se = row?.payload.subject.systemEvent
    expect(se?.kind).toBe('alarm-arm-refused')
    expect(se?.titleKey).toBe('system.alarm-arm-refused.title.home')
    expect(se?.bodyKey).toBe('alarm.armRefused.body.hint')
    expect(se?.textParams).toMatchObject({ names: '• Finestra porch' })
    expect(se?.textParams?.['seconds']).toBeUndefined()
    // The state is the panel's REAL one — armed night, refused a switch to
    // home — never a hard-coded `disarmed`. And the refusal the row's Arm
    // anyway is bound to is FROZEN on it.
    expect(se?.data).toMatchObject({ state: 'armed_night', previous: 'armed_night', refusalId })

    // …and it renders, in a language, naming the sensor. A key with no
    // sentence behind it delivers a title and an empty line — which is exactly
    // how the arm announcement shipped broken once already.
    const { entries } = await h.center.buildProvider().getHistory({ filter: { limit: 10 } })
    expect(entries[0]?.subject.systemEvent?.kind).toBe('alarm-arm-refused')
    expect(entries[0]?.subject.systemEvent?.body).toBe(
      'Open:\n• Finestra porch\nTap “Arm anyway” to arm with them excluded.',
    )
  })

  it('a CHECK FAILURE is a notification row, not only a line', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-check-failed'])
    h.center.alarmArmGuard().announceCheckFailed({
      mode: 'away',
      state: 'arming',
      at: 6_000,
      error: 'Error: device-manager unreachable',
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const row = h.rows()[0]
    expect(row?.targetId).toBe('tgt-phone')
    const se = row?.payload.subject.systemEvent
    expect(se?.kind).toBe('alarm-check-failed')
    expect(se?.titleKey).toBe('system.alarm-check-failed.title.away')
    // The state the arm LANDS in, not the disarmed it left.
    expect(se?.data).toMatchObject({ state: 'arming', previous: 'arming' })
    const { entries } = await h.center.buildProvider().getHistory({ filter: { limit: 10 } })
    expect(entries[0]?.subject.systemEvent?.title).toBe('Armed away without checking openings')
    expect(entries[0]?.subject.systemEvent?.body).toBe('The device states could not be read')
  })

  it('the alarm mirrors NOTHING in the state cache — it reads openings', async () => {
    const reads: (readonly number[])[] = []
    const openings = new Map<number, NcAlarmOpening>()
    const h = await makeHarness(openings, {
      reloadMs: 10,
      readDeviceStates: async (ids) => {
        reads.push([...ids])
        return new Map()
      },
    })
    await makeContactRule(h.center, [PORCH, RETRO, CAMERA_ID])
    h.panel.exclusions.exclude([PORCH], 0)
    // The reconcile tick reads the EXCLUDED device's opening and lifts it:
    // secure first, then open.
    openings.set(PORCH, secure('closed'))
    await vi.waitFor(() => {
      expect(h.panel.exclusions.snapshot()[0]?.phase).toBe('closed')
    })
    openings.set(PORCH, open('open'))
    await vi.waitFor(() => {
      expect(h.panel.excludedDevices()).toEqual([])
    })
    // Neither a covered device nor an excluded one is mirrored as a
    // collapsed state word: nothing reads it.
    expect(reads.some((ids) => ids.some((id) => [PORCH, RETRO, CAMERA_ID].includes(id)))).toBe(
      false,
    )
  })

  const COVER = 5001
  const LOCK = 5002
  function sensorEvent(
    sourceDeviceId: number,
    kind: string,
    value: Record<string, unknown>,
  ): SensorEvent {
    return {
      id: `se-${String(sourceDeviceId)}-${kind}`,
      deviceId: sourceDeviceId,
      sourceDeviceId,
      kind,
      value,
      timestamp: 10,
    }
  }

  it('an excluded COVER is released after it closes and re-arms on the next opening (event path)', async () => {
    const h = await makeHarness()
    h.panel.exclusions.exclude([COVER], 0)
    h.center.onUnownedSensorEvent(sensorEvent(COVER, 'cover', { state: 'closing' }), [])
    expect(h.panel.exclusions.snapshot()[0]?.phase).toBe('open')
    h.center.onUnownedSensorEvent(sensorEvent(COVER, 'cover', { state: 'closed' }), [])
    expect(h.panel.exclusions.snapshot()[0]?.phase).toBe('closed')
    h.center.onUnownedSensorEvent(sensorEvent(COVER, 'cover', { state: 'opening' }), [])
    expect(h.panel.excludedDevices()).toEqual([])
  })

  it('an excluded LOCK is released after it locks and re-arms when unlocked (event path)', async () => {
    const h = await makeHarness()
    h.panel.exclusions.exclude([LOCK], 0)
    h.center.onUnownedSensorEvent(sensorEvent(LOCK, 'lock', { state: 'locked' }), [])
    expect(h.panel.exclusions.snapshot()[0]?.phase).toBe('closed')
    h.center.onUnownedSensorEvent(sensorEvent(LOCK, 'lock', { state: 'unlocked' }), [])
    expect(h.panel.excludedDevices()).toEqual([])
  })

  it('an UNKNOWN reading changes nothing', async () => {
    const h = await makeHarness()
    h.panel.exclusions.exclude([COVER], 0)
    h.center.onUnownedSensorEvent(sensorEvent(COVER, 'cover', { state: 'ajar' }), [])
    h.center.onUnownedSensorEvent(sensorEvent(COVER, 'cover', { state: 'opening' }), [])
    expect(h.panel.excludedDevices()).toEqual([COVER])
    expect(h.panel.exclusions.snapshot()[0]?.phase).toBe('open')
  })

  it('names the excluded sensor in the ARMED sentence', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-armed'])
    h.panel.excluded.push(PORCH)
    publish(h.center, {
      kind: 'alarm-armed',
      state: 'armed_home',
      previous: 'arming',
      mode: 'home',
      at: 5_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    const se = h.rows()[0]?.payload.subject.systemEvent
    expect(se?.bodyKey).toBe('alarm.arm.body.bypassed')
    expect(se?.textParams).toMatchObject({ bypassedNames: '• Device 3243' })
  })

  it('names it in the ARMING sentence too — while the operator can still fix it', async () => {
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arming'])
    h.panel.excluded.push(PORCH)
    publish(h.center, {
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'home',
      seconds: 30,
      at: 5_000,
    })
    await vi.waitFor(() => {
      expect(h.rows()).toHaveLength(1)
    })
    expect(h.rows()[0]?.payload.subject.systemEvent?.bodyKey).toBe('alarm.arming.body.bypassedOnly')
  })
})

/**
 * The provenance the exclusion depends on.
 *
 * `alarm-panel.trigger` takes a device id and nothing else, so the ONLY way the
 * panel can know which sensor is about to set it off is the attribution the
 * centre notes immediately before the actuation. If it carries the camera and
 * not the contact, every exclusion silently stops working and the bypassed
 * window sets the alarm off — with no line saying why.
 */
describe('the sensor rides the attribution', () => {
  const PORCH = 3243
  const CAM_B = 618
  const MOSAIC = 'nc-mosaic:alarm-test'
  const TILE_A = 'nc-linked:a'
  const TILE_B = 'nc-linked:b'

  async function makeContactTriggerRule(
    center: NotificationCenter,
    targetIds: readonly string[] = ['tgt-phone'],
  ): Promise<string> {
    const { rule } = await center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'contatti',
        delivery: 'device-event',
        conditions: { devices: [PORCH], sensorKinds: ['contact'] },
        targets: targetIds.map((targetId) => ({ targetId })),
        throttle: { cooldownSec: 0, scope: 'rule' },
        actions: {
          onTrigger: [
            {
              kind: 'do',
              action: {
                kind: 'cap',
                deviceId: PANEL_ID,
                cap: 'alarm-panel',
                method: 'trigger',
                args: {},
              },
            },
          ],
        },
      }),
    })
    return rule.id
  }

  it('carries the SENSOR id, not only the camera, on a device-event match', async () => {
    const h = await makeHarness()
    await makeContactTriggerRule(h.center)
    h.center.onSensorEventPersisted({
      id: 'sensor-row-1',
      deviceId: CAMERA_ID,
      sourceDeviceId: PORCH,
      kind: 'contact',
      value: { entryOpen: true, lastChangedAt: 1_000 },
      timestamp: 1_000,
    })
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
    })
    expect(h.claimed[0]?.deviceId).toBe(CAMERA_ID)
    expect(h.claimed[0]?.sourceDeviceId).toBe(PORCH)
  })

  it('freezes linked-set still owners on the fire ref so the siren carries a snapshot', async () => {
    // A contact linked to TWO cameras has no marker track — only shelf owners.
    // Before the fix, fireRefFor dropped them and the announce/combined row
    // shipped keyFrame with zero owners (text-only siren).
    const h = await makeHarness()
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    const ruleId = await makeContactTriggerRule(h.center, ['tgt-tablet'])
    h.center.onSensorEvent({
      event: {
        id: 'sensor-linked-1',
        deviceId: CAMERA_ID,
        sourceDeviceId: PORCH,
        kind: 'contact',
        value: { entryOpen: true, lastChangedAt: 1_000 },
        timestamp: 1_000,
      },
      linkedCameraIds: [CAMERA_ID, CAM_B],
      rowCameraIds: [CAMERA_ID, CAM_B],
      linkedStills: {
        sensorId: PORCH,
        cameraIds: [CAMERA_ID, CAM_B],
        mosaicOwnerId: MOSAIC,
        cameraOwnerIds: [TILE_A, TILE_B],
      },
    })
    await vi.waitFor(() => {
      expect(h.actuations).toHaveLength(1)
    })
    const source = h.claimed[0]
    expect(source).toMatchObject({
      ruleId,
      sourceDeviceId: PORCH,
      trackId: MOSAIC,
    })

    publish(h.center, triggered(source ?? undefined))
    await vi.waitFor(() => {
      const rows = h.rows().filter((r) => r.payload.subject.systemEvent?.kind === 'alarm-triggered')
      expect(rows).toHaveLength(1)
      // Sensor effective policy is one snapshot; the mosaic owner is the still.
      expect(rows[0]?.payload.mediaImage).toBe('clean')
      expect(rows[0]?.payload.subject.trackId).toBe(MOSAIC)
      expect(rows[0]?.deviceId).toBe(CAMERA_ID)
    })
  })
})
