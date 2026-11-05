import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ModelStudioAddon } from '../model-studio.addon.js'

/**
 * D986 M4: Model Studio declares its settings through the cluster hook of `custom-model-registry`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends ModelStudioAddon {
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

describe('Model Studio scoped settings', () => {
  it('names custom-model-registry and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('custom-model-registry')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'custom-model-registry'))).toEqual(
      ['plusCatalogPlusApiKey'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
