/**
 * D873: the generated local CA is name-constrained, an unconstrained one is replaced once,
 * an upload that no client can be told to trust is refused, and "Revert to generated"
 * keeps the upload.
 */
import { webcrypto, X509Certificate } from 'node:crypto'
import * as fs from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { connect } from 'node:tls'
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate as PeculiarCertificate,
  X509CertificateGenerator,
} from '@peculiar/x509'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareBootTls } from '../boot-tls.js'
import {
  ensureTlsCert,
  type CertIdentity,
  type HostFacts,
  reissueTlsLeaf,
  replaceUnconstrainedLocalCa,
  retirePreviousLocalCa,
} from '../cert-manager.js'
import { generateCa, issueLeaf, loadCa } from '../cert-issue.js'
import {
  isConstrainedCa,
  PERMITTED_IP_RANGES,
  permitsIdentity,
  readNameConstraints,
} from '../cert-name-constraints.js'
import {
  revertToGeneratedCertificate,
  storeUploadedCertificate,
  useStoredUploadedCertificate,
} from '../tls-actions.js'
import { readTlsAccessStatus, readTlsMode, splitPemCertificates } from '../tls-status.js'
import { checkUploadedCa, chainsToPublicRoot } from '../uploaded-cert.js'

const FIXED_HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: {
    eth0: [
      { address: '192.168.10.9', internal: false },
      { address: '2001:db8::7', internal: false },
      { address: '100.64.1.2', internal: false },
    ],
    lo: [{ address: '127.0.0.1', internal: true }],
  },
}

const SIGNING = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const

const DAY = 86_400_000

interface SelfSigned {
  readonly certPem: string
  readonly keyPem: string
}

/** The CA every install made before D873 has: `pathlen:0`, no name constraints. */
async function selfSignedCa(options: {
  readonly isCa: boolean
  readonly notBefore: Date
  readonly notAfter: Date
  readonly name?: string
}): Promise<SelfSigned> {
  const keys = await webcrypto.subtle.generateKey(SIGNING, true, ['sign', 'verify'])
  const extensions = [
    new BasicConstraintsExtension(options.isCa, options.isCa ? 0 : undefined, true),
    ...(options.isCa
      ? [new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)]
      : []),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
  ]
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${options.name ?? 'Spec CA'}`,
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    keys,
    signingAlgorithm: SIGNING,
    extensions,
  })
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`
  return { certPem: `${cert.toString('pem')}\n`, keyPem }
}

async function legacyCa(): Promise<SelfSigned> {
  const now = new Date()
  return selfSignedCa({
    isCa: true,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + 3000 * DAY),
    name: 'CamStack Local CA',
  })
}

const IDENTITY: CertIdentity = {
  dnsNames: ['spec.local'],
  ipAddresses: ['192.168.10.9'],
  requiredDnsNames: [],
  requiredIpAddresses: [],
}

/** A leaf under a CA the spec built, for an upload. */
async function leafUnder(
  ca: SelfSigned,
  now = new Date(),
): Promise<{ chain: string; key: string }> {
  const signer = await loadCa(ca.certPem, ca.keyPem)
  const leaf = await issueLeaf(signer, IDENTITY, 'spec.local', 397, now)
  return { chain: leaf.certPem, key: leaf.keyPem }
}

function listen(server: ReturnType<typeof createHttpsServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/** TLS handshake validating against `caPem` at 127.0.0.1; resolves to the verify error code or null. */
function handshakeError(port: number, caPem: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(
      { host: '127.0.0.1', port, ca: caPem, checkServerIdentity: () => undefined },
      () => {
        const error: unknown = socket.authorizationError
        socket.end()
        resolve(error ? String(error) : null)
      },
    )
    socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
  })
}

