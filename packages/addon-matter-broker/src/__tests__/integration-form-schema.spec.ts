import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MatterBrokerAddon } from '../addon.js'

/**
 * D986 M4: the Matter broker form is the instance form (`integrationFormSchema`) — the connection
 * form its records carry — not the addon's global settings schema, which was an informational
 * pointer to a screen that no longer exists.
 */
class Probe extends MatterBrokerAddon {
  formFor(): Promise<ConfigUISchema | null> {
    return this.integrationFormSchema({ integrationId: 'fabric-1', mode: 'account' })
  }
  globalFormForTest(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

describe('the Matter integration form', () => {
  it('is the connection form, with the keys the record carries', async () => {
    const form = await new Probe().formFor()
    if (form === null) throw new Error('no instance form declared')
    const keys = form.sections
      .flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    expect(keys.sort()).toEqual([
      'reconcileIntervalMs',
      'threadDataset',
      'wifiPassword',
      'wifiSsid',
    ])
  })

  it('is no longer the addon-settings global schema', () => {
    expect(new Probe().globalFormForTest()).toBeNull()
  })
})
