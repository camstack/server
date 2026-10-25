/**
 * The try-climb's memory, carried across the close-and-recreate re-offer a
 * tier change is (D635, round 2).
 *
 * When there is no capacity evidence for the next rung — REMB is capped by the
 * rung we are on and the probe is missing or failed — the ladder may still
 * TRY the next rung on a clean path, and revert fast if the new rung does not
 * land. A tier change rebuilds the session and its controller, so the fact
 * "this rung is a trial, from `low`" and the backoff after a failed trial must
 * travel with the adaptive intent, like `failures` already does.
 */
import type { CamProfile } from '@camstack/types'

export interface TryClimbRevert {
  /** The rung that was tried and did not land. */
  readonly tier: CamProfile
  /** Its delivery ratio at the revert; null when the revert was a stall/loss with no ratio. */
  readonly deliveryRatio: number | null
  readonly stalled: boolean
  /** Epoch ms of the revert. */
  readonly at: number
}

export interface TryClimbCarry {
  /** Consecutive failed tries in this viewer session. A kept trial resets it. */
  readonly failures: number
  /** No new try before this, epoch ms. */
  readonly notBefore: number
  readonly lastRevert: TryClimbRevert | null
  /** Set while the current rung is a TRIAL: the rung to revert to. */
  readonly trialFrom: CamProfile | null
}

export const NO_TRY_HISTORY: TryClimbCarry = {
  failures: 0,
  notBefore: 0,
  lastRevert: null,
  trialFrom: null,
}

/** Backoff after the Nth consecutive failed try: base × 2^(N−1), capped. */
export function tryBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 0) return 0
  return Math.min(baseMs * 2 ** (failures - 1), maxMs)
}

export interface TrialConfig {
  /**
   * How long a tried rung must hold before it is kept. 20 000 ms: the change
   * blackout (8 s, ICE/DTLS on the re-offer) + one delivery window of a 4 s GOP
   * (6 s = three 2 s reports) + two evaluations to confirm a drop (4 s), plus
   * margin. "Within its first window", measured on the rungs this hub serves.
   */
  readonly trialMs: number
  /**
   * Hard end of a trial whose delivery was never measured although the client
   * reports (a window that never covered). 40 000 ms = 2 × `trialMs`.
   */
  readonly trialMaxMs: number
  /** Below this delivery ratio the tried rung is not landing. 0.9 — the climb ratio. */
  readonly trialRevertRatio: number
  /**
   * Consecutive measured evaluations below `trialRevertRatio` that revert. 2:
   * one window can be off by an IDR at its edge (`delivery-meter.ts`); two in
   * a row (4 s) is the rung, not the alignment.
   */
  readonly trialRevertConsecutive: number
}

export interface TrialInput {
  readonly deliveryRatio: number | null
  readonly clientReporting: boolean
  readonly stalled: boolean
  readonly lossFailing: boolean
}

export type TrialVerdict =
  | { readonly kind: 'running'; readonly forMs: number }
  | { readonly kind: 'kept' }
  | { readonly kind: 'revert'; readonly deliveryRatio: number | null; readonly stalled: boolean }

/** Watches one tried rung through its first window. Pure: fed, never reads a clock. */
export class TrialWatch {
  private startedAt: number | null = null
  private lowStreak = 0
  private measured = 0

  constructor(
    readonly from: CamProfile,
    private readonly config: TrialConfig,
  ) {}

  /**
   * Start the trial over: it must be judged afresh on live media. Called when
   * recorded playback takes the track (review m14) — time off live must never
   * count toward keeping a rung that was never measured.
   */
  restart(): void {
    this.startedAt = null
    this.lowStreak = 0
    this.measured = 0
  }

  judge(now: number, input: TrialInput): TrialVerdict {
    this.startedAt ??= now
    if (input.stalled || input.lossFailing) {
      return { kind: 'revert', deliveryRatio: input.deliveryRatio, stalled: input.stalled }
    }
    if (input.deliveryRatio !== null) {
      this.measured += 1
      this.lowStreak = input.deliveryRatio < this.config.trialRevertRatio ? this.lowStreak + 1 : 0
      if (this.lowStreak >= this.config.trialRevertConsecutive) {
        return { kind: 'revert', deliveryRatio: input.deliveryRatio, stalled: false }
      }
    }
    const forMs = now - this.startedAt
    // With no client telemetry there is nothing to measure: the stall and
    // loss paths are the only judges, and time alone ends the trial.
    const judged = this.measured >= this.config.trialRevertConsecutive || !input.clientReporting
    if ((forMs >= this.config.trialMs && judged) || forMs >= this.config.trialMaxMs) {
      return { kind: 'kept' }
    }
    return { kind: 'running', forMs }
  }
}

/**
 * The try-climb memory per DEVICE on this broker, with a TTL (review I4).
 * The per-session intent survives only a re-offer; without this, every new
 * viewer session of a camera whose next rung keeps failing started again at
 * try #1. The trial itself (`trialFrom`) never carries to a new session.
 */
export class DeviceTryMemory {
  private readonly entries = new Map<
    number,
    { readonly carry: TryClimbCarry; readonly at: number }
  >()

  /** @param ttlMs forget a device not refreshed for this long — 600 000 ms, the backoff cap. */
  constructor(private readonly ttlMs: number) {}

  set(deviceId: number, carry: TryClimbCarry, now: number): void {
    this.entries.set(deviceId, { carry, at: now })
  }

  get(deviceId: number, now: number): TryClimbCarry | null {
    const entry = this.entries.get(deviceId)
    if (entry === undefined) return null
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(deviceId)
      return null
    }
    return { ...entry.carry, trialFrom: null }
  }
}
