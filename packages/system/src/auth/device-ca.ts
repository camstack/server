/**
 * Device CA (D855) — the THIRD certificate authority, distinct from the HTTPS
 * local CA (`tls/cert-issue.ts`, RSA) and the mesh CA
 * (`kernel/moleculer/mesh-mtls/mesh-ca.ts`). EC P-256, key in the keychain
 * (owner `system`), certificate persisted like `cluster.meshCa`.
 *
 * It signs ONE kind of leaf: a device credential. The device generated the key
 * pair; the hub only ever sees the public half (an SPKI). Same library and
 * WebCrypto path as the other two CAs, same pinned `@peculiar/x509`.
 */
import { backdatedNotBefore } from '../tls/cert-backdate.js'
import { withUtcTimeEncoding } from '../tls/cert-utc-time.js'
import type { webcrypto as WebCrypto } from 'node:crypto'
import { createPublicKey, randomBytes, verify, webcrypto, X509Certificate } from 'node:crypto'
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  cryptoProvider,
  type Extension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate as PeculiarCertificate,
  X509CertificateGenerator,
} from '@peculiar/x509'
import {
  buildSecretRef,
  DEVICE_CERT_VALIDITY_DAYS,
  DEVICE_SAN_CREDENTIAL_PREFIX,
  DEVICE_SAN_USER_PREFIX,
} from '@camstack/types'

cryptoProvider.set(webcrypto)

const MS_PER_DAY = 86_400_000
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2'

/** `secret://system/global/deviceCaKey` — EC P-256 PKCS#8 PEM of the device CA. */
export const DEVICE_CA_KEY_REF: string = buildSecretRef({
  owner: 'system',
  scope: { kind: 'global' },
  fieldPath: 'deviceCaKey',
})

/** Settings section / field holding the public CA certificate PEM (beside `cluster.meshCa`). */
export const DEVICE_CA_SETTINGS_SECTION = 'cluster'
export const DEVICE_CA_FIELD = 'deviceCa'

export const DEVICE_CA_COMMON_NAME = 'CamStack Device CA'
export const DEVICE_CA_VALIDITY_DAYS = 3650

const KEY_ALGORITHM: WebCrypto.EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGNING_ALGORITHM: WebCrypto.EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

export interface DeviceCaSigner {
  readonly certPem: string
  readonly keyPem: string
  readonly cert: PeculiarCertificate
  readonly privateKey: WebCrypto.CryptoKey
}

export interface DeviceLeafMaterial {
  readonly certPem: string
  readonly serialNumber: string
  readonly notBefore: Date
  readonly notAfter: Date
  /** SHA-256 of the DER, colon-hex uppercase. */
  readonly fingerprint: string
}

function freshSerial(): string {
  return `00${randomBytes(16).toString('hex')}`
}

function certPemOf(cert: PeculiarCertificate): string {
  return `${cert.toString('pem')}\n`
}

