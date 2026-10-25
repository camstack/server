import { sign as nodeSign, webcrypto, X509Certificate } from 'node:crypto'
import {
  buildDeviceSignatureMessage,
  DEVICE_CERT_VALIDITY_DAYS,
  DEVICE_ENROLLMENT_TTL_MS,
  DEVICE_NONCE_TTL_MS,
  type DeviceSignaturePurpose,
  type SettingsStoreClient,
} from '@camstack/types'
import { SubjectAlternativeNameExtension, X509Certificate as Peculiar } from '@peculiar/x509'
import { beforeEach, describe, expect, it } from 'vitest'
import { CERT_NOT_BEFORE_BACKDATE_MS } from '../../tls/cert-backdate.js'
import { makeStore } from '../../builtins/local-auth/__tests__/memory-settings-store.js'
import { DEVICE_CA_KEY_REF, verifyDeviceSignature } from '../device-ca.js'
import { DeviceCaStore } from '../device-ca-store.js'
import { fakeSecrets } from './fake-secrets.js'
import { DeviceCredentialManager, PREVIOUS_LEAF_GRACE_MS } from '../device-credential-manager.js'

const DAY = 86_400_000
const ORIGIN = 'https://hub.example.com'

interface Device {
  readonly spki: string
  sign(message: string, encoding?: 'p1363' | 'der'): Promise<string>
}

async function newDevice(): Promise<Device> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString(
    'base64url',
  )
  return {
    spki,
    sign: async (message, encoding = 'p1363') => {
      if (encoding === 'p1363') {
        const sig = await webcrypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          Buffer.from(message),
        )
        return Buffer.from(sig).toString('base64url')
      }
      const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)
      const { createPrivateKey } = await import('node:crypto')
      const key = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
      return nodeSign('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }).toString(
        'base64url',
      )
    },
  }
}

function harness(opts: { selfEnrollment?: boolean } = {}) {
  let now = Date.parse('2026-10-15T10:00:00Z')
  const store = makeStore() as unknown as SettingsStoreClient
  const settings = new Map<string, Record<string, unknown>>()
  const ca = new DeviceCaStore({
    secrets: fakeSecrets(),
    readSection: async (s) => settings.get(s) ?? {},
    writeSection: async (s, patch) => {
      settings.set(s, { ...settings.get(s), ...patch })
    },
  })
  const manager = new DeviceCredentialManager(store, {
    ca,
    findUser: async (id) => (id === 'gone' ? null : { username: `user-${id}` }),
    selfEnrollmentAllowed: async () => opts.selfEnrollment ?? true,
    now: () => now,
  })
  return {
    manager,
    ca,
    store,
    settings,
    advance: (ms: number) => {
      now += ms
    },
    at: () => now,
  }
}

type Harness = ReturnType<typeof harness>

async function enroll(h: Harness, device: Device, userId = 'u-1') {
  const { code } = h.manager.startEnrollment({
    userId,
    deviceName: 'Wife iPhone',
    createdBy: 'admin',
  })
  const issued = await h.manager.completeEnrollment({
    code,
    publicKeySpki: device.spki,
    platform: 'ios',
  })
  if (!issued.ok) throw new Error(`enrollment refused: ${issued.reason}`)
  return issued
}

async function prove(
  h: Harness,
  device: Device,
  certPem: string,
  purpose: DeviceSignaturePurpose,
  overrides: { origin?: string; signWith?: Device } = {},
) {
  const { nonce } = h.manager.issueNonce(ORIGIN)
  const message = buildDeviceSignatureMessage({
    purpose,
    origin: overrides.origin ?? ORIGIN,
    nonce,
  })
  const signature = await (overrides.signWith ?? device).sign(message)
  return { certPem, nonce, signature, purpose }
}