describe('the generated local CA is name-constrained (D873)', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-constraints-'))
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('carries a CRITICAL nameConstraints with exactly the permitted ranges and local DNS', async () => {
    const result = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    const ca = new PeculiarCertificate(fs.readFileSync(result.caCertPath, 'utf-8'))
    const set = readNameConstraints(ca)
    expect(set).not.toBeNull()
    expect(set?.critical).toBe(true)
    expect([...(set?.ipRanges ?? [])].toSorted()).toEqual([...PERMITTED_IP_RANGES].toSorted())
    expect(set?.ipRanges).toEqual(
      expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']),
    )
    expect(set?.dnsNames).toEqual(expect.arrayContaining(['.local', 'localhost', 'spec-host.lan']))
    expect(isConstrainedCa(ca)).toBe(true)
  })

  it('a non-critical constraint does not count as constrained', async () => {
    const legacy = await legacyCa()
    expect(isConstrainedCa(new PeculiarCertificate(legacy.certPem))).toBe(false)
  })

  it('names the CA cannot certify are left out of the leaf and never force a reissue', async () => {
    const first = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    expect(first.sans.join(' ')).toContain('192.168.10.9')
    expect(first.sans.join(' ')).not.toContain('2001:db8::7')
    expect(first.sans.join(' ')).toContain('100.64.1.2')
    expect(first.droppedNames).toEqual(expect.arrayContaining(['2001:db8::7']))
    const again = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    expect(again.generated).toBe(false)
  })

  it('OpenSSL accepts the leaf under the constraint and rejects one outside it', async () => {
    const result = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    const caPem = fs.readFileSync(result.caCertPath, 'utf-8')
    const ca = await loadCa(caPem, fs.readFileSync(result.caKeyPath, 'utf-8'))

    const good = createHttpsServer({
      cert: fs.readFileSync(result.certPath),
      key: fs.readFileSync(result.keyPath),
    })
    const bad = createHttpsServer()
    try {
      const goodPort = await listen(good)
      expect(await handshakeError(goodPort, caPem)).toBeNull()

      // Forced past our own filter, as a bug or a hostile caller would.
      const outside = await issueLeaf(
        ca,
        {
          dnsNames: ['bank.example.com'],
          ipAddresses: ['127.0.0.1'],
          requiredDnsNames: [],
          requiredIpAddresses: [],
        },
        'bank.example.com',
        397,
        new Date(),
      )
      bad.setSecureContext({ cert: outside.certPem + caPem, key: outside.keyPem })
      const badPort = await listen(bad)
      // The same CA validates the permitted leaf above, so this refusal is the name constraint.
      expect(await handshakeError(badPort, caPem)).not.toBeNull()
    } finally {
      good.close()
      bad.close()
    }
  })

  it('a leaf is re-issued on an address change and the CA stays the same', async () => {
    const first = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    const moved: HostFacts = {
      hostname: FIXED_HOST.hostname,
      networkInterfaces: { eth0: [{ address: '192.168.10.77', internal: false }] },
    }
    const second = await ensureTlsCert(dataDir, { hostFacts: moved })
    expect(second.generated).toBe(true)
    expect(second.reason).toBe('san-coverage-gap')
    expect(second.caRotated).toBe(false)
    expect(second.caFingerprintSha256).toBe(first.caFingerprintSha256)
    expect(second.fingerprintSha256).not.toBe(first.fingerprintSha256)

    const regenerated = await reissueTlsLeaf(dataDir, { hostFacts: moved })
    expect(regenerated.caFingerprintSha256).toBe(first.caFingerprintSha256)
  })

  it('permitsIdentity keeps private ranges and local names, drops public ones', async () => {
    const ca = await generateCa(new Date(), ['hub'])
    const set = readNameConstraints(ca.cert)
    if (set === null) throw new Error('constraints expected')
    const result = permitsIdentity(set, {
      dnsNames: ['hub', 'x.local', 'a.example.com', 'localhost'],
      ipAddresses: [
        '10.1.2.3',
        '172.31.0.1',
        '172.32.0.1',
        '8.8.8.8',
        'fd12::1',
        '::1',
        '2001:db8::1',
      ],
      requiredDnsNames: [],
      requiredIpAddresses: [],
    })
    expect(result.identity.dnsNames).toEqual(['hub', 'x.local', 'localhost'])
    expect(result.identity.ipAddresses).toEqual(['10.1.2.3', '172.31.0.1', 'fd12::1', '::1'])
    expect(result.dropped).toEqual(
      expect.arrayContaining(['a.example.com', '172.32.0.1', '8.8.8.8', '2001:db8::1']),
    )
  })
})

