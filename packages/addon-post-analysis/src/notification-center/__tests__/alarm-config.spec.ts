/**
 * The alarm configuration surface, through the real center.
 *
 * Two halves that must never disagree: the durations an operator edits, and
 * the list of what a mode ACTUALLY arms. The second is derived from the rule
 * set on every read — the tests below are mostly about proving it stays
 * derived, because a cached copy is right on the day it is written and wrong
 * the first time a rule is disabled.
 *
 * The arm announcement is here too, and specifically the case where nothing
 * is sent: a mode that arms nothing must produce a log line and NOT a
 * notification, because "Away armed" followed by an unwatched night is worse
 * than silence.
 */
import { makeNcRecords } from './support/nc-test-deps.js'
import type {
  AlarmArmMode,
  NcAlarmProfilesView,
  NcAlarmSettings,
  NcAlarmSettingsPatch,
} from '@camstack/types'
import {
  activateAlarmProfile,
  applyBlockingEdit,
  applyModeDelaysEdits,
  applyNonBlockingEdit,
  applySecureOnArmEdit,
  cloneAlarmSettings,
  createAlarmProfile,
  deleteAlarmProfile,
  ensureAlarmProfiles,
  isDefaultAlarmProfileId,
  NC_ALARM_DEFAULT_PROFILE_ID,
  NcRuleInputSchema,
  renameAlarmProfile,
  syncActiveAlarmProfileSettings,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcAlarmOpening } from '../alarm/alarm-openings.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { type NcAlarmPanelPort, NotificationCenter } from '../index.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const PANEL_ID = 42
const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  { id: 'tgt-off', addonId: 'notifiers', name: 'old-phone', kind: 'ntfy', enabled: false },
]

const DEVICE_NAMES: ReadonlyMap<number, string> = new Map([
  [101, 'Cancello'],
  [102, 'Garage'],
])

/** The scalar fields of a patch — everything that is not a list or an edit. */
function globalFields(patch: NcAlarmSettingsPatch): Partial<NcAlarmSettings> {
  const {
    nonBlocking: _nb,
    nonBlockingEdit: _nbe,
    blocking: _bl,
    blockingEdit: _ble,
    secureOnArmOff: _so,
    secureOnArmEdit: _soe,
    modeDelays: _md,
    ...scalars
  } = patch
  return scalars
}

/**
 * A panel that holds its settings in a variable — the same contract the real
 * device satisfies. The centre only ever sees this interface, which is why
 * none of this needs a kernel.
 */
