/**
 * Pure pairing-code parsing + validation for Matter commissioning. No matter.js
 * import — the actual `commissionNode` call lives behind {@link MatterController};
 * this module only validates/normalises the operator-entered code so the addon
 * fails fast on a malformed code BEFORE touching the controller.
 *
 * Matter supports two onboarding payload forms:
 *  - a QR payload string beginning `MT:` (base-38 encoded);
 *  - an 11-digit (or 21-digit with vendor/product) manual pairing code.
 *
 * Full decoding of either is the controller's job (matter.js has a parser). Here
 * we only classify + sanity-check so the UI can reject obvious garbage.
 */

export type PairingCodeKind = 'qr' | 'manual'

export interface ParsedPairingCode {
  readonly kind: PairingCodeKind
  /** The normalised code to hand to the controller (trimmed; digits-only for manual). */
  readonly normalized: string
}

/** A clear validation error for a malformed pairing code. */
export class InvalidPairingCodeError extends Error {
  constructor(message: string) {
    super(`matter-broker: invalid pairing code — ${message}`)
    this.name = 'InvalidPairingCodeError'
  }
}

/**
 * Classify + normalise an operator-entered pairing code. Throws
 * {@link InvalidPairingCodeError} on an empty / unrecognisable code.
 *
 * - `MT:`-prefixed → QR payload (kept verbatim, uppercased).
 * - otherwise → strip non-digits and require 11 or 21 digits (the manual code
 *   lengths defined by the Matter spec).
 */
export function parsePairingCode(raw: string): ParsedPairingCode {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new InvalidPairingCodeError('empty code')
  }
  if (trimmed.toUpperCase().startsWith('MT:')) {
    return { kind: 'qr', normalized: trimmed.toUpperCase() }
  }
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length !== 11 && digits.length !== 21) {
    throw new InvalidPairingCodeError(`manual code must be 11 or 21 digits (got ${digits.length})`)
  }
  return { kind: 'manual', normalized: digits }
}

/** True when a code parses cleanly (no throw). Convenience for `testSettings`. */
export function isValidPairingCode(raw: string): boolean {
  try {
    parsePairingCode(raw)
    return true
  } catch {
    return false
  }
}
