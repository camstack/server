import * as fs from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { connect } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureTlsCert,
  type EnsureTlsResult,
  type HostFacts,
  loadTlsCert,
} from '../cert-manager.js'
import {
  clearHttpsListener,
  registerHttpsListener,
  servedHttpsLeafFingerprint,
} from '../https-listener.js'
import {
  applyCertificateToListener,
  revertToGeneratedCertificate,
  storeUploadedCertificate,
} from '../tls-actions.js'
import { readTlsAccessStatus, splitPemCertificates } from '../tls-status.js'

const FIXED_HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: {
    eth0: [{ address: '192.168.10.9', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }],
  },
}

/** The leaf fingerprint a TLS client is actually handed on a fresh handshake. */
function servedByListener(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256
      socket.end()
      resolve(fingerprint)
    })
    socket.on('error', reject)
  })
}

function listen(server: HttpsServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

interface ForeignPair {
  readonly leafPem: string
  readonly chainPem: string
  readonly keyPem: string
  readonly caPem: string
  readonly ca: EnsureTlsResult
}

/** A certificate the node's local CA did NOT issue — what an upload is (e.g. mkcert). */
async function foreignPair(dir: string): Promise<ForeignPair> {
  const ca = await ensureTlsCert(dir, { hostFacts: FIXED_HOST })
  const chainPem = fs.readFileSync(ca.certPath, 'utf-8')
  const [leafPem] = splitPemCertificates(chainPem)
  if (leafPem === undefined) throw new Error('generated chain has no leaf')
  return {
    leafPem,
    chainPem,
    keyPem: fs.readFileSync(ca.keyPath, 'utf-8'),
    caPem: fs.readFileSync(ca.caCertPath, 'utf-8'),
    ca,
  }
}

describe('certificate actions reach the HTTPS listener (D726)', () => {
  let dataDir: string
  let foreignDir: string
  let server: HttpsServer | null = null
  let local: EnsureTlsResult

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-actions-'))
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-actions-foreign-'))
    local = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
  })

  afterEach(async () => {
    clearHttpsListener()
    const current = server
    server = null
    if (current !== null) await new Promise<void>((resolve) => current.close(() => resolve()))
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(foreignDir, { recursive: true, force: true })
  })

  async function startListener(): Promise<number> {
    const pair = loadTlsCert(local.certPath, local.keyPath)
    const created = createHttpsServer({ cert: pair.cert, key: pair.key })
    server = created
    const port = await listen(created)
    registerHttpsListener(created, pair)
    return port
  }

  it('an upload is served on the next handshake, with no restart', async () => {
    const port = await startListener()
    expect(await servedByListener(port)).toBe(local.fingerprintSha256)
    const upload = await foreignPair(foreignDir)

    await storeUploadedCertificate(dataDir, {
      certPem: upload.leafPem,
      keyPem: upload.keyPem,
      caPem: upload.caPem,
    })
    const outcome = applyCertificateToListener(dataDir)

    expect(outcome.kind).toBe('reloaded')
    expect(await servedByListener(port)).toBe(upload.ca.fingerprintSha256)
    const status = readTlsAccessStatus(dataDir, servedHttpsLeafFingerprint())
    expect(status.leafFingerprintSha256).toBe(upload.ca.fingerprintSha256)
    expect(status.restartRequired).toBe(false)
  })

  it('reports restartRequired while the listener still serves the old leaf', async () => {
    await startListener()
    const upload = await foreignPair(foreignDir)

    await storeUploadedCertificate(dataDir, {
      certPem: upload.leafPem,
      keyPem: upload.keyPem,
      caPem: upload.caPem,
    })

    // No reload yet: exactly the state the live hub was left in.
    expect(readTlsAccessStatus(dataDir, servedHttpsLeafFingerprint()).restartRequired).toBe(true)
  })

  it('revert puts a generated leaf under the ORIGINAL local CA back on the listener', async () => {
    const port = await startListener()
    const upload = await foreignPair(foreignDir)
    await storeUploadedCertificate(dataDir, { certPem: upload.chainPem, keyPem: upload.keyPem })
    applyCertificateToListener(dataDir)

    await revertToGeneratedCertificate(dataDir, { hostFacts: FIXED_HOST })
    applyCertificateToListener(dataDir)

    const status = readTlsAccessStatus(dataDir, servedHttpsLeafFingerprint())
    expect(status.mode).toBe('generated')
    expect(status.caFingerprintSha256).toBe(local.caFingerprintSha256)
    expect(await servedByListener(port)).toBe(status.leafFingerprintSha256)
    expect(status.restartRequired).toBe(false)
  })

  it('says no-listener when this process serves no HTTPS', async () => {
    const upload = await foreignPair(foreignDir)
    await storeUploadedCertificate(dataDir, {
      certPem: upload.leafPem,
      keyPem: upload.keyPem,
      caPem: upload.caPem,
    })
    expect(applyCertificateToListener(dataDir).kind).toBe('no-listener')
    expect(readTlsAccessStatus(dataDir, servedHttpsLeafFingerprint()).restartRequired).toBe(false)
  })
})