export async function generateDeviceCa(now: Date = new Date()): Promise<DeviceCaSigner> {
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify'])
  const extensions: Extension[] = [
    new BasicConstraintsExtension(true, 0, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.createSelfSigned({
      serialNumber: freshSerial(),
      name: `CN=${DEVICE_CA_COMMON_NAME}`,
      notBefore: backdatedNotBefore(now),
      notAfter: new Date(now.getTime() + DEVICE_CA_VALIDITY_DAYS * MS_PER_DAY),
      keys,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  return {
    certPem: certPemOf(cert),
    keyPem: `${PemConverter.encode(pkcs8, 'PRIVATE KEY')}\n`,
    cert,
    privateKey: keys.privateKey,
  }
}

export async function loadDeviceCa(certPem: string, keyPem: string): Promise<DeviceCaSigner> {
  const cert = new PeculiarCertificate(certPem)
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    PemConverter.decodeFirst(keyPem),
    KEY_ALGORITHM,
    true,
    ['sign'],
  )
  return { certPem, keyPem, cert, privateKey }
}

/**
 * A new self-signed certificate for the SAME key pair as `keyPem` (same
 * subject, so leaves already issued still verify): completes a CA creation that
 * died between its key write and its certificate write.
 */
export async function rebuildDeviceCaCertificate(keyPem: string): Promise<DeviceCaSigner> {
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    PemConverter.decodeFirst(keyPem),
    KEY_ALGORITHM,
    true,
    ['sign'],
  )
  const jwk = await webcrypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await webcrypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    KEY_ALGORITHM,
    true,
    ['verify'],
  )
  const now = new Date()
  const extensions: Extension[] = [
    new BasicConstraintsExtension(true, 0, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(publicKey),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.createSelfSigned({
      serialNumber: freshSerial(),
      name: `CN=${DEVICE_CA_COMMON_NAME}`,
      notBefore: backdatedNotBefore(now),
      notAfter: new Date(now.getTime() + DEVICE_CA_VALIDITY_DAYS * MS_PER_DAY),
      keys: { privateKey, publicKey },
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return { certPem: certPemOf(cert), keyPem, cert, privateKey }
}

/** Import (and thereby validate) a device public key: SPKI DER, ECDSA P-256. */
export async function importDevicePublicKey(spki: Uint8Array): Promise<WebCrypto.CryptoKey> {
  return webcrypto.subtle.importKey('spki', spki, KEY_ALGORITHM, true, ['verify'])
}

export interface IssueDeviceLeafInput {
  readonly credentialId: string
  readonly userId: string
  readonly publicKeySpki: Uint8Array
  readonly now?: Date
  readonly validDays?: number
}

/**
 * Sign a device leaf: CN = credential id; SAN URIs `camstack:credential:<id>`
 * and `camstack:user:<userId>`; EKU clientAuth; 365 days by default.
 */
export async function issueDeviceLeaf(
  ca: DeviceCaSigner,
  input: IssueDeviceLeafInput,
): Promise<DeviceLeafMaterial> {
  const publicKey = await importDevicePublicKey(input.publicKeySpki)
  const issuedAt = input.now ?? new Date()
  const notBefore = backdatedNotBefore(issuedAt)
  const notAfter = new Date(
    issuedAt.getTime() + (input.validDays ?? DEVICE_CERT_VALIDITY_DAYS) * MS_PER_DAY,
  )
  const serialNumber = freshSerial()
  const extensions: Extension[] = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
    new ExtendedKeyUsageExtension([CLIENT_AUTH_OID]),
    new SubjectAlternativeNameExtension([
      { type: 'url', value: `${DEVICE_SAN_CREDENTIAL_PREFIX}${input.credentialId}` },
      { type: 'url', value: `${DEVICE_SAN_USER_PREFIX}${input.userId}` },
    ]),
    await SubjectKeyIdentifierExtension.create(publicKey),
    await AuthorityKeyIdentifierExtension.create(ca.cert),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${input.credentialId}`,
      issuer: ca.cert.subject,
      notBefore,
      notAfter,
      publicKey,
      signingKey: ca.privateKey,
      signingAlgorithm: SIGNING_ALGORITHM,
      extensions,
    }),
  )
  const pem = certPemOf(cert)
  return {
    certPem: pem,
    serialNumber,
    notBefore,
    notAfter,
    fingerprint: new X509Certificate(pem).fingerprint256,
  }
}

export type DeviceLeafRefusal =
  | 'malformed-certificate'
  | 'not-issued-by-device-ca'
  | 'not-yet-valid'
  | 'expired'
  | 'missing-credential-san'
  | 'missing-client-auth'

export type DeviceLeafVerdict =
  | {
      readonly ok: true
      readonly credentialId: string
      readonly userId: string | null
      readonly publicKeySpki: Buffer
      readonly serialNumber: string
      readonly fingerprint: string
      readonly notAfter: Date
    }
  | { readonly ok: false; readonly reason: DeviceLeafRefusal }

function sanValues(cert: PeculiarCertificate): readonly string[] {
  const san = cert.getExtension(SubjectAlternativeNameExtension)
  if (san === null) return []
  return san.names.items.filter((n) => n.type === 'url').map((n) => n.value)
}

/** Chain (signature by the device CA), validity window, EKU and identity of a presented leaf. */
export async function verifyDeviceLeaf(
  caCertPem: string,
  leafPem: string,
  now: Date = new Date(),
): Promise<DeviceLeafVerdict> {
  let leaf: PeculiarCertificate
  let ca: PeculiarCertificate
  try {
    leaf = new PeculiarCertificate(leafPem)
    ca = new PeculiarCertificate(caCertPem)
  } catch {
    return { ok: false, reason: 'malformed-certificate' }
  }
  const signedByCa = await leaf.verify({ publicKey: ca, signatureOnly: true }, webcrypto)
  if (!signedByCa || leaf.issuer !== ca.subject) {
    return { ok: false, reason: 'not-issued-by-device-ca' }
  }
  if (now < leaf.notBefore) return { ok: false, reason: 'not-yet-valid' }
  if (now > leaf.notAfter) return { ok: false, reason: 'expired' }
  const eku = leaf.getExtension(ExtendedKeyUsageExtension)
  if (eku === null || !eku.usages.includes(CLIENT_AUTH_OID)) {
    return { ok: false, reason: 'missing-client-auth' }
  }
  const sans = sanValues(leaf)
  const credentialId = sans
    .find((v) => v.startsWith(DEVICE_SAN_CREDENTIAL_PREFIX))
    ?.slice(DEVICE_SAN_CREDENTIAL_PREFIX.length)
  if (credentialId === undefined || credentialId === '') {
    return { ok: false, reason: 'missing-credential-san' }
  }
  const userId =
    sans.find((v) => v.startsWith(DEVICE_SAN_USER_PREFIX))?.slice(DEVICE_SAN_USER_PREFIX.length) ??
    null
  return {
    ok: true,
    credentialId,
    userId,
    publicKeySpki: Buffer.from(leaf.publicKey.rawData),
    serialNumber: leaf.serialNumber,
    fingerprint: new X509Certificate(leafPem).fingerprint256,
    notAfter: leaf.notAfter,
  }
}

/**
 * ECDSA P-256 / SHA-256 over `message`. Accepts the raw `r||s` form WebCrypto
 * and Android emit (64 bytes) and the DER form the Secure Enclave emits.
 */
export function verifyDeviceSignature(
  publicKeySpki: Uint8Array,
  message: string,
  signatureBase64Url: string,
): boolean {
  let signature: Buffer
  try {
    signature = Buffer.from(signatureBase64Url, 'base64url')
  } catch {
    return false
  }
  if (signature.length === 0) return false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpki), format: 'der', type: 'spki' })
    const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der'
    return verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding }, signature)
  } catch {
    return false
  }
}
