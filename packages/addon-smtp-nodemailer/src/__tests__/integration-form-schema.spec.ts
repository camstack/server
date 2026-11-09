import { describe, expect, it } from 'vitest'
import { SmtpNodemailerAddon } from '../smtp.addon.js'

/**
 * D986 M4: the relay form is the instance form, not the addon's global settings schema — the relay
 * values live on the relay record, never in `addon-settings`.
 */
describe('the SMTP relay settings', () => {
  it('is no longer the addon-settings scoped settings', async () => {
    expect(await new SmtpNodemailerAddon().listScopedSettings()).toEqual([])
  })
})
