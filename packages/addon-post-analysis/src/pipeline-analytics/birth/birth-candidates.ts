/**
 * The frame path's birth candidates and their suppression bookkeeping (D377,
 * D379, D922): which fresh ids are births, the deferred re-offer, deferral
 * exhaustion, the carried birth evidence and the gate submission — then, after
 * the verdicts, the per-frame retain of the birth sets, the rejected ids and
 * the events a rejected birth may not keep. Moved out of
 * `pipeline-analytics/index.ts` verbatim (Plan B, extraction 5): the inline
 * blocks of `processFrame` became methods, in the same places in its order.
 */
import type { AddonContext, IScopedLogger, ObjectEventDraft } from '@camstack/types'
import type { BirthCandidate } from '../confirmation-gate.js'
import type { ConfirmationGateSettings } from '../confirmation-gate-settings.js'
import { sessionDetectorOf } from '../confirmation-session-detector.js'
import type { FrameState } from '../frame/frame-state.js'
import type { FrameProcessorResult } from '../pipeline/frame-processor.js'
import { classifyTrackAppearance } from '../pipeline/track-appearance.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import type { EventMediaDispatcher } from '../services/event-media-dispatcher.js'
import type { BirthGate } from './birth-gate.js'
import type {
  BirthCandidatesDeps,
  BirthRound,
  BirthRoundInput,
  BornCandidate,
} from './birth-types.js'

