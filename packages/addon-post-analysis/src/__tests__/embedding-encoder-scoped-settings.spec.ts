import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import EmbeddingEncoderAddon from '../embedding-encoder/addon/index.js'

/**
 * D986 M4: the embedding encoder declares its settings through the cluster hook of `embedding-encoder`, names that
 * capability up front (the first config resolve runs before the providers register), and
 * keeps the keys it always stored.
 */
class Probe extends EmbeddingEncoderAddon {
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

describe('the embedding encoder scoped settings', () => {
  it('names embedding-encoder and declares its keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('embedding-encoder')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'embedding-encoder'))).toEqual(
      ['modelId'].sort(),
    )
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })
})