function makeFakePanel(initial?: Partial<NcAlarmSettings>): NcAlarmPanelPort {
  let settings: NcAlarmSettings = {
    exitDelaySec: 30,
    entryDelaySec: 20,
    triggeredDurationSec: 0,
    announceArm: false,
    announceTargets: [],
    nonBlocking: [],
    blocking: [],
    secureOnArmOff: [],
    modeDelays: [],
    ...initial,
  }
  let profiles = ensureAlarmProfiles(null, settings)
  const view = (): NcAlarmProfilesView => ({
    activeId: profiles.activeId,
    items: profiles.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: isDefaultAlarmProfileId(p.id),
    })),
  })
  return {
    deviceId: PANEL_ID,
    settings: () => settings,
    applySettings: async (patch: NcAlarmSettingsPatch) => {
      // The REAL pure functions, never a spread of the patch: a spread would store a
      // `nonBlockingEdit` key and make a stripped write look landed.
      const edit = patch.nonBlockingEdit
      const applied = edit === undefined ? null : applyNonBlockingEdit(settings.nonBlocking, edit)
      if (applied?.kind === 'refused') {
        throw new Error(`non-blocking edit refused: ${applied.reason}`)
      }
      const blockingEdit = patch.blockingEdit
      const blockingApplied =
        blockingEdit === undefined ? null : applyBlockingEdit(settings.blocking, blockingEdit)
      if (blockingApplied?.kind === 'refused') {
        throw new Error(`blocking edit refused: ${blockingApplied.reason}`)
      }
      const secureEdit = patch.secureOnArmEdit
      const secureApplied =
        secureEdit === undefined ? null : applySecureOnArmEdit(settings.secureOnArmOff, secureEdit)
      if (secureApplied?.kind === 'refused') {
        throw new Error(`secure-on-arm edit refused: ${secureApplied.reason}`)
      }
      settings = {
        ...settings,
        ...globalFields(patch),
        ...(patch.nonBlocking !== undefined ? { nonBlocking: patch.nonBlocking } : {}),
        ...(applied?.kind === 'applied' ? { nonBlocking: applied.lists } : {}),
        ...(patch.blocking !== undefined ? { blocking: patch.blocking } : {}),
        ...(blockingApplied?.kind === 'applied' ? { blocking: blockingApplied.lists } : {}),
        ...(patch.secureOnArmOff !== undefined ? { secureOnArmOff: patch.secureOnArmOff } : {}),
        ...(secureApplied?.kind === 'applied' ? { secureOnArmOff: secureApplied.lists } : {}),
        ...(patch.modeDelays !== undefined
          ? { modeDelays: applyModeDelaysEdits(settings.modeDelays, patch.modeDelays) }
          : {}),
      }
      profiles = syncActiveAlarmProfileSettings(profiles, settings)
      return settings
    },
    profilesView: () => view(),
    createProfile: async (input) => {
      const result = createAlarmProfile(profiles, {
        name: input.name,
        id: input.newId,
        source: input.source,
      })
      if (result.kind === 'refused') throw new Error(result.reason)
      profiles = result.state
      return view()
    },
    renameProfile: async (id, name) => {
      const result = renameAlarmProfile(profiles, { id, name })
      if (result.kind === 'refused') throw new Error(result.reason)
      profiles = result.state
      return view()
    },
    deleteProfile: async (id) => {
      const wasActive = profiles.activeId === id
      const result = deleteAlarmProfile(profiles, id)
      if (result.kind === 'refused') throw new Error(result.reason)
      profiles = result.state
      if (wasActive) {
        const def = profiles.profiles.find((p) => p.id === NC_ALARM_DEFAULT_PROFILE_ID)
        if (def !== undefined) settings = cloneAlarmSettings(def.settings)
      }
      return view()
    },
    activateProfile: async (id) => {
      profiles = syncActiveAlarmProfileSettings(profiles, settings)
      const result = activateAlarmProfile(profiles, id)
      if (result.kind === 'refused') throw new Error(result.reason)
      profiles = result.state
      const next = profiles.profiles.find((p) => p.id === id)
      if (next === undefined) throw new Error('not-found')
      settings = cloneAlarmSettings(next.settings)
      return view()
    },
    availableModes: () => MODES,
    triggerFromRule: () => 'accepted',
    classifyRuleMatch: () => ({ kind: 'none' }),
    announceLifted: () => undefined,
    excludedDevices: () => [],
    observeOpening: () => 'unchanged',
    armWith: async () => ({ outcome: 'armed', excluded: [] }),
    armAnyway: async () => ({ outcome: 'rejected', reason: 'unknown-refusal' }),
    exclusionPhases: () => [],
    forgetExcluded: () => undefined,
    bypassInput: () => ({ outcome: 'refused', reason: 'disarmed' }),
    inputBypasses: () => [],
    pruneInputBypasses: () => undefined,
    currentState: () => 'disarmed',
    currentTarget: () => 'disarmed',
    disarm: async () => undefined,
  }
}

interface Harness {
  readonly center: NotificationCenter
  readonly sends: NcSendInput[]
}

