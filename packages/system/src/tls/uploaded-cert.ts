import { createPrivateKey, X509Certificate } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { SERVER_AUTH_OID } from './cert-evaluation.js'

/** Stable codes of the `server` i18n catalog (D863); the English text always travels beside them. */
export type UploadedTlsErrorCode =
  | 'tls.cert-unparsable'
  | 'tls.key-unparsable'
  | 'tls.key-mismatch'
  | 'tls.missing-server-auth'
  | 'tls.ca-required'
  | 'tls.ca-unparsable'
  | 'tls.ca-not-issuer'
  | 'tls.ca-not-a-ca'
  | 'tls.ca-expired'

export interface UploadedTlsFailure {
  readonly ok: false
  readonly code: UploadedTlsErrorCode
  /** English text; the hub translates by `code`. */
  readonly error: string
}

export type UploadedTlsValidation =
  | { readonly ok: true; readonly fingerprintSha256: string; readonly validTo: string }
  | UploadedTlsFailure

const MESSAGES: Readonly<Record<UploadedTlsErrorCode, string>> = {
  'tls.cert-unparsable': 'Certificate PEM could not be parsed.',
  'tls.key-unparsable': 'Private key PEM could not be parsed.',
  'tls.key-mismatch': 'Private key does not match the certificate.',
  'tls.missing-server-auth': 'Certificate is missing extendedKeyUsage = serverAuth.',
  'tls.ca-required':
    'This certificate was not issued by a public certificate authority, so its CA certificate is required: devices need it to trust the hub. Paste the CA certificate (for mkcert, the rootCA.pem in the folder `mkcert -CAROOT` prints).',
  'tls.ca-unparsable': 'The CA certificate could not be parsed.',
  'tls.ca-not-issuer': 'The certificate was not issued by the CA certificate you supplied.',
  'tls.ca-not-a-ca':
    'The supplied CA certificate is not a certificate authority (CA:TRUE is missing).',
  'tls.ca-expired': 'The supplied CA certificate has expired or is not valid yet.',
}

function failure(code: UploadedTlsErrorCode): UploadedTlsFailure {
  return { ok: false, code, error: MESSAGES[code] }
}

/**
 * Operator-supplied material must parse, match its key, and carry
 * `extendedKeyUsage = serverAuth` — the same leaf defects D227 refused
 * to keep generating.
 */
export function validateUploadedTls(certPem: string, keyPem: string): UploadedTlsValidation {
  let leaf: X509Certificate
  try {
    leaf = new X509Certificate(certPem)
  } catch {
    return failure('tls.cert-unparsable')
  }
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) return failure('tls.key-mismatch')
  } catch {
    return failure('tls.key-unparsable')
  }
  const eku = leaf.keyUsage
  if (eku === undefined || !eku.includes(SERVER_AUTH_OID)) {
    return failure('tls.missing-server-auth')
  }
  return {
    ok: true,
    fingerprintSha256: leaf.fingerprint256,
    validTo: new Date(leaf.validTo).toISOString(),
  }
}

/** Every certificate in a PEM bundle, in order. */
export function pemCertificates(pem: string): readonly string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  return blocks === null ? [] : blocks.map((block) => `${block}\n`)
}

function parseAll(pems: readonly string[]): readonly X509Certificate[] {
  const parsed: X509Certificate[] = []
  for (const pem of pems) {
    try {
      parsed.push(new X509Certificate(pem))
    } catch {
      // An unreadable block is simply not a candidate.
    }
  }
  return parsed
}

function issuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey)
  } catch {
    return false
  }
}

let defaultPublicRoots: readonly X509Certificate[] | undefined

/** The trust anchors of public CAs that ship with Node. */
export function publicRootCertificates(): readonly X509Certificate[] {
  defaultPublicRoots ??= parseAll(rootCertificates)
  return defaultPublicRoots
}

/**
 * True when the served chain leads to a public CA that clients already trust:
 * the leaf, or one of the chain's own certificates, is signed by a public root.
 * Such a certificate needs nothing installed on a device, so no CA is required.
 */
export function chainsToPublicRoot(
  chainPem: string,
  roots: readonly X509Certificate[] = publicRootCertificates(),
): boolean {
  const [leaf, ...rest] = parseAll(pemCertificates(chainPem))
  if (leaf === undefined) return false
  let current = leaf
  const pool = [...rest]
  for (let depth = 0; depth < 8; depth += 1) {
    if (roots.some((root) => issuedBy(current, root))) return true
    const next = pool.find((candidate) => candidate !== current && issuedBy(current, candidate))
    if (next === undefined) return false
    pool.splice(pool.indexOf(next), 1)
    current = next
  }
  return false
}

export type UploadedCaCheck =
  | {
      readonly ok: true
      /** The CA that signed the leaf, to be kept for "Download CA"; `null` for a public chain with none supplied. */
      readonly issuerPem: string | null
      readonly publicChain: boolean
    }
  | UploadedTlsFailure

/** Is `cert` a usable CA at `now`? */
function caProblem(cert: X509Certificate, now: Date): UploadedTlsErrorCode | null {
  if (!cert.ca) return 'tls.ca-not-a-ca'
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return 'tls.ca-expired'
  return null
}

/**
 * The CA rule for an upload (D873). A CA the operator supplies must parse, be a CA, be in
 * date and actually have signed the leaf. Without one, the upload is accepted only when
 * its own chain carries the issuer or leads to a public root; anything else is refused,
 * because a device cannot be told to trust a certificate nobody can hand it the CA of.
 */
export function checkUploadedCa(
  chainPem: string,
  caPem: string | undefined,
  options?: { readonly now?: Date; readonly publicRoots?: readonly X509Certificate[] },
): UploadedCaCheck {
  const now = options?.now ?? new Date()
  const [leaf, ...chainRest] = parseAll(pemCertificates(chainPem))
  if (leaf === undefined) return failure('tls.cert-unparsable')

  const supplied = caPem !== undefined && caPem.trim() !== ''
  if (supplied) {
    const candidates = parseAll(pemCertificates(caPem))
    if (candidates.length === 0) return failure('tls.ca-unparsable')
    return pickIssuer(leaf, candidates, now, chainPem, options?.publicRoots)
  }

  const fromChain = chainRest.filter((cert) => issuedBy(leaf, cert))
  if (fromChain.length > 0) return pickIssuer(leaf, fromChain, now, chainPem, options?.publicRoots)
  if (chainsToPublicRoot(chainPem, options?.publicRoots)) {
    return { ok: true, issuerPem: null, publicChain: true }
  }
  return failure('tls.ca-required')
}

function pickIssuer(
  leaf: X509Certificate,
  candidates: readonly X509Certificate[],
  now: Date,
  chainPem: string,
  publicRoots: readonly X509Certificate[] | undefined,
): UploadedCaCheck {
  const signers = candidates.filter((candidate) => issuedBy(leaf, candidate))
  if (signers.length === 0) return failure('tls.ca-not-issuer')
  let firstProblem: UploadedTlsErrorCode | null = null
  for (const signer of signers) {
    const problem = caProblem(signer, now)
    if (problem === null) {
      return {
        ok: true,
        issuerPem: `${signer.toString().trimEnd()}\n`,
        publicChain: chainsToPublicRoot(chainPem, publicRoots),
      }
    }
    firstProblem ??= problem
  }
  return failure(firstProblem ?? 'tls.ca-not-issuer')
}
