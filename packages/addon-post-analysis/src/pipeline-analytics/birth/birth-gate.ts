/** The birth confirmation gate's host side (D922 / D925), moved verbatim out of
 *  `pipeline-analytics/index.ts` (Plan B, extraction 5). */
import type {
  AddonContext,
  DetectionSource,
  FrameHandle,
  NativeRecoveryEvidence,
} from '@camstack/types'
import {
  type BirthCandidate,
  type BirthConfirmationRun,
  type ConfirmationDecision,
  type ConfirmationGateDeps,
  confirmBirths,
  type RedetectAnswer,
} from '../confirmation-gate.js'
import type { ConfirmationGateSettings } from '../confirmation-gate-settings.js'
import type { SessionDetector } from '../confirmation-session-detector.js'
import type { FrameState } from '../frame/frame-state.js'
import { type CaptureCropFn, captureCropFrameRect } from '../pipeline/capture-crop.js'
import type { DisplayCropFn } from '../pipeline/display-crop.js'
import type { PhantomCellRegistry } from '../pipeline/stationary/phantom-cells.js'
import type { CaptureScheduler } from '../runtime/capture-scheduler.js'
import {
  CONFIRMATION_CROP_MAX_WIDTH,
  CONFIRMATION_CROP_PADDING,
  redetectCropForConfirmation,
} from './birth-redetect.js'
import type { BirthGateDeps } from './birth-types.js'

