import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { X509Certificate } from '@peculiar/x509'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CA_COMMON_NAME, localCaCommonName } from '../cert-issue.js'
import { ensureTlsCert, type HostFacts, reissueTlsLeaf } from '../cert-manager.js'

/** The machine, fixed: the SAN set must not depend on the runner. */
const FIXED_HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: {
    eth0: [{ address: '192.168.10.9', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }],
  },
}

/** The CN of the root on disk, as one decoded value (not the escaped DN string). */
function caCommonNameOnDisk(caCertPath: string): string {
  const cert = new X509Certificate(fs.readFileSync(caCertPath, 'utf-8'))
  return cert.subjectName.getField('CN').join('|')
}

describe('localCaCommonName', () => {
  it('names the hub after the plain CA name', () => {
    expect(localCaCommonName('Casa Milano')).toBe('CamStack Local CA — Casa Milano')
  })

  it('falls back to the plain name when there is no usable hub name', () => {
    expect(localCaCommonName(undefined)).toBe(CA_COMMON_NAME)
    expect(localCaCommonName('')).toBe(CA_COMMON_NAME)
    expect(localCaCommonName('  \t\u0007 ')).toBe(CA_COMMON_NAME)
    // The product's own fallback name says nothing about the hub.
    expect(localCaCommonName('CamStack')).toBe(CA_COMMON_NAME)
  })

  it('strips control characters and collapses whitespace', () => {
    expect(localCaCommonName('  Lab\u0000\nNode\u009b  2 ')).toBe('CamStack Local CA — Lab Node 2')
  })

  it('keeps the whole CN within 64 characters', () => {
    const cn = localCaCommonName('x'.repeat(200))
    expect([...cn].length).toBe(64)
    expect(cn.startsWith('CamStack Local CA — x')).toBe(true)
  })
})

describe('the local root is named after the hub', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-ca-name-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a NEW root carries the hub name in its subject', async () => {
    const result = await ensureTlsCert(tmpDir, {
      hostFacts: FIXED_HOST,
      hubName: 'Casa, Milano',
    })
    expect(result.caRotated).toBe(true)
    expect(caCommonNameOnDisk(result.caCertPath)).toBe('CamStack Local CA — Casa, Milano')
  })

  it('without a hub name the root keeps the plain name', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(caCommonNameOnDisk(result.caCertPath)).toBe(CA_COMMON_NAME)
  })

  it('an existing root is NOT regenerated when the hub name changes', async () => {
    const first = await ensureTlsCert(tmpDir, {
      hostFacts: FIXED_HOST,
      hubName: 'Old Name',
    })
    const before = fs.readFileSync(first.caCertPath, 'utf-8')

    const boot = await ensureTlsCert(tmpDir, {
      hostFacts: FIXED_HOST,
      hubName: 'New Name',
    })
    expect(boot.generated).toBe(false)
    expect(boot.caFingerprintSha256).toBe(first.caFingerprintSha256)

    // The operator's "Regenerate" reissues the leaf only, under the same root.
    const reissued = await reissueTlsLeaf(tmpDir, {
      hostFacts: FIXED_HOST,
      hubName: 'New Name',
    })
    expect(reissued.caRotated).toBe(false)
    expect(fs.readFileSync(reissued.caCertPath, 'utf-8')).toBe(before)
    expect(caCommonNameOnDisk(reissued.caCertPath)).toBe('CamStack Local CA — Old Name')
  })
})
