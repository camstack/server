/**
 * The exporter page pattern on the HA export: the reconcile cadence is a tuning knob, so it
 * sits in a collapsed Advanced section. The hub address is no setting of the addon: each
 * instance chooses a ROLE (D986 §5), stored beside its own switch.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { HaExportAddon } from '../ha-export.addon.js'

function schema(knownBrokers: readonly { id: string; name: string }[] = []): ConfigUISchema {
  const addon = new HaExportAddon()
  Object.defineProperty(addon, 'config', {
    value: { ...addonConfig(addon), knownBrokers },
  })
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema })
    .globalSettingsSchema
  return read.call(addon)
}

function addonConfig(addon: HaExportAddon): Record<string, unknown> {
  return Reflect.get(addon, 'config')
}

function keysOf(s: ConfigUISchema, id: string): string[] {
  const section = s.sections.find((sec) => sec.id === id)
  return (section?.fields ?? []).flatMap((f) => ('key' in f ? [f.key] : []))
}

describe('HA export settings page', () => {
  it('keeps the reconcile interval in a collapsed Advanced and stores no URL', () => {
    const s = schema()
    expect(keysOf(s, 'ha-export-advanced')).toEqual(['reconcileIntervalSec'])
    const advanced = s.sections.find((sec) => sec.id === 'ha-export-advanced')
    expect(advanced?.style).toBe('accordion')
    expect(advanced?.defaultCollapsed).toBe(true)
    const all = s.sections.flatMap((sec) => sec.fields.flatMap((f) => ('key' in f ? [f.key] : [])))
    expect(all).not.toContain('publicBaseUrl')
  })

  it('offers one media role per instance, as a select with the two roles', () => {
    const s = schema([
      { id: 'lan-ha', name: 'Living room HA' },
      { id: 'remote-ha', name: 'Holiday house HA' },
    ])
    expect(keysOf(s, 'ha-export-transport')).toEqual(['mediaRole:lan-ha', 'mediaRole:remote-ha'])
    const field = s.sections.find((sec) => sec.id === 'ha-export-transport')?.fields[0]
    expect(field?.type).toBe('select')
    if (field?.type !== 'select') return
    expect(field.options.map((o) => o.value)).toEqual(['internal', 'publicEndpoint'])
    expect(field.default).toBe('publicEndpoint')
  })
})
