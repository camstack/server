import { DeviceType, type ConfigSectionWithValues } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { hasConfigTabContent, isConfigTabSection } from '../config-tab-sections'
import { DEVICE_EXPORT_TAB_ID } from '../device-export-tab'

/** The Extensions section exactly as `device-aggregation.ts` derives it from the cap's owned widget. */
const EXTENSIONS: ConfigSectionWithValues = {
  id: 'device-extension-widget',
  title: 'Extensions',
  tab: 'general',
  order: 72,
  fields: [
    {
      type: 'widget',
      key: 'device-extensionWidget',
      label: 'Extensions',
      widgetId: 'host/extensions-panel',
    },
  ],
}
const RECORDING: ConfigSectionWithValues = {
  id: 'recording',
  title: 'Recording',
  tab: 'general',
  fields: [{ type: 'widget', key: 'rec', label: 'Recording', widgetId: 'host/recording-panel' }],
}

describe('isConfigTabSection — what the default Config tab renders', () => {
  it('keeps an ordinary settings section', () => {
    expect(isConfigTabSection(RECORDING)).toBe(true)
  })
  it('drops the Extensions card: Customize carries its slots (D676 ruling 4)', () => {
    expect(isConfigTabSection(EXTENSIONS)).toBe(false)
  })
  it('drops a hero section: it renders once under the device’s hero card (D915)', () => {
    expect(isConfigTabSection({ ...RECORDING, location: 'hero' })).toBe(false)
  })
  it('drops a top-tab section and an Export section', () => {
    expect(isConfigTabSection({ ...RECORDING, location: 'top-tab' })).toBe(false)
    expect(isConfigTabSection({ ...RECORDING, tab: DEVICE_EXPORT_TAB_ID })).toBe(false)
  })
})

describe('hasConfigTabContent — hide empty Config from the tab bar', () => {
  it('keeps Config while the aggregate has not answered (D315)', () => {
    expect(hasConfigTabContent(undefined, DeviceType.Sensor, true, false)).toBe(true)
  })
  it('hides Config when only Export / top-tab / Extensions remain', () => {
    expect(
      hasConfigTabContent(
        [EXTENSIONS, { ...RECORDING, tab: DEVICE_EXPORT_TAB_ID }],
        DeviceType.Sensor,
        true,
        true,
      ),
    ).toBe(false)
  })
  it('keeps Config when an ordinary settings section remains', () => {
    expect(hasConfigTabContent([RECORDING], DeviceType.Sensor, true, true)).toBe(true)
  })
  it('keeps Config for a non-admin camera (read-only Extensions card)', () => {
    expect(hasConfigTabContent([], DeviceType.Camera, false, true)).toBe(true)
  })
})
