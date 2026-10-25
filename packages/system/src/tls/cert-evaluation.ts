/**
 * The regeneration rule (D227), as a pure function.
 *
 * `ensureTlsCert` reissues **only** when the material on disk cannot do
 * its job. Never because it is old, never because the machine picked up
 * an address the certificate does not need, never because a new build
 * shipped. The decision is a function of (files on disk, machine
 * identity, clock) alone, so the same inputs always produce the same
 * answer — which is what makes a reissue happen once and then stop.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { X509Certificate as PeculiarCertificate } from '@peculiar/x509'
import type { CertIdentity } from './cert-identity.js'
import { isConstrainedCa } from './cert-name-constraints.js'

/** OID `id-kp-serverAuth`. Apple's trustd requires it on the leaf. */
export const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'

/**
 * Apple's `SecPolicyCheckOtherTrustValidityPeriod` ceiling is 825 days;
 * the CA/Browser Forum's recommended maximum is 397. We sit at 397.
 */
export const MAX_LEAF_VALIDITY_DAYS = 397

/** Reissue this long before the leaf dies, so nobody serves an expired one. */
export const LEAF_RENEWAL_WINDOW_DAYS = 30

/** A local root outlives many leaves — it is the anchor an operator trusts. */
export const CA_VALIDITY_DAYS = 3650

/**
 * The CA must outlive any leaf it signs by a margin, or a leaf issued
 * today expires after its own issuer.
 */
export const CA_RENEWAL_WINDOW_DAYS: number = MAX_LEAF_VALIDITY_DAYS + LEAF_RENEWAL_WINDOW_DAYS

const MS_PER_DAY = 86_400_000

/**
 * Why a reissue is happening. Reported on `EnsureTlsResult` and logged
 * verbatim — an operator who trusted the old certificate by hand learns
 * from this string, not from a browser error.
 */
export type CertRegenerationReason =
  | 'missing'
  | 'unreadable'
  | 'no-local-ca'
  | 'ca-expiring'
  | 'ca-unconstrained'
  | 'key-mismatch'
  | 'expiring'
  | 'missing-server-auth-eku'
  | 'not-issued-by-local-ca'
  | 'validity-too-long'
  | 'san-coverage-gap'

export interface CertEvaluationInput {
  /** Contents of `camstack.crt` — leaf first, then the issuing CA. */
  readonly chainPem: string
  /** Contents of `camstack.key` — the leaf's private key. */
  readonly keyPem: string
  /** Contents of `camstack-ca.crt` — the local root. */
  readonly caPem: string
  readonly identity: CertIdentity
  readonly now: Date
}

/** Reasons that invalidate the root as well as the leaf. */
const REASONS_REQUIRING_NEW_CA: readonly CertRegenerationReason[] = [
  'missing',
  'unreadable',
  'no-local-ca',
  'ca-expiring',
  'ca-unconstrained',
]

export function reasonRequiresNewCa(reason: CertRegenerationReason): boolean {
  return REASONS_REQUIRING_NEW_CA.includes(reason)
}

function parse(pem: string): X509Certificate | null {
  try {
    return new X509Certificate(pem)
  } catch {
    return null
  }
}

/** A root without a CRITICAL name constraint (every pre-D873 install) can vouch for any site. */
function caIsUnconstrained(caPem: string): boolean {
  try {
    return !isConstrainedCa(new PeculiarCertificate(caPem))
  } catch {
    return true
  }
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY
}

function hasServerAuthEku(leaf: X509Certificate): boolean {
  // Node exposes the EXTENDED key usage OIDs under `keyUsage`; `undefined`
  // means the extension is absent altogether — the live-hub defect.
  const eku = leaf.keyUsage
  return eku !== undefined && eku.length === 1 && eku[0] === SERVER_AUTH_OID
}

function keyMatches(leaf: X509Certificate, keyPem: string): boolean {
  try {
    return leaf.checkPrivateKey(createPrivateKey(keyPem))
  } catch {
    return false
  }
}

function coversIdentity(leaf: X509Certificate, identity: CertIdentity): boolean {
  for (const name of identity.requiredDnsNames) {
    if (leaf.checkHost(name) === undefined) return false
  }
  for (const ip of identity.requiredIpAddresses) {
    if (leaf.checkIP(ip) === undefined) return false
  }
  return true
}

/**
 * `null` when the material on disk is fit to keep serving.
 *
 * Order matters only for the quality of the reported reason; any
 * non-null answer produces the same action.
 */
export function evaluateExistingCert(input: CertEvaluationInput): CertRegenerationReason | null {
  const leaf = parse(input.chainPem)
  const ca = parse(input.caPem)
  if (leaf === null || ca === null) return 'unreadable'

  if (daysBetween(input.now, new Date(ca.validTo)) < CA_RENEWAL_WINDOW_DAYS) return 'ca-expiring'
  if (caIsUnconstrained(input.caPem)) return 'ca-unconstrained'
  if (!keyMatches(leaf, input.keyPem)) return 'key-mismatch'
  if (daysBetween(input.now, new Date(leaf.validTo)) < LEAF_RENEWAL_WINDOW_DAYS) return 'expiring'
  if (!hasServerAuthEku(leaf)) return 'missing-server-auth-eku'

  // A self-signed `CA:TRUE` leaf is the pre-repair shape. It also makes
  // Conscrypt skip validation entirely when installed as an anchor.
  if (leaf.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
    return 'not-issued-by-local-ca'
  }

  const span = daysBetween(new Date(leaf.validFrom), new Date(leaf.validTo))
  if (span > MAX_LEAF_VALIDITY_DAYS + 1) return 'validity-too-long'

  // Asymmetric on purpose: a MISSING name is a fault, an EXTRA name is not.
  if (!coversIdentity(leaf, input.identity)) return 'san-coverage-gap'

  return null
}