function makeHarness(
  panel: NcAlarmPanelPort | null,
  /** What the device directory mirrors — cold by default. */
  identities: readonly NcDeviceIdentity[] = [],
  /** The opening reader; absent = not wired on this node. */
  openings?: ReadonlyMap<number, NcAlarmOpening>,
): Harness {
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => resolvePruneWindows({}),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async (deviceId) => DEVICE_NAMES.get(deviceId) ?? null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => identities,
    ...(openings === undefined
      ? {}
      : {
          readDeviceOpenings: async (ids: readonly number[]) =>
            new Map([...openings].filter(([id]) => ids.includes(id))),
        }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  center.setAlarmPanel(panel)
  return { center, sends }
}

/** A rule gated on the panel being in `states`, scoped to `devices`. */
async function gatedRule(
  center: NotificationCenter,
  name: string,
  states: readonly string[],
  devices?: readonly number[],
): Promise<string> {
  const { rule } = await center.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name,
      enabled: true,
      delivery: 'immediate',
      conditions: {
        deviceState: { deviceId: PANEL_ID, states: [...states] },
        ...(devices !== undefined ? { devices: [...devices] } : {}),
      },
      targets: [{ targetId: 'tgt-phone' }],
      throttle: { scope: 'rule', minIntervalSec: 0 },
    }),
    caller: { userId: 'admin-1', isAdmin: true },
  })
  return rule.id
}

describe('getAlarmConfig', () => {
  it('answers honestly on a node with NO panel', async () => {
    // An agent has no panel. Returning defaults with a real-looking deviceId
    // would give the operator an editor whose Save goes nowhere.
    const { center } = makeHarness(null)
    const config = await center.buildProvider().getAlarmConfig({})
    expect(config.deviceId).toBeNull()
    expect(config.coverage).toEqual([])
  })

  it('serves the panel settings alongside a row for EVERY mode', async () => {
    const { center } = makeHarness(makeFakePanel({ entryDelaySec: 45 }))
    const config = await center.buildProvider().getAlarmConfig({})
    expect(config.deviceId).toBe(PANEL_ID)
    expect(config.settings.entryDelaySec).toBe(45)
    // Including the modes nothing is gated on — "night arms nothing" is the
    // most useful thing this surface can say.
    expect(config.coverage.map((c) => c.mode)).toEqual(['home', 'away', 'night'])
    expect(config.coverage.every((c) => c.ruleCount === 0)).toBe(true)
  })

  it('DERIVES the coverage from the rules that exist right now', async () => {
    const { center } = makeHarness(makeFakePanel())
    await gatedRule(center, 'gate at night', ['armed_away', 'armed_night'], [101])
    await gatedRule(center, 'garage away', ['armed_away'], [102])
    const config = await center.buildProvider().getAlarmConfig({})
    const away = config.coverage.find((c) => c.mode === 'away')
    expect(away?.ruleCount).toBe(2)
    expect(away?.deviceIds).toEqual([101, 102])
    expect(config.coverage.find((c) => c.mode === 'night')?.deviceIds).toEqual([101])
    expect(config.coverage.find((c) => c.mode === 'home')?.ruleCount).toBe(0)
  })

  it('drops a device the moment its rule is DISABLED — no cached copy survives', async () => {
    // The failure a stored list would produce: the operator switches a rule
    // off and the panel keeps promising that camera is armed.
    const { center } = makeHarness(makeFakePanel())
    const ruleId = await gatedRule(center, 'gate', ['armed_away'], [101])
    const provider = center.buildProvider()
    expect(
      (await provider.getAlarmConfig({})).coverage.find((c) => c.mode === 'away')?.deviceIds,
    ).toEqual([101])
    await provider.setRuleEnabled({ ruleId, enabled: false })
    const after = await provider.getAlarmConfig({})
    expect(after.coverage.find((c) => c.mode === 'away')?.ruleCount).toBe(0)
    expect(after.coverage.find((c) => c.mode === 'away')?.deviceIds).toEqual([])
  })
})

describe('setAlarmConfig', () => {
  it('persists a patch and returns the config the panel settled on', async () => {
    const { center } = makeHarness(makeFakePanel())
    const provider = center.buildProvider()
    const result = await provider.setAlarmConfig({ patch: { triggeredDurationSec: 180 } })
    expect(result.settings.triggeredDurationSec).toBe(180)
    // Untouched fields survive a partial patch.
    expect(result.settings.exitDelaySec).toBe(30)
    expect((await provider.getAlarmConfig({})).settings.triggeredDurationSec).toBe(180)
  })

  it('a nonBlockingEdit round-trips into settings.nonBlocking of the answer', async () => {
    const { center } = makeHarness(makeFakePanel())
    const result = await center.buildProvider().setAlarmConfig({
      patch: { nonBlockingEdit: { mode: 'home', deviceId: 101, nonBlocking: true } },
    })
    expect(result.settings.nonBlocking).toEqual([{ mode: 'home', deviceIds: [101] }])
  })

  it('REFUSES on a node with no panel instead of pretending to save', async () => {
    const { center } = makeHarness(null)
    await expect(
      center.buildProvider().setAlarmConfig({ patch: { entryDelaySec: 5 } }),
    ).rejects.toThrow(/no alarm panel/)
  })
})

