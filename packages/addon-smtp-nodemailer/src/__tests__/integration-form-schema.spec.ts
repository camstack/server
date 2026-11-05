import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { SmtpNodemailerAddon } from '../smtp.addon.js'

/**
 * D986 M4: the relay form is the instance form (`integrationFormSchema`), not the addon's global
 * settings schema — the relay values live on the relay record, never in `addon-settings`.
 */
class Probe extends SmtpNodemailerAddon {
  relayFormFor(): Promise<ConfigUISchema | null> {
    return this.integrationFormSchema({ integrationId: 'relay-1', mode: 'account' })
  }
  globalFormForTest(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) => ('key' in field ? [field.key] : []))
    .sort()
}

describe('the SMTP relay form', () => {
  it('is the instance form, with the keys the relay record carries', async () => {
    const addon = new Probe()
    expect(keysOf(await addon.relayFormFor())).toEqual(
      ['fromAddress', 'fromName', 'host', 'password', 'port', 'secure', 'username'].sort(),
    )
  })

  it('is no longer the addon-settings global schema', () => {
    expect(new Probe().globalFormForTest()).toBeNull()
  })
})
