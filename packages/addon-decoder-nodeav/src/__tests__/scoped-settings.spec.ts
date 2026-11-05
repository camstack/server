import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import DecoderNodeAvAddon from '../addon/index.js'

/**
 * D986 M4: the decoder's hwaccel settings are per node, declared on the node hook of the `decoder`
 * capability, named up front (the first config resolve runs before the providers register), with
 * the keys it always stored (`hwaccel@<node>`, `probedBestHwaccel@<node>`).
 */
class Probe extends DecoderNodeAvAddon {
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

describe('the node-av decoder scoped settings', () => {
  it('names decoder and declares its keys on the node hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('decoder')
    expect(keysOf(await addon.getScopedSettingsSchema('node', 'decoder'))).toEqual(
      ['hwaccel', 'probedBestHwaccel'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('node', 'audio-codec')).toBeNull()
    expect(await addon.getScopedSettingsSchema('cluster', 'decoder')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'decoder')).toBeNull()
  })
})