describe('getAlarmSensors', () => {
  it('answers each asked id once, ascending; an id the reader left out is unknown', async () => {
    const openings = new Map<number, NcAlarmOpening>([
      [101, { kind: 'reading', reading: 'secure', state: 'closed', cap: 'contact' }],
      [102, { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' }],
      // A placeholder (an HA cover's constructor word): never closed.
      [619, { kind: 'unknown', cap: 'cover', raw: { state: 'closed', lastChangedAt: 0 } }],
    ])
    const { center } = makeHarness(makeFakePanel(), [], openings)
    const { sensors } = await center
      .buildProvider()
      .getAlarmSensors({ deviceIds: [108, 619, 102, 101, 102] })
    expect(sensors.map((s) => [s.deviceId, s.reading, s.unknownWhy])).toEqual([
      [101, 'closed', null],
      [102, 'open', null],
      [108, 'unknown', 'read-failed'],
      [619, 'unknown', 'unknown-word'],
    ])
  })

  it('takes `online` from the device directory; an id it does not know is null', async () => {
    const openings = new Map<number, NcAlarmOpening>([
      [101, { kind: 'reading', reading: 'secure', state: 'closed', cap: 'contact' }],
      [102, { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' }],
      [108, { kind: 'reading', reading: 'secure', state: 'closed', cap: 'contact' }],
    ])
    const { center } = makeHarness(
      makeFakePanel(),
      [
        { deviceId: 101, type: 'sensor', name: 'Door', isCamera: false, online: false },
        { deviceId: 102, type: 'sensor', name: 'Window', isCamera: false, online: true },
      ],
      openings,
    )
    await center.start({ evaluation: true })
    const { sensors } = await center.buildProvider().getAlarmSensors({ deviceIds: [101, 102, 108] })
    expect(sensors.map((s) => [s.deviceId, s.online])).toEqual([
      [101, false],
      [102, true],
      [108, null],
    ])
    await center.stop()
  })

  it('REJECTS when the opening reader is not wired — never an empty answer', async () => {
    const { center } = makeHarness(makeFakePanel())
    await expect(center.buildProvider().getAlarmSensors({ deviceIds: [101] })).rejects.toThrow(
      'the opening reader is not wired on this node',
    )
  })
})

/**
 * WHAT A MODE DOES NOT ARM.
 *
 * "Away armed — 2 cameras" is a promise, and a muted camera among those two
 * makes it false in exactly the way nobody notices until an incident. Every
 * reason here comes from an authority that already owned the switch (D62); the
 * panel keeps no list of its own.
 */
describe('coverage exclusions', () => {
  it('names a MUTED camera as skipped, with the reason', async () => {
    const { center } = makeHarness(makeFakePanel())
    await gatedRule(center, 'gate', ['armed_away'], [101, 102])
    await center.buildProvider().setDeviceMuted({ deviceId: 102, muted: true })
    const config = await center.buildProvider().getAlarmConfig({})
    const away = config.coverage.find((c) => c.mode === 'away')
    expect(away?.deviceIds).toEqual([101, 102])
    expect(away?.skippedDevices).toEqual([{ deviceId: 102, reason: 'muted' }])
  })

  it('reports NOTHING as skipped while the device mirror is cold', async () => {
    // Fail-quiet, not fail-loud: an unreadable authority must never render as
    // "every camera is excluded" on the first seconds after a deploy.
    const { center } = makeHarness(makeFakePanel())
    await gatedRule(center, 'gate', ['armed_away'], [101])
    const config = await center.buildProvider().getAlarmConfig({})
    expect(config.coverage.find((c) => c.mode === 'away')?.skippedDevices).toEqual([])
  })

  it('excludes a camera whose detection is off — and NEVER a sensor', async () => {
    // `detectionActive: false` is a SWITCH on a camera and an ABSENCE on a
    // contact sensor, which has no detection pipeline and never will. Reading
    // the second as the first reported the whole of `home` as excluded the
    // moment seven contacts joined it, and the arm notification said the mode
    // would protect nothing while it armed seven working sensors.
    const { center } = makeHarness(makeFakePanel(), [
      { deviceId: 102, type: 'camera', name: 'Garage', isCamera: true, detectionActive: false },
      { deviceId: 3243, type: 'sensor', name: 'Porch', isCamera: false, detectionActive: false },
    ])
    await center.start({ evaluation: true })
    await gatedRule(center, 'gate', ['armed_home'], [102, 3243])
    const config = await center.buildProvider().getAlarmConfig({})
    const home = config.coverage.find((c) => c.mode === 'home')
    expect(home?.skippedDevices).toEqual([{ deviceId: 102, reason: 'detection-off' }])
    await center.stop()
  })
})

describe('alarm configuration profiles', () => {
  it('seeds Default from current settings and create empty uses system defaults', async () => {
    const { center } = makeHarness(
      makeFakePanel({
        nonBlocking: [{ mode: 'home', deviceIds: [7] }],
        secureOnArmOff: [{ mode: 'away', deviceIds: [42] }],
      }),
    )
    const provider = center.buildProvider()
    const initial = await provider.getAlarmConfig({})
    expect(initial.profiles?.activeId).toBe(NC_ALARM_DEFAULT_PROFILE_ID)
    expect(initial.profiles?.items).toEqual([
      { id: NC_ALARM_DEFAULT_PROFILE_ID, name: 'Default', isDefault: true },
    ])
    expect(initial.settings.nonBlocking).toEqual([{ mode: 'home', deviceIds: [7] }])

    const afterCreate = await provider.createAlarmProfile({ name: 'Summer' })
    expect(afterCreate.profiles?.items.map((p) => p.name).sort()).toEqual(['Default', 'Summer'])
    expect(afterCreate.profiles?.activeId).toBe(NC_ALARM_DEFAULT_PROFILE_ID)
    // Still on Default — memberships unchanged.
    expect(afterCreate.settings.nonBlocking).toEqual([{ mode: 'home', deviceIds: [7] }])

    const summer = afterCreate.profiles?.items.find((p) => p.name === 'Summer')
    expect(summer).toBeDefined()
    if (summer === undefined) return
    const activated = await provider.activateAlarmProfile({ id: summer.id })
    expect(activated.profiles?.activeId).toBe(summer.id)
    expect(activated.settings.nonBlocking).toEqual([])
    expect(activated.settings.secureOnArmOff).toEqual([])
    expect(activated.settings.exitDelaySec).toBe(30)
  })

  it('clone copies secure-on-arm memberships; deleting Default is refused', async () => {
    const { center } = makeHarness(
      makeFakePanel({
        secureOnArmOff: [{ mode: 'away', deviceIds: [42] }],
      }),
    )
    const provider = center.buildProvider()
    const cloned = await provider.createAlarmProfile({
      name: 'Winter',
      cloneFromId: NC_ALARM_DEFAULT_PROFILE_ID,
    })
    const winter = cloned.profiles?.items.find((p) => p.name === 'Winter')
    expect(winter).toBeDefined()
    if (winter === undefined) return
    const activated = await provider.activateAlarmProfile({ id: winter.id })
    expect(activated.settings.secureOnArmOff).toEqual([{ mode: 'away', deviceIds: [42] }])
    await expect(provider.deleteAlarmProfile({ id: NC_ALARM_DEFAULT_PROFILE_ID })).rejects.toThrow(
      /cannot be deleted|cannot-delete-default/,
    )
  })
})

/**
 * The arm announcement now rides the OUTBOX as an `alarm-armed` system event —
 * durable, retried, in history, translated at delivery. Its tests live with the
 * rest of the alarm's notifications, in `alarm-notifications.spec.ts`; there is
 * no second delivery path left here to test.
 */
