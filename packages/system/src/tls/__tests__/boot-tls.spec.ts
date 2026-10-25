import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareBootTls } from '../boot-tls.js'
import { ensureTlsCert, type HostFacts } from '../cert-manager.js'
import { readTlsMode, writeTlsMode } from '../tls-status.js'

const FIXED_HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: {
    eth0: [{ address: '192.168.10.9', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }],
  },
}

/**
 * The two certificate sources the admin UI offers — generated and uploaded —
 * are the ONLY ways a node gets a certificate (D726). These pin what the boot
 * listener serves for each, because an uploaded certificate that boot quietly
 * replaced would leave the operator with no way to set one at all.
 */
describe('prepareBootTls', () => {
  let dataDir: string
  let foreignDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-tls-'))
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-tls-foreign-'))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(foreignDir, { recursive: true, force: true })
  })

  it('generates the local CA and leaf on a fresh data dir', async () => {
    const boot = await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })
    expect(boot.mode).toBe('generated')
    expect(boot.ensured?.generated).toBe(true)
    expect(boot.pair.cert.toString('utf-8')).toBe(
      fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8'),
    )
  })

  it('keeps an existing generated certificate across boots', async () => {
    await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })
    const before = fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')
    const second = await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })
    expect(second.mode).toBe('generated')
    expect(second.ensured?.generated).toBe(false)
    expect(second.pair.cert.toString('utf-8')).toBe(before)
  })

  it('serves an uploaded certificate verbatim and never reissues over it', async () => {
    // A node that already has its own local CA, then an operator upload of a
    // certificate that root did NOT issue — exactly what a real upload is.
    await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    const foreign = await ensureTlsCert(foreignDir, { hostFacts: FIXED_HOST })
    const uploadedCert = fs.readFileSync(foreign.certPath, 'utf-8')
    const uploadedKey = fs.readFileSync(foreign.keyPath, 'utf-8')
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.crt'), uploadedCert)
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.key'), uploadedKey)
    writeTlsMode(dataDir, 'uploaded')

    const boot = await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })

    expect(boot.mode).toBe('uploaded')
    expect(boot.ensured).toBeUndefined()
    expect(boot.pair.cert.toString('utf-8')).toBe(uploadedCert)
    expect(boot.pair.key.toString('utf-8')).toBe(uploadedKey)
    expect(fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')).toBe(uploadedCert)
    expect(readTlsMode(dataDir)).toBe('uploaded')
  })

  it('falls back to generated, and says so, when the uploaded files are gone', async () => {
    fs.mkdirSync(path.join(dataDir, 'tls'), { recursive: true })
    writeTlsMode(dataDir, 'uploaded')

    const boot = await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })

    expect(boot.mode).toBe('generated')
    expect(boot.uploadedMissing).toBe(true)
    expect(boot.ensured?.generated).toBe(true)
    expect(readTlsMode(dataDir)).toBe('generated')
  })
})
