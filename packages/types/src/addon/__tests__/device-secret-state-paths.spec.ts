import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { isSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { type KeychainWorld, newWorld, worldContext } from './keychain-world.js'

/**
 * `secretStatePaths` also name hidden credentials in the PER-DEVICE store
 * (D870): the stream-broker keeps a camera's restream tokens as the device
 * setting `rtspTokens`, and a token must live in the keychain, never as
 * plaintext in the settings rows.
 */
const ID = 'broker'

class BrokerLike extends BaseAddon<{ x: string }> {
  protected override readonly secretStatePaths = ['rtspTokens']
  constructor() {
    super({ x: '' })
  }
  protected async onInitialize() {
    return []
  }
}

describe('secretStatePaths cover the per-device store', () => {
  let w: KeychainWorld
  beforeEach(() => {
    w = newWorld()
  })
  afterEach(() => clearKnownSecrets())

  it('a device setting named in secretStatePaths is stored as a keychain marker', async () => {
    const addon = new BrokerLike()
    await addon.initialize(worldContext(w, ID))

    await addon.ctx.settings!.writeDeviceStore(7, {
      rtspTokens: '{"native:main":"tok-a"}',
      fps: 10,
    })

    const stored = w.devices.get(7)
    expect(isSecretMarker(stored?.['rtspTokens'])).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('tok-a')
    expect(stored?.['fps']).toBe(10)
    expect(w.kc.get(`secret://${ID}/device/7/rtspTokens`)?.value).toBe('{"native:main":"tok-a"}')
    // …and it reads back as the value.
    expect((await addon.ctx.settings!.readDeviceStore(7))['rtspTokens']).toBe(
      '{"native:main":"tok-a"}',
    )
  })

  it('a locked keychain REFUSES the write - the token is never stored in plaintext', async () => {
    w.locked = true
    const addon = new BrokerLike()
    await addon.initialize(worldContext(w, ID))

    await expect(
      addon.ctx.settings!.writeDeviceStore(7, { rtspTokens: '{"native:main":"tok-a"}' }),
    ).rejects.toThrow()
    expect(JSON.stringify(w.devices.get(7) ?? {})).not.toContain('tok-a')
  })
})