export class BirthGate {
  constructor(private readonly deps: BirthGateDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  private get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  private get captureCrop(): CaptureCropFn | null {
    return this.deps.captureCrop()
  }

  private get captureDisplayCropFn(): DisplayCropFn | null {
    return this.deps.captureDisplayCropFn()
  }

  private get phantomCells(): PhantomCellRegistry | null {
    return this.deps.phantomCells()
  }

  private resolveDeviceConfirmationGateSettings(
    deviceId: number,
  ): Promise<ConfirmationGateSettings> {
    return this.deps.resolveDeviceConfirmationGateSettings(deviceId)
  }

  private procKey(deviceId: number, source: DetectionSource): string {
    return this.deps.procKey(deviceId, source)
  }

  private redetectCropForConfirmation(
    detector: SessionDetector | null,
    deviceId: number,
    cropJpeg: Buffer,
  ): Promise<RedetectAnswer> {
    return redetectCropForConfirmation(this.ctx, detector, deviceId, cropJpeg)
  }

  /**
   * Confirm a batch of track-birth candidates before they are created. Returns
   * the set of trackIds whose births may PROCEED. When the gate is disabled
   * (default) or no crop path is available, every candidate is confirmed —
   * byte-identical to no gate. Confirmations run CONCURRENTLY (one inference per
   * candidate) and each failure path fails OPEN, so the synchronous frame path
   * is never blocked or reordered by a slow/failed re-detection.
   */
  async confirmTrackBirths(
    candidates: readonly BirthCandidate[],
    params: {
      deviceId: number
      /**
       * Which stream this frame came from. A promoted secondary subject is
       * queued under the SAME `procKey` the frame path takes it from — an
       * onboard-source promotion parked in the pipeline slot would never ride
       * a frame and would silently do nothing.
       */
      source: DetectionSource
      frameHandle: FrameHandle | undefined
      frameWidth: number
      frameHeight: number
      /**
       * The detector that made the claim — the frame's stamped root, on the
       * node that ran it, which is the node the crop is cut on (D925). `null`
       * when the frame names none: the gate then has no detector to ask and
       * defers, never asking another model.
       */
      sessionDetector: SessionDetector | null
      /** Deferral attempts already spent per candidate — logged on every verdict. */
      attemptsFor: (trackId: string) => number
    },
    exhaustedIds: ReadonlySet<string> = new Set<string>(),
  ): Promise<BirthConfirmationRun> {
    // D409: the decisions this run took, keyed by trackId, handed back to the
    // birth loop with the outcome. A LOCAL map, built inside `onDecision`, and
    // never a member field: several frames of the same camera are in flight at
    // once and would overwrite each other's answers.
    const decisions = new Map<string, ConfirmationDecision>()
    /** The pixels each candidate was judged on, offered by the gate and held
     *  only for this run — see `MediaFileKind.confirmationCrop`. */
    const offeredCrops = new Map<string, Buffer>()
    const allConfirmed = (): BirthConfirmationRun => ({
      outcome: {
        confirmed: new Set(candidates.map((c) => c.trackId)),
        undecided: new Set<string>(),
      },
      // Nothing was measured, so no pixels were judged.
      crops: new Map<string, Buffer>(),
      // Empty: no decision was TAKEN. The ledger records that as
      // `reason: null`, which is a different population from a measured birth.
      decisions,
    })
    if (candidates.length === 0) return allConfirmed()
    const config = await this.resolveDeviceConfirmationGateSettings(params.deviceId)
    if (!config.enabled) return allConfirmed()
    const { frameHandle, frameWidth, frameHeight, deviceId, source } = params
    const captureCrop = this.captureCrop
    // NO CROP PATH AT ALL — no handle, no capture function, no usable dims.
    // These births are CONFIRMED, deliberately, and this is the one place the
    // deferral is not applied.
    //
    // The defect that motivated deferral was a crop MISS with a working path
    // (`reason: "no-crop"`, handle present, native lease gone). A handle-less
    // frame is a different condition: decode starvation, where the whole frame
    // is unavailable. Deferring there would delay every birth on an already
    // struggling camera by up to `maxDeferralMs` and push its firstFrame that
    // much later — which is precisely the failure the DEFECT-A fix elsewhere in
    // this file exists to prevent. Fixing a crop miss must not create a
    // starvation regression.
    //
    // Raised from `debug` to `info`: a camera born entirely unmeasured is
    // exactly the thing that should be visible in Loki.
    if (!frameHandle || !captureCrop || frameWidth <= 0 || frameHeight <= 0) {
      this.ctx.logger.info('confirmation gate: no crop path — births allowed unmeasured', {
        tags: { deviceId },
        meta: {
          candidates: candidates.length,
          hasHandle: Boolean(frameHandle),
          hasCaptureCrop: Boolean(captureCrop),
          frameWidth,
          frameHeight,
        },
      })
      return allConfirmed()
    }
    const { sessionDetector } = params
    // The native second-pass measurement per candidate, so the decision log
    // can say what a `native-pass` confirmation rested on (the gate's decision
    // carries the score; the geometry stays here, where the candidate is).
    const candidateNativeRecovery = new Map<string, NativeRecoveryEvidence>()
    for (const c of candidates) {
      if (c.nativeRecovery !== undefined) candidateNativeRecovery.set(c.trackId, c.nativeRecovery)
    }
    const deps: ConfirmationGateDeps = {
      // S4: scheduler-routed, LATENCY-SENSITIVE — this crop gates track birth
      // (processFrame AWAITS confirmTrackBirths). kind 'confirm' ranks at
      // priority 0 (with firstFrame) so it jumps every queued lower-priority
      // capture. No coalesceKey — each candidate is a distinct bbox. A `null`
      // (dropped or cancelled) leaves the birth UNDECIDED, never confirmed.
      //
      // `staleAfterMs` IS THE GATE'S OWN DEADLINE, not a tuning knob. This
      // request used to carry none, on the premise that "a queued confirmation
      // must run when its turn comes, never be silently dropped". That premise
      // is contradicted three lines down the call stack: `confirmOne` wraps
      // this fetch in `withTimeout(config.timeoutMs)` and DISCARDS whatever
      // arrives later — a confirmation that lands after the deadline confirms
      // nothing, because the verdict (`undecided`/`timeout`) has already been
      // taken and the birth already deferred. So the entry outlived its only
      // reader, and the scheduler had no way to know:
      //   • `dropExpired` skips entries without a `staleAfterMs`, so an
      //     abandoned confirm could NEVER be reclaimed from a queued lane;
      //   • at priority 0 it sits at the HEAD, so `insertByPriority` puts every
      //     keyFrame/thumbnail/face/plate arrival at the TAIL and `shedToCap`
      //     sheds it on admission — that is the `keyFrame:overflow` an operator
      //     reads as a track with no preview;
      //   • and when it finally executed it spent one of the lane's three slots
      //     on a `getNativeCrop` for a handle by then seconds old (measured
      //     2026-08-30 on camera 104: mean `handleAgeMs` 5 102, max 32 847),
      //     which is the `worker-lease-gone` that is 95.7% of native misses.
      // Live evidence for the abandonment itself, same day, 3 h: 844 of 1 119
      // gate attempts on 104 ended `timeout` and only 83 ended `no-crop` — the
      // gate was not seeing misses, it was seeing its own requests never come
      // back. On camera 108, whose lane never saturates, `timeout` is 2/81.
      // Dropping one is SAFE and always was: `fetchCrop` → `null` →
      // `undecided(candidate, 'no-crop')`, a birth NOT confirmed — the same
      // reasoning `DEFAULT_CAPTURE_PRIORITY` already records for the overflow
      // shed.
      //
      // NO in-attempt retry, deliberately. An earlier draft slept ~60 ms
      // between crop fetches to give the native lease time to land, and it was
      // wrong twice over: it sat on the SYNCHRONOUS frame path that
      // `processFrame` awaits, and it duplicated work the DEFERRAL already
      // does — the next frame retries the same birth with a fresher box, for
      // free. Two mechanisms for one job, and only one of them blocks the
      // pipeline.
      fetchCrop: (candidate) =>
        this.captureScheduler.request({
          deviceId,
          trackId: candidate.trackId,
          kind: 'confirm',
          staleAfterMs: config.timeoutMs,
          exec: () =>
            captureCrop(
              frameHandle,
              {
                x: candidate.bbox.x,
                y: candidate.bbox.y,
                w: candidate.bbox.w,
                h: candidate.bbox.h,
              },
              frameWidth,
              frameHeight,
              CONFIRMATION_CROP_PADDING,
              CONFIRMATION_CROP_MAX_WIDTH,
              deviceId,
            ),
        }),
      // Reached ONLY when the caller marks a candidate exhausted (see
      // `exhaustedIds` below). Sub-native is acceptable here and nowhere else
      // in the model path: the gate asks "vehicle or wall?", not "whose face is
      // this?" — and the alternative, failing open, is what put a brick wall in
      // camera 636's feed as a `vehicle`.
      fetchFallbackCrop: (candidate) => {
        const displayCrop = this.captureDisplayCropFn
        if (!displayCrop) return Promise.resolve(null)
        return displayCrop(
          frameHandle,
          {
            x: candidate.bbox.x,
            y: candidate.bbox.y,
            w: candidate.bbox.w,
            h: candidate.bbox.h,
          },
          frameWidth,
          frameHeight,
          CONFIRMATION_CROP_PADDING,
          candidate.trackId,
          CONFIRMATION_CROP_MAX_WIDTH,
        )
      },
      redetect: (cropJpeg) => this.redetectCropForConfirmation(sessionDetector, deviceId, cropJpeg),
      // Held only for this run — written below for the verdicts worth bytes,
      // then dropped. The gate offers every candidate's crop; deciding which
      // are worth keeping is the host's job and not the gate's.
      keepCrop: (candidate, cropJpeg) => {
        offeredCrops.set(candidate.trackId, cropJpeg)
      },
      // The frame rectangle `fetchCrop` above asks the runner for — the SAME
      // derivation the capture applies (`captureCropWindow`), so a box the
      // re-detector reports in crop space lands where the pixels were.
      cropRectFor: (candidate) =>
        captureCropFrameRect(
          { x: candidate.bbox.x, y: candidate.bbox.y, w: candidate.bbox.w, h: candidate.bbox.h },
          frameWidth,
          frameHeight,
          CONFIRMATION_CROP_PADDING,
        ),
      // PHANTOM-CELL BAR. A candidate born in a cell that has closed
      // short-and-motionless three or more times in 24 h faces a higher bar
      // than the same box a metre away. Synchronous, off the in-RAM mirror
      // (D49): a birth decision may never be gated on a fallible read, and a
      // registry that failed to construct simply returns the configured bar.
      minConfidenceFor: (candidate) =>
        this.phantomCells?.spawnBar({
          deviceId,
          className: candidate.className,
          x: candidate.bbox.x,
          y: candidate.bbox.y,
          base: config.minConfidence,
          now: Date.now(),
        }).bar ?? config.minConfidence,
      onDecision: (decision) => {
        // D409 — remembered for the ledger before anything is logged, so a row
        // is never lost to a formatting change in the lines below.
        decisions.set(decision.trackId, decision)
        // EVERY decision carries the crop score it was made on, confirmations
        // included. `minConfidence` is one scalar for all classes while the
        // detector floors are per-class (person 0.65, others 0.50), and the
        // question of whether the gate bar should follow them cannot be
        // answered without the distribution of crop scores per class. Only
        // suppressions used to be logged, and without a score — so the bar was
        // unchoosable from data. Confirmations are per BIRTH, not per frame,
        // so this is bounded by track-birth rate.
        const meta = {
          trackId: decision.trackId,
          reason: decision.reason,
          className: decision.className,
          ...(decision.bestScore !== undefined ? { bestScore: decision.bestScore } : {}),
          // WHICH detector judged it (D925) — the session's own, never a node
          // default — and how many looks this birth already spent.
          ...(sessionDetector !== null
            ? {
                modelId: sessionDetector.modelId,
                deviceKey: sessionDetector.deviceKey,
                node: sessionDetector.nodeId,
              }
            : {}),
          attempts: params.attemptsFor(decision.trackId),
          ...(decision.bestIncompatibleClass !== undefined
            ? {
                bestIncompatibleClass: decision.bestIncompatibleClass,
                bestIncompatibleScore: decision.bestIncompatibleScore,
              }
            : {}),
          minConfidence: config.minConfidence,
          // WHICH PIXELS decided this (D379): `carried` is the birth's own
          // frame, `native` a later fetch of it, `fallback` a different instant
          // that may confirm and may never suppress. The before/after of this
          // change is read straight off this field — a gate answering from
          // `carried` never enters the miss path at all.
          ...(decision.cropSource !== undefined ? { cropSource: decision.cropSource } : {}),
          // The geometry the native second pass measured on, when THAT is
          // what confirmed this birth (`reason: native-pass`). Without it the
          // line says a birth was confirmed without a crop and gives no way to
          // check the claim.
          ...(decision.reason === 'native-pass'
            ? {
                nativeRecoveryCropSidePx: candidateNativeRecovery.get(decision.trackId)?.cropSidePx,
                nativeRecoveryViewPx: candidateNativeRecovery.get(decision.trackId)?.viewPx,
              }
            : {}),
          // The bar this candidate ACTUALLY faced. With a per-cell bar,
          // "was 0.62 a pass?" is no longer answerable from the config alone.
          ...(decision.appliedMinConfidence !== undefined &&
          decision.appliedMinConfidence > config.minConfidence
            ? {
                appliedMinConfidence: decision.appliedMinConfidence,
                barRaisedByPhantomCell: true,
              }
            : {}),
        }
        switch (decision.verdict) {
          case 'suppressed':
            this.ctx.logger.info('confirmation gate: birth suppressed (false positive)', {
              tags: { deviceId },
              meta,
            })
            break
          case 'undecided':
            // Was `debug`, so it never reached Loki. That is a large part of
            // why 45% of births going unmeasured stayed invisible for as long
            // as it did — the only trace was a level nobody ships.
            this.ctx.logger.info('confirmation gate: birth undecided', {
              tags: { deviceId },
              meta,
            })
            break
          case 'confirmed':
            this.ctx.logger.info('confirmation gate: birth confirmed', {
              tags: { deviceId },
              meta,
            })
            break
        }
        // What the crop confidently held BESIDES the candidate. Until now the
        // score was logged as `bestIncompatibleScore` and nothing else
        // happened: on camera 101 the dog beside the person was found at
        // 0.74–0.91 on the person's own native crop, five times, and never
        // became a subject. It rides the next frame as a detection.
        if (decision.secondary !== undefined) {
          this.frameState.secondarySubjects.add(
            this.procKey(deviceId, source),
            decision.secondary,
            decision.trackId,
            Date.now(),
          )
          this.ctx.logger.info('confirmation gate: secondary subject promoted from the crop', {
            tags: { deviceId },
            meta: {
              trackId: decision.trackId,
              className: decision.className,
              secondaryClass: decision.secondary.className,
              secondaryScore: decision.secondary.score,
              secondaryBbox: decision.secondary.bbox,
              verdict: decision.verdict,
            },
          })
        }
      },
    }
    const outcome = await confirmBirths(candidates, config, deps, exhaustedIds)
    return { outcome, decisions, crops: offeredCrops }
  }
}