describe('the CA an uploaded certificate reports is its own issuer, never the local CA', () => {
  let dataDir: string
  let foreignDir: string
  let local: EnsureTlsResult

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-issuer-'))
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-issuer-foreign-'))
    local = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(foreignDir, { recursive: true, force: true })
  })

  it('a bare leaf (mkcert style) with its CA reports that CA for Download CA', async () => {
    const upload = await foreignPair(foreignDir)
    await storeUploadedCertificate(dataDir, {
      certPem: upload.leafPem,
      keyPem: upload.keyPem,
      caPem: upload.caPem,
    })

    const status = readTlsAccessStatus(dataDir, null)
    expect(status.mode).toBe('uploaded')
    expect(status.caFingerprintSha256).toBe(upload.ca.caFingerprintSha256)
    expect(status.caCertPem).toContain('BEGIN CERTIFICATE')
    expect(status.caMissing).toBe(false)
  })

  it('a chain reports the issuer it carries', async () => {
    const upload = await foreignPair(foreignDir)
    await storeUploadedCertificate(dataDir, { certPem: upload.chainPem, keyPem: upload.keyPem })

    const status = readTlsAccessStatus(dataDir, null)
    expect(status.caFingerprintSha256).toBe(upload.ca.caFingerprintSha256)
    expect(status.caCertPem).toContain('BEGIN CERTIFICATE')
  })

  it('a supplied CA is reported, and the local CA files are left untouched', async () => {
    const localCaBefore = fs.readFileSync(local.caCertPath, 'utf-8')
    const upload = await foreignPair(foreignDir)
    await storeUploadedCertificate(dataDir, {
      certPem: upload.leafPem,
      keyPem: upload.keyPem,
      caPem: upload.caPem,
    })

    const status = readTlsAccessStatus(dataDir, null)
    expect(status.caFingerprintSha256).toBe(upload.ca.caFingerprintSha256)
    expect(status.caFingerprintSha256).not.toBe(local.caFingerprintSha256)
    expect(fs.readFileSync(local.caCertPath, 'utf-8')).toBe(localCaBefore)
  })

  it('a supplied CA that did not issue the leaf is refused, and nothing is written', async () => {
    const upload = await foreignPair(foreignDir)
    const before = fs.readFileSync(local.certPath, 'utf-8')
    await expect(
      storeUploadedCertificate(dataDir, {
        certPem: upload.leafPem,
        keyPem: upload.keyPem,
        caPem: fs.readFileSync(local.caCertPath, 'utf-8'),
      }),
    ).rejects.toMatchObject({ i18nCode: 'tls.ca-not-issuer' })
    expect(fs.readFileSync(local.certPath, 'utf-8')).toBe(before)
    expect(readTlsAccessStatus(dataDir, null).mode).toBe('generated')
  })
})
