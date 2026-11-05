import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ConsoleLoggingAddon } from '../console-logging.addon.js'

/**
 * D986 M4: console logging declares its settings through the cluster hook of `log-destination`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends ConsoleLoggingAddon {
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

describe('console logging scoped settings', () => {
  it('names llm and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('log-destination')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'log-destination'))).toEqual(
      ['level'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
