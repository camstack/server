import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DeviceHistoryAddon } from '../device-history.addon.js'

/**
 * D986 M4: device history declares its settings through the cluster hook of `device-history`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends DeviceHistoryAddon {
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

describe('device history scoped settings', () => {
  it('names llm and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('device-history')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'device-history'))).toEqual(
      ['rawDays', 'fiveMinuteDays', 'hourDays', 'dayDays'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
