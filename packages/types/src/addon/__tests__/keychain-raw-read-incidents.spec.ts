import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { isSecretMarker, makeSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { type KeychainWorld, newWorld, worldContext } from './keychain-world.js'

/**
 * The three incidents of 2026-10-08, each reproduced GENERICALLY — the same
 * code shape, in a throwaway addon — against the root fix (D798): a marker in
 * the store, the addon reads, gets the plaintext; writes it back, nothing
 * changes and nothing loops.
 */

// ── Wyze (b4906cec6): no globalSettingsSchema, credentials read raw ────────

interface WyzeLikeConfig {
  apiKey: string
}

class NoSchemaAddon extends BaseAddon<WyzeLikeConfig> {
  constructor() {
    super({ apiKey: '' })
  }
  protected async onInitialize() {
    return []
  }
  /** The shape: read the store, use `store.password` as a string. */
  async credentials(): Promise<{ username: unknown; password: unknown }> {
    const stored = await this.resolveGlobalStore()
    return { username: stored['username'], password: stored['password'] }
  }
  /** The shape: persist the whole credentials object it just read. */
  async persistCredentials(): Promise<void> {
    const { username, password } = await this.credentials()
    await this.updateGlobalSettings({ username, password } as Partial<WyzeLikeConfig>)
  }
}

// ── ONVIF (a79a31462): `_getAddonConfig()` reads a password raw ────────────

interface OnvifLikeConfig {
  defaultPassword: string
}

class RawConfigAddon extends BaseAddon<OnvifLikeConfig> {
  constructor() {
    super({ defaultPassword: '' })
  }
  protected async onInitialize() {
    return []
  }
  protected override globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'd',
          title: 'd',
          fields: [{ type: 'password', key: 'defaultPassword', label: 'Default password' }],
        },
      ],
    }
  }
  /** The shape: `raw.defaultPassword` typed as a string, undefined when not one. */
  async addonConfig(): Promise<{ defaultPassword: string | undefined }> {
    const raw = await this.resolveGlobalStore()
    const value = raw['defaultPassword']
    return { defaultPassword: typeof value === 'string' && value !== '' ? value : undefined }
  }
}

// ── Reolink (675e83e39): hidden state, bootstrap-if-absent, restart on change

interface ReolinkLikeConfig {
  emailPushAuthPassword: string
}

const MAX_TURNS = 20

class BootstrapAddon extends BaseAddon<ReolinkLikeConfig> {
  protected override readonly secretStatePaths = ['emailPushAuthPassword']
  serverStarts = 0
  minted = 0
  passwordInUse: unknown = null

  constructor() {
    super({ emailPushAuthPassword: '' })
  }
  protected async onInitialize() {
    await this.startServer()
    return []
  }
  /** A config change restarts the server — which reads the store again. */
  protected override async onConfigChanged(): Promise<void> {
    if (this.serverStarts < MAX_TURNS) await this.startServer()
  }
  /** The shape: a non-string password is "absent" → mint one and persist it. */
  private async startServer(): Promise<void> {
    this.serverStarts++
    const store = await this.resolveGlobalStore()
    const stored = store['emailPushAuthPassword']
    if (typeof stored === 'string' && stored.length > 0) {
      this.passwordInUse = stored
      return
    }
    if (isSecretMarker(stored)) {
      // Stored, unavailable: run on a temporary password and save nothing.
      this.passwordInUse = 'temporary'
      return
    }
    this.minted++
    const fresh = `minted-${this.minted}-password`
    this.passwordInUse = fresh
    await this.updateGlobalSettings({ emailPushAuthPassword: fresh })
  }
}

describe('the 2026-10-08 raw-read incidents, generically (D798)', () => {
  let w: KeychainWorld
  beforeEach(() => {
    w = newWorld()
  })
  afterEach(() => clearKnownSecrets())

  it('Wyze: a marker under a key no schema declares reads as plaintext and writes back unchanged', async () => {
    const ref = 'secret://wyze-like/global/password'
    w.store = { username: 'me@example.com', password: makeSecretMarker(ref) }
    w.kc.set(ref, { value: 'wyze-password-1', version: 1 })
    const addon = new NoSchemaAddon()
    await addon.initialize(worldContext(w, 'wyze-like'))
    expect(await addon.credentials()).toEqual({
      username: 'me@example.com',
      password: 'wyze-password-1',
    })
    await addon.persistCredentials()
    expect(w.store['password']).toEqual(makeSecretMarker(ref))
    expect(JSON.stringify(w.store)).not.toContain('wyze-password-1')
    expect(w.blobWrites).toBe(0)
    expect(w.puts).toBe(0)
  })

  it('ONVIF: the raw config read gets the password, not undefined', async () => {
    const ref = 'secret://onvif-like/global/defaultPassword'
    w.store = { defaultPassword: makeSecretMarker(ref) }
    w.kc.set(ref, { value: 'onvif-default-pw', version: 1 })
    const addon = new RawConfigAddon()
    await addon.initialize(worldContext(w, 'onvif-like'))
    expect(await addon.addonConfig()).toEqual({ defaultPassword: 'onvif-default-pw' })
  })

  it('Reolink: the kept password is used — nothing minted, no new version, no restart loop', async () => {
    const ref = 'secret://reolink-like/global/emailPushAuthPassword'
    w.store = { emailPushAuthPassword: makeSecretMarker(ref) }
    w.kc.set(ref, { value: 'provisioned-on-cameras', version: 1 })
    const addon = new BootstrapAddon()
    await addon.initialize(worldContext(w, 'reolink-like'))
    expect(addon.passwordInUse).toBe('provisioned-on-cameras')
    expect(addon.minted).toBe(0)
    expect(addon.serverStarts).toBe(1)
    expect(w.puts).toBe(0)
    expect(w.kc.get(ref)?.version).toBe(1)
  })

  it('Reolink, keychain down: the marker reads as "stored, unavailable" and is never replaced', async () => {
    const ref = 'secret://reolink-like/global/emailPushAuthPassword'
    w.store = { emailPushAuthPassword: makeSecretMarker(ref) }
    w.kc.set(ref, { value: 'provisioned-on-cameras', version: 1 })
    w.resolveFails = true
    const addon = new BootstrapAddon()
    await addon.initialize(worldContext(w, 'reolink-like'))
    expect(addon.passwordInUse).toBe('temporary')
    expect(addon.minted).toBe(0)
    expect(w.kc.get(ref)).toEqual({ value: 'provisioned-on-cameras', version: 1 })
    await addon.shutdown()
  })

  it('Reolink, the naive shape (no marker check): the overwrite is refused, the kept password survives', async () => {
    const ref = 'secret://reolink-like/global/emailPushAuthPassword'
    w.store = { emailPushAuthPassword: makeSecretMarker(ref) }
    w.kc.set(ref, { value: 'provisioned-on-cameras', version: 1 })
    w.resolveFails = true
    class NaiveBootstrap extends BootstrapAddon {
      async mintOverwhatever(): Promise<void> {
        await this.updateGlobalSettings({ emailPushAuthPassword: 'minted-over-the-kept-one' })
      }
    }
    const addon = new NaiveBootstrap()
    await addon.initialize(worldContext(w, 'reolink-like'))
    await expect(addon.mintOverwhatever()).rejects.toThrow(/was not replaced/)
    expect(w.kc.get(ref)).toEqual({ value: 'provisioned-on-cameras', version: 1 })
    expect(w.updatedEvents).toBe(0)
    await addon.shutdown()
  })
})
