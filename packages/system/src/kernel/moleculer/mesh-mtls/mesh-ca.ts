/**
 * Hub mesh CA — EC P-256, key in the keychain, cert in `cluster.meshCa`.
 *
 * Distinct from the HTTPS local CA (`tls/cert-issue.ts`, RSA): the mesh CA
 * signs node leaves (CN = nodeID) and unlock-ticket JWS (ES256). Issuance uses
 * `@peculiar/x509` over WebCrypto — same library the HTTPS path already uses
 * (installed `1.14.3`; registry latest at adoption time was `2.1.0` — stay on
 * the pinned range already shipping).
 */
import { backdatedNotBefore } from '../../../tls/cert-backdate.js'
import { withUtcTimeEncoding } from '../../../tls/cert-utc-time.js'
import type { webcrypto as WebCrypto } from 'node:crypto'
import { createHash, randomBytes, webcrypto, X509Certificate } from 'node:crypto'
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  cryptoProvider,
  type Extension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  Pkcs10CertificateRequest,
  Pkcs10CertificateRequestGenerator,
  SubjectKeyIdentifierExtension,
  X509Certificate as PeculiarCertificate,
  X509CertificateGenerator,
} from '@peculiar/x509'
import {
  CLIENT_AUTH_OID,
  MESH_CA_COMMON_NAME,
  MESH_CA_VALIDITY_DAYS,
  MESH_LEAF_VALIDITY_DAYS,
  SERVER_AUTH_OID,
} from './constants.js'

cryptoProvider.set(webcrypto)

const MS_PER_DAY = 86_400_000

/** Key generation — EC P-256 (plan). WebCrypto DOM names are not in @types/node. */
export const MESH_KEY_ALGORITHM: WebCrypto.EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: 'P-256',
}

/** Signing — ECDSA with SHA-256. */
export const MESH_SIGNING_ALGORITHM: WebCrypto.EcdsaParams = {
  name: 'ECDSA',
  hash: 'SHA-256',
}

/** A node id: letters, digits, `.`, `_`, `-`; at most 63 characters; starts with a letter or digit. */
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i
/** Ids no agent may take: the hub's own, whatever the case (D857). */
const RESERVED_NODE_IDS: ReadonlySet<string> = new Set(['hub'])

/** True for an id an agent may carry: the pattern, and not a reserved name. */
export function isValidAgentNodeId(nodeId: string): boolean {
  return NODE_ID_PATTERN.test(nodeId) && !RESERVED_NODE_IDS.has(nodeId.toLowerCase())
}

export interface MeshCaSigner {
  readonly certPem: string
  readonly keyPem: string
  readonly cert: PeculiarCertificate
  readonly privateKey: WebCrypto.CryptoKey
  readonly publicKey: WebCrypto.CryptoKey
}

export interface MeshLeafMaterial {
  readonly certPem: string
  readonly serialNumber: string
  readonly notAfter: Date
  readonly commonName: string
}

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

/** SHA-256 fingerprint of the DER cert, colon-hex uppercase (Node style). */
export function caFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}

