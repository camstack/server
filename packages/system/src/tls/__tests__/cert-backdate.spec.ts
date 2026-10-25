import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateDeviceCa, issueDeviceLeaf } from '../../auth/device-ca.js'
import { generateMeshCa, issueMeshLeafForNode } from '../../kernel/moleculer/mesh-mtls/mesh-ca.js'
import { backdatedNotBefore, CERT_NOT_BEFORE_BACKDATE_MS } from '../cert-backdate.js'
import { generateCa, issueLeaf } from '../cert-issue.js'

const DAY_MS = 86_400_000
const IDENTITY = {
  dnsNames: ['hub.example.test'],
  ipAddresses: [],
  requiredDnsNames: [],
  requiredIpAddresses: [],
}

/** A peer whose clock is behind refuses anything dated after its own "now". */
function expectBackdated(certPem: string, issuedAt: Date, validDays: number): void {
  const cert = new X509Certificate(certPem)
  expect(Date.parse(cert.validFrom)).toBeLessThanOrEqual(issuedAt.getTime() - 4 * 60_000)
  // Only the start moves: the lifetime still counts from the real now.
  expect(
    Math.abs(Date.parse(cert.validTo) - (issuedAt.getTime() + validDays * DAY_MS)),
  ).toBeLessThan(2_000)
}

describe('certificates are backdated so a peer with a slow clock accepts them', () => {
  it('the backdate is five minutes', () => {
    expect(CERT_NOT_BEFORE_BACKDATE_MS).toBe(5 * 60_000)
  })

  it('mesh CA and mesh leaf', async () => {
    const now = new Date()
    const ca = await generateMeshCa(now)
    expect(new X509Certificate(ca.certPem).ca).toBe(true)
    expectBackdated(ca.certPem, now, 3650)
    const leaf = await issueMeshLeafForNode(ca, 'node-a', { now, validDays: 30 })
    expectBackdated(leaf.certPem, now, 30)
  })

  it('local HTTPS CA and server leaf', async () => {
    const now = new Date()
    const ca = await generateCa(now)
    const leaf = await issueLeaf(ca, IDENTITY, 'hub.example.test', 30, now)
    const cert = new X509Certificate(leaf.certPem)
    expect(Date.parse(cert.validFrom)).toBeLessThanOrEqual(now.getTime() - 4 * 60_000)
    // Browsers cap the total span, so the served leaf's span stays exactly validDays.
    const span = Date.parse(cert.validTo) - Date.parse(cert.validFrom)
    expect(Math.abs(span - 30 * DAY_MS)).toBeLessThan(2_000)
    const caCert = new X509Certificate(ca.certPem)
    expect(Date.parse(caCert.validFrom)).toBeLessThanOrEqual(now.getTime() - 4 * 60_000)
  })

  it('device CA and device leaf', async () => {
    const now = new Date()
    const ca = await generateDeviceCa(now)
    expect(Date.parse(new X509Certificate(ca.certPem).validFrom)).toBeLessThanOrEqual(
      now.getTime() - 4 * 60_000,
    )
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const leaf = await issueDeviceLeaf(ca, {
      credentialId: 'c-1',
      userId: 'u-1',
      publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }),
      now,
      validDays: 30,
    })
    expectBackdated(leaf.certPem, now, 30)
    expect(leaf.notBefore.getTime()).toBeLessThanOrEqual(now.getTime() - 4 * 60_000)
  })

  /**
   * Europe/Rome fall-back repeats 02:00–03:00. 01:30Z is inside that hour;
   * 00:30Z is the first 02:30 (still CEST). 00:30Z on the spring-forward
   * morning is the other transition the suite must keep exact.
   */
  it('encodes notBefore and notAfter as UTC across a DST transition', async () => {
    const instants = [
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-03-29T00:30:00.000Z',
    ]
    for (const iso of instants) {
      const now = new Date(iso)
      const ca = await generateCa(now)
      const leaf = await issueLeaf(ca, IDENTITY, 'hub.example.test', 30, now)
      const encoded = new X509Certificate(leaf.certPem)
      const start = Math.floor(backdatedNotBefore(now).getTime() / 1000) * 1000
      expect(Date.parse(encoded.validFrom)).toBe(start)
      expect(Date.parse(encoded.validTo) - Date.parse(encoded.validFrom)).toBe(30 * DAY_MS)
      expect(Date.parse(new X509Certificate(ca.certPem).validFrom)).toBe(start)
    }
  })
})
