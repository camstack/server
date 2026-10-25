import { type ConfigSectionWithValues, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isExtensionsPanelSection, showReadOnlyExtensionsInConfig } from '../extensions-section'

function section(fields: ConfigSectionWithValues['fields']): ConfigSectionWithValues {
  return { id: 's', title: 'S', fields }
}

describe('isExtensionsPanelSection (D676 ruling 4)', () => {
  it('finds the Extensions widget at the top level', () => {
    expect(
      isExtensionsPanelSection(
        section([
          { type: 'widget', key: 'ext', label: 'Extensions', widgetId: 'host/extensions-panel' },
        ]),
      ),
    ).toBe(true)
  })
  it('finds it inside a group', () => {
    expect(
      isExtensionsPanelSection(
        section([
          {
            type: 'group',
            key: 'g',
            label: 'G',
            fields: [{ type: 'widget', key: 'ext', label: 'E', widgetId: 'host/extensions-panel' }],
          },
        ]),
      ),
    ).toBe(true)
  })
  it('leaves every other widget in Config', () => {
    expect(
      isExtensionsPanelSection(
        section([
          { type: 'widget', key: 'rec', label: 'Recording', widgetId: 'host/recording-panel' },
        ]),
      ),
    ).toBe(false)
  })
})

describe('showReadOnlyExtensionsInConfig (L4, final review, D676)', () => {
  it('a non-admin on a camera sees it read-only — Customize is admin-only', () => {
    expect(showReadOnlyExtensionsInConfig(DeviceType.Camera, false)).toBe(true)
  })
  it('an admin does not: they have it in Customize, never twice', () => {
    expect(showReadOnlyExtensionsInConfig(DeviceType.Camera, true)).toBe(false)
  })
  it('a non-admin on a non-host device type sees nothing — no slot to show', () => {
    expect(showReadOnlyExtensionsInConfig(DeviceType.Sensor, false)).toBe(false)
  })
  it('an unanswered device type is not claimed as a host (D315)', () => {
    expect(showReadOnlyExtensionsInConfig(undefined, false)).toBe(false)
  })
})