/** Compact fingerprint (lowercase hex, no colons). */
export function caFingerprintCompact(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

export async function generateMeshCa(now: Date = new Date()): Promise<MeshCaSigner> {
  const keys = await webcrypto.subtle.generateKey(MESH_KEY_ALGORITHM, true, ['sign', 'verify'])
  const extensions: Extension[] = [
    new BasicConstraintsExtension(true, 0, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    await SubjectKeyIdentifierExtension.create(keys.publicKey),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.createSelfSigned({
      serialNumber: freshSerial(),
      name: `CN=${MESH_CA_COMMON_NAME}`,
      notBefore: backdatedNotBefore(now),
      notAfter: new Date(now.getTime() + MESH_CA_VALIDITY_DAYS * MS_PER_DAY),
      keys,
      signingAlgorithm: MESH_SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return {
    certPem: toCertPem(cert),
    keyPem: await exportKeyPem(keys.privateKey),
    cert,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  }
}

export async function loadMeshCa(certPem: string, keyPem: string): Promise<MeshCaSigner> {
  const cert = new PeculiarCertificate(certPem)
  const privateKey = await webcrypto.subtle.importKey(
    'pkcs8',
    PemConverter.decodeFirst(keyPem),
    MESH_KEY_ALGORITHM,
    true,
    ['sign'],
  )
  const publicKey = await cert.publicKey.export(webcrypto)
  return { certPem, keyPem, cert, privateKey, publicKey }
}

/**
 * Issue a leaf from a CSR. CN must be present; when `expectedNodeId` is set
 * it must match. Validity: 30 days.
 */
export async function issueMeshLeafFromCsr(
  ca: MeshCaSigner,
  csrPem: string,
  opts: {
    readonly expectedNodeId?: string
    readonly now?: Date
    readonly validDays?: number
    /** The hub's own leaf, made in-process from a key it generated itself (never a remote CSR). */
    readonly allowReserved?: boolean
  } = {},
): Promise<MeshLeafMaterial> {
  const csr = new Pkcs10CertificateRequest(csrPem)
  const ok = await csr.verify(webcrypto)
  if (!ok) throw new Error('CSR signature is invalid')

  const cn = subjectCn(csr.subject)
  if (cn === null || cn.length === 0) throw new Error('CSR subject has no CN')
  if (opts.allowReserved !== true && !isValidAgentNodeId(cn)) {
    throw new Error(`CSR CN '${cn}' is not an id an agent may carry`)
  }
  if (opts.expectedNodeId !== undefined && opts.expectedNodeId !== cn) {
    throw new Error(`CSR CN '${cn}' does not match the token nodeId '${opts.expectedNodeId}'`)
  }

  const now = opts.now ?? new Date()
  const validDays = opts.validDays ?? MESH_LEAF_VALIDITY_DAYS
  const serialNumber = freshSerial()
  const notAfter = new Date(now.getTime() + validDays * MS_PER_DAY)
  const extensions: Extension[] = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
    new ExtendedKeyUsageExtension([SERVER_AUTH_OID, CLIENT_AUTH_OID]),
    await SubjectKeyIdentifierExtension.create(csr.publicKey),
    await AuthorityKeyIdentifierExtension.create(ca.cert),
  ]
  const cert = await withUtcTimeEncoding(() =>
    X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${cn}`,
      issuer: ca.cert.subject,
      notBefore: backdatedNotBefore(now),
      notAfter,
      publicKey: csr.publicKey,
      signingKey: ca.privateKey,
      signingAlgorithm: MESH_SIGNING_ALGORITHM,
      extensions,
    }),
  )
  return { certPem: toCertPem(cert), serialNumber, notAfter, commonName: cn }
}

/** Issue a leaf for a known nodeID with a freshly generated key pair (tests / hub self). */
export async function issueMeshLeafForNode(
  ca: MeshCaSigner,
  nodeId: string,
  opts: { readonly now?: Date; readonly validDays?: number } = {},
): Promise<MeshLeafMaterial & { readonly keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(MESH_KEY_ALGORITHM, true, ['sign', 'verify'])
  const csr = await createMeshCsrPem(keys, nodeId)
  const leaf = await issueMeshLeafFromCsr(ca, csr, {
    expectedNodeId: nodeId,
    now: opts.now,
    validDays: opts.validDays,
    allowReserved: true,
  })
  return { ...leaf, keyPem: await exportKeyPem(keys.privateKey) }
}

export function subjectCn(subject: string): string | null {
  const match = /(?:^|,)\s*CN\s*=\s*([^,]+)/i.exec(subject)
  return match?.[1]?.trim() ?? null
}

export async function createMeshCsrPem(
  keys: WebCrypto.CryptoKeyPair,
  commonName: string,
): Promise<string> {
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: MESH_SIGNING_ALGORITHM,
  })
  return `${csr.toString('pem')}\n`
}

export async function generateMeshKeyPair(): Promise<WebCrypto.CryptoKeyPair> {
  return webcrypto.subtle.generateKey(MESH_KEY_ALGORITHM, true, ['sign', 'verify'])
}

export async function exportMeshPrivateKeyPem(key: WebCrypto.CryptoKey): Promise<string> {
  return exportKeyPem(key)
}
