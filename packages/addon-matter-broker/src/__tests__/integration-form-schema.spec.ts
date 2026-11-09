import { describe, expect, it } from 'vitest'
import { MatterBrokerAddon } from '../addon.js'
import { buildConnectionFormSchema } from '../config.js'

/**
 * D986 M4: the Matter broker form is the instance form (`matter-account-instances`) — the
 * connection form its records carry — not the addon's global settings schema, which was an
 * informational pointer to a screen that no longer exists.
 */
describe('the Matter integration form', () => {
  it('is the connection form, with the keys the record carries', () => {
    const keys = buildConnectionFormSchema()
      .sections.flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    expect(keys.sort()).toEqual([
      'reconcileIntervalMs',
      'threadDataset',
      'wifiPassword',
      'wifiSsid',
    ])
  })

  it('is no longer the addon-settings scoped settings', async () => {
    expect(await new MatterBrokerAddon().listScopedSettings()).toEqual([])
  })
})
