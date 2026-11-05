import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AlertCenterAddon } from '../alerts.addon.js'

/**
 * D986 M4: the alert center declares its settings through the cluster hook of `alerts`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends AlertCenterAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('the alert center scoped settings', () => {
  it('names alerts and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('alerts')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'alerts'))).toEqual(
      ['maxAlerts', 'retentionDays'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
