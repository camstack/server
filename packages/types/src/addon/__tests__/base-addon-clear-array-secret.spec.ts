import { afterEach, describe, expect, it } from 'vitest'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { makeSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { newWorld, worldContext } from './keychain-world.js'

/**
 * `clearSecrets` on a key that is an ARRAY of rows carrying secrets (`tokens[userId].accessToken`)
 * used to store the clear instruction itself (`{ $secretClear: true }`) as the key's value: the
 * config then held an object where the addon expected a list, and the next read of it threw
 * "tokens.find is not a function" (export-alexa ledger migration, 2026-11-03).
 */
interface Row {
  userId: string
  accessToken: string
}
class LedgerAddon extends BaseAddon<{ tokens: Row[] }> {
  protected override readonly secretStatePaths = ['tokens[userId].accessToken']
  constructor() {
    super({ tokens: [] })
  }
  protected async onInitialize() {
    return []
  }
  clear() {
    return this.clearSecrets(['tokens'])
  }
}

afterEach(() => clearKnownSecrets())

describe('BaseAddon.clearSecrets on an array of secret-carrying rows', () => {
  it('leaves an empty list, deletes the credentials, and keeps config.tokens a list', async () => {
    const w = newWorld()
    const ref = 'secret://ledger/global/tokens[u1].accessToken'
    w.store = {
      tokens: [{ userId: 'u1', accessToken: makeSecretMarker(ref) }],
    }
    w.kc.set(ref, { value: 'plain', version: 1 })
    const addon = new LedgerAddon()
    await addon.initialize(worldContext(w, 'ledger'))
    expect(addon.config.tokens).toHaveLength(1)

    await addon.clear()

    expect(w.store['tokens']).toEqual([])
    expect(Array.isArray(addon.config.tokens)).toBe(true)
    expect(addon.config.tokens).toEqual([])
    expect(w.kc.has(ref)).toBe(false)
  })
})
