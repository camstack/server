/**
 * Cluster-wide sections must not reach a camera's Analytics tab (D62).
 *
 * `getDeviceSettingsContribution` builds the per-camera form from the SAME
 * `globalSettingsSchema()` the global page renders, then drops the sections
 * named in `GLOBAL_ONLY_SECTIONS`. The four below have a reader that consults
 * the global addon store only (`pruneWindows()` -> `resolveGlobalStore`,
 * `deviceAlertSettingsMirror` -> `rawGlobalStoreMirror`), so a per-camera write
 * to any of their keys was stored and never read. Showing them on a camera was
 * the dead knob.
 *
 * Disarm: remove one id from `GLOBAL_ONLY_SECTIONS` — that id's case fails.
 */
import { describe, expect, it } from 'vitest'
import { PRUNE_SETTING_KEYS } from '../../notification-center/prune-windows.js'
import { DEVICE_ALERT_DEFAULTS } from '../device-alert-settings.js'
import { buildGlobalSettingsSchema, stripGlobalOnlyFields } from '../settings-schema.js'

const sections = buildGlobalSettingsSchema().sections

function keysOf(id: string): readonly string[] {
  const section = sections.find((s) => s.id === id)
  return (section?.fields ?? []).map((f) => f.key).filter((k): k is string => k !== undefined)
}

describe('global-only sections are stripped from the per-camera form', () => {
  const perDeviceIds = stripGlobalOnlyFields(sections).map((s) => s.id)

  it.each([
    'prune-windows',
    'device-alerts',
    'embedding-index',
    'cluster-post-processing',
  ])('%s is on the global page and absent per camera', (id) => {
    expect(sections.map((s) => s.id)).toContain(id)
    expect(perDeviceIds).not.toContain(id)
  })

  it('the hidden fields are exactly the keys the global readers consume', () => {
    expect([...keysOf('prune-windows')].sort()).toEqual([...PRUNE_SETTING_KEYS].sort())
    expect([...keysOf('device-alerts')].sort()).toEqual(Object.keys(DEVICE_ALERT_DEFAULTS).sort())
  })

  it('keeps every section that has a per-camera reader', () => {
    for (const id of ['retention', 'media-policy', 'package-drop', 'audio-detection']) {
      expect(perDeviceIds).toContain(id)
    }
  })
})
