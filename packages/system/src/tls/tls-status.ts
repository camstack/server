import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate as PeculiarCertificate } from '@peculiar/x509'
import { isConstrainedCa } from './cert-name-constraints.js'
import { chainsToPublicRoot } from './uploaded-cert.js'

export type TlsMode = 'generated' | 'uploaded' | 'disabled'

/** An uploaded certificate kept on disk (D873): selectable again after "Revert to generated". */
export interface StoredUploadInfo {
  readonly leafFingerprintSha256: string
  readonly validTo: string
  /** Whether a CA that signed it is kept with it. */
  readonly hasCa: boolean
}

export interface TlsAccessStatus {
  readonly mode: TlsMode
  readonly leafFingerprintSha256: string | null
  readonly caFingerprintSha256: string | null
  readonly validTo: string | null
  readonly sans: readonly string[]
  readonly caCertPem: string | null
  readonly reissueError: string | null
  readonly restartRequired: boolean
  /**
   * An uploaded certificate is served but no CA that signed it is kept and the chain does
   * not lead to a public CA: "Download CA" has nothing to hand out, so devices cannot be
   * made to trust the hub (D873). `false` otherwise.
   */
  readonly caMissing: boolean
  /** Does the hub's own generated CA carry a critical name constraint? `null` while it has no CA. */
  readonly localCaConstrained: boolean | null
  /** ISO time the generated CA was replaced by a constrained one; devices must re-trust it. */
  readonly caReplacedAt: string | null
  /** The uploaded certificate kept on disk, whether or not it is the one served. */
  readonly storedUpload: StoredUploadInfo | null
}

function tlsDir(dataDir: string): string {
  return join(dataDir, 'tls')
}

export function readTlsMode(dataDir: string): TlsMode {
  const marker = join(tlsDir(dataDir), 'mode')
  if (existsSync(marker)) {
    const raw = readFileSync(marker, 'utf-8').trim()
    if (raw === 'uploaded') return 'uploaded'
    if (raw === 'disabled') return 'disabled'
  }
  const certPath = join(tlsDir(dataDir), 'camstack.crt')
  return existsSync(certPath) ? 'generated' : 'disabled'
}

export function writeTlsMode(dataDir: string, mode: TlsMode): void {
  mkdirSync(tlsDir(dataDir), { recursive: true })
  writeFileSync(join(tlsDir(dataDir), 'mode'), `${mode}\n`, 'utf-8')
}

export function readExtraSans(dataDir: string): readonly string[] {
  const path = join(tlsDir(dataDir), 'extra-sans.json')
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

export function writeExtraSans(dataDir: string, sans: readonly string[]): void {
  mkdirSync(tlsDir(dataDir), { recursive: true })
  writeFileSync(join(tlsDir(dataDir), 'extra-sans.json'), `${JSON.stringify(sans)}\n`, 'utf-8')
}

/** The kept copy of the last upload: the chain and key as the operator supplied them. */
export const STORED_UPLOAD_CERT_FILE = 'uploaded.crt'
export const STORED_UPLOAD_KEY_FILE = 'uploaded.key'
const CA_REPLACED_MARKER_FILE = 'ca-replaced.json'

function readStoredUpload(dir: string): StoredUploadInfo | null {
  const certPath = join(dir, STORED_UPLOAD_CERT_FILE)
  if (!existsSync(certPath) || !existsSync(join(dir, STORED_UPLOAD_KEY_FILE))) return null
  try {
    const leaf = new X509Certificate(readFileSync(certPath, 'utf-8'))
    return {
      leafFingerprintSha256: leaf.fingerprint256,
      validTo: new Date(leaf.validTo).toISOString(),
      hasCa: existsSync(join(dir, UPLOADED_CA_FILE)),
    }
  } catch {
    return null
  }
}

function readLocalCaConstrained(dir: string): boolean | null {
  const caPath = join(dir, 'camstack-ca.crt')
  if (!existsSync(caPath)) return null
  try {
    return isConstrainedCa(new PeculiarCertificate(readFileSync(caPath, 'utf-8')))
  } catch {
    return null
  }
}

function readCaReplacedAt(dir: string): string | null {
  const path = join(dir, CA_REPLACED_MARKER_FILE)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const at: unknown =
      parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'replacedAt') : null
    return typeof at === 'string' ? at : null
  } catch {
    return null
  }
}

