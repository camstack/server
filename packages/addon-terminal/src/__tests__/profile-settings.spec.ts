import { describe, expect, it } from 'vitest'
import {
  defaultsFromSettingsSchema,
  glancesSettingsToArgs,
  sanitizeProfileSettings,
  settingsSchemaForProfile,
  spawnArgsForInstance,
} from '../profile-settings.js'

describe('settingsSchemaForProfile', () => {
  it('exports a Glances panel schema and nothing for other profiles', () => {
    const glances = settingsSchemaForProfile('glances')
    expect(glances).not.toBeNull()
    const keys = glances!.sections.flatMap((section) => section.fields.map((field) => field.key))
    expect(keys).toEqual([
      'showCpu',
      'showMem',
      'showLoad',
      'showNetwork',
      'showDiskIo',
      'showFs',
      'showProcessList',
      'showContainers',
      'showSensors',
    ])
    expect(settingsSchemaForProfile('monitor')).toBeNull()
    expect(settingsSchemaForProfile('top')).toBeNull()
    expect(settingsSchemaForProfile('shell')).toBeNull()
    expect(settingsSchemaForProfile('htop-custom')).toBeNull()
  })
})

describe('glancesSettingsToArgs', () => {
  it('emits no argv when every panel is on — the measured default', () => {
    expect(
      glancesSettingsToArgs({
        showCpu: true,
        showMem: true,
        showLoad: true,
        showNetwork: true,
        showDiskIo: true,
        showFs: true,
        showProcessList: true,
        showContainers: true,
        showSensors: true,
      }),
    ).toEqual([])
  })

  it('disables only the panels the operator turned off', () => {
    expect(
      glancesSettingsToArgs({
        showCpu: true,
        showMem: true,
        showLoad: true,
        showNetwork: true,
        showDiskIo: true,
        showFs: true,
        showProcessList: false,
        showContainers: false,
        showSensors: false,
      }),
    ).toEqual(['--disable-plugin', 'processlist,containers,sensors'])
  })
})

describe('sanitizeProfileSettings', () => {
  it('fills Glances defaults and drops unknown keys', () => {
    expect(sanitizeProfileSettings('glances', { showProcessList: false, extra: 1 })).toEqual({
      showCpu: true,
      showMem: true,
      showLoad: true,
      showNetwork: true,
      showDiskIo: true,
      showFs: true,
      showProcessList: false,
      showContainers: true,
      showSensors: true,
    })
  })

  it('returns an empty bag for profiles without a schema', () => {
    expect(sanitizeProfileSettings('monitor', { showCpu: false })).toEqual({})
  })
})

describe('spawnArgsForInstance', () => {
  it('appends Glances feature argv to instance args', () => {
    expect(
      spawnArgsForInstance({
        profileId: 'glances',
        instanceArgs: ['-t', '5'],
        profileArgs: ['-m', 'glances'],
        profileSettings: { showProcessList: false },
      }),
    ).toEqual(['-t', '5', '--disable-plugin', 'processlist'])
  })

  it('falls back to the live profile template when instance args are empty', () => {
    expect(
      spawnArgsForInstance({
        profileId: 'glances',
        instanceArgs: [],
        profileArgs: ['-m', 'glances'],
        profileSettings: { showSensors: false },
      }),
    ).toEqual(['-m', 'glances', '--disable-plugin', 'sensors'])
  })

  it('returns undefined when there is nothing to override', () => {
    expect(
      spawnArgsForInstance({
        profileId: 'monitor',
        instanceArgs: [],
        profileArgs: ['-b'],
        profileSettings: {},
      }),
    ).toBeUndefined()
  })
})

describe('defaultsFromSettingsSchema', () => {
  it('reads boolean defaults off the Glances schema', () => {
    const defaults = defaultsFromSettingsSchema(settingsSchemaForProfile('glances')!)
    expect(defaults.showProcessList).toBe(true)
    expect(defaults.showCpu).toBe(true)
  })
})
