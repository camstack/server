import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { clearKnownSecrets } from '../../keychain/known-secrets.js'
import { isSecretMarker, makeSecretMarker } from '../../keychain/secret-marker.js'
import { BaseAddon } from '../base-addon.js'
import { SecretOverwriteRefusedError } from '../secret-write-back.js'
import { type KeychainWorld, newWorld, worldContext } from './keychain-world.js'

/**
 * D798 — every addon-facing read of an addon's own settings answers VALUES.
 * One spec per read path, then the write-back and the unavailable semantics.
 */

interface Config {
  host: string
  apiToken: string
}

const ID = 'reader'
const TOKEN_REF = `secret://${ID}/global/apiToken`
const SIGNING_REF = `secret://${ID}/global/signingKey`
const CAM_REF = `secret://${ID}/device/7/camPassword`

class ReaderAddon extends BaseAddon<Config> {
  protected override readonly secretStatePaths = ['signingKey']
  configChanges = 0

  constructor() {
    super({ host: '', apiToken: '' })
  }

  protected async onInitialize() {
    return []
  }

  protected override async onConfigChanged(): Promise<void> {
    this.configChanges++
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 's',
          title: 's',
          fields: [
            { type: 'text', key: 'host', label: 'Host' },
            { type: 'password', key: 'apiToken', label: 'API token' },
          ],
        },
      ],
    }
  }

  protected override deviceSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'd',
          title: 'd',
          fields: [{ type: 'password', key: 'camPassword', label: 'Camera password' }],
        },
      ],
    }
  }

  globalStore() {
    return this.resolveGlobalStore()
  }
  storedKey(key: string) {
    return this.readStoredGlobalKey(key)
  }
  get unresolved() {
    return this.unresolvedSecrets
  }
}

function fieldValue(
  form: Awaited<ReturnType<ReaderAddon['getGlobalSettings']>>,
  key: string,
): unknown {
  const field = form?.sections.flatMap((s) => s.fields).find((f) => 'key' in f && f.key === key)
  return field && 'value' in field ? field.value : undefined
}

function seeded(w: KeychainWorld): void {
  w.store = {
    host: 'cam.local',
    apiToken: makeSecretMarker(TOKEN_REF),
    signingKey: makeSecretMarker(SIGNING_REF),
  }
  w.kc.set(TOKEN_REF, { value: 'token-value-123', version: 1 })
  w.kc.set(SIGNING_REF, { value: 'signing-value-456', version: 1 })
  w.devices.set(7, { camPassword: makeSecretMarker(CAM_REF), fps: 10 })
  w.kc.set(CAM_REF, { value: 'cam-value-789', version: 1 })
}

async function started(w: KeychainWorld): Promise<ReaderAddon> {
  const addon = new ReaderAddon()
  await addon.initialize(worldContext(w, ID))
  return addon
}

describe('BaseAddon — every addon-facing read resolves keychain markers (D798)', () => {
  let w: KeychainWorld
  beforeEach(() => {
    w = newWorld()
    seeded(w)
  })
  afterEach(() => clearKnownSecrets())

  it('resolveGlobalStore()', async () => {
    const addon = await started(w)
    expect(await addon.globalStore()).toEqual({
      host: 'cam.local',
      apiToken: 'token-value-123',
      signingKey: 'signing-value-456',
    })
  })

  it('ctx.settings.readAddonStore()', async () => {
    const addon = await started(w)
    const stored = await addon.ctx.settings!.readAddonStore()
    expect(stored['apiToken']).toBe('token-value-123')
    expect(stored['signingKey']).toBe('signing-value-456')
  })

  it('ctx.settings.readAddonStoreResult()', async () => {
    const addon = await started(w)
    const read = await addon.ctx.settings!.readAddonStoreResult!()
    expect(read.kind === 'value' ? read.value['apiToken'] : null).toBe('token-value-123')
  })

  it('ctx.settings.readAddonStoreKeyResult() and readStoredGlobalKey()', async () => {
    const addon = await started(w)
    expect(await addon.ctx.settings!.readAddonStoreKeyResult!('apiToken')).toEqual({
      kind: 'present',
      value: 'token-value-123',
    })
    expect(await addon.storedKey('signingKey')).toEqual({
      kind: 'present',
      value: 'signing-value-456',
    })
  })

  it('ctx.settings.readDeviceStore() and readDeviceStoreBatch()', async () => {
    const addon = await started(w)
    expect(await addon.ctx.settings!.readDeviceStore(7)).toEqual({
      camPassword: 'cam-value-789',
      fps: 10,
    })
    const batch = await addon.ctx.settings!.readDeviceStoreBatch!([7, 8])
    expect(batch.get(7)?.['camPassword']).toBe('cam-value-789')
    expect(batch.get(8)).toEqual({})
  })

  it("another owner's marker (a door like device-manager keeps them) is left alone: not resolved, not reported, not taken over", async () => {
    const foreign = makeSecretMarker('secret://some-driver/device/9/password')
    w.devices.set(9, { password: foreign })
    const addon = await started(w)
    expect(await addon.ctx.settings!.readDeviceStore(9)).toEqual({ password: foreign })
    await addon.ctx.settings!.writeDeviceStore(9, { password: 'plain-from-elsewhere' })
    expect(w.kc.has(`secret://${ID}/device/9/password`)).toBe(false)
    expect(w.puts).toBe(0)
  })

  it('the forms still never carry a value — global, device, and an override overlaying a resolved read', async () => {
    const addon = await started(w)
    const view = { $secret: TOKEN_REF, v: 1, set: true }
    expect(fieldValue(await addon.getGlobalSettings(), 'apiToken')).toEqual(view)
    // A `getGlobalSettings` override that passes the resolved store as overlay.
    const overlaid = await addon.getGlobalSettings(await addon.globalStore())
    expect(fieldValue(overlaid, 'apiToken')).toEqual(view)
    expect(JSON.stringify(overlaid)).not.toContain('token-value-123')
    const device = await addon.getDeviceSettings(7)
    expect(JSON.stringify(device)).not.toContain('cam-value-789')
  })
})