export class BirthCandidates {
  constructor(private readonly deps: BirthCandidatesDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get eventMediaDispatcher(): EventMediaDispatcher | null {
    return this.deps.eventMediaDispatcher()
  }

  private get birthGate(): BirthGate {
    return this.deps.birthGate()
  }

  private resolveDeviceConfirmationGateSettings(
    deviceId: number,
  ): Promise<ConfirmationGateSettings> {
    return this.deps.resolveDeviceConfirmationGateSettings(deviceId)
  }

  /** The fresh ids that are births, and the gate's run over them. */
  async collectAndConfirm(input: BirthRoundInput): Promise<BirthRound> {
    const {
      deviceId,
      source,
      key,
      log,
      frame,
      frameHandle,
      result,
      prevIds,
      currentTrackIds,
      positionsCountById,
    } = input
    // Pre-pass: classify every fresh id as a true BIRTH vs a RESURRECTION — a
    // root id dropping out of the active set and reappearing. Tracker v2 never
    // resurrects an id across a gap in the sense the old tracker did (L2 links
    // pieces instead); what still produces this shape is a fusion: the
    // survivor id IS the root id, reused across however many pieces fuse into
    // it, so the same store-level trackId can go quiet for a frame (its live
    // piece coasted out or ended) and reappear once a LATER piece is fused
    // into that same survivor. A resurrected track is already known to the
    // TrackStore (>1 recorded position), so the once-per-track start work —
    // firstFrame media, `start` lifecycle, snapshot-clock seed, update-gate
    // memory — must NOT run again; doing so appended duplicate firstFrames and
    // re-emitted `start`. The gate continues from its existing reference.
    // Births are COLLECTED here (in currentTrackIds iteration order) so the
    // optional confirmation gate can run one concurrent re-detection pass
    // before any `start` is emitted.
    const bornCandidates: BornCandidate[] = []
    for (const id of currentTrackIds) {
      if (prevIds.has(id)) continue
      const t = result.tracked.find((x) => x.trackId === id)
      if (!t) continue
      const appearance = classifyTrackAppearance({
        inPrevActive: false,
        positionsCount: positionsCountById.get(id) ?? 1,
      })
      // ALREADY BORN. `classifyTrackAppearance` cannot see this on its own:
      // `inPrevActive` is read from a map several in-flight frames write at
      // their END, and `positionsCount` stays 1 for as long as the track
      // COASTS (a coasted upsert appends no position) — which is precisely the
      // state of a subject the full-frame pass is too coarse to see. So the
      // id would be offered to the gate a second time and judged on a stale
      // box. It is not: this is a continuing track (D377).
      if (this.frameState.startedBirths.hasStarted(key, id)) continue
      // ALREADY JUDGED. The first birth verdict wins in both directions: a
      // rejected id is never offered to the gate again.
      if (this.frameState.suppressedBirths.isRejected(key, id)) continue
      if (appearance === 'resurrection') {
        log.info('track resumed', {
          tags: { deviceId },
          meta: {
            trackId: id,
            className: t.className,
            source,
            resurrected: true,
          },
        })
        // A resurrected id skips the fresh-birth seed below, but the media
        // bookkeeping clocks (the rolling-lastFrame clock, the in-flight flags) are
        // cleared ONLY on track END (TTL expiry), never on the intervening
        // "lost" transition — so this id still carries the STALE positive
        // `lastFrameAt` from its PRIOR life. Left stale, `lastFrameElapsed` is
        // immediately true on the resurrection frame → an anomalous near-birth
        // `lastFrame` (~90ms after resume) that then freezes (the "lastFrame
        // frozen <200ms" class in sweeps — resurrections, not the landed-clock
        // defect). Re-seed the rolling-lastFrame clock to THIS frame's timestamp
        // (mirroring the fresh-birth seed) so the first rolled `lastFrame` can
        // fire no sooner than one interval AFTER the resume. The track KEEPS its
        // media history: the firstFrame-pending / thumbnail-landed flags and
        // the snapshot clock are deliberately left untouched.
        if (this.eventMediaDispatcher) {
          this.residents.setLastFrameAt(deviceId, id, result.timestamp)
          // firstFrame self-heal (live evidence 2026-07-23, tracks e1d1df37 /
          // 0e178201 / 8200edf1 on dev101): a track whose birth the confirmation
          // gate SUPPRESSED (or that flapped straight into resurrection) never
          // entered the firstFrame-pending set, yet keeps living and persisting
          // media — it ended with NO firstFrame at all. On resume, when nothing
          // has ever landed for this id, re-arm pending so the DEFECT-A retry
          // captures the earliest available view. `firstFrameLanded` guards the
          // true first view from being overwritten by a later retry.
          if (!this.residents.isFirstFrameLanded(id) && !this.residents.isFirstFramePending(id)) {
            this.residents.markFirstFramePending(deviceId, id)
          }
        }
        continue
      }
      bornCandidates.push({ id, t })
    }

    // Deferred births get another look, with their CURRENT box. That is the
    // mechanism and not a detail: the box grows as the subject moves, and a
    // native crop that missed at birth is routinely available two frames later
    // (the miss is retry-by-design upstream). Without this a birth the gate
    // could not measure would simply never be measured.
    for (const id of this.frameState.deferredBirths.deferredIds(key)) {
      if (bornCandidates.some((c) => c.id === id)) continue
      if (this.frameState.suppressedBirths.isRejected(key, id)) continue
      const t = result.tracked.find((x) => x.trackId === id)
      if (t) bornCandidates.push({ id, t })
    }

    // Detection confirmation gate (default OFF → confirms all). When enabled it
    // re-runs object detection on the hi-res native crop of each birth box and
    // SUPPRESSES births whose crop does not confirm a class-compatible object,
    // killing false-positive tracks (static "person" phantoms, parked-truck
    // ghosts). Fail-DEFERRED + concurrent: the sync loop below keeps its
    // ordering and is never blocked or reordered by a slow/failed re-detection,
    // and a birth it could not MEASURE is deferred rather than waved through.
    // Which deferrals are over. Computed HERE because the gate holds no clock:
    // exhaustion is a property of how long the CALLER has been waiting, not of
    // any single attempt. An exhausted candidate may use the sub-native
    // fallback, and falls open if even that misses.
    const gateSettings = await this.resolveDeviceConfirmationGateSettings(deviceId)
    const exhaustionNowMs = Date.now()
    const exhaustedIds = new Set<string>()
    for (const { id } of bornCandidates) {
      if (
        this.frameState.deferredBirths.exhausted(
          key,
          id,
          exhaustionNowMs,
          gateSettings.maxAttempts,
          gateSettings.maxDeferralMs,
        )
      ) {
        exhaustedIds.add(id)
      }
    }

    // D379 — the pixels each candidate ARRIVED WITH. Remembered on the frame
    // that carried them, in this camera's own reserve, because a birth the gate
    // defers is re-offered on LATER frames where the same track is an ordinary
    // matched detection carrying nothing. Remembering here, at the point the
    // candidate is built, is what makes a deferral and a carried crop compose.
    for (const { id, t } of bornCandidates) {
      if (t.birthEvidence === undefined) continue
      this.frameState.birthEvidence.remember(
        key,
        id,
        Buffer.from(t.birthEvidence.jpegBase64, 'base64'),
        exhaustionNowMs,
      )
    }

    // D409: which candidates were submitted WITH birth-instant pixels in hand.
    // "Available" and "decided it" are different questions — the carried crop is
    // confirm-only, so a candidate can hold evidence, be inconclusive on it and
    // be decided by a native crop of a later instant. The ledger keeps both.
    const withBirthEvidence = new Set<string>()
    // The session's detector: the root this frame was stamped with, on the node
    // that ran it (D925). The gate re-judges with it and nothing else.
    const sessionDetector = frameHandle ? sessionDetectorOf(frame, frameHandle.nodeId) : null
    const run = await this.birthGate.confirmTrackBirths(
      bornCandidates.map(({ id, t }): BirthCandidate => {
        const evidenceCrop = this.frameState.birthEvidence.get(key, id, exhaustionNowMs)
        if (evidenceCrop !== null) withBirthEvidence.add(id)
        return {
          trackId: id,
          className: t.className,
          bbox: t.bbox,
          // What the runner's native second pass measured about THIS box, when
          // that pass is what produced it (D377). The gate confirms on it
          // rather than deriving a third, tighter crop of a subject the coarse
          // pass was already too coarse to see.
          ...(t.nativeRecovery !== undefined ? { nativeRecovery: t.nativeRecovery } : {}),
          // The box's own pixels, from the frame it was measured on (D379).
          // The gate looks at these BEFORE asking anyone for a crop, and they
          // may only CONFIRM — a negative escalates to the native path.
          ...(evidenceCrop !== null ? { evidenceCrop } : {}),
        }
      }),
      {
        deviceId,
        source,
        frameHandle,
        frameWidth: result.frameWidth,
        frameHeight: result.frameHeight,
        sessionDetector,
        attemptsFor: (trackId) => this.frameState.deferredBirths.attemptsFor(key, trackId),
      },
      exhaustedIds,
    )
    return { bornCandidates, exhaustedIds, withBirthEvidence, sessionDetector, run }
  }

  /** The per-frame retain of the birth sets, against the ids the tracker still carries. */
  retainBirths(key: string, currentTrackIds: ReadonlySet<string>): void {
    // Forget a rejected birth once the tracker stops carrying its id, so the
    // set cannot grow for the process's lifetime on a camera that produces
    // phantoms continuously — which is exactly the camera this exists for.
    this.frameState.suppressedBirths.retain(key, currentTrackIds)
    this.frameState.startedBirths.retain(key, currentTrackIds)
    // Same contract, same frame: an id the tracker dropped can never be decided.
    this.frameState.deferredBirths.retain(key, currentTrackIds)
    // …and its evidence is pixels held for a question nobody will ask again.
    this.frameState.birthEvidence.retain(key, currentTrackIds)
  }

  /** This frame's tracked ids whose birth was rejected — said once per id. */
  rejectedThisFrame(
    deviceId: number,
    key: string,
    log: IScopedLogger,
    result: FrameProcessorResult,
  ): Set<string> {
    const rejectedThisFrame = new Set<string>()
    for (const t of result.tracked) {
      if (!this.frameState.suppressedBirths.isRejected(key, t.trackId)) continue
      rejectedThisFrame.add(t.trackId)
      if (this.frameState.suppressedBirths.firstSkip(key, t.trackId)) {
        log.info('frame work skipped — the track birth was suppressed', {
          tags: { deviceId },
          meta: { trackId: t.trackId, className: t.className },
        })
      }
    }
    return rejectedThisFrame
  }

  /**
   * The events of `drafts` whose track's birth the confirmation gate rejected,
   * removed — the SAME array when none is, so a caller can tell. A rejected
   * birth is a track that never existed: it has no event row, no media and no
   * notification, on any frame. Each drop is logged (bounded by event rate):
   * an accepted event that silently vanishes reads as "never happened" (D391).
   */
  dropSuppressedBirthEvents(
    deviceId: number,
    key: string,
    drafts: readonly ObjectEventDraft[],
  ): readonly ObjectEventDraft[] {
    const isSuppressed = (e: ObjectEventDraft): boolean =>
      e.trackId !== undefined && this.frameState.suppressedBirths.suppressesEvents(key, e.trackId)
    if (!drafts.some(isSuppressed)) return drafts
    const kept: ObjectEventDraft[] = []
    for (const e of drafts) {
      if (!isSuppressed(e)) {
        kept.push(e)
        continue
      }
      this.ctx.logger.info('object event dropped — the track birth was suppressed', {
        tags: { deviceId },
        meta: {
          trackId: e.trackId,
          className: e.className,
          state: e.state,
          zones: e.zones,
          reason: 'birth-suppressed',
        },
      })
    }
    return kept
  }
}