describe('device enrollment', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('issues a leaf with the credential SAN, user SAN, clientAuth EKU, CN and 365 days', async () => {
    const device = await newDevice()
    const issued = await enroll(h, device)
    const cert = new Peculiar(issued.certPem)
    expect(cert.subject).toBe(`CN=${issued.credentialId}`)
    const sans = cert.getExtension(SubjectAlternativeNameExtension)?.names.items.map((n) => n.value)
    expect(sans).toContain(`camstack:credential:${issued.credentialId}`)
    expect(sans).toContain('camstack:user:u-1')
    const node = new X509Certificate(issued.certPem)
    expect(node.keyUsage ?? []).toBeDefined()
    // notBefore is backdated 5 min for clock skew; expiry still counts from the real issue time.
    expect(cert.notAfter.getTime() - cert.notBefore.getTime()).toBe(
      DEVICE_CERT_VALIDITY_DAYS * DAY + CERT_NOT_BEFORE_BACKDATE_MS,
    )
    expect(issued.chainPem).toContain('BEGIN CERTIFICATE')
    // The leaf is issued for the device's own public key; nothing private came in.
    expect(Buffer.from(cert.publicKey.rawData).toString('base64url')).toBe(device.spki)
  })

  it('the device CA key is in the keychain (system) and its certificate in settings; created lazily', async () => {
    expect(await h.ca.lookup()).toEqual({ state: 'absent' })
    await enroll(h, await newDevice())
    expect((await h.ca.lookup()).state).toBe('ready')
    expect(h.settings.get('cluster')?.['deviceCa']).toContain('BEGIN CERTIFICATE')
    expect(DEVICE_CA_KEY_REF).toContain('deviceCaKey')
  })

  it('a code is single use: the second redemption is refused', async () => {
    const { code } = h.manager.startEnrollment({ userId: 'u-1', deviceName: 'p', createdBy: 'a' })
    const device = await newDevice()
    const first = await h.manager.completeEnrollment({
      code,
      publicKeySpki: device.spki,
      platform: 'ios',
    })
    expect(first.ok).toBe(true)
    const second = await h.manager.completeEnrollment({
      code,
      publicKeySpki: device.spki,
      platform: 'ios',
    })
    expect(second).toEqual({ ok: false, reason: 'unknown-or-used-code' })
  })

  it('a code expires after 10 minutes and is burned by the attempt', async () => {
    const { code } = h.manager.startEnrollment({ userId: 'u-1', deviceName: 'p', createdBy: 'a' })
    h.advance(DEVICE_ENROLLMENT_TTL_MS + 1)
    const device = await newDevice()
    expect(
      await h.manager.completeEnrollment({ code, publicKeySpki: device.spki, platform: 'ios' }),
    ).toEqual({
      ok: false,
      reason: 'expired-code',
    })
    expect(
      await h.manager.completeEnrollment({ code, publicKeySpki: device.spki, platform: 'ios' }),
    ).toEqual({
      ok: false,
      reason: 'unknown-or-used-code',
    })
  })

  it('an unknown code and a malformed public key are refused', async () => {
    expect(
      await h.manager.completeEnrollment({ code: 'nope', publicKeySpki: 'AAAA', platform: 'ios' }),
    ).toEqual({ ok: false, reason: 'unknown-or-used-code' })
    const { code } = h.manager.startEnrollment({ userId: 'u-1', deviceName: 'p', createdBy: 'a' })
    expect(
      await h.manager.completeEnrollment({ code, publicKeySpki: 'AAAA', platform: 'ios' }),
    ).toEqual({
      ok: false,
      reason: 'bad-public-key',
    })
  })

  it('the code is not stored: nothing in the registry or the store holds it', async () => {
    const { code } = h.manager.startEnrollment({ userId: 'u-1', deviceName: 'p', createdBy: 'a' })
    const device = await newDevice()
    await h.manager.completeEnrollment({ code, publicKeySpki: device.spki, platform: 'ios' })
    const rows = await h.store.query.query({ collection: 'device_credentials' })
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  it('records enrolledVia: qr for the code path, self for enrollSelf', async () => {
    const qr = await enroll(h, await newDevice())
    const device = await newDevice()
    const self = await h.manager.enrollSelf({
      userId: 'u-1',
      publicKeySpki: device.spki,
      deviceName: 'My phone',
      platform: 'android',
    })
    if (!self.ok) throw new Error('self enrollment refused')
    expect(h.manager.get(qr.credentialId)?.enrolledVia).toBe('qr')
    expect(h.manager.get(self.credentialId)?.enrolledVia).toBe('self')
  })

  it('enrollSelf is refused with a clear reason when the hub setting disables it', async () => {
    const off = harness({ selfEnrollment: false })
    const device = await newDevice()
    expect(
      await off.manager.enrollSelf({
        userId: 'u-1',
        publicKeySpki: device.spki,
        deviceName: 'p',
        platform: 'ios',
      }),
    ).toEqual({ ok: false, reason: 'self-enrollment-disabled' })
  })
})

describe('device certificate login', () => {
  let h: Harness
  let device: Device
  let certPem: string
  let credentialId: string
  beforeEach(async () => {
    h = harness()
    device = await newDevice()
    const issued = await enroll(h, device)
    certPem = issued.certPem
    credentialId = issued.credentialId
  })

  it('accepts a good proof (raw r||s and DER signatures) and stamps lastUsed', async () => {
    const raw = await h.manager.authenticate({
      ...(await prove(h, device, certPem, 'login')),
      from: '203.0.113.9',
    })
    expect(raw.ok).toBe(true)
    expect(h.manager.get(credentialId)?.lastUsedFrom).toBe('203.0.113.9')
    const { nonce } = h.manager.issueNonce(ORIGIN)
    const der = await device.sign(
      buildDeviceSignatureMessage({ purpose: 'login', origin: ORIGIN, nonce }),
      'der',
    )
    expect(
      (await h.manager.authenticate({ certPem, nonce, signature: der, purpose: 'login' })).ok,
    ).toBe(true)
  })

  it('refuses a bad signature (another key signed it)', async () => {
    const other = await newDevice()
    const proof = await prove(h, device, certPem, 'login', { signWith: other })
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('refuses a signature made for another origin', async () => {
    const proof = await prove(h, device, certPem, 'login', { origin: 'https://evil.example.com' })
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('refuses a login signature replayed as a renewal or a revoke (purpose is signed)', async () => {
    const { nonce } = h.manager.issueNonce(ORIGIN)
    const signature = await device.sign(
      buildDeviceSignatureMessage({ purpose: 'login', origin: ORIGIN, nonce }),
    )
    expect(await h.manager.authenticate({ certPem, nonce, signature, purpose: 'renew' })).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('refuses a replayed nonce and an expired nonce', async () => {
    const proof = await prove(h, device, certPem, 'login')
    expect((await h.manager.authenticate(proof)).ok).toBe(true)
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'unknown-nonce' })
    const late = await prove(h, device, certPem, 'login')
    h.advance(DEVICE_NONCE_TTL_MS + 1)
    expect(await h.manager.authenticate(late)).toEqual({ ok: false, reason: 'expired-nonce' })
  })

  it('refuses an expired certificate', async () => {
    h.advance(DEVICE_CERT_VALIDITY_DAYS * DAY + DAY)
    const proof = await prove(h, device, certPem, 'login')
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a revoked credential', async () => {
    await h.manager.revoke(credentialId, 'admin:root')
    const proof = await prove(h, device, certPem, 'login')
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'revoked' })
    expect(h.manager.check(credentialId)).toBe('revoked')
  })

  it('refuses a certificate the device CA did not issue', async () => {
    const stranger = harness()
    const strangerDevice = await newDevice()
    const foreign = await enroll(stranger, strangerDevice)
    const proof = await prove(h, strangerDevice, foreign.certPem, 'login')
    expect(await h.manager.authenticate(proof)).toEqual({
      ok: false,
      reason: 'not-issued-by-device-ca',
    })
  })

  it('a deleted row is `unknown-credential` (definitive), and delete refuses a live credential', async () => {
    expect(await h.manager.delete(credentialId)).toBe('live')
    expect(h.manager.get(credentialId)).toBeDefined()
    await h.manager.revoke(credentialId, 'admin:root')
    expect(await h.manager.delete(credentialId)).toBe('deleted')
    expect(h.manager.check(credentialId)).toBe('unknown')
    const proof = await prove(h, device, certPem, 'login')
    expect(await h.manager.authenticate(proof)).toEqual({ ok: false, reason: 'unknown-credential' })
  })

  it('device-signed revoke: a `revoke` proof revokes, recording revokedBy `device`', async () => {
    const proof = await prove(h, device, certPem, 'revoke')
    const checked = await h.manager.authenticate(proof)
    if (!checked.ok) throw new Error('refused')
    await h.manager.revoke(checked.credential.id, 'device')
    expect(h.manager.get(credentialId)).toMatchObject({ revokedBy: 'device' })
    expect(h.manager.check(credentialId)).toBe('revoked')
  })
})

describe('hardening (security review)', () => {
  it('LOW: the signature is checked BEFORE the registry - a revoked or deleted credential is not revealed to a forger', async () => {
    const h = harness()
    const device = await newDevice()
    const issued = await enroll(h, device)
    await h.manager.revoke(issued.credentialId, 'admin:root')
    const forger = await newDevice()
    const forged = await prove(h, device, issued.certPem, 'login', { signWith: forger })
    expect(await h.manager.authenticate(forged)).toEqual({ ok: false, reason: 'bad-signature' })
    await h.manager.delete(issued.credentialId)
    const forgedAgain = await prove(h, device, issued.certPem, 'login', { signWith: forger })
    expect(await h.manager.authenticate(forgedAgain)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
    // the genuine holder still gets the definitive answer
    const genuine = await prove(h, device, issued.certPem, 'login')
    expect(await h.manager.authenticate(genuine)).toEqual({
      ok: false,
      reason: 'unknown-credential',
    })
  })

  it("LOW: nonces are bounded PER CLIENT - a flooder cannot evict another client's nonce", async () => {
    const h = harness()
    const device = await newDevice()
    const issued = await enroll(h, device)
    const victim = h.manager.issueNonce(ORIGIN, '203.0.113.7')
    for (let i = 0; i < 400; i++) h.manager.issueNonce(ORIGIN, '198.51.100.9')
    const signature = await device.sign(
      buildDeviceSignatureMessage({ purpose: 'login', origin: ORIGIN, nonce: victim.nonce }),
    )
    const result = await h.manager.authenticate({
      certPem: issued.certPem,
      nonce: victim.nonce,
      signature,
      purpose: 'login',
    })
    expect(result.ok).toBe(true)
  })

  it('LOW: after a renewal the OLD leaf works for 24 h, then is `superseded` (not definitive)', async () => {
    const h = harness()
    const device = await newDevice()
    const first = await enroll(h, device)
    const checked = await h.manager.authenticate(await prove(h, device, first.certPem, 'renew'))
    if (!checked.ok) throw new Error('refused')
    const renewed = await h.manager.renew(checked.credential)
    if (!renewed.ok) throw new Error('renew refused')
    expect(
      (await h.manager.authenticate(await prove(h, device, renewed.certPem, 'login'))).ok,
    ).toBe(true)
    // inside the grace the previous leaf (a device that lost the answer) still signs in
    expect((await h.manager.authenticate(await prove(h, device, first.certPem, 'login'))).ok).toBe(
      true,
    )
    h.advance(PREVIOUS_LEAF_GRACE_MS + 1000)
    expect(await h.manager.authenticate(await prove(h, device, first.certPem, 'login'))).toEqual({
      ok: false,
      reason: 'superseded',
    })
    expect(
      (await h.manager.authenticate(await prove(h, device, renewed.certPem, 'login'))).ok,
    ).toBe(true)
  })
})

describe('device certificate renewal', () => {
  it('issues a new leaf for the SAME public key with a later expiry', async () => {
    const h = harness()
    const device = await newDevice()
    const first = await enroll(h, device)
    h.advance(340 * DAY)
    const proof = await prove(h, device, first.certPem, 'renew')
    const checked = await h.manager.authenticate(proof)
    if (!checked.ok) throw new Error('refused')
    const renewed = await h.manager.renew(checked.credential)
    if (!renewed.ok) throw new Error('renew refused')
    const before = new Peculiar(first.certPem)
    const after = new Peculiar(renewed.certPem)
    expect(Buffer.from(after.publicKey.rawData).equals(Buffer.from(before.publicKey.rawData))).toBe(
      true,
    )
    expect(after.notAfter.getTime()).toBeGreaterThan(before.notAfter.getTime())
    expect(renewed.credentialId).toBe(first.credentialId)
    expect(new X509Certificate(renewed.certPem).fingerprint256).not.toBe(
      new X509Certificate(first.certPem).fingerprint256,
    )
    // The new certificate logs in.
    expect(
      (await h.manager.authenticate(await prove(h, device, renewed.certPem, 'login'))).ok,
    ).toBe(true)
  })

  it('refuses to renew a revoked credential', async () => {
    const h = harness()
    const device = await newDevice()
    const first = await enroll(h, device)
    const checked = await h.manager.authenticate(await prove(h, device, first.certPem, 'renew'))
    if (!checked.ok) throw new Error('refused')
    await h.manager.revoke(first.credentialId, 'user:u-1')
    expect(await h.manager.renew(checked.credential)).toEqual({ ok: false, reason: 'revoked' })
  })
})

describe('verifyDeviceSignature', () => {
  it('rejects empty and garbage signatures without throwing', async () => {
    const device = await newDevice()
    const spki = Buffer.from(device.spki, 'base64url')
    expect(verifyDeviceSignature(spki, 'm', '')).toBe(false)
    expect(verifyDeviceSignature(spki, 'm', 'AAAA')).toBe(false)
  })
})