describe('BaseAddon — writing back a resolved read is a no-op (D798)', () => {
  let w: KeychainWorld
  beforeEach(() => {
    w = newWorld()
    seeded(w)
  })
  afterEach(() => clearKnownSecrets())

  it('the whole resolved addon blob written back: no blob write, no keychain version', async () => {
    const addon = await started(w)
    const before = structuredClone(w.store)
    await addon.ctx.settings!.writeAddonStore(await addon.ctx.settings!.readAddonStore())
    expect(w.store).toEqual(before)
    expect(w.blobWrites).toBe(0)
    expect(w.puts).toBe(0)
    expect(w.kc.get(TOKEN_REF)?.version).toBe(1)
  })

  it('updateGlobalSettings with the resolved values: no config change, no AddonUpdated', async () => {
    const addon = await started(w)
    const stored = await addon.globalStore()
    await addon.updateGlobalSettings({ host: 'cam.local', apiToken: String(stored['apiToken']) })
    expect(w.blobWrites).toBe(0)
    expect(w.puts).toBe(0)
    expect(addon.configChanges).toBe(0)
    expect(w.updatedEvents).toBe(0)
  })

  it('a device blob written back: unchanged', async () => {
    const addon = await started(w)
    await addon.ctx.settings!.writeDeviceStore(7, await addon.ctx.settings!.readDeviceStore(7))
    expect(w.devices.get(7)?.['camPassword']).toEqual(makeSecretMarker(CAM_REF))
    expect(w.deviceWrites).toBe(0)
    expect(w.puts).toBe(0)
  })

  it('a real change next to the write-back still lands — and the secret stays a marker', async () => {
    const addon = await started(w)
    const stored = await addon.ctx.settings!.readAddonStore()
    await addon.ctx.settings!.writeAddonStore({ ...stored, host: 'other.local' })
    expect(w.store['host']).toBe('other.local')
    expect(w.store['apiToken']).toEqual(makeSecretMarker(TOKEN_REF))
    expect(w.puts).toBe(0)
  })

  it('a changed value is stored in the keychain under the same ref, never in the blob', async () => {
    const addon = await started(w)
    await addon.updateGlobalSettings({ apiToken: 'token-value-NEW' })
    expect(w.store['apiToken']).toEqual(makeSecretMarker(TOKEN_REF))
    expect(w.kc.get(TOKEN_REF)).toEqual({ value: 'token-value-NEW', version: 2 })
    expect(JSON.stringify(w.store)).not.toContain('token-value-NEW')
    expect(addon.config.apiToken).toBe('token-value-NEW')
    expect(addon.configChanges).toBe(1)
  })
})

describe('BaseAddon — an unavailable keychain (D798)', () => {
  let w: KeychainWorld
  beforeEach(() => {
    w = newWorld()
    seeded(w)
  })
  afterEach(() => clearKnownSecrets())

  it('reads answer the MARKER (stored, unavailable) — never "" and never absent', async () => {
    w.locked = true
    const addon = await started(w)
    const stored = await addon.globalStore()
    expect(isSecretMarker(stored['apiToken'])).toBe(true)
    expect(stored['apiToken']).not.toBe('')
    expect(addon.unresolved.map((u) => u.ref)).toContain(TOKEN_REF)
    const device = await addon.ctx.settings!.readDeviceStore(7)
    expect(isSecretMarker(device['camPassword'])).toBe(true)
    await addon.shutdown()
  })

  it('an addon may not overwrite a stored secret it cannot read, even when puts work', async () => {
    w.resolveFails = true
    const addon = await started(w)
    await expect(addon.updateGlobalSettings({ apiToken: 'minted-replacement' })).rejects.toThrow(
      SecretOverwriteRefusedError,
    )
    expect(w.kc.get(TOKEN_REF)).toEqual({ value: 'token-value-123', version: 1 })
    expect(w.store['apiToken']).toEqual(makeSecretMarker(TOKEN_REF))
    await addon.shutdown()
  })

  it('the operator still can: a deliberate change is not a regenerate', async () => {
    w.resolveFails = true
    const addon = await started(w)
    await addon.updateGlobalSettingsAsOperator({ apiToken: 'operator-typed-value' })
    expect(w.kc.get(TOKEN_REF)?.value).toBe('operator-typed-value')
    await addon.shutdown()
  })

  it('a MISSING ref (gone from the keychain) may be minted again', async () => {
    w.kc.delete(TOKEN_REF)
    const addon = await started(w)
    await addon.updateGlobalSettings({ apiToken: 'fresh-token-value' })
    expect(w.kc.get(TOKEN_REF)?.value).toBe('fresh-token-value')
    expect(w.store['apiToken']).toEqual(makeSecretMarker(TOKEN_REF))
  })
})
