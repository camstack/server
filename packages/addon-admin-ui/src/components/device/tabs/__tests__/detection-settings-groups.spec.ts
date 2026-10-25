import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_GROUP,
  SETTINGS_GROUP_TABS,
  groupOfSettingsSection,
} from '../detection-settings-groups'

describe('detection settings sub-tab grouping', () => {
  it('maps each contributed section id to its concern group', () => {
    const expected: Record<string, string> = {
      'pipeline-object-detection': 'object-detection',
      'detection-sensitivity': 'object-detection',
      'onboard-object-detection': 'object-detection',
      tracking: 'tracking',
      'tracking-core': 'tracking',
      'motion-tuning': 'motion',
      'stationary-objects': 'stationary',
      occupancy: 'stationary',
      zones: 'zones',
      'pipeline-audio': 'audio',
      'cluster-assignment': 'cluster',
      'orchestrator-live': 'cluster',
    }
    for (const [sectionId, group] of Object.entries(expected)) {
      expect(groupOfSettingsSection(sectionId)).toBe(group)
    }
  })

  it('routes an unmapped section id to the default group so nothing disappears', () => {
    expect(groupOfSettingsSection('some-future-section')).toBe(DEFAULT_SETTINGS_GROUP)
    expect(groupOfSettingsSection('')).toBe(DEFAULT_SETTINGS_GROUP)
  })

  it('every mapped group id (and the default) is a declared sub-tab', () => {
    const declared = new Set(SETTINGS_GROUP_TABS.map((t) => t.id))
    expect(declared.has(DEFAULT_SETTINGS_GROUP)).toBe(true)
    for (const sectionId of [
      'pipeline-object-detection',
      'tracking',
      'motion-tuning',
      'stationary-objects',
      'zones',
      'pipeline-audio',
      'cluster-assignment',
    ]) {
      expect(declared.has(groupOfSettingsSection(sectionId))).toBe(true)
    }
  })
})
