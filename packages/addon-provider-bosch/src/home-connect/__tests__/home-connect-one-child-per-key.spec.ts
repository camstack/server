import { describe, expect, it } from 'vitest'
import {
  deriveChildBindings,
  legacyKindBinding,
  type HomeConnectChildBinding,
} from '../home-connect-child-bindings.js'
import { mergeChildBindings } from '../home-connect-child-reconciler.js'
import { careDescription, CARE_NAMES } from './dishwasher-care-fixture.js'

/**
 * The live hub carried two children named "Remote control level": the old fixed catalog
 * guessed `BSH.Common.Status.RemoteControlLevel` (device 34, suffix `remote-control-level`),
 * the appliance's IDDF lists `BSH.Common.Setting.RemoteControlLevel` (device 59).
 */
const STALE_KEY = 'BSH.Common.Status.RemoteControlLevel'

function legacyRemoteControlLevel(): HomeConnectChildBinding {
  const base = legacyKindBinding('remote-control-level', 'Remote control level')
  if (base === null) throw new Error('fixture: legacy kind missing')
  // As PERSISTED on the hub before the fix: the stale key.
  return { ...base, key: STALE_KEY }
}

/** The appliance has said a value, so the setting is bound. */
const FEATURES = new Map<string, unknown>([[CARE_NAMES.remoteControlLevel, 'ManualControl']])

const SETTING_SUFFIX = 'bsh-common-setting-remotecontrollevel'

function derivedSettingChild(): HomeConnectChildBinding {
  const description = careDescription()
  const derived = deriveChildBindings({ description, features: FEATURES })
  const found = derived.find((b) => b.key === CARE_NAMES.remoteControlLevel)
  if (found === undefined) throw new Error('fixture: derived binding missing')
  return found
}

describe('one child per Home Connect key', () => {
  const description = careDescription()
  const derived = deriveChildBindings({ description, features: FEATURES })

  it('the legacy "Remote control level" and the derived one are ONE child, under the legacy id', () => {
    const live = [legacyRemoteControlLevel(), derivedSettingChild()]
    expect(live.map((b) => b.stableIdSuffix)).toContain(SETTING_SUFFIX)
    const merged = mergeChildBindings(live, derived, description)
    const levels = merged.filter((b) => b.name === 'Remote control level')
    expect(levels).toHaveLength(1)
    expect(levels[0]?.key).toBe(CARE_NAMES.remoteControlLevel)
    // The id the operator already has (device 34) survives; the derived twin (59) is gone.
    expect(levels[0]?.stableIdSuffix).toBe('remote-control-level')
    expect(merged.some((b) => b.stableIdSuffix === SETTING_SUFFIX)).toBe(false)
  })

  it('a container not yet carrying the derived twin keeps the legacy id and gains no second child', () => {
    const merged = mergeChildBindings([legacyRemoteControlLevel()], derived, description)
    const levels = merged.filter((b) => b.key === CARE_NAMES.remoteControlLevel)
    expect(levels.map((b) => b.stableIdSuffix)).toEqual(['remote-control-level'])
    expect(merged.some((b) => b.key === STALE_KEY)).toBe(false)
  })

  it('whatever the persisted rows, no two merged bindings share a key or a suffix', () => {
    const merged = mergeChildBindings(
      [legacyRemoteControlLevel(), derivedSettingChild(), ...derived],
      derived,
      description,
    )
    expect(new Set(merged.map((b) => b.key)).size).toBe(merged.length)
    expect(new Set(merged.map((b) => b.stableIdSuffix)).size).toBe(merged.length)
  })

  it('the catalog no longer names the stale key', () => {
    expect(legacyKindBinding('remote-control-level', '')?.key).toBe(CARE_NAMES.remoteControlLevel)
  })
})
