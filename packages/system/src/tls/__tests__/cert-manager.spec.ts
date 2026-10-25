import type { webcrypto as WebCrypto } from 'node:crypto'
import { webcrypto, X509Certificate } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as peculiar from '@peculiar/x509'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CertIdentity,
  ensureTlsCert,
  evaluateExistingCert,
  type HostFacts,
  loadTlsCert,
  MAX_LEAF_VALIDITY_DAYS,
} from '../cert-manager.js'

/** OID for `id-kp-serverAuth` — the field Apple's trustd requires on the leaf. */
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'

/**
 * The machine this suite runs on, fixed. Without it every SAN assertion
 * below is a statement about the runner's hostname and NICs: a CI box that
 * happens to own `10.99.0.1` turns "regenerates on a SAN gap" green-for-the-
 * wrong-reason, and one whose hostname is not a legal DNS label changes the
 * identity set outright.
 */
const FIXED_HOST: HostFacts = {
  hostname: 'spec-host.lan',
  networkInterfaces: {
    eth0: [{ address: '192.168.10.9', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }],
  },
}

/**
 * Extension OIDs that appear more than once. RFC 5280 §4.2 forbids it and
 * OpenSSL 3 — i.e. `node:crypto` — treats such a certificate as invalid.
 * Parsed with an implementation independent of the one under assertion.
 */
function duplicateExtensionOids(cert: X509Certificate): readonly string[] {
  const seen = new Map<string, number>()
  for (const ext of new peculiar.X509Certificate(cert.raw).extensions) {
    seen.set(ext.type, (seen.get(ext.type) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([oid]) => oid)
}

function readLeaf(certPath: string): X509Certificate {
  // The cert file is a chain; `X509Certificate` parses the first entry, the leaf.
  return new X509Certificate(fs.readFileSync(certPath))
}

function splitPem(pem: string): readonly string[] {
  return pem
    .split('-----END CERTIFICATE-----')
    .filter((chunk) => chunk.includes('-----BEGIN CERTIFICATE-----'))
    .map((chunk) => `${chunk}-----END CERTIFICATE-----\n`)
}

/**
 * Reproduces the pre-repair generator: ONE self-signed `CA:TRUE` leaf, 825
 * days, no EKU. This is what every install in the field is serving today.
 *
 * Built in-process on purpose. It used to be `openssl req -x509` — which
 * made the FIXTURE, not just the subject, a statement about the host's
 * openssl (D551).
 */
async function writeLegacyCert(tlsDir: string): Promise<void> {
  fs.mkdirSync(tlsDir, { recursive: true })
  const alg: WebCrypto.RsaHashedKeyGenParams = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  }
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])
  const now = Date.now()
  const cert = await peculiar.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=camstack.local',
    notBefore: new Date(now),
    notAfter: new Date(now + 825 * 86_400_000),
    keys,
    signingAlgorithm: alg,
    extensions: [
      new peculiar.BasicConstraintsExtension(true, undefined, true),
      new peculiar.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'dns', value: 'camstack.local' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  })
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  fs.writeFileSync(path.join(tlsDir, 'camstack.crt'), cert.toString('pem'))
  fs.writeFileSync(
    path.join(tlsDir, 'camstack.key'),
    `${peculiar.PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`,
  )
}

