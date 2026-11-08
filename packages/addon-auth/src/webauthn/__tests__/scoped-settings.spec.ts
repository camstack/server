import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthWebauthnAddon } from '../auth-webauthn.addon.js'

/**
 * D986: the relying-party identity is one value for the whole cluster, so it is declared on the
 * CLUSTER hook of `login-method` (rows `<addonId>.<field>`, the keys the addon always stored),
 * named up front, and the addon keeps no form of its own beside it.
 */
class Probe extends AuthWebauthnAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

const valueKeys = (schema: ConfigUISchema | null): string[] => {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('webauthn scoped settings', () => {
  it('declares the four relying-party keys on the cluster hook only', async () => {
    const addon = new Probe()
    expect(addon.caps()).toContain('login-method')
    expect(valueKeys(await addon.getScopedSettingsSchema('cluster', 'login-method'))).toEqual([
      'challengeTtlSec',
      'origin',
      'rpID',
      'rpName',
    ])
    expect(await addon.getScopedSettingsSchema('node', 'login-method')).toBeNull()
    expect(await addon.getScopedSettingsSchema('cluster', 'not-a-capability')).toBeNull()
  })

  it('serves that form through the settings read without a hand-built overlay', async () => {
    const view = await new Probe().getScopedSettings('cluster', 'login-method')
    const keys = (view?.sections ?? [])
      .flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field && field.type !== 'info' ? [field.key] : []))
    expect(keys.sort()).toEqual(['challengeTtlSec', 'origin', 'rpID', 'rpName'])
  })
})
