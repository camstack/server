/**
 * Certificate issuance. Isolated so `cert-manager.ts` reads as policy and
 * this file reads as mechanics.
 *
 * **In-process, by decision (D551).** This used to shell out to `openssl`
 * three times. The hub's own TLS identity is not allowed to be a function
 * of which openssl happens to sit on the host: this fleet alone runs four
 * of them, and one — Ubuntu 20.04's 1.1.1f — silently ADDED the ambient
 * `/etc/ssl/openssl.cnf` `[req] x509_extensions = v3_ca` block on top of
 * our `-addext` flags, producing a root with two `basicConstraints` and
 * two `subjectKeyIdentifier` extensions. RFC 5280 §4.2 allows each at
 * most once, so OpenSSL 3 (which is what `node:crypto` is) marked that
 * root invalid: `X509Certificate.ca` read `false` on our own CA and
 * `checkIssued()` refused the pair. Under D227 that means "not issued by
 * the local CA", i.e. rotate the root — on every boot, forever, voiding
 * every trust an operator had granted by hand.
 *
 * Keys come from WebCrypto (`node:crypto`'s own implementation) and the
 * DER is assembled by `@peculiar/x509`. Nothing here reads the host.
 */
import { backdatedNotBefore } from './cert-backdate.js'
import { withUtcTimeEncoding } from './cert-utc-time.js'
import type { webcrypto as WebCrypto } from 'node:crypto'
import { randomBytes, webcrypto } from 'node:crypto'
import { isIP } from 'node:net'
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  cryptoProvider,
  type Extension,
  ExtendedKeyUsageExtension,
  type JsonGeneralName,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate as PeculiarCertificate,
  X509CertificateGenerator,
} from '@peculiar/x509'
import { CA_VALIDITY_DAYS, SERVER_AUTH_OID } from './cert-evaluation.js'
import { buildNameConstraintSet, createNameConstraintsExtension } from './cert-name-constraints.js'
import type { CertIdentity } from './cert-identity.js'

cryptoProvider.set(webcrypto)

/** Subject of the local root. Distinct from the leaf's CN by construction. */
export const CA_COMMON_NAME = 'CamStack Local CA'

/** Between {@link CA_COMMON_NAME} and the hub's name in a new root's subject. */
export const CA_HUB_NAME_SEPARATOR = ' — '

/** X.520 `ub-common-name`: the most characters a CN may carry. */
const X509_COMMON_NAME_MAX_LENGTH = 64

/** C0 controls, DEL and the C1 range. */
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/**
 * The subject CN of a NEW local root: `CamStack Local CA — <hub name>`, so two hubs'
 * roots installed on one phone can be told apart in its settings. The name is
 * sanitised for a CN (controls removed, whitespace collapsed) and cut so the whole
 * CN stays within 64 characters. An absent or unusable name, or one that is just
 * the product's own name, yields the plain {@link CA_COMMON_NAME}.
 *
 * Only a root being CREATED is named: an existing root is never reissued to rename
 * it, since every device that trusts it would have to install it again.
 */
export function localCaCommonName(hubName: string | undefined): string {
  if (hubName === undefined) return CA_COMMON_NAME
  const cleaned = [...hubName]
    .map((char) => (isControlCodePoint(char.codePointAt(0) ?? 0) ? ' ' : char))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '' || cleaned.toLowerCase() === 'camstack') return CA_COMMON_NAME
  const room = X509_COMMON_NAME_MAX_LENGTH - CA_COMMON_NAME.length - CA_HUB_NAME_SEPARATOR.length
  const name = [...cleaned].slice(0, room).join('').trimEnd()
  return `${CA_COMMON_NAME}${CA_HUB_NAME_SEPARATOR}${name}`
}

const MS_PER_DAY = 86_400_000

/**
 * Expiry of a served leaf. Browsers cap the TOTAL span (notBefore to notAfter) at 397 days, so
 * the span is `validDays` counted from the backdated start: the backdate costs five minutes of
 * expiry here, never extra span.
 */
function leafNotAfter(now: Date, validDays: number): Date {
  return new Date(backdatedNotBefore(now).getTime() + validDays * MS_PER_DAY)
}

/**
 * RSA-2048 / SHA-256. Unchanged from the openssl invocation this replaces:
 * every client that trusted the previous material still understands this.
 */
const SIGNING_ALGORITHM: WebCrypto.RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
}

/** A PEM-encoded certificate and the PKCS#8 PEM of its private key. */
export interface CertMaterial {
  readonly certPem: string
  readonly keyPem: string
}

/** An issuing root: its PEM, and the live key handle needed to sign with it. */
export interface CaSigner {
  readonly certPem: string
  readonly keyPem: string
  readonly cert: PeculiarCertificate
  readonly privateKey: WebCrypto.CryptoKey
}

/**
 * A serial number that is positive and unpredictable. `00` prefix for the
 * same reason the openssl invocation carried one: a leading bit of 1 would
 * make the DER INTEGER negative.
 */
function freshSerial(): string {
  return `00${randomBytes(16).toString('hex')}`
}

function toPkcs8Pem(pkcs8: ArrayBuffer): string {
  return `${PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`
}

