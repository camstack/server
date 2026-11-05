import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import RecorderV2Addon from '../addon/index.js'

/**
 * D986 M4: the recorder declares its settings through the cluster hook of `recording`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends RecorderV2Addon {
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

describe('the recorder scoped settings', () => {
  it('names recording and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('recording')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'recording'))).toEqual(
      ['recordingNodeId', 'recordingHubHostname'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
