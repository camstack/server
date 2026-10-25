import {
  type AddonContext,
  createSecretsAccess,
  type KeychainResolveResult,
  type KeychainTransport,
  makeSecretMarker,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  loadDeviceConfigWithSecrets,
  persistDeviceConfigWithSecrets,
} from '../device-config-secrets.js'

/**
 * The device-config door (D787): a camera password is kept in the keychain for
 * its DRIVER, the blob holds a marker, and the driver's `loadConfig` reads the
 * value back — no driver ever sees a marker.
 */

interface Kc {
  readonly values: Map<string, { value: string; version: number }>
  locked: boolean
  readonly callers: string[]
}

function transportFor(kc: Kc, owner: string): KeychainTransport {
  return {
    async put({ ref, value }) {
      kc.callers.push(owner)
      if (kc.locked) throw new Error('locked')
      const version = (kc.values.get(ref)?.version ?? 0) + 1
      kc.values.set(ref, { value, version })
      return { ref, version }
    },
    async resolve({ refs }) {
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const v = kc.values.get(ref)
        out[ref] = kc.locked
          ? { kind: 'unavailable', reason: 'wrong-key' }
          : v
            ? { kind: 'value', value: v.value, version: v.version }
            : { kind: 'missing' }
      }
      return out
    },
    async delete({ refs }) {
      for (const r of refs) kc.values.delete(r)
      return { deleted: refs.length }
    },
    async getState() {
      return { state: 'ready' }
    },
  }
}

function ctxFor(kc: Kc): AddonContext {
  const logger: AddonContext['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const secrets = createSecretsAccess({
    owner: 'device-manager',
    transport: transportFor(kc, 'device-manager'),
    transportForOwner: (owner) => transportFor(kc, owner),
  })
  // Only `logger` and `secrets` are read by the door.
  return { logger, secrets } as unknown as AddonContext // documented test boundary: the door reads two members
}

const REF = 'secret://provider-onvif/device/101/password'

describe('device config keychain door', () => {
  it('stores the declared password for the DRIVER and the blob gets a marker', async () => {
    const kc: Kc = { values: new Map(), locked: false, callers: [] }
    let blob: Record<string, unknown> = {}
    await persistDeviceConfigWithSecrets(
      {
        ctx: ctxFor(kc),
        readStored: async () => blob,
        write: async (patch) => {
          blob = { ...blob, ...patch }
        },
      },
      {
        deviceId: 101,
        ownerAddonId: 'provider-onvif',
        data: { host: '10.0.0.9', password: 'camera-password-1' },
        secretPaths: ['password'],
        operatorWrite: false,
      },
    )
    expect(blob).toEqual({ host: '10.0.0.9', password: makeSecretMarker(REF) })
    expect(kc.callers).toEqual(['provider-onvif'])
    const loaded = await loadDeviceConfigWithSecrets(ctxFor(kc), {
      deviceId: 101,
      ownerAddonId: 'provider-onvif',
      stored: blob,
    })
    expect(loaded).toEqual({ host: '10.0.0.9', password: 'camera-password-1' })
  })

  it('a pre-keychain inline password written back unchanged stays inline (no silent migration)', async () => {
    const kc: Kc = { values: new Map(), locked: false, callers: [] }
    let blob: Record<string, unknown> = { host: 'h', password: 'legacy-password' }
    await persistDeviceConfigWithSecrets(
      {
        ctx: ctxFor(kc),
        readStored: async () => blob,
        write: async (patch) => {
          blob = { ...blob, ...patch }
        },
      },
      {
        deviceId: 101,
        ownerAddonId: 'provider-onvif',
        data: { ...blob },
        secretPaths: ['password'],
        operatorWrite: false,
      },
    )
    expect(blob['password']).toBe('legacy-password')
    expect(kc.values.size).toBe(0)
  })

  it('the OPERATOR sending the same value stores it as sent — in the keychain', async () => {
    const kc: Kc = { values: new Map(), locked: false, callers: [] }
    let blob: Record<string, unknown> = { host: 'h', password: 'legacy-password' }
    await persistDeviceConfigWithSecrets(
      {
        ctx: ctxFor(kc),
        readStored: async () => blob,
        write: async (patch) => {
          blob = { ...blob, ...patch }
        },
      },
      {
        deviceId: 101,
        ownerAddonId: 'provider-onvif',
        data: { password: 'legacy-password' },
        secretPaths: ['password'],
        operatorWrite: true,
      },
    )
    expect(blob['password']).toEqual(makeSecretMarker(REF))
    expect(kc.values.get(REF)?.value).toBe('legacy-password')
  })

  it('a locked keychain: loadConfig leaves the password out — never an empty string', async () => {
    const kc: Kc = {
      values: new Map([[REF, { value: 'p', version: 1 }]]),
      locked: true,
      callers: [],
    }
    const loaded = await loadDeviceConfigWithSecrets(ctxFor(kc), {
      deviceId: 101,
      ownerAddonId: 'provider-onvif',
      stored: { host: 'h', password: makeSecretMarker(REF) },
    })
    expect(loaded).toEqual({ host: 'h' })
  })
})
