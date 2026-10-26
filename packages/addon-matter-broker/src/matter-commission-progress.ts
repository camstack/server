/**
 * Commissioning progress the admin UI polls, plus the named failures a share
 * code can produce. Pure — no matter.js import.
 *
 * Phases follow the on-network share path: discover the device, establish
 * PASE, then commission onto this fabric. A missing or malformed code never
 * becomes a later phase.
 */

export const CommissionPhase = {
  Idle: 'idle',
  Discovering: 'discovering',
  Pase: 'pase',
  Commissioning: 'commissioning',
  Done: 'done',
  Failed: 'failed',
} as const

export type CommissionPhase = (typeof CommissionPhase)[keyof typeof CommissionPhase]

export const CommissionFailureCode = {
  CodeExpired: 'code-expired',
  DeviceNotFound: 'device-not-found',
  WrongCode: 'wrong-code',
  InvalidCode: 'invalid-code',
  Unknown: 'unknown',
} as const

export type CommissionFailureCode =
  (typeof CommissionFailureCode)[keyof typeof CommissionFailureCode]

export interface CommissionProgress {
  readonly phase: CommissionPhase
  readonly failure: CommissionFailureCode | null
  readonly message: string | null
}

export const IDLE_COMMISSION_PROGRESS: CommissionProgress = {
  phase: CommissionPhase.Idle,
  failure: null,
  message: null,
}

/** Stable prefix the UI matches. The human text follows the colon. */
export function commissionFailureMessage(code: CommissionFailureCode, detail: string): string {
  return `matter-commission:${code}: ${detail}`
}

/**
 * Map a controller or matter.js error onto a named failure. Order matters:
 * an expired commissioning window is not "device not found", and a rejected
 * passcode is not a network miss.
 */
export function classifyCommissionError(message: string): CommissionFailureCode {
  const text = message.toLowerCase()
  if (text.includes('invalid pairing code') || text.includes('11 or 21')) {
    return CommissionFailureCode.InvalidCode
  }
  if (
    text.includes('expired') ||
    text.includes('commissioning window') ||
    text.includes('window closed')
  ) {
    return CommissionFailureCode.CodeExpired
  }
  if (
    text.includes('passcode') ||
    text.includes('wrong code') ||
    text.includes('pase') ||
    text.includes('authentication failed') ||
    text.includes('status 0x7e') ||
    text.includes('invalid code')
  ) {
    return CommissionFailureCode.WrongCode
  }
  if (
    text.includes('not found') ||
    text.includes('no device') ||
    text.includes('no commissionable') ||
    text.includes('discovery') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('unreachable')
  ) {
    return CommissionFailureCode.DeviceNotFound
  }
  return CommissionFailureCode.Unknown
}
