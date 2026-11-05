import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WyzeProviderAddon } from '../addon.js'

/**
 * D986 M4: the Wyze account form is the instance form (`integrationFormSchema`), not the addon's
 * global settings schema. The credentials live on the connection record; the keychain contract of
 * the (stale) global store is kept by `secretStatePaths`, proved in `global-credentials-keychain.spec.ts`.
 */
class Probe extends WyzeProviderAddon {
  formFor(): Promise<ConfigUISchema | null> {
    return this.integrationFormSchema({ integrationId: 'acct-1', mode: 'account' })
  }
  globalFormForTest(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

describe('the Wyze account form', () => {
  it('is the instance form, with the four credential keys', async () => {
    const form = await new Probe().formFor()
    if (form === null) throw new Error('no instance form declared')
    const keys = form.sections
      .flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    expect(keys.sort()).toEqual(['apiId', 'apiKey', 'email', 'password'])
  })

  it('is no longer the addon-settings global schema', () => {
    expect(new Probe().globalFormForTest()).toBeNull()
  })
})
