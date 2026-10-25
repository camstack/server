/**
 * The agent's pairing endpoints as the UI sees them (D857). Types mirror
 * `AgentPairingPublicView` / `AgentPairingLocalView` in
 * `packages/system/src/kernel/moleculer/mesh-mtls/pairing/agent-pairing.ts`.
 *
 * `pairing/status` answers two shapes: from the network a pending pairing is
 * who asks and until when; from this machine (genuine loopback) it also carries
 * the pairing id, the one-time PIN and the agent's own code. The UI never shows
 * or prefills that code: the operator types what the HUB shows.
 */
import { authHeaders, fetchJson } from './api-client'
import { translate } from './i18n'

export const PAIRING_STATUS_PATH = '/api/agent/pairing/status'
export const PAIRING_CONFIRM_PATH = '/api/agent/pairing/confirm'
export const PAIRING_REJECT_PATH = '/api/agent/pairing/reject'
export const PAIRING_RESET_PATH = '/api/agent/pairing/reset'
export const PAIRING_FORGET_PATH = '/api/agent/pairing/forget'

/** Digits of the code the hub shows (`PAIRING_CODE_DIGITS`). */
export const PAIRING_CODE_DIGITS = 6
/** Digits of the one-time local PIN (`PAIRING_PIN_DIGITS`). */
export const PAIRING_PIN_DIGITS = 8

export type PairingState = 'unpaired' | 'pending' | 'paired'

export interface PendingPairing {
  readonly hub: {
    readonly nodeId: string
    readonly url: string
    readonly caFingerprint: string
  }
  readonly expiresAt: number
  /** Loopback view only. */
  readonly pairingId?: string
  /** Loopback view only: the single-use local PIN. */
  readonly pin?: string
  /** Loopback view only: whether the operator already confirmed here. */
  readonly localConfirmed?: boolean
}

export interface PairingStatusView {
  readonly state: PairingState
  readonly pending: readonly PendingPairing[]
}

/** What a failed `confirm` / `reject` / `reset` / `forget` says. */
export interface PairingFailureBody {
  readonly ok: false
  readonly error?: string
  readonly message?: string
  readonly retryAfterMs?: number
}

export interface PairingOk {
  readonly ok: true
}

export type PairingOutcome = PairingOk | PairingFailureBody

export function fetchPairingStatus(): Promise<PairingStatusView> {
  return fetchJson<PairingStatusView>(PAIRING_STATUS_PATH)
}

/** The local view carries a PIN per pending pairing; the public one never does. */
export function isLoopbackView(pending: readonly PendingPairing[]): boolean {
  return pending.some((p) => typeof p.pin === 'string')
}

/** True when the page itself is served from this machine. */
export function pageIsLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function isPairingOutcome(value: unknown): value is PairingOutcome {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'ok') === 'boolean'
  )
}

/**
 * POST a pairing action. Not `postJson`: the pairing endpoints answer 401 for a
 * wrong PIN or reset code, which is an answer to show, not a locked dashboard.
 */
export async function sendPairing(
  path: string,
  body: Record<string, unknown>,
): Promise<PairingOutcome> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    const parsed: unknown = await res.json().catch(() => null)
    if (isPairingOutcome(parsed)) return parsed
    return res.ok
      ? { ok: true }
      : { ok: false, message: translate('pairingApi.httpStatus', { status: res.status }) }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : translate('pairingApi.requestFailed'),
    }
  }
}

export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 90) return `${seconds} s`
  return `${Math.ceil(seconds / 60)} min`
}

/** One sentence for a refused request, with the wait when the server rationed it. */
export function describeFailure(failure: PairingFailureBody): string {
  const base = failure.message ?? failure.error ?? translate('pairingApi.refused')
  if (failure.retryAfterMs === undefined) return base
  return translate('pairingApi.retryIn', { message: base, wait: formatWait(failure.retryAfterMs) })
}

/** `m:ss` left until `expiresAt`, never negative. */
export function formatCountdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const mm = Math.floor(left / 60)
  const ss = String(left % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** Groups of four, as the hub prints a fingerprint. */
export function groupFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(.{4})/g, '$1 ').trim()
}