/** Where an upload's own CA is kept — never over the local CA's `camstack-ca.crt`. */
export const UPLOADED_CA_FILE = 'uploaded-ca.crt'

interface IssuerCert {
  readonly pem: string
  readonly cert: X509Certificate
}

/** Every certificate in a PEM bundle, in order. */
export function splitPemCertificates(pem: string): readonly string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  return blocks === null ? [] : blocks.map((block) => `${block}\n`)
}

/**
 * The certificate that signed `leaf`, from the upload itself: the CA the
 * operator supplied, else the rest of the uploaded chain. `null` when the
 * upload did not include it — and then nothing may stand in for it: the
 * local CA did not sign an uploaded leaf, so handing it out as "the CA" would
 * tell a client to trust a root that verifies nothing it is served.
 */
function uploadedIssuer(dir: string, leaf: X509Certificate, chainPem: string): IssuerCert | null {
  const caPath = join(dir, UPLOADED_CA_FILE)
  const candidates = [
    ...(existsSync(caPath) ? splitPemCertificates(readFileSync(caPath, 'utf-8')) : []),
    ...splitPemCertificates(chainPem).slice(1),
  ]
  for (const pem of candidates) {
    try {
      const cert = new X509Certificate(pem)
      if (leaf.checkIssued(cert) && leaf.verify(cert.publicKey)) return { pem, cert }
    } catch {
      // An unreadable candidate is simply not the issuer.
    }
  }
  return null
}

function generatedIssuer(dir: string): IssuerCert | null {
  const caPath = join(dir, 'camstack-ca.crt')
  if (!existsSync(caPath)) return null
  const pem = readFileSync(caPath, 'utf-8')
  return { pem, cert: new X509Certificate(pem) }
}

/**
 * What the node's certificate is, and whether the listener serves it.
 * `servedLeafFingerprint` is the leaf the HTTPS listener presents right now
 * (`servedHttpsLeafFingerprint()`), or `null` when unknown; a restart is
 * required exactly when the listener serves a different leaf than the one
 * on disk — a measured fact, not a flag a mutation remembered to set.
 */
export function readTlsAccessStatus(
  dataDir: string,
  servedLeafFingerprint: string | null,
): TlsAccessStatus {
  const dir = tlsDir(dataDir)
  const certPath = join(dir, 'camstack.crt')
  const mode = readTlsMode(dataDir)
  if (!existsSync(certPath)) {
    const ca = mode === 'uploaded' ? null : generatedIssuer(dir)
    return {
      mode: 'disabled',
      leafFingerprintSha256: null,
      caFingerprintSha256: null,
      validTo: null,
      sans: [],
      caCertPem: ca?.pem ?? null,
      reissueError: null,
      restartRequired: false,
      caMissing: false,
      localCaConstrained: readLocalCaConstrained(dir),
      caReplacedAt: readCaReplacedAt(dir),
      storedUpload: readStoredUpload(dir),
    }
  }
  try {
    const chainPem = readFileSync(certPath, 'utf-8')
    const leaf = new X509Certificate(chainPem)
    const ca = mode === 'uploaded' ? uploadedIssuer(dir, leaf, chainPem) : generatedIssuer(dir)
    const san = leaf.subjectAltName ?? ''
    return {
      mode,
      leafFingerprintSha256: leaf.fingerprint256,
      caFingerprintSha256: ca?.cert.fingerprint256 ?? null,
      validTo: new Date(leaf.validTo).toISOString(),
      sans: san === '' ? [] : san.split(', '),
      caCertPem: ca?.pem ?? null,
      reissueError: null,
      restartRequired:
        servedLeafFingerprint !== null && servedLeafFingerprint !== leaf.fingerprint256,
      caMissing: mode === 'uploaded' && ca === null && !chainsToPublicRoot(chainPem),
      localCaConstrained: readLocalCaConstrained(dir),
      caReplacedAt: readCaReplacedAt(dir),
      storedUpload: readStoredUpload(dir),
    }
  } catch {
    return {
      mode,
      leafFingerprintSha256: null,
      caFingerprintSha256: null,
      validTo: null,
      sans: [],
      caCertPem: null,
      reissueError: 'Certificate on disk could not be parsed.',
      restartRequired: false,
      caMissing: false,
      localCaConstrained: readLocalCaConstrained(dir),
      caReplacedAt: readCaReplacedAt(dir),
      storedUpload: readStoredUpload(dir),
    }
  }
}
