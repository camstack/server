/**
 * How far a freshly issued certificate's `notBefore` is moved into the past.
 *
 * TLS refuses a certificate whose `notBefore` is in the verifier's future, and X.509 dates have
 * one-second resolution, so a certificate dated "now" fails the handshake on any peer whose clock
 * runs even slightly behind the issuer's. Expiry is always computed from the real `now`; only the
 * start of validity moves.
 */
export const CERT_NOT_BEFORE_BACKDATE_MS: number = 5 * 60_000

export function backdatedNotBefore(now: Date): Date {
  return new Date(now.getTime() - CERT_NOT_BEFORE_BACKDATE_MS)
}