describe('an unconstrained generated CA is replaced once, keeping the old until the new leaf is live (D873)', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-replace-'))
    // The hub as it was before D873: a full set of files under an unconstrained CA.
    const first = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    const legacy = await legacyCa()
    const signer = await loadCa(legacy.certPem, legacy.keyPem)
    const leaf = await issueLeaf(
      signer,
      {
        ...IDENTITY,
        dnsNames: ['spec-host.lan', 'camstack.local'],
        ipAddresses: ['192.168.10.9', '127.0.0.1'],
        requiredDnsNames: ['camstack.local'],
        requiredIpAddresses: ['127.0.0.1', '192.168.10.9'],
      },
      'camstack.local',
      397,
      new Date(),
    )
    fs.writeFileSync(first.caCertPath, legacy.certPem)
    fs.writeFileSync(first.caKeyPath, legacy.keyPem)
    fs.writeFileSync(first.certPath, leaf.certPem + legacy.certPem)
    fs.writeFileSync(first.keyPath, leaf.keyPem)
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('replaces the CA on the normal path, keeps the old one aside, and marks it', async () => {
    const tlsDir = path.join(dataDir, 'tls')
    const oldFp = new X509Certificate(fs.readFileSync(path.join(tlsDir, 'camstack-ca.crt')))
      .fingerprint256

    const result = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })

    expect(result.generated).toBe(true)
    expect(result.reason).toBe('ca-unconstrained')
    expect(result.caRotated).toBe(true)
    expect(result.caFingerprintSha256).not.toBe(oldFp)
    expect(
      isConstrainedCa(new PeculiarCertificate(fs.readFileSync(result.caCertPath, 'utf-8'))),
    ).toBe(true)
    // Old material is still there, key included.
    expect(
      new X509Certificate(fs.readFileSync(`${result.caCertPath}.previous`)).fingerprint256,
    ).toBe(oldFp)
    expect(fs.existsSync(`${result.caKeyPath}.previous`)).toBe(true)
    const status = readTlsAccessStatus(dataDir, null)
    expect(status.localCaConstrained).toBe(true)
    expect(status.caReplacedAt).not.toBeNull()
    // The new leaf chains to the new CA.
    const chain = splitPemCertificates(fs.readFileSync(result.certPath, 'utf-8'))
    const leaf = new X509Certificate(chain[0] ?? '')
    expect(leaf.verify(new X509Certificate(fs.readFileSync(result.caCertPath)).publicKey)).toBe(
      true,
    )

    // Stable afterwards: no second replacement.
    const again = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    expect(again.generated).toBe(false)
  })

  it('the retired CA goes only when asked, key and certificate', async () => {
    const result = await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
    expect(fs.existsSync(`${result.caKeyPath}.previous`)).toBe(true)
    expect(retirePreviousLocalCa(dataDir)).toBe(true)
    expect(fs.existsSync(`${result.caKeyPath}.previous`)).toBe(false)
    expect(fs.existsSync(`${result.caCertPath}.previous`)).toBe(false)
    expect(retirePreviousLocalCa(dataDir)).toBe(false)
  })

  it('beside an uploaded certificate, only the CA is replaced and the served pair is untouched', async () => {
    writeMode(dataDir, 'uploaded')
    const served = fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')

    const boot = await prepareBootTls(dataDir, { hostFacts: FIXED_HOST })

    expect(boot.mode).toBe('uploaded')
    expect(boot.dormantCaReplaced).toBe(true)
    expect(fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')).toBe(served)
    expect(readTlsAccessStatus(dataDir, null).localCaConstrained).toBe(true)
    expect(await replaceUnconstrainedLocalCa(dataDir)).toBe(false)
  })
})

function writeMode(dataDir: string, mode: string): void {
  fs.writeFileSync(path.join(dataDir, 'tls', 'mode'), `${mode}\n`)
}

