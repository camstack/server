import type { SwitchPowerSourceResult } from '@apocaliss92/nodelink-js'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPowerSourceSetting,
  buildPowerSourceSettingsSection,
  POWER_SOURCE_SETTING_KEY,
  type PowerSourceApi,
  type PowerSourceTarget,
} from '../power-source.js'
import { createRecordingLogger } from './clip-test-logger.js'

describe('buildPowerSourceSettingsSection', () => {
  it('is an ordinary select in its own section of the Advanced tab, seeded from the camera', () => {
    const [section, ...more] = buildPowerSourceSettingsSection({
      isBattery: true,
      source: 'adapter',
    })
    expect(more).toHaveLength(0)
    expect(section?.tab).toBe('advanced')
    expect(section?.id).toBe('power-source')
    const [field, ...fields] = section?.fields ?? []
    expect(fields).toHaveLength(0)
    expect(field).toMatchObject({
      type: 'select',
      key: POWER_SOURCE_SETTING_KEY,
      default: 'adapter',
    })
    expect(field?.type === 'select' ? field.options.map((o) => o.value) : []).toEqual([
      'adapter',
      'battery',
    ])
  })

  it('has no section for a mains camera, an unread source or an unknown one', () => {
    expect(buildPowerSourceSettingsSection({ isBattery: false, source: 'adapter' })).toEqual([])
    expect(buildPowerSourceSettingsSection({ isBattery: true, source: undefined })).toEqual([])
    expect(buildPowerSourceSettingsSection({ isBattery: true, source: 'unknown' })).toEqual([])
  })
})

function buildTarget(reads: readonly ('adapter' | 'battery')[], supported = true) {
  const remaining = [...reads]
  const switchSpy = vi.fn(
    async (): Promise<SwitchPowerSourceResult> => ({
      mode: 'adapter',
      dryRun: false,
      accepted: true,
    }),
  )
  const api: PowerSourceApi = {
    getPowerSource: async () => remaining.shift(),
    probePowerSourceSwitchSupport: async () => supported,
    switchPowerSource: switchSpy,
  }
  const target: PowerSourceTarget = {
    api,
    channel: 0,
    deviceId: 5912,
    logger: createRecordingLogger(),
  }
  return { target, switchSpy }
}

describe('applyPowerSourceSetting', () => {
  it('writes the chosen mode through the one switch implementation', async () => {
    const { target, switchSpy } = buildTarget(['battery', 'adapter'])
    await applyPowerSourceSetting(target, 'adapter')
    expect(switchSpy).toHaveBeenCalledWith('adapter', { channel: 0 })
  })

  it('refuses a value that is not a power source and writes nothing', async () => {
    const { target, switchSpy } = buildTarget(['battery'])
    await expect(applyPowerSourceSetting(target, 'solar')).rejects.toThrow(/power source/i)
    expect(switchSpy).not.toHaveBeenCalled()
  })

  it('throws when the camera did not take the switch, so the form keeps the edit unsaved', async () => {
    const { target } = buildTarget(['battery', 'battery'])
    await expect(applyPowerSourceSetting(target, 'adapter')).rejects.toThrow(/did not/i)
  })

  it('throws when the device refused the dry run', async () => {
    const { target, switchSpy } = buildTarget(['battery'], false)
    await expect(applyPowerSourceSetting(target, 'adapter')).rejects.toThrow(/refused/i)
    expect(switchSpy).not.toHaveBeenCalled()
  })
})