describe('cert-manager', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tls-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generates a cert when none exists', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(result.certPath).toContain('camstack.crt')
    expect(result.keyPath).toContain('camstack.key')
    expect(result.generated).toBe(true)
    expect(fs.existsSync(result.certPath)).toBe(true)
    expect(fs.existsSync(result.keyPath)).toBe(true)
  })

  it('reuses existing cert on second call', async () => {
    const first = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(second.generated).toBe(false)
    expect(second.reason).toBeNull()
    expect(second.certPath).toBe(first.certPath)

    const cert1 = fs.readFileSync(first.certPath, 'utf-8')
    const cert2 = fs.readFileSync(second.certPath, 'utf-8')
    expect(cert1).toBe(cert2)
  })

  it('loadTlsCert returns PEM buffers', async () => {
    const { certPath, keyPath } = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const pair = loadTlsCert(certPath, keyPath)
    expect(pair.cert).toBeInstanceOf(Buffer)
    expect(pair.key).toBeInstanceOf(Buffer)
    expect(pair.cert.toString().startsWith('-----BEGIN CERTIFICATE-----')).toBe(true)
    expect(pair.key.toString().startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  })

  it('generated cert has correct CN', async () => {
    const { certPath } = await ensureTlsCert(tmpDir, {
      hostFacts: FIXED_HOST,
      commonName: 'camstack.local',
    })
    expect(readLeaf(certPath).subject).toContain('CN=camstack.local')
  })

  it('generated cert has SAN for localhost and local IPs', async () => {
    const { certPath } = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const san = readLeaf(certPath).subjectAltName ?? ''
    expect(san).toContain('DNS:localhost')
    expect(san).toContain('IP Address:127.0.0.1')
  })

  it('cert is valid for at least 1 year', async () => {
    const validTo = new Date(
      readLeaf((await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })).certPath).validTo,
    )
    const oneYearFromNow = new Date()
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1)
    expect(validTo.getTime()).toBeGreaterThanOrEqual(oneYearFromNow.getTime() - 86400000)
  })

  // ── Defect 1 — extendedKeyUsage = serverAuth ───────────────────────

  it('leaf carries extendedKeyUsage serverAuth, and nothing wider', async () => {
    const leaf = readLeaf((await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })).certPath)
    // Node exposes the EXTENDED key usage OIDs under `keyUsage`.
    expect(leaf.keyUsage).toEqual([SERVER_AUTH_OID])
  })

  // ── Defect 4 — CA → leaf, not a self-signed leaf ───────────────────

  it('emits a CA → leaf pair: the leaf is not a CA and is issued by the local root', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const leaf = readLeaf(result.certPath)
    expect(leaf.ca).toBe(false)
    expect(leaf.issuer).not.toBe(leaf.subject)

    const ca = new X509Certificate(fs.readFileSync(result.caCertPath))
    expect(ca.ca).toBe(true)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
  })

  it('the served cert file is the full chain: leaf first, then the CA', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const chain = splitPem(fs.readFileSync(result.certPath, 'utf-8'))
    expect(chain).toHaveLength(2)
    expect(new X509Certificate(chain[0]!).ca).toBe(false)
    expect(new X509Certificate(chain[1]!).ca).toBe(true)
  })

  it('the CA private key is written 0600', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(fs.statSync(result.caKeyPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(result.keyPath).mode & 0o777).toBe(0o600)
  })

  // ── Defect 3 — 397-day leaf ────────────────────────────────────────

  it('leaf validity is at most 397 days', async () => {
    const leaf = readLeaf((await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })).certPath)
    const spanDays =
      (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / 86_400_000
    expect(MAX_LEAF_VALIDITY_DAYS).toBe(397)
    expect(spanDays).toBeLessThanOrEqual(397)
  })

  // ── Link-local SANs can never match — they must be dropped ─────────

  it('drops link-local addresses from the SAN list', async () => {
    const { certPath } = await ensureTlsCert(tmpDir, {
      hostFacts: FIXED_HOST,
      extraSans: ['fe80::10ff:e001:1180:5ecf', '169.254.1.1', '10.99.0.1'],
    })
    const san = readLeaf(certPath).subjectAltName ?? ''
    expect(san.toUpperCase()).not.toContain('FE80')
    expect(san).not.toContain('169.254.1.1')
    // …while a routable extra SAN is still honoured.
    expect(san).toContain('10.99.0.1')
  })

  // ── Defect 2 — regenerate on SAN drift ─────────────────────────────

  it('regenerates when an address the hub must answer for is no longer covered', async () => {
    const first = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(first.generated).toBe(true)

    // The machine gained an address (DHCP move / new interface).
    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, extraSans: ['10.99.0.1'] })
    expect(second.generated).toBe(true)
    expect(second.reason).toBe('san-coverage-gap')
    expect(readLeaf(second.certPath).checkIP('10.99.0.1')).toBe('10.99.0.1')
  })

  it('regenerates when the hostname the cert must answer for changes', async () => {
    await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, commonName: 'camstack.local' })
    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, commonName: 'hub.lan' })
    expect(second.generated).toBe(true)
    expect(second.reason).toBe('san-coverage-gap')
  })

  it('does NOT regenerate when the cert merely names an address the hub no longer has', async () => {
    // A cert that is a SUPERSET of the current identity still does its job.
    // Regenerating here is what makes a cert churn on every boot and destroys
    // any trust the operator granted by hand.
    const first = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, extraSans: ['10.99.0.1'] })
    expect(first.generated).toBe(true)
    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(second.generated).toBe(false)
    expect(second.reason).toBeNull()
  })

  it('does NOT regenerate when a ULA IPv6 address rotates', async () => {
    // Live hub 2026-10-03: eth0 ULA interface-id stepped on every restart
    // (…:6780:… → …:6980:… → …:6F80:…) and D227's ULA gate reissued the
    // leaf eight times in one day. IPv6 never gates — only IPv4 + DNS do.
    const hostA: HostFacts = {
      hostname: 'spec-host.lan',
      networkInterfaces: {
        eth0: [
          { address: '192.168.10.9', internal: false },
          { address: 'fdc4:e03a:df37:e201:10ff:e000:6780:5ecf', internal: false },
        ],
      },
    }
    const hostB: HostFacts = {
      hostname: 'spec-host.lan',
      networkInterfaces: {
        eth0: [
          { address: '192.168.10.9', internal: false },
          { address: 'fdc4:e03a:df37:e201:10ff:e000:6f80:5ecf', internal: false },
        ],
      },
    }
    const first = await ensureTlsCert(tmpDir, { hostFacts: hostA })
    expect(first.generated).toBe(true)
    const second = await ensureTlsCert(tmpDir, { hostFacts: hostB })
    expect(second.generated).toBe(false)
    expect(second.fingerprintSha256).toBe(first.fingerprintSha256)
  })

  // ── Migration — one shot, then stable ──────────────────────────────

  it('replaces a legacy self-signed cert exactly once', async () => {
    await writeLegacyCert(path.join(tmpDir, 'tls'))
    const legacyPem = fs.readFileSync(path.join(tmpDir, 'tls', 'camstack.crt'), 'utf-8')

    const migrated = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(migrated.generated).toBe(true)
    expect(migrated.reason).toBe('no-local-ca')
    expect(fs.readFileSync(migrated.certPath, 'utf-8')).not.toBe(legacyPem)

    // Second boot: nothing changes. A cert that moves on every restart is a
    // worse bug than the one being fixed.
    const stable = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(stable.generated).toBe(false)
    expect(fs.readFileSync(stable.certPath, 'utf-8')).toBe(
      fs.readFileSync(migrated.certPath, 'utf-8'),
    )
  })

  it('rotates only the leaf on drift — the CA anchor survives', async () => {
    const first = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const caBefore = fs.readFileSync(first.caCertPath, 'utf-8')

    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, extraSans: ['10.99.0.1'] })
    expect(second.generated).toBe(true)
    expect(fs.readFileSync(second.caCertPath, 'utf-8')).toBe(caBefore)
    expect(second.caFingerprintSha256).toBe(first.caFingerprintSha256)
    expect(second.fingerprintSha256).not.toBe(first.fingerprintSha256)
  })

  it('keeps serving the existing certificate when a reissue fails', async () => {
    // Nothing about this repair may take a booting hub down. If openssl
    // cannot produce a new leaf, the old one still answers handshakes —
    // degraded, loudly reported, but alive.
    const first = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const certBefore = fs.readFileSync(first.certPath, 'utf-8')
    fs.writeFileSync(first.caKeyPath, 'not a private key\n')

    const second = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST, extraSans: ['10.99.0.1'] })
    expect(second.generated).toBe(false)
    expect(second.reissueError).not.toBeNull()
    expect(fs.readFileSync(second.certPath, 'utf-8')).toBe(certBefore)
  })

  // ── D551 — the machine's identity is injected, never read ──────────

  it('certifies the INJECTED machine identity, not the one running the suite', async () => {
    const { certPath } = await ensureTlsCert(tmpDir, {
      hostFacts: {
        hostname: 'some-other-box.lan',
        networkInterfaces: { eth7: [{ address: '10.77.0.4', internal: false }] },
      },
    })
    const leaf = readLeaf(certPath)
    expect(leaf.checkHost('some-other-box.lan')).toBe('some-other-box.lan')
    expect(leaf.checkIP('10.77.0.4')).toBe('10.77.0.4')
    // The real machine is absent — proof the reader, not a mirror of it, moved.
    expect(leaf.checkHost(os.hostname())).toBeUndefined()
  })

  // ── D551 — the certificate is not a function of the machine ────────

  it('issues a usable CA → leaf pair on a machine with no openssl binary at all', async () => {
    // The hub's own TLS identity may not depend on what is installed next
    // to it. Four openssl implementations already run in this fleet, one of
    // them (Ubuntu 20.04's 1.1.1f) emitted a root with DUPLICATE
    // basicConstraints — which `node:crypto` calls invalid, so the hub
    // rotated its own root on every boot. An empty PATH is the cheapest
    // statement of the rule: nothing on the host is consulted.
    const emptyBin = path.join(tmpDir, 'empty-bin')
    fs.mkdirSync(emptyBin, { recursive: true })
    const originalPath = process.env['PATH']
    process.env['PATH'] = emptyBin
    let result: Awaited<ReturnType<typeof ensureTlsCert>>
    try {
      result = await ensureTlsCert(path.join(tmpDir, 'data'), { hostFacts: FIXED_HOST })
    } finally {
      process.env['PATH'] = originalPath
    }

    const leaf = readLeaf(result.certPath)
    const ca = new X509Certificate(fs.readFileSync(result.caCertPath))
    expect(leaf.ca).toBe(false)
    expect(ca.ca).toBe(true)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.keyUsage).toEqual([SERVER_AUTH_OID])

    // RFC 5280 §4.2: an extension appears at most once. The 1.1.1 root
    // carried basicConstraints and subjectKeyIdentifier twice each, and
    // that alone is what made OpenSSL 3 refuse the pair.
    expect(duplicateExtensionOids(ca)).toEqual([])
    expect(duplicateExtensionOids(leaf)).toEqual([])
  })

  it('reports what changed so the operator can be told', async () => {
    const result = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    expect(result.fingerprintSha256).toMatch(/^[0-9A-F:]+$/)
    expect(result.caFingerprintSha256).toMatch(/^[0-9A-F:]+$/)
    expect(new Date(result.validTo).getTime()).toBeGreaterThan(Date.now())
    expect(result.sans.length).toBeGreaterThan(0)
  })
})

