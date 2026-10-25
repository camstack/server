/**
 * Pure model for System → Nodes → "Agents found on the network" (D857).
 *
 * Types are derived from the generated client, never restated. Everything here
 * is a function of the answered data: the dialog phase, the countdown and the
 * labels. Nothing is guessed while a query is still pending (D315).
 */
import type { AddonApi } from '@camstack/types'

type PairingApi = AddonApi['agentPairing']

export type DiscoveredAgent = Awaited<
  ReturnType<PairingApi['listDiscoveredAgents']['query']>
>['agents'][number]

export type PairingView = Awaited<ReturnType<PairingApi['getPairing']['query']>>

export type AgentPairState = DiscoveredAgent['state']

export type PairingStatus = PairingView['state']

export const AGENT_STATE_LABEL: Readonly<Record<AgentPairState, string>> = {
  unpaired: 'Not paired',
  pending: 'Pairing…',
  paired: 'Paired',
}

/** The code the operator types is exactly six digits. */
export const PAIRING_CODE_LENGTH = 6

const TERMINAL: ReadonlySet<PairingStatus> = new Set(['paired', 'rejected', 'failed', 'expired'])

export function isTerminalPairing(state: PairingStatus): boolean {
  return TERMINAL.has(state)
}

/** Digits only, capped at six: what the confirm input is allowed to hold. */
export function sanitizeCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH)
}

export function isCompleteCode(code: string): boolean {
  return code.length === PAIRING_CODE_LENGTH
}

/** `m:ss` left until `expiresAt` (never negative). */
export function formatCountdown(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `host:port`, bracketing IPv6. */
export function formatEndpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/** Shortened certificate fingerprint for a table cell; the full value is the title. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.length <= 23 ? fingerprint : `${fingerprint.slice(0, 20)}…`
}

export type PairingPhase =
  | 'sending'
  | 'send-failed'
  | 'awaiting-both'
  | 'awaiting-agent'
  | 'awaiting-hub'
  | 'completing'
  | 'paired'
  | 'rejected'
  | 'failed'
  | 'expired'

export interface PhaseInput {
  readonly view: PairingView | null
  readonly beginError: string | null
}

/** Which step the dialog is on. `view === null` means the offer is still going out. */
export function pairingPhase({ view, beginError }: PhaseInput): PairingPhase {
  if (view === null) return beginError === null ? 'sending' : 'send-failed'
  switch (view.state) {
    case 'paired':
      return 'paired'
    case 'rejected':
      return 'rejected'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'completing':
      return 'completing'
    case 'awaiting-confirmation':
      if (view.hubConfirmed && !view.agentConfirmed) return 'awaiting-agent'
      if (view.agentConfirmed && !view.hubConfirmed) return 'awaiting-hub'
      return 'awaiting-both'
  }
}

/** The phases in which the operator may still type a code and confirm. */
export function canConfirm(phase: PairingPhase): boolean {
  return phase === 'awaiting-both' || phase === 'awaiting-hub'
}

export const PHASE_HEADLINE: Readonly<Record<PairingPhase, string>> = {
  sending: 'Sending the pairing offer to the agent…',
  'send-failed': 'The agent could not be reached',
  'awaiting-both': 'Waiting for both confirmations',
  'awaiting-agent': 'Confirmed here — waiting for the agent',
  'awaiting-hub': 'The agent is confirmed — now confirm here',
  completing: 'Issuing the node certificate…',
  paired: 'Paired',
  rejected: 'Pairing was rejected',
  failed: 'Pairing failed',
  expired: 'The pairing expired',
}
