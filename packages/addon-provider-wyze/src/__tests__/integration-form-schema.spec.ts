import { describe, expect, it } from 'vitest'
import { WyzeProviderAddon } from '../addon.js'
import { buildSettingsSchema } from '../settings-schema.js'

/**
 * D986 M4: the Wyze account form is the instance form (`wyze-instances`), not the addon's global
 * settings schema. The credentials live on the connection record; the keychain contract of the
 * (stale) global store is kept by `secretStatePaths`, proved in `global-credentials-keychain.spec.ts`.
 */
describe('the Wyze account form', () => {
  it('has the four credential keys', () => {
    const keys = buildSettingsSchema()
      .sections.flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    expect(keys.sort()).toEqual(['apiId', 'apiKey', 'email', 'password'])
  })

  it('is no longer the addon-settings scoped settings', async () => {
    expect(await new WyzeProviderAddon().listScopedSettings()).toEqual([])
  })
})
