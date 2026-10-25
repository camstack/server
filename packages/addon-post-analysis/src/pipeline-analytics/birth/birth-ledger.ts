/**
 * The birth-decision ledger record (D409): one durable row per resolved birth
 * verdict. Moved out of `pipeline-analytics/index.ts` verbatim (Plan B,
 * extraction 5): only the visibility of the entry point changed, and the
 * once-per-process "no ledger" flag moved with the only code that reads it.
 */
import type { AddonContext } from '@camstack/types'
import type { ConfirmationDecision } from '../confirmation-gate.js'
import type { SessionDetector } from '../confirmation-session-detector.js'
import type { FrameState } from '../frame/frame-state.js'
import { buildBirthDecisionRecord } from '../pipeline/birth-decision-record.js'
import type { BirthDecisionLedgerStore } from '../store/birth-decision-ledger-store.js'
import type { BirthLedgerDeps } from './birth-types.js'

export class BirthLedger {
  /** Has the "no ledger on this runner" warning already been said? Once per
   *  process: the condition is a property of the runner, not of the birth. */
  private birthLedgerAbsenceLogged = false

  constructor(private readonly deps: BirthLedgerDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  private get birthDecisionLedger(): BirthDecisionLedgerStore | null {
    return this.deps.birthDecisionLedger()
  }

  /**
   * Record ONE resolved birth verdict in the durable ledger (D409).
   *
   * Synchronous up to the append, which is fired and forgotten: the frame path
   * awaits `confirmTrackBirths` already, and a measurement must never add a
   * store round trip to the latency of a birth. `BirthDecisionLedgerStore.append`
   * never throws, so the un-awaited promise cannot reject.
   *
   * Cost, per BIRTH and not per frame: one `Map.get`, one `Set.has`, a counter
   * bump and one INSERT. Measured fleet-wide on the live hub 2026-09-08 at ~49
   * births/hour, i.e. 0.014 writes/s — three orders of magnitude below the
   * 12-19/s the runtime-state guard was written for, and a different shape
   * (append-only, never a periodic rewrite of an unchanged slice).
   *
   * A runner with no ledger (construction failed) records nothing and says so
   * exactly once per process, rather than per birth: a measurement that cannot
   * be taken must be visible, but it must not become the noisiest line in Loki.
   */
  recordBirthDecision(input: {
    deviceId: number
    trackId: string
    className: string
    confirmed: boolean
    exhaustedFallback: boolean
    attempts: number
    deferredForMs: number
    matchedThisFrame?: boolean
    birthEvidenceAvailable: boolean
    decision: ConfirmationDecision | undefined
    sessionDetector: SessionDetector | null
    decidedAtMs: number
    firstSeen: number | null
  }): void {
    const ledger = this.birthDecisionLedger
    if (ledger === null) {
      if (!this.birthLedgerAbsenceLogged) {
        this.birthLedgerAbsenceLogged = true
        this.ctx.logger.warn('birth decisions are NOT being measured — no ledger on this runner', {
          tags: { deviceId: input.deviceId },
        })
      }
      return
    }
    // The motion reference is read and the burst counter advanced TOGETHER, so
    // a row can never carry an onset without the index that qualifies it.
    const motionOnsetAtMs = this.frameState.motionOnsets.onsetFor(input.deviceId)
    const birthIndexInBurst = this.frameState.motionOnsets.noteBirth(input.deviceId)
    const decision = input.decision
    void ledger.append(
      buildBirthDecisionRecord({
        deviceId: input.deviceId,
        trackId: input.trackId,
        className: input.className,
        confirmed: input.confirmed,
        exhaustedFallback: input.exhaustedFallback,
        attempts: input.attempts,
        deferredForMs: input.deferredForMs,
        ...(input.matchedThisFrame !== undefined
          ? { matchedThisFrame: input.matchedThisFrame }
          : {}),
        birthEvidenceAvailable: input.birthEvidenceAvailable,
        // WHICH PIXELS decided it. `carried` is D379's birth-instant crop —
        // the only source that makes a coasted decision a real observation of
        // the instant the birth claims.
        decidedByBirthEvidence: decision?.cropSource === 'carried',
        // `null` when the gate is DISABLED and took no decision at all.
        reason: decision?.reason ?? null,
        bestScore: decision?.bestScore ?? null,
        appliedMinConfidence: decision?.appliedMinConfidence ?? null,
        // WHICH pixels the verdict was taken on — a suppression is always
        // `native` (D379); absent when no crop was judged (D922).
        cropSource: decision?.cropSource ?? null,
        // The detector the gate ASKED (D925): set when it judged a crop, or
        // when the session's detector could not be reached — never otherwise,
        // so a no-crop or native-pass row does not claim a re-detect.
        detector:
          decision !== undefined &&
          (decision.cropSource !== undefined || decision.reason === 'session-device-unavailable')
            ? (input.sessionDetector ?? null)
            : null,
        decidedAtMs: input.decidedAtMs,
        firstSeen: input.firstSeen,
        motionOnsetAtMs,
        birthIndexInBurst,
      }),
    )
  }
}
