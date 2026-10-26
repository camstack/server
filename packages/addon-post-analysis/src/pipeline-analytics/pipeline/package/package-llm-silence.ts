/**
 * One open "package confirm is not answering" edge per camera (D931).
 *
 * A single timeout is the call's bound doing its job. Three uncertain confirms
 * in a row, with no yes and no no between them, is the provider not answering
 * — the shape camera 615 showed on 2026-10-26 (nine timeouts, zero answers).
 * A time window would also count a timeout that a later answer already closed.
 * The streak resets on any answer. A further uncertain while the edge is
 * open does not raise again.
 */

/** Consecutive uncertain confirms before the silence edge opens. */
export const PACKAGE_LLM_SILENCE_STREAK = 3

export type PackageLlmSilenceReason = 'timeout' | 'error'

/** Why this confirm produced no verdict. `timeout` is the only alert reason of its own. */
export type PackageLlmUncertainDetail =
  | 'timeout'
  | 'unreachable'
  | 'unparseable'
  | 'no-image'
  | 'unwired'

export function packageLlmAlertReason(detail: PackageLlmUncertainDetail): PackageLlmSilenceReason {
  return detail === 'timeout' ? 'timeout' : 'error'
}

export interface PackageLlmSilenceNote {
  readonly deviceId: number
  readonly reason: PackageLlmSilenceReason
  readonly detail: PackageLlmUncertainDetail
  readonly latencyMs: number
}

export type PackageLlmSilenceEdge =
  | { readonly phase: 'silent'; readonly note: PackageLlmSilenceNote }
  | { readonly phase: 'answered'; readonly deviceId: number }

export class PackageLlmSilence {
  private readonly streak = new Map<number, number>()
  private readonly open = new Set<number>()

  noteUncertain(note: PackageLlmSilenceNote): PackageLlmSilenceEdge | null {
    const next = (this.streak.get(note.deviceId) ?? 0) + 1
    this.streak.set(note.deviceId, next)
    if (next < PACKAGE_LLM_SILENCE_STREAK || this.open.has(note.deviceId)) return null
    this.open.add(note.deviceId)
    return { phase: 'silent', note }
  }

  noteAnswered(deviceId: number): PackageLlmSilenceEdge | null {
    this.streak.set(deviceId, 0)
    if (!this.open.has(deviceId)) return null
    this.open.delete(deviceId)
    return { phase: 'answered', deviceId }
  }

  forget(deviceId: number): void {
    this.streak.delete(deviceId)
    this.open.delete(deviceId)
  }
}
