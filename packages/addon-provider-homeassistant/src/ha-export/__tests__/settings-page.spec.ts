/**
 * The exporter page pattern on the HA export: the reconcile cadence is a
 * tuning knob, so it sits in a collapsed Advanced section, out of the way of
 * the address an operator does need to check.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { HaExportAddon } from '../ha-export.addon.js'

function schema(): ConfigUISchema {
  const addon = new HaExportAddon()
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema })
    .globalSettingsSchema
  return read.call(addon)
}

function keysOf(id: string): string[] {
  const section = schema().sections.find((s) => s.id === id)
  return (section?.fields ?? []).flatMap((f) => ('key' in f ? [f.key] : []))
}

describe('HA export settings page', () => {
  it('keeps the address in Connection and the reconcile interval in a collapsed Advanced', () => {
    expect(keysOf('ha-export-transport')).toEqual(['publicBaseUrl'])
    expect(keysOf('ha-export-advanced')).toEqual(['reconcileIntervalSec'])
    const advanced = schema().sections.find((s) => s.id === 'ha-export-advanced')
    expect(advanced?.style).toBe('accordion')
    expect(advanced?.defaultCollapsed).toBe(true)
    expect(schema().sections.find((s) => s.id === 'ha-export-transport')?.title).toBe('Connection')
  })
})
