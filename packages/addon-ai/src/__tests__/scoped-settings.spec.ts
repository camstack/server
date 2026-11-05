import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AiAddon } from '../addon.js'

/**
 * D986 M4: the AI addon declares its settings through the cluster hook of `llm`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends AiAddon {
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

describe('the AI addon scoped settings', () => {
  it('names llm and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('llm')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'llm'))).toEqual(
      ['chatRetentionMaxAgeDays', 'chatRetentionMaxCount'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
