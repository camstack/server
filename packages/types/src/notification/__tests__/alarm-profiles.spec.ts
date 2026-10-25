/**
 * Alarm configuration profiles — named {@link NcAlarmSettings} snapshots.
 *
 * Create without a source → system defaults; clone → copy; Default always
 * exists after ensure; Default cannot be deleted; activating applies the blob.
 */
import { describe, expect, it } from 'vitest'
import {
  activateAlarmProfile,
  cloneAlarmSettings,
  createAlarmProfile,
  deleteAlarmProfile,
  ensureAlarmProfiles,
  isDefaultAlarmProfileId,
  NC_ALARM_DEFAULT_PROFILE_ID,
  NC_ALARM_DEFAULT_PROFILE_NAME,
  ncAlarmSystemDefaultSettings,
  renameAlarmProfile,
  syncActiveAlarmProfileSettings,
  type NcAlarmProfilesState,
} from '../alarm-profiles.js'
import type { NcAlarmSettings } from '../../capabilities/notification-rules.cap.js'

const SETTINGS_A: NcAlarmSettings = {
  ...ncAlarmSystemDefaultSettings(),
  exitDelaySec: 45,
  nonBlocking: [{ mode: 'home', deviceIds: [7] }],
  secureOnArmOff: [{ mode: 'away', deviceIds: [42] }],
}

function seeded(): NcAlarmProfilesState {
  return ensureAlarmProfiles(null, SETTINGS_A)
}

describe('ncAlarmSystemDefaultSettings', () => {
  it('has empty memberships and stock delays', () => {
    const s = ncAlarmSystemDefaultSettings()
    expect(s.nonBlocking).toEqual([])
    expect(s.blocking).toEqual([])
    expect(s.secureOnArmOff).toEqual([])
    expect(s.announceTargets).toEqual([])
    expect(s.modeDelays).toEqual([])
    expect(s.exitDelaySec).toBe(30)
    expect(s.entryDelaySec).toBe(20)
    expect(s.triggeredDurationSec).toBe(10)
    expect(s.postTriggeredAction).toBe('rearmAfter')
  })
})

describe('ensureAlarmProfiles', () => {
  it('seeds Default from current flat settings', () => {
    const state = ensureAlarmProfiles(null, SETTINGS_A)
    expect(state.activeId).toBe(NC_ALARM_DEFAULT_PROFILE_ID)
    expect(state.profiles).toHaveLength(1)
    expect(state.profiles[0]?.name).toBe(NC_ALARM_DEFAULT_PROFILE_NAME)
    expect(state.profiles[0]?.settings.nonBlocking).toEqual([{ mode: 'home', deviceIds: [7] }])
    expect(state.profiles[0]?.settings.secureOnArmOff).toEqual([{ mode: 'away', deviceIds: [42] }])
  })

  it('does not mutate the seed source', () => {
    const state = ensureAlarmProfiles(null, SETTINGS_A)
    const blob = state.profiles[0]?.settings
    expect(blob).toBeDefined()
    if (blob === undefined) return
    blob.nonBlocking[0]!.deviceIds.push(99)
    expect(SETTINGS_A.nonBlocking[0]?.deviceIds).toEqual([7])
  })
})

describe('createAlarmProfile', () => {
  it('create empty starts at system defaults', () => {
    const base = seeded()
    const result = createAlarmProfile(base, {
      name: 'Summer',
      id: 'p-summer',
      source: { kind: 'defaults' },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const created = result.state.profiles.find((p) => p.id === 'p-summer')
    expect(created?.settings).toEqual(ncAlarmSystemDefaultSettings())
    expect(result.state.activeId).toBe(NC_ALARM_DEFAULT_PROFILE_ID)
  })

  it('clone copies memberships including secure-on-arm', () => {
    const base = seeded()
    const result = createAlarmProfile(base, {
      name: 'Winter',
      id: 'p-winter',
      source: { kind: 'clone', fromId: NC_ALARM_DEFAULT_PROFILE_ID },
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const created = result.state.profiles.find((p) => p.id === 'p-winter')
    expect(created?.settings.nonBlocking).toEqual([{ mode: 'home', deviceIds: [7] }])
    expect(created?.settings.secureOnArmOff).toEqual([{ mode: 'away', deviceIds: [42] }])
    // Independent copy
    created!.settings.nonBlocking[0]!.deviceIds.push(8)
    expect(base.profiles[0]?.settings.nonBlocking[0]?.deviceIds).toEqual([7])
  })

  it('refuses empty or duplicate names', () => {
    const base = seeded()
    expect(
      createAlarmProfile(base, {
        name: '  ',
        id: 'x',
        source: { kind: 'defaults' },
      }).kind,
    ).toBe('refused')
    expect(
      createAlarmProfile(base, {
        name: NC_ALARM_DEFAULT_PROFILE_NAME,
        id: 'x',
        source: { kind: 'defaults' },
      }).kind,
    ).toBe('refused')
  })
})

describe('rename / delete / activate', () => {
  it('renames and refuses delete of Default', () => {
    const base = seeded()
    const renamed = renameAlarmProfile(base, { id: NC_ALARM_DEFAULT_PROFILE_ID, name: 'All year' })
    expect(renamed.kind).toBe('ok')
    if (renamed.kind !== 'ok') return
    expect(renamed.state.profiles[0]?.name).toBe('All year')
    expect(isDefaultAlarmProfileId(renamed.state.profiles[0]!.id)).toBe(true)
    expect(deleteAlarmProfile(renamed.state, NC_ALARM_DEFAULT_PROFILE_ID).kind).toBe('refused')
  })

  it('deleting the active non-default profile falls back to Default', () => {
    let state = seeded()
    const created = createAlarmProfile(state, {
      name: 'Summer',
      id: 'p-summer',
      source: { kind: 'defaults' },
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    const activated = activateAlarmProfile(created.state, 'p-summer')
    expect(activated.kind).toBe('ok')
    if (activated.kind !== 'ok') return
    const deleted = deleteAlarmProfile(activated.state, 'p-summer')
    expect(deleted.kind).toBe('ok')
    if (deleted.kind !== 'ok') return
    expect(deleted.state.activeId).toBe(NC_ALARM_DEFAULT_PROFILE_ID)
    expect(deleted.state.profiles).toHaveLength(1)
  })

  it('activate refuses unknown ids', () => {
    expect(activateAlarmProfile(seeded(), 'nope').kind).toBe('refused')
  })
})

describe('syncActiveAlarmProfileSettings', () => {
  it('writes the live flat settings into the active profile only', () => {
    let state = seeded()
    const created = createAlarmProfile(state, {
      name: 'Summer',
      id: 'p-summer',
      source: { kind: 'defaults' },
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    state = created.state
    const next = syncActiveAlarmProfileSettings(state, {
      ...SETTINGS_A,
      exitDelaySec: 99,
    })
    expect(
      next.profiles.find((p) => p.id === NC_ALARM_DEFAULT_PROFILE_ID)?.settings.exitDelaySec,
    ).toBe(99)
    expect(next.profiles.find((p) => p.id === 'p-summer')?.settings.exitDelaySec).toBe(30)
  })
})

describe('cloneAlarmSettings', () => {
  it('copies nested arrays', () => {
    const copy = cloneAlarmSettings(SETTINGS_A)
    expect(copy).toEqual(SETTINGS_A)
    expect(copy.nonBlocking).not.toBe(SETTINGS_A.nonBlocking)
    expect(copy.secureOnArmOff[0]?.deviceIds).not.toBe(SETTINGS_A.secureOnArmOff[0]?.deviceIds)
  })
})
