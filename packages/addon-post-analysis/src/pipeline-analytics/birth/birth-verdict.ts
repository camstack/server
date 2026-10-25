/**
 * One birth candidate's verdict on the frame path (D377, D409, D922): the
 * deferral of an undecided birth, the late-verdict guards, the ledger row,
 * and the suppression — retraction, or a held suppression with its judged
 * crop. Moved out of `pipeline-analytics/index.ts` verbatim (Plan B,
 * extraction 5): the body of the verdict loop in `processFrame` became
 * `resolve`, and each `continue` a `return false`. `true` means the birth
 * proceeds to the start ritual, which stays in `processFrame`.
 */
import type { DebugCropCaptureInput } from '../pipeline/debug-crop-capture.js'
import { suppressionMayRetract } from '../pipeline/onboard-birth-authority.js'
import type { FrameState } from '../frame/frame-state.js'
import type { MediaStore } from '../store/media-store.js'
import type { TrackStore } from '../store/track-store.js'
import type { BirthLedger } from './birth-ledger.js'
import type { BirthVerdictDeps, BirthVerdictInput } from './birth-types.js'

export class BirthVerdict {
  constructor(private readonly deps: BirthVerdictDeps) {}

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get mediaStore(): MediaStore | null {
    return this.deps.mediaStore()
  }

  private get birthLedger(): BirthLedger {
    return this.deps.birthLedger()
  }

  private offerDebugCrop(input: DebugCropCaptureInput): void {
    this.deps.offerDebugCrop(input)
  }

  private clearLiveTrackState(deviceId: number, trackId: string): void {
    this.deps.clearLiveTrackState(deviceId, trackId)
  }

