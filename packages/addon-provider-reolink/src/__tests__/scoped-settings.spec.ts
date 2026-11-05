import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ReolinkProviderAddon } from '../addon.js'

/**
 * D986 M4: the Reolink provider declares its settings through the device-defaults hook of `videoclips`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends ReolinkProviderAddon {
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

describe('the Reolink provider scoped settings', () => {
  it('names videoclips and declares its keys on the device-defaults hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('videoclips')
    expect(keysOf(await addon.getScopedSettingsSchema('device-defaults', 'videoclips'))).toEqual(
      ['clipCatalogRefreshMinutes'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('device-defaults', 'not-a-capability')).toBeNull()
  })
})