// ── The evaluator, directly — cases the public API cannot stage ──────

describe('evaluateExistingCert', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tls-eval-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const identity: CertIdentity = {
    dnsNames: ['localhost'],
    ipAddresses: ['127.0.0.1'],
    requiredDnsNames: ['localhost'],
    requiredIpAddresses: ['127.0.0.1'],
  }

  it('returns null for a conformant, well-covered cert', async () => {
    const { certPath, keyPath, caCertPath } = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const reason = evaluateExistingCert({
      chainPem: fs.readFileSync(certPath, 'utf-8'),
      keyPem: fs.readFileSync(keyPath, 'utf-8'),
      caPem: fs.readFileSync(caCertPath, 'utf-8'),
      identity,
      now: new Date(),
    })
    expect(reason).toBeNull()
  })

  it('flags a cert inside the renewal window as expiring', async () => {
    const { certPath, keyPath, caCertPath } = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const leaf = new X509Certificate(fs.readFileSync(certPath))
    // Stand one day inside the renewal window before expiry.
    const almostExpired = new Date(new Date(leaf.validTo).getTime() - 29 * 86_400_000)
    const reason = evaluateExistingCert({
      chainPem: fs.readFileSync(certPath, 'utf-8'),
      keyPem: fs.readFileSync(keyPath, 'utf-8'),
      caPem: fs.readFileSync(caCertPath, 'utf-8'),
      identity,
      now: almostExpired,
    })
    expect(reason).toBe('expiring')
  })

  it('flags an unparseable cert', () => {
    const reason = evaluateExistingCert({
      chainPem: 'not a certificate',
      keyPem: 'not a key',
      caPem: 'not a certificate',
      identity,
      now: new Date(),
    })
    expect(reason).toBe('unreadable')
  })

  it('flags a leaf that is not issued by the local CA on disk', async () => {
    const { certPath, keyPath } = await ensureTlsCert(tmpDir, { hostFacts: FIXED_HOST })
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tls-other-'))
    try {
      const foreign = await ensureTlsCert(other, { hostFacts: FIXED_HOST })
      const reason = evaluateExistingCert({
        chainPem: fs.readFileSync(certPath, 'utf-8'),
        keyPem: fs.readFileSync(keyPath, 'utf-8'),
        caPem: fs.readFileSync(foreign.caCertPath, 'utf-8'),
        identity,
        now: new Date(),
      })
      expect(reason).toBe('not-issued-by-local-ca')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