  /** `false` when the candidate is NOT born on this frame. */
  resolve(input: BirthVerdictInput): boolean {
    const {
      id,
      t,
      deviceId,
      source,
      key,
      log,
      frameHandle,
      result,
      processor,
      outcome,
      run,
      exhaustedIds,
      withBirthEvidence,
      sessionDetector,
      gateNowMs,
    } = input
    // ── Verdict 3: UNDECIDED — the gate could not measure this birth. ──
    //
    // The track stays PROVISIONAL: the in-RAM upsert above stands, and
    // nothing else runs. `dropActive` removes only the in-RAM entry
    // (persistence happens at track CLOSE), so a provisional birth retracted
    // before close was never written anywhere — but media rows are keyed by
    // trackId and would OUTLIVE the retraction, which is exactly why the
    // birth ritual below waits for a real verdict.
    if (outcome.undecided.has(id)) {
      this.frameState.deferredBirths.defer(key, id, gateNowMs)
      log.info('birth undecided — deferred for another look', {
        meta: {
          trackId: id,
          className: t.className,
          attempts: this.frameState.deferredBirths.attemptsFor(key, id),
          elapsedMs: this.frameState.deferredBirths.elapsedMs(key, id, gateNowMs),
          source,
        },
      })
      return false
    }

    // A verdict arrived — this id is no longer waiting for one.
    const wasDeferred = this.frameState.deferredBirths.isDeferred(key, id)
    const deferredForMs = this.frameState.deferredBirths.elapsedMs(key, id, gateNowMs)
    const deferredAttempts = this.frameState.deferredBirths.attemptsFor(key, id)
    this.frameState.deferredBirths.resolve(key, id)
    // The verdict is in, so the pixels that produced it are dead weight. The
    // reserve is small and per camera precisely so a slot is worth freeing
    // the instant it stops being evidence (D379).
    this.frameState.birthEvidence.resolve(key, id)

    // Confirmation gate verdict — a suppressed birth is a rejected false
    // positive: no `start`, no firstFrame, no lifecycle memory.
    // A VERDICT THAT ARRIVES FOR AN ALREADY-BORN TRACK CHANGES NOTHING.
    // Several frames are in flight at once, so a candidate submitted before
    // the guard above could still be decided after the birth ran. Retracting
    // here is what killed the recovered dog on camera 101 at 04:59:38.821Z,
    // 486 ms after the same id had been confirmed at 0.7068 and started.
    if (this.frameState.startedBirths.hasStarted(key, id)) {
      this.frameState.deferredBirths.resolve(key, id)
      log.info('late birth verdict ignored — the track was already born', {
        meta: {
          trackId: id,
          className: t.className,
          source,
          verdict: outcome.confirmed.has(id) ? 'confirmed' : 'suppressed',
        },
      })
      return false
    }
    // THE MIRROR: a verdict that arrives for an id another in-flight frame
    // already SUPPRESSED changes nothing either. The first verdict wins in
    // both directions; birthing it now would open a resident and start a
    // lifecycle for an id the TrackStore never saw, which nothing closes.
    if (this.frameState.suppressedBirths.isRejected(key, id)) {
      this.frameState.deferredBirths.resolve(key, id)
      this.frameState.birthEvidence.resolve(key, id)
      log.info('late birth verdict ignored — the birth was already suppressed', {
        tags: { deviceId },
        meta: {
          trackId: id,
          className: t.className,
          verdict: outcome.confirmed.has(id) ? 'confirmed' : 'suppressed',
        },
      })
      return false
    }
    // ── D409 MEASUREMENT — one durable row per RESOLVED verdict. ──
    //
    // Placed here, after the already-born guard, because a late verdict for a
    // track that has already been born decided nothing and must not enter the
    // denominator. Placed BEFORE the three verdict branches because all three
    // are decisions and the point is to count them against each other.
    //
    // Records, and changes nothing: no branch below reads it, and the append
    // is fire-and-forget and cannot throw.
    this.birthLedger.recordBirthDecision({
      deviceId,
      trackId: id,
      className: t.className,
      confirmed: outcome.confirmed.has(id),
      exhaustedFallback: wasDeferred && exhaustedIds.has(id),
      attempts: deferredAttempts,
      deferredForMs,
      // THE COLUMN THE RE-OFFER DEFECT IS COUNTED IN. The deferred-birth
      // re-offer above pulls the candidate straight out of `result.tracked`
      // with no `matchedThisFrame` check, so a birth CAN be decided on a frame
      // the subject was never observed in. How often, per camera, and whether
      // D379's carried pixels made it a real observation anyway, is the
      // question this row exists to answer.
      matchedThisFrame: t.matchedThisFrame,
      birthEvidenceAvailable: withBirthEvidence.has(id),
      decision: run.decisions.get(id),
      sessionDetector,
      decidedAtMs: gateNowMs,
      firstSeen: this.trackStore?.peekActive(id)?.firstSeen ?? null,
    })
    if (!outcome.confirmed.has(id)) {
      // RETRACT the row the upsert above already wrote. `dropActive` removes
      // the in-RAM track without persisting it, so a rejected birth never
      // reaches the historical feed. This is the OPPOSITE of what a
      // stationary promotion does — that one `closeActive`s, because a parked
      // car has lived a full life and owns media, events and a vector that
      // only the persisted row can be retention-swept from; dropping it there
      // is the 18.9 GB orphan bug of D161. Dropping is correct HERE precisely
      // because a suppressed birth owns nothing yet. Remembering the id keeps
      // later frames from writing it straight back.
      if (!suppressionMayRetract(source)) {
        // KEEP THE PIXELS THE GATE JUDGED. Only here: the track survives this
        // verdict, so the row has an owner that will age it out (D161). A
        // crop kept beside a retracted birth would be a media row owned by a
        // track that never existed.
        const judged = run.crops.get(id)
        if (judged !== undefined && this.mediaStore) {
          void this.mediaStore
            .put({
              deviceId,
              ownerKind: 'track',
              ownerId: id,
              kind: 'confirmationCrop',
              timestamp: gateNowMs,
              data: judged,
            })
            .catch((err: unknown) => {
              // A debug frame that fails to land is not worth a warn on the
              // frame path, but silence would make "the crop is missing" and
              // "the crop was never offered" read identically.
              log.debug('confirmation crop not kept', {
                meta: { trackId: id, error: String(err) },
              })
            })
        }
        // OPERATOR-DEBUG evidence for the gate's verdict. The
        // `confirmationCrop` above is the TIGHT crop the detector actually
        // judged — model input, unchanged, and deliberately so. This is the
        // other half the 2026-09-18 traces needed and no stored row had: the
        // same subject with its NEIGHBOURHOOD, so a reflection, a painted
        // figure or a mis-paired box/frame is visible as such rather than
        // filling the frame. Only inside this surviving-track branch, for the
        // same reason the crop above is: a row beside a retracted birth would
        // outlive its owner (D161).
        if (frameHandle !== undefined) {
          const decision = run.decisions.get(id)
          this.offerDebugCrop({
            deviceId,
            trackId: id,
            decision: 'birth-confirmation',
            subject: { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h },
            frameHandle,
            frameWidth: result.frameWidth,
            frameHeight: result.frameHeight,
            timestamp: gateNowMs,
            evidence: {
              className: t.className,
              source,
              verdict: 'suppression-held',
              ...(decision?.cropSource !== undefined ? { cropSource: decision.cropSource } : {}),
              ...(decision?.bestScore !== undefined ? { bestScore: decision.bestScore } : {}),
              judgedCropKept: judged !== undefined,
            },
          })
        }
        // The root detector here is the CAMERA's firmware and the gate is a
        // DIFFERENT detector overruling it — see `onboard-birth-authority.ts`.
        // Held, not confirmed: the ordinary lifetime still decides. Said out
        // loud, because a birth that survives a suppression must not be
        // indistinguishable from one that was never questioned.
        log.info('birth suppression held — the gate is not this root detector', {
          tags: { deviceId },
          meta: { trackId: id, className: t.className, source },
        })
        return false
      }
      this.frameState.suppressedBirths.reject(key, id)
      // Review H3: a refused birth never becomes a link end in L2.
      processor.markSuppressed(id)
      this.trackStore?.dropActive(id)
      // A retracted birth is a track that ENDED — it simply never existed.
      // Without this the detail dispatcher, the best-shot tracker and the
      // frame park keep working on it: measured on device 106, 43
      // `runDetailSubtree: no crop source resolved` and 27 refused parks
      // spent on tracks that had been dropped seconds earlier, the first
      // request landing ~20 s after the frame it names. A branch that
      // accepts work and produces nothing is the branch D391 is about.
      this.clearLiveTrackState(deviceId, id)
      // The line names WHY and on WHAT (D922): a retraction is a discarded
      // birth, and a branch that discards work says so on the record.
      const suppression = run.decisions.get(id)
      log.info('birth suppressed — track record retracted', {
        tags: { deviceId },
        meta: {
          trackId: id,
          className: t.className,
          source,
          reason: suppression?.reason ?? null,
          bestScore: suppression?.bestScore ?? null,
          appliedMinConfidence: suppression?.appliedMinConfidence ?? null,
          cropSource: suppression?.cropSource ?? null,
          attempts: deferredAttempts,
          ...(wasDeferred ? { wasDeferred, deferredForMs, deferredAttempts } : {}),
        },
      })
      return false
    }
    if (wasDeferred && exhaustedIds.has(id)) {
      // The ONE remaining fail-open. `warn`, not `info`: at this point the
      // gate has retried the crop, waited out the deferral and tried the
      // sub-native fallback, and still never looked at this subject. It used
      // to be the routine outcome of any crop miss; it should now be rare,
      // and if it is not, the bounds are wrong.
      log.warn('birth allowed unmeasured — deferral exhausted, no crop available', {
        meta: {
          trackId: id,
          className: t.className,
          source,
          deferredForMs,
          deferredAttempts,
        },
      })
    } else if (wasDeferred) {
      // The line that says whether the deferral is EARNING anything. Without
      // it, "the gate stopped failing open" and "the gate now suppresses
      // everything it could not measure" look identical in the aggregate.
      log.info('birth decided late — confirmed after deferral', {
        meta: {
          trackId: id,
          className: t.className,
          source,
          deferredForMs,
          deferredAttempts,
        },
      })
    }
    return true
  }
}
