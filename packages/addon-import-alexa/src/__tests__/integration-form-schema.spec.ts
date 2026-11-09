import { describe, expect, it } from 'vitest'
import { AlexaImportAddon } from '../addon.js'
import { buildConnectionFormSchema } from '../config.js'

/**
 * D986 M4: the Alexa import form is the instance form (`alexa-account-instances`) — the connection
 * form its records carry — not the addon's global settings schema, which was an informational
 * pointer to a screen that no longer exists.
 */
describe('the Alexa import integration form', () => {
  it('is the connection form: region and poll interval, never the sign-in cookie or refresh token', () => {
    const keys = buildConnectionFormSchema()
      .sections.flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    expect(keys.sort()).toEqual(['amazonDomain', 'pollIntervalMs'])
  })

  it('is no longer the addon-settings scoped settings', async () => {
    expect(await new AlexaImportAddon().listScopedSettings()).toEqual([])
  })
})
