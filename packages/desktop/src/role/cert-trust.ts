/**
 * Viewer-role certificate trust: OS chain first, then trust-on-first-use on the
 * hub's ROOT, per hub, never a global bypass. See ADR-0402.
 *
 * The hub/agent roles append `ignore-certificate-errors`, which disables
 * verification for the whole process and pre-empts this hook entirely — that is
 * acceptable for a self-signed cert on loopback. The viewer talks to a hub over
 * the LAN, so it appends nothing and adjudicates here instead, on ITS OWN
 * session partition:
 *
 *   1. `net::OK` — the OS chain already trusts it (a real cert, a tunnel).
 *      Accept, no prompt, ever.
 *   2. Otherwise, compare the ISSUER's fingerprint against the pin stored for
 *      this hub. D227 makes the hub's local root stable across SAN drift and
 *      DHCP moves, so a matching pin is the same root the operator confirmed.
 *   3. No pin → reject, and the shell shows the trust page with the fingerprint
 *      to compare out of band. A MISMATCH against an existing pin → reject with
 *      a harder page: no one-click acceptance, re-pinning means clearing the
 *      hub entry.
 *
 * `decideCertificateTrust` is the whole policy and is pure — the Electron hook
 * below only extracts fields and maps the verdict onto a verify code.
 */
import type { Session } from 'electron'

/** Electron's `setCertificateVerifyProc` accept code. */
export const VERIFY_ACCEPT = 0
/** Electron's `setCertificateVerifyProc` reject code. */
export const VERIFY_REJECT = -2

/** Why a certificate was accepted or refused. Every value is logged. */
export type CertTrustReason = 'os-trust' | 'pinned-issuer' | 'no-pin' | 'pin-mismatch'

export interface CertTrustDecision {
  readonly accept: boolean
  readonly reason: CertTrustReason
}

export interface CertTrustInput {
  /** Chromium's own verdict, e.g. `net::OK` or `net::ERR_CERT_AUTHORITY_INVALID`. */
  readonly verificationResult: string
  /**
   * SHA-256 fingerprint of the ISSUER certificate presented by the server,
   * or null when the chain carried no issuer to inspect.
   */
  readonly issuerFingerprint: string | null
  /** The fingerprint this hub was pinned to, or null when never trusted. */
  readonly pinnedFingerprint: string | null
}

/**
 * The trust policy. Pure — no Electron, no store, no I/O.
 *
 * Note the ordering: OS trust wins before the pin is consulted, so a hub that
 * later gets a real certificate keeps working without the operator clearing an
 * obsolete pin.
 */
export function decideCertificateTrust(input: CertTrustInput): CertTrustDecision {
  if (input.verificationResult === 'net::OK') {
    return { accept: true, reason: 'os-trust' }
  }
  if (input.pinnedFingerprint === null) {
    return { accept: false, reason: 'no-pin' }
  }
  if (input.issuerFingerprint !== null && input.issuerFingerprint === input.pinnedFingerprint) {
    return { accept: true, reason: 'pinned-issuer' }
  }
  return { accept: false, reason: 'pin-mismatch' }
}

/** What the shell needs to know about a refusal, to render the trust page. */
export interface CertTrustRejection {
  readonly hostname: string
  readonly reason: CertTrustReason
  /** The fingerprint the server actually presented — shown for comparison. */
  readonly issuerFingerprint: string | null
  readonly leafSubjectName: string
  readonly leafIssuerName: string
  readonly validStart: number
  readonly validExpiry: number
  readonly verificationResult: string
}

export interface CertTrustHooks {
  /** The pin for the ACTIVE hub, read fresh on every verification. */
  readonly pinnedFingerprint: () => string | null
  /** Called for every verdict — trust decisions are never silent. */
  readonly onDecision: (
    decision: CertTrustDecision,
    hostname: string,
    verificationResult: string,
  ) => void
  /** Called only on a refusal, with everything the trust page needs. */
  readonly onRejected: (rejection: CertTrustRejection) => void
}

/**
 * Install the policy on a session partition. Applies to that partition only —
 * the viewer's, never the default session.
 */
export function installCertificateTrust(session: Session, hooks: CertTrustHooks): void {
  session.setCertificateVerifyProc((request, callback) => {
    const issuerCert = request.certificate.issuerCert ?? null
    const issuerFingerprint = issuerCert?.fingerprint ?? null
    const decision = decideCertificateTrust({
      verificationResult: request.verificationResult,
      issuerFingerprint,
      pinnedFingerprint: hooks.pinnedFingerprint(),
    })
    hooks.onDecision(decision, request.hostname, request.verificationResult)
    if (!decision.accept) {
      hooks.onRejected({
        hostname: request.hostname,
        reason: decision.reason,
        issuerFingerprint,
        leafSubjectName: request.certificate.subjectName,
        leafIssuerName: request.certificate.issuerName,
        validStart: request.certificate.validStart,
        validExpiry: request.certificate.validExpiry,
        verificationResult: request.verificationResult,
      })
    }
    callback(decision.accept ? VERIFY_ACCEPT : VERIFY_REJECT)
  })
}
