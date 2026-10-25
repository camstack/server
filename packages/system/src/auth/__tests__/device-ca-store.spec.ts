import { describe, expect, it } from 'vitest'
import { DEVICE_CA_KEY_REF, issueDeviceLeaf, verifyDeviceLeaf } from '../device-ca.js'
import { DeviceCaStore } from '../device-ca-store.js'
import { makeFakeSecrets } from './fake-secrets.js'

function harness() {
  const secrets = makeFakeSecrets()
  const settings = new Map<string, Record<string, unknown>>()
  let failWrite = false
  const store = new DeviceCaStore({
    secrets: secrets.handle,
    readSection: async (s) => settings.get(s) ?? {},
    writeSection: async (s, patch) => {
      if (failWrite) {
        failWrite = false
        throw new Error('settings write failed')
      }
      settings.set(s, { ...settings.get(s), ...patch })
    },
  })
  return {
    secrets,
    settings,
    store,
    failNextWrite: () => {
      failWrite = true
    },
    fresh: () =>
      new DeviceCaStore({
        secrets: secrets.handle,
        readSection: async (s) => settings.get(s) ?? {},
        writeSection: async (s, patch) => {
          settings.set(s, { ...settings.get(s), ...patch })
        },
      }),
  }
}

describe('DeviceCaStore', () => {
  it('reports `absent` only when BOTH the key and the certificate are missing, and creates then', async () => {
    const h = harness()
    expect(await h.store.lookup()).toEqual({ state: 'absent' })
    const ca = await h.store.ensure()
    expect(ca.certPem).toContain('BEGIN CERTIFICATE')
    expect(h.settings.get('cluster')?.['deviceCa']).toBe(ca.certPem)
    expect(h.secrets.values.has(DEVICE_CA_KEY_REF)).toBe(true)
  })

  it('SECURITY: key missing with the certificate present is an explicit error, never a new CA', async () => {
    const h = harness()
    await h.store.ensure()
    const certBefore = h.settings.get('cluster')?.['deviceCa']
    h.secrets.values.clear() // the keychain lost the key
    const reopened = h.fresh()
    const found = await reopened.lookup()
    expect(found.state).toBe('unavailable')
    if (found.state === 'unavailable') expect(found.reason).toContain('key is missing')
    await expect(reopened.ensure()).rejects.toThrow(/device CA unavailable/)
    expect(h.secrets.values.has(DEVICE_CA_KEY_REF)).toBe(false)
    expect(h.settings.get('cluster')?.['deviceCa']).toBe(certBefore)
  })

  it('a creation that died after the key write is completed by the next lookup, with the SAME key', async () => {
    const h = harness()
    h.failNextWrite()
    await expect(h.store.ensure()).rejects.toThrow('settings write failed')
    expect(h.secrets.values.has(DEVICE_CA_KEY_REF)).toBe(true)
    expect(h.settings.get('cluster')?.['deviceCa']).toBeUndefined()
    const keyBefore = h.secrets.values.get(DEVICE_CA_KEY_REF)
    const recovered = await h.fresh().lookup()
    expect(recovered.state).toBe('ready')
    expect(h.secrets.values.get(DEVICE_CA_KEY_REF)).toBe(keyBefore)
    expect(h.settings.get('cluster')?.['deviceCa']).toContain('BEGIN CERTIFICATE')
    expect(h.secrets.puts()).toBe(1)
  })

  it('a leaf issued before the interruption still verifies against the rebuilt certificate', async () => {
    const h = harness()
    const original = await h.store.ensure()
    const leaf = await issueDeviceLeaf(original, {
      credentialId: 'c-1',
      userId: 'u-1',
      publicKeySpki: Buffer.from(
        (await crypto.subtle.exportKey(
          'spki',
          (
            await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
              'sign',
              'verify',
            ])
          ).publicKey,
        )) as ArrayBuffer,
      ),
    })
    delete h.settings.get('cluster')?.['deviceCa'] // certificate lost, key kept
    const rebuilt = await h.fresh().lookup()
    if (rebuilt.state !== 'ready') throw new Error('not rebuilt')
    expect(rebuilt.ca.certPem).not.toBe(original.certPem)
    expect((await verifyDeviceLeaf(rebuilt.ca.certPem, leaf.certPem)).ok).toBe(true)
  })
})