function toCertPem(cert: PeculiarCertificate): string {
  return `${cert.toString('pem')}\n`
}

async function exportKeyPem(key: WebCrypto.CryptoKey): Promise<string> {
  return toPkcs8Pem(await webcrypto.subtle.exportKey('pkcs8', key))
}

/** SAN entries, in the order `cert-identity` produced them. */
function subjectAltNames(identity: CertIdentity): readonly JsonGeneralName[] {
  const names: JsonGeneralName[] = []
  for (const dns of identity.dnsNames) names.push({ type: 'dns', value: dns })
  for (const ip of identity.ipAddresses) {
    if (isIP(ip) !== 0) names.push({ type: 'ip', value: ip })
  }
  return names
}

/**
 * A local root: 10 years, `pathlen:0` so it can sign leaves and nothing
 * else, and **no EKU** — Apple rejects an anchor asserting
 * `anyExtendedKeyUsage`, and a root with no EKU constrains nothing.
 *
 * It carries a CRITICAL `nameConstraints` extension (D873): private address
 * ranges and local-only DNS names, plus `hostnames` (the hub's own single-label
 * names at creation). A leaked key therefore cannot vouch for a public site.
 *
 * `commonName` is the subject CN, from {@link localCaCommonName}.
 */
export async function generateCa(
  now: Date,
  hostnames: readonly string[] = [],
  commonName: string = CA_COMMON_NAME,
): Promise<CaSigner> {
  const keys = await webcrypto.subtle.generateKey(SIGNING_ALGORITHM, true, ['sign', 'verify'])
  const extensions: Extension[] = [
    new BasicConstraintsExtension(true, 0, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
    createNameConstraintsExtension(buildNameConstraintSet(hostnames)),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.createSelfSigned({
      serialNumber: freshSerial(),
      // The JSON form, never a `CN=…` string: a hub name may hold `,` `=` `+`.
      name: [{ CN: [commonName] }],
      notBefore: backdatedNotBefore(now),
      notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * MS_PER_DAY),
      keys,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return {
    certPem: toCertPem(cert),
    keyPem: await exportKeyPem(keys.privateKey),
    cert,
    privateKey: keys.privateKey,
  }
}

/** Re-open a root already on disk so a leaf can be issued under it. */
export async function loadCa(certPem: string, keyPem: string): Promise<CaSigner> {
  const cert = new PeculiarCertificate(certPem)
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    PemConverter.decodeFirst(keyPem),
    SIGNING_ALGORITHM,
    true,
    ['sign'],
  )
  return { certPem, keyPem, cert, privateKey }
}

/**
 * A server leaf signed by the local root: `CA:FALSE`, and
 * `extendedKeyUsage=serverAuth` — not `anyExtendedKeyUsage`, which
 * Apple's `testAppTrustRoot_AnyEKU_AfterJul2019` asserts must fail.
 */
export async function issueLeaf(
  ca: CaSigner,
  identity: CertIdentity,
  commonName: string,
  validDays: number,
  now: Date,
): Promise<CertMaterial> {
  const keys = await webcrypto.subtle.generateKey(SIGNING_ALGORITHM, true, ['sign', 'verify'])
  const extensions: Extension[] = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
    new ExtendedKeyUsageExtension([SERVER_AUTH_OID]),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
    await AuthorityKeyIdentifierExtension.create(ca.cert),
    new SubjectAlternativeNameExtension(subjectAltNames(identity)),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.create({
      serialNumber: freshSerial(),
      subject: `CN=${commonName}`,
      issuer: ca.cert.subject,
      notBefore: backdatedNotBefore(now),
      notAfter: leafNotAfter(now, validDays),
      publicKey: keys.publicKey,
      signingKey: ca.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return { certPem: toCertPem(cert), keyPem: await exportKeyPem(keys.privateKey) }
}

/**
 * A server leaf for a key pair the CALLER holds (D856): an agent sends a CSR, the
 * hub signs its public key under the local root. Same extensions as
 * {@link issueLeaf} - `CA:FALSE`, serverAuth only - so a device that trusts the
 * hub root trusts the agent. The private key never exists on the hub.
 */
export async function issueLeafFromCsr(
  ca: CaSigner,
  csrPem: string,
  identity: CertIdentity,
  commonName: string,
  validDays: number,
  now: Date,
): Promise<string> {
  const csr = new Pkcs10CertificateRequest(csrPem)
  if (!(await csr.verify(webcrypto))) throw new Error('CSR signature is invalid')
  const extensions: Extension[] = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
    new ExtendedKeyUsageExtension([SERVER_AUTH_OID]),
    await SubjectKeyIdentifierExtension.create(csr.publicKey),
    await AuthorityKeyIdentifierExtension.create(ca.cert),
    new SubjectAlternativeNameExtension(subjectAltNames(identity)),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.create({
      serialNumber: freshSerial(),
      subject: `CN=${commonName}`,
      issuer: ca.cert.subject,
      notBefore: backdatedNotBefore(now),
      notAfter: leafNotAfter(now, validDays),
      publicKey: csr.publicKey,
      signingKey: ca.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return toCertPem(cert)
}