describe('an upload must come with a CA unless its chain is public (D873)', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-ca-'))
    await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('refuses a private-CA leaf without its CA, with a translated code, and writes nothing', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)
    const served = fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')

    await expect(
      storeUploadedCertificate(dataDir, { certPem: chain, keyPem: key }),
    ).rejects.toMatchObject({ i18nCode: 'tls.ca-required' })

    expect(fs.readFileSync(path.join(dataDir, 'tls', 'camstack.crt'), 'utf-8')).toBe(served)
    expect(readTlsMode(dataDir)).toBe('generated')
  })

  it('accepts the same leaf with its CA and keeps the CA for Download CA', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)

    await storeUploadedCertificate(dataDir, { certPem: chain, keyPem: key, caPem: mkcert.certPem })

    const status = readTlsAccessStatus(dataDir, null)
    expect(status.mode).toBe('uploaded')
    expect(status.caCertPem).toContain('BEGIN CERTIFICATE')
    expect(status.caFingerprintSha256).toBe(new X509Certificate(mkcert.certPem).fingerprint256)
    expect(status.caMissing).toBe(false)
  })

  it('accepts a chain that carries its issuer without a separate CA', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)
    await storeUploadedCertificate(dataDir, { certPem: chain + mkcert.certPem, keyPem: key })
    expect(readTlsAccessStatus(dataDir, null).caMissing).toBe(false)
  })

  it('accepts a leaf without a CA when its chain leads to a public root', async () => {
    const publicRoot = await legacyCa()
    const { chain, key } = await leafUnder(publicRoot)
    const roots = [new X509Certificate(publicRoot.certPem)]

    await storeUploadedCertificate(dataDir, { certPem: chain, keyPem: key }, { publicRoots: roots })

    expect(readTlsMode(dataDir)).toBe('uploaded')
    expect(chainsToPublicRoot(chain, roots)).toBe(true)
    expect(chainsToPublicRoot(chain, [])).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'tls', 'uploaded-ca.crt'))).toBe(false)
  })

  it('validates the CA: unparsable, wrong issuer, not a CA, expired', async () => {
    const mkcert = await legacyCa()
    const { chain } = await leafUnder(mkcert)
    const other = await legacyCa()

    expect(checkUploadedCa(chain, 'not a pem')).toMatchObject({
      ok: false,
      code: 'tls.ca-unparsable',
    })
    expect(checkUploadedCa(chain, other.certPem)).toMatchObject({
      ok: false,
      code: 'tls.ca-not-issuer',
    })

    const notCa = await selfSignedCa({
      isCa: false,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 100 * DAY),
    })
    const underNotCa = await leafUnder(notCa)
    expect(checkUploadedCa(underNotCa.chain, notCa.certPem)).toMatchObject({
      ok: false,
      code: 'tls.ca-not-a-ca',
    })

    const expired = await selfSignedCa({
      isCa: true,
      notBefore: new Date(Date.now() - 800 * DAY),
      notAfter: new Date(Date.now() - 400 * DAY),
    })
    const underExpired = await leafUnder(expired, new Date(Date.now() - 700 * DAY))
    expect(checkUploadedCa(underExpired.chain, expired.certPem)).toMatchObject({
      ok: false,
      code: 'tls.ca-expired',
    })
  })

  it('an already-uploaded leaf with no CA is reported as caMissing', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)
    // A hub as the operator's: uploaded before the CA became mandatory.
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.crt'), chain)
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.key'), key)
    writeMode(dataDir, 'uploaded')

    const status = readTlsAccessStatus(dataDir, null)
    expect(status.mode).toBe('uploaded')
    expect(status.caCertPem).toBeNull()
    expect(status.caMissing).toBe(true)
  })
})

describe('"Revert to generated" keeps the upload so it can be selected again (D873)', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-keeps-'))
    await ensureTlsCert(dataDir, { hostFacts: FIXED_HOST })
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('reverts to a generated leaf, keeps the upload and its CA, and re-selects it', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)
    await storeUploadedCertificate(dataDir, { certPem: chain, keyPem: key, caPem: mkcert.certPem })
    const uploadedFp = new X509Certificate(chain).fingerprint256

    await revertToGeneratedCertificate(dataDir, { hostFacts: FIXED_HOST })

    const reverted = readTlsAccessStatus(dataDir, null)
    expect(reverted.mode).toBe('generated')
    expect(reverted.leafFingerprintSha256).not.toBe(uploadedFp)
    expect(reverted.storedUpload).toMatchObject({ leafFingerprintSha256: uploadedFp, hasCa: true })
    expect(fs.existsSync(path.join(dataDir, 'tls', 'uploaded-ca.crt'))).toBe(true)

    await useStoredUploadedCertificate(dataDir)

    const back = readTlsAccessStatus(dataDir, null)
    expect(back.mode).toBe('uploaded')
    expect(back.leafFingerprintSha256).toBe(uploadedFp)
    expect(back.caFingerprintSha256).toBe(new X509Certificate(mkcert.certPem).fingerprint256)
  })

  it('an upload made before uploads were kept is kept by the revert itself', async () => {
    const mkcert = await legacyCa()
    const { chain, key } = await leafUnder(mkcert)
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.crt'), chain)
    fs.writeFileSync(path.join(dataDir, 'tls', 'camstack.key'), key)
    writeMode(dataDir, 'uploaded')

    await revertToGeneratedCertificate(dataDir, { hostFacts: FIXED_HOST })
    await useStoredUploadedCertificate(dataDir)

    expect(readTlsAccessStatus(dataDir, null).leafFingerprintSha256).toBe(
      new X509Certificate(chain).fingerprint256,
    )
  })

  it('re-selecting with nothing kept is refused with a translated code', async () => {
    await expect(useStoredUploadedCertificate(dataDir)).rejects.toMatchObject({
      i18nCode: 'tls.no-stored-upload',
    })
  })
})
