/**
 * The digest producer's loop — collect, select, render, deliver, stamp.
 *
 * It answers the same five questions the timelapse scheduler does, and the
 * order matters as much as the answers:
 *
 *   1. has a window CLOSED?           schedule → `findLastClosedWindow`;
 *                                     motion   → `motionWindowCloseAt`
 *   2. have its TRACKS closed?        `decideSummaryWindow` (the barrier)
 *   3. is the close above the rule's ELIGIBILITY FLOOR?
 *   4. did the render AND the enqueue succeed?
 *   5. → stamp, and only then
 *
 * **The stamp is LAST.** A render that failed, or a queue that refused the
 * rows, must leave the window eligible for the next tick, because a closed
 * window does not come back. The predecessor design in this repo stamped first
 * and one ffmpeg failure cost an entire night, permanently.
 *
 * **The floor is `max(generatedAt, createdAt)`.** `createdAt` is what stops a
 * rule created this morning reaching back to a window that closed before it
 * existed and retrying it every minute forever — an unstamped rule looks
 * identical whether the hub was down or the rule is new, and only the birth
 * time tells them apart (live incident: timelapse rule 16fa78ac / camera 1441).
 *
 * **The cheap question comes first.** No media is read until the window is
 * known to hold something worth rendering: `listTracks` → filter → select →
 * and only then one blob per surviving tile. That ordering is D54's discipline
 * and D56's measurement (a `listByOwner` that read ~10 MB to choose two files
 * was the dominant cost of a hub-main saturation).
 *
 * Every log line about a camera carries `tags: { deviceId }`. The window lines
 * are cross-camera by construction and carry `meta: { ruleId, deviceIds }`
 * instead — a digest's own line has no single camera to tag, and inventing one
 * would make it answer the per-camera question wrongly.
 */

import type { IScopedLogger, NcRuleTarget } from '@camstack/types'
import type { NcArtifactPublishMeta } from '../artifact-index.js'
import type { NcArtifactPublication } from '../artifact-plane.js'
import type { NcOutboxEnqueueInput } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'
import { countDetections, type DetectionCounts } from '../timelapse/detection-counts.js'
import { type ClosedWindow, findLastClosedWindow } from '../timelapse/window-bounds.js'
import type { NcZoneOwnerLookup } from '../zone-ownership.js'
import { mosaicTextPlan, renderMosaic } from './mosaic-renderer.js'
import { renderSubjectView } from './summary-ai-subject-view.js'
import type { NcSummaryAiInput, NcSummaryAiOutcome, SummaryAiFrame } from './summary-ai.js'
import type { NcSummaryCollector } from './summary-collector.js'
import {
  buildSummaryOutboxInputs,
  type SummaryArtifactRef,
  summaryCaptionText,
} from './summary-delivery.js'
import type { NcSummaryRule } from './summary-rule.js'
import {
  filterSummaryCandidates,
  frameDedupeKey,
  isSubjectCropRung,
  pickSummaryMedia,
  remainingSummaryCandidates,
  type SummaryCandidate,
  type SummaryMediaRow,
  selectSummaryTiles,
} from './summary-selection.js'
import type { NcSummaryStore } from './summary-store.js'
import { decideSummaryWindow, motionWindowCloseAt } from './summary-window.js'

/** How often the producer ticks. */
const SUMMARY_TICK_MS = 60_000

/**
 * How long after a SCHEDULE window closes before it is even considered.
 *
 * Distinct from the track-close barrier and needed alongside it: the barrier
 * counts tracks this process OBSERVED, and a process that started mid-window
 * observed none of the ones already running. The settle is the floor under
 * that blind spot.
 */
const SUMMARY_SETTLE_MS = 5 * 60_000

/** How far back a tick may look for a schedule close. */
const SUMMARY_LOOKBACK_MS = 8 * 86_400_000

/**
 * How many tracks ONE window may read, per camera.
 *
 * `queryHistorical` defaults to `limit ?? 50`, and at that default a busy night
 * would have planned the digest from the fifty most recent tracks and reported
 * "50" for a night that held four hundred. The timelapse hit exactly this.
 */
const SUMMARY_TRACK_QUERY_LIMIT = 2_000

/** The outside world this producer needs. Injected, so every branch is testable. */
export interface NcSummaryPorts {
  /**
   * Tracks whose life overlaps the window, for ONE camera. The wiring maps
   * `Track` rows onto {@link SummaryCandidate}; nothing here reads a `Track`.
   *
   * It MUST answer {@link SummaryCandidate.confirmed} — the threshold is the
   * device's own `minHits` and this side of the boundary does not know it. An
   * implementation that leaves the field absent leaves the promotion gate
   * inert; the filter counts that case rather than hiding it.
   */
  readonly listTracks: (input: {
    readonly deviceId: number
    readonly sinceMs: number
    readonly untilMs: number
    readonly limit: number
  }) => Promise<readonly SummaryCandidate[]>
  /** Media INDEX rows for a track — never the bytes. */
  readonly listMediaInfo: (trackId: string) => Promise<readonly SummaryMediaRow[]>
  /** ONE blob, by media key. */
  readonly readMedia: (mediaId: number) => Promise<Buffer | null>
  /**
   * A whole frame for the model, plus the subject's box ON THAT FRAME and the
   * frame it was measured in.
   *
   * Optional, and absence is not a failure: without it the model is sent the
   * stored crop exactly as before. It exists because every still measured on
   * 102 the night of 2026-09-16 contained a second vehicle and nothing said
   * which one was the subject, so the model invented the relationship between
   * them. See `summary-ai-subject-view.ts`.
   *
   * **The rectangle is right by CONSTRUCTION, never by agreement between two
   * timestamps.** Since D510 the whole-frame media rows carry the box that was
   * measured on them, so the answer is usually the track's own `keyFrame` — no
   * pairing at all. A row written before that column existed still falls back
   * to the nearest `TrackSnapshot`, which is the same guarantee reached the
   * older way; what neither path will ever do is pair an arbitrary stored
   * frame with the nearest recorded position, which can be half a second out,
   * and half a second of a car crossing a 4K frame is a quarter of its width.
   */
  readonly subjectShotFor?: (
    trackId: string,
    deviceId: number,
    aroundMs: number,
  ) => Promise<SummarySubjectShot | null>
  /**
   * What a LOCATION looks like, by its name — operator-authored, shared by
   * every camera in it.
   *
   * Absent, or empty, sends nothing: a hub that never fills it in produces
   * exactly the digest it does today.
   */
  readonly locationDescriptions?: () => Promise<ReadonlyMap<string, string>>
  // NOTE: the map is keyed by the FOLDED location label (trimmed, lower-cased
  // — `locationIconKey`), not by the operator's spelling. The lookup folds to
  // match; see the call site.
  /**
   * `NcArtifactPlane.publishIndexed` — files the bytes on the retained shelf,
   * records them in the viewer's artefact index, and mints the signed link a
   * notifier BACKEND fetches.
   *
   * The two answers fail independently and both are expected: `url: null` on an
   * install with no reachable public address (the digest still ships, and the
   * viewer can still open it), `artifactId: null` on a node with no index.
   */
  readonly publish: (
    bytes: Uint8Array,
    mime: string,
    meta: NcArtifactPublishMeta,
  ) => Promise<NcArtifactPublication>
  /**
   * Persist the finished mosaic where EVENT MEDIA already lives — the
   * operator's directive: same data structure, same storage location, no second
   * retained store. Best-effort and optional: a mosaic that could not be filed
   * must never cost the notification that carries it.
   */
  readonly storeMosaic?: (input: {
    readonly deviceId: number
    /**
     * The RULE this mosaic belongs to — not an owner id, and never a
     * synthetic one (D480).
     *
     * `summary-<ruleId>-<windowEndMs>` used to be built here and handed over
     * as an `ownerId`, which put a string no table has ever held into a
     * table's namespace: 675 rows / 271 MiB on the live hub that no probe
     * could resolve and no sweep could collect. The wiring now owns the
     * mapping (`fileSummaryMosaic`), the media row is owned by the rule, and
     * how many a rule keeps is the writer's bound.
     */
    readonly ruleId: string
    readonly timestamp: number
    readonly jpeg: Buffer
  }) => Promise<number | null>
  readonly getDeviceName?: (deviceId: number) => Promise<string | null>
  /**
   * The camera's operator-authored location label (`DeviceInfo.location`) —
   * WHERE a still was taken, for the AI roster line (`SummaryAiFrame.location`).
   * Nullable at the source and optional here: an absent port, a `null` answer
   * or a read that throws all leave the frame without a location, which the
   * prompt renders exactly as before the label existed.
   */
  readonly getDeviceLocation?: (deviceId: number) => Promise<string | null>
  /** WHICH zones each camera owns — see `zone-ownership.ts`. */
  readonly zoneOwner?: NcZoneOwnerLookup
}

/** The two rules that can place a subject on a stored frame. Declared HERE and
 *  not imported from the store for the same reason `SubjectShot` is a
 *  structural twin: the notification centre states what it consumes, and the
 *  store states what it produces, neither importing the other. */
export type SubjectShotSource = 'media-box' | 'snapshot'

/** A whole frame, and where the subject was in it at that moment. */
export interface SummarySubjectShot {
  readonly mediaId: number
  /** WHICH rule produced the rectangle — recorded at capture on this very
   *  frame (`media-box`, D510), or paired from the nearest snapshot. Both end
   *  in a box, so without this the framing count cannot tell them apart and
   *  the capture-time path could stop silently. */
  readonly source: SubjectShotSource
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
}

export interface NcSummaryProducerDeps extends NcSummaryPorts {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly store: NcSummaryStore
  readonly collector: NcSummaryCollector
  readonly texts?: NcTextCatalog
  /**
   * The joint AI pass (#35 P2) — `NcSummaryAiAnalyst.analyse`, injected.
   *
   * OPTIONAL, and its absence is a normal install rather than a fault: a node
   * with no `llm` provider reachable, or a hub whose AI addon has not been
   * deployed, produces exactly the P1 digest. The producer never constructs it,
   * never imports the analyst, and never treats "not wired" as an error — which
   * is what keeps a rule with `ai.enabled` from becoming a rule that fails.
   */
  readonly analyseAi?: (input: NcSummaryAiInput) => Promise<NcSummaryAiOutcome>
  /** `NcOutbox.enqueue` — the SAME durable queue a detection rule uses. */
  readonly enqueue: (inputs: readonly NcOutboxEnqueueInput[]) => Promise<number>
  readonly disabledTargetIds?: (ruleId: string) => readonly string[]
  readonly settleMs?: number
  readonly lookbackMs?: number
  readonly tickMs?: number
}

/** What one tick did — what the tests and the log line both read. */
export interface SummaryTickReport {
  readonly produced: number
  /** Rules whose window has not closed yet. */
  readonly collecting: number
  /** Rules whose window closed but whose tracks are still running. */
  readonly barrier: number
  /** Rules whose last close is at or below the eligibility floor. */
  readonly beforeFloor: number
  /** Rules whose production failed (and stay eligible). */
  readonly failed: number
  /** Rules with no closed window at all. */
  readonly idle: number
  /** Windows that matched nothing and were not delivered. */
  readonly empty: number
  /**
   * Windows PRODUCED but withheld because the AI pass gave no answer and the
   * rule said `onFailure: 'skip'`.
   *
   * Counted apart from `empty` deliberately: a rule dropping every window
   * because LM Studio is down looks identical to a rule that matched nothing,
   * and one of those is a broken feature.
   */
  readonly skippedByAi: number
}

export interface SummaryRunResult {
  readonly produced: number
  readonly window: ClosedWindow | null
  readonly tiles?: number
  readonly cameras?: number
  readonly matched?: number
  /**
   * PARKED objects the window held and the rule dropped.
   *
   * Reported, never inferred: a Test run that returns 2 tiles out of 40 tracks
   * has to say whether the other 38 were a quiet night or a car park, and this
   * is the only number that distinguishes them.
   */
  readonly droppedStationary?: number
  readonly enqueued?: number
  readonly mosaicBytes?: number
  readonly mosaicUrl?: string
  readonly error?: string
  /** The sentence the model wrote, when there was one — the Test button shows it. */
  readonly aiText?: string
  /** Why there was none. Absent when the rule asked for no AI at all. */
  readonly aiFailure?: string
  /** How many frames the model was shown. */
  readonly aiImages?: number
  /** The window was produced and WITHHELD by `ai.onFailure: 'skip'`. */
  readonly skippedByAi?: true
}

interface MutableReport {
  produced: number
  collecting: number
  barrier: number
  beforeFloor: number
  failed: number
  idle: number
  empty: number
  skippedByAi: number
}

interface LoadTilesInput {
  readonly rule: NcSummaryRule
  readonly preferred: readonly SummaryCandidate[]
  readonly refill: readonly SummaryCandidate[]
  readonly maxTiles: number
}

/** One drawn cell: the track it stands for and the single blob read for it. */
export interface LoadedSummaryTile {
  readonly candidate: SummaryCandidate
  readonly jpeg: Buffer
}

/**
 * What the tile loader drew, and what it REFUSED — per reason.
 *
 * `droppedNoMedia` used to be computed by the caller as
 * `max(0, maxTiles - tiles.length)`, which is the number of EMPTY CELLS in the
 * mosaic and has nothing to do with media: a rule with `maxTiles: 12` on a
 * quiet night that matched 5 tracks and drew all 5 reported
 * `matched: 5, tiles: 5, droppedNoMedia: 7` with not one track dropped. A
 * counter that fires when nothing went wrong is worse than no counter — it is
 * the number an operator reads first when a digest looks thin.
 */
export interface LoadTilesOutcome {
  readonly tiles: readonly LoadedSummaryTile[]
  /** TRACKS whose media the ladder could not serve: no rung, an unreadable
   *  blob, or a read that threw. Never an unfilled cell. */
  readonly droppedNoMedia: number
  /** TRACKS whose picture was the same camera-second as an earlier tile —
   *  deliberate dedupe, not a media fault, and counted apart from it. */
  readonly droppedDuplicateFrame: number
}

const EMPTY_REPORT: SummaryTickReport = {
  produced: 0,
  collecting: 0,
  barrier: 0,
  beforeFloor: 0,
  failed: 0,
  idle: 0,
  empty: 0,
  skippedByAi: 0,
}

/**
 * The earliest window CLOSE a rule may ever be offered.
 *
 * RULE-level, because a digest's output is rule-level: unlike the timelapse
 * there is no per-camera artefact a shared stamp could destroy.
 */
export function summaryEligibilityFloor(rule: NcSummaryRule): number {
  return Math.max(rule.generatedAt ?? 0, rule.createdAt)
}

export class NcSummaryProducer {
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight = false
  private readonly settleMs: number
  private readonly lookbackMs: number
  private readonly tickMs: number
  private readonly texts: NcTextCatalog

  constructor(private readonly deps: NcSummaryProducerDeps) {
    this.settleMs = deps.settleMs ?? SUMMARY_SETTLE_MS
    this.lookbackMs = deps.lookbackMs ?? SUMMARY_LOOKBACK_MS
    this.tickMs = deps.tickMs ?? SUMMARY_TICK_MS
    this.texts = deps.texts ?? new NcTextCatalog()
  }

  /**
   * Boot: arm the interval, then fire the back-fill tick WITHOUT waiting on it.
   *
   * Same contract as the timelapse producer, and for the same reason: a digest
   * tick renders a mosaic and publishes it, so awaiting it here would hold
   * `NotificationCenter.start()` → the addon's `initialize()` → the runner's
   * capability manifest. `start()` resolving means the producer is running,
   * never that the back-fill has finished. See `timelapse-scheduler.start()`
   * for the incident this pins.
   */
  async start(): Promise<void> {
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    void this.tick().catch((err: unknown) => {
      this.deps.logger.warn('summary back-fill tick failed', { meta: { error: String(err) } })
    })
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * One pass over every enabled rule. SINGLE-FLIGHT, and that is the only thing
   * bounding concurrency on this path: ten rules whose windows close together
   * must not open ten simultaneous render/publish sequences.
   */
  async tick(): Promise<SummaryTickReport> {
    if (this.tickInFlight) return EMPTY_REPORT
    this.tickInFlight = true
    const report: MutableReport = { ...EMPTY_REPORT }
    try {
      const now = this.deps.now()
      const rules = this.deps.store.listEnabled()
      this.deps.collector.retainRules(rules.map((r) => r.id))
      const abandoned = this.deps.collector.sweep(now)
      if (abandoned > 0) {
        // Non-zero means the close hook is missing closes, which silently
        // degrades every barrier. It must never be inferred from a graph.
        this.deps.logger.warn('summary collector abandoned tracks that never closed', {
          meta: { abandoned, ...this.deps.collector.stats() },
        })
      }
      for (const rule of rules) {
        await this.tickRule(rule, now, report)
      }
    } finally {
      this.tickInFlight = false
    }
    return report
  }

  /**
   * The operator's Test button: produce the given window right now, ignoring
   * the settle, the barrier and the floor.
   *
   * It DELIVERS — same as `nc.injectTestEvent` and `nc.testTimelapseRule`, for
   * the same reason: a test that stops short of the notifier does not test the
   * thing that breaks. It deliberately does NOT stamp, so pressing Test at noon
   * cannot cancel tonight's scheduled run.
   */
  async runNow(input: {
    readonly ruleId: string
    readonly window?: ClosedWindow
  }): Promise<SummaryRunResult> {
    const rule = this.deps.store.get(input.ruleId)
    if (rule === null) throw new Error(`summary rule not found: ${input.ruleId}`)
    const window = input.window ?? this.lastClosedWindow(rule, this.deps.now())
    if (window === null) {
      return {
        produced: 0,
        window: null,
        error: 'no window has closed recently for this rule',
      }
    }
    return this.produce(rule, window, { stamp: false, deliverEmpty: true })
  }

  // ── one rule, one tick ─────────────────────────────────────────────

  private async tickRule(rule: NcSummaryRule, now: number, report: MutableReport): Promise<void> {
    const decision = this.decide(rule, now)
    if (decision === null) {
      report.idle += 1
      return
    }
    if (decision.kind === 'collecting') {
      report.collecting += 1
      return
    }
    if (decision.kind === 'barrier') {
      report.barrier += 1
      this.deps.logger.debug('summary window waiting for its tracks to close', {
        meta: {
          ruleId: rule.id,
          openTracks: decision.openTracks,
          deadlineMs: decision.deadlineMs,
          trackIds: this.deps.collector
            .openTrackIds(rule.deviceIds, decision.deadlineMs - rule.barrierSeconds * 1000)
            .join(','),
        },
      })
      return
    }
    if (summaryEligibilityFloor(rule) >= decision.window.endMs) {
      report.beforeFloor += 1
      // Not silent — a skipped window must be explainable — but not a warn:
      // this is the CORRECT outcome and it recurs every tick until the rule's
      // first real window closes.
      this.deps.logger.debug('summary window predates the rule — not attempted', {
        meta: {
          ruleId: rule.id,
          windowStart: decision.window.startMs,
          windowEnd: decision.window.endMs,
          createdAt: rule.createdAt,
        },
      })
      if (rule.window.kind === 'motion') {
        this.deps.collector.closeMotionWindow(rule.id, decision.window.endMs)
      }
      return
    }
    if (decision.barrierBroken > 0) {
      this.deps.logger.warn('summary barrier expired with tracks still open', {
        meta: {
          ruleId: rule.id,
          stillOpen: decision.barrierBroken,
          windowEnd: decision.window.endMs,
          barrierSeconds: rule.barrierSeconds,
        },
      })
    }
    const outcome = await this.produce(rule, decision.window, {
      stamp: true,
      deliverEmpty: rule.deliverEmpty,
    })
    if (rule.window.kind === 'motion') {
      this.deps.collector.closeMotionWindow(rule.id, decision.window.endMs)
    }
    if (outcome.error !== undefined) report.failed += 1
    else if (outcome.produced > 0) report.produced += 1
    else if (outcome.skippedByAi === true) report.skippedByAi += 1
    else report.empty += 1
  }

  /** Which window (if any) this rule is standing at, and whether it may run. */
  private decide(rule: NcSummaryRule, now: number): ReturnType<typeof decideSummaryWindow> | null {
    const barrierMs = rule.barrierSeconds * 1000
    if (rule.window.kind === 'schedule') {
      const window = findLastClosedWindow({
        schedule: rule.window.schedule,
        nowMs: now,
        lookbackMs: this.lookbackMs,
      })
      if (window === null) return null
      // The settle is applied by moving the DECISION clock back, not the
      // window: the window is what the schedule says it is, and reporting a
      // shifted one would collect the wrong range.
      return decideSummaryWindow({
        openedAtMs: window.startMs,
        closeAtMs: window.endMs,
        openTracks: this.deps.collector.openTrackCount(rule.deviceIds, window.startMs),
        barrierMs,
        nowMs: now - this.settleMs,
      })
    }
    const open = this.deps.collector.refreshMotionWindow(rule.id, rule.deviceIds)
    if (open === null) return null
    const close = motionWindowCloseAt(open, {
      quietMs: rule.window.quietSeconds * 1000,
      maxWindowMs: rule.window.maxWindowSeconds * 1000,
    })
    return decideSummaryWindow({
      openedAtMs: open.openedAtMs,
      closeAtMs: close.closeAtMs,
      openTracks: this.deps.collector.openTrackCount(rule.deviceIds, open.openedAtMs),
      barrierMs,
      nowMs: now,
      cappedByCeiling: close.cappedByCeiling,
    })
  }

  private lastClosedWindow(rule: NcSummaryRule, now: number): ClosedWindow | null {
    if (rule.window.kind === 'schedule') {
      return findLastClosedWindow({
        schedule: rule.window.schedule,
        nowMs: now,
        lookbackMs: this.lookbackMs,
      })
    }
    const open = this.deps.collector.motionWindow(rule.id)
    if (open !== null) return { startMs: open.openedAtMs, endMs: now }
    // No window has been observed: offer the rule's own rolling span ending
    // now. It is the honest answer to "show me what a window would contain".
    return { startMs: now - rule.window.maxWindowSeconds * 1000, endMs: now }
  }

  // ── the production ─────────────────────────────────────────────────

  /**
   * Collect → select → read → render → publish → enqueue → (optionally) stamp.
   * Never throws.
   */
  private async produce(
    rule: NcSummaryRule,
    window: ClosedWindow,
    opts: { readonly stamp: boolean; readonly deliverEmpty: boolean },
  ): Promise<SummaryRunResult> {
    const meta = {
      ruleId: rule.id,
      deviceIds: rule.deviceIds.join(','),
      windowStart: window.startMs,
      windowEnd: window.endMs,
    }
    try {
      const candidates = await this.collectCandidates(rule, window)
      const filtered = filterSummaryCandidates(candidates, rule.filters, this.deps.zoneOwner)
      const selection = selectSummaryTiles(filtered.kept, {
        maxTiles: rule.maxTiles,
        rank: rule.rank,
      })

      if (selection.tiles.length === 0 && !opts.deliverEmpty) {
        this.deps.logger.info('summary window held nothing — not delivered', {
          meta: {
            ...meta,
            scanned: candidates.length,
            droppedByClass: filtered.droppedByClass,
            droppedByZone: filtered.droppedByZone,
            droppedByImportance: filtered.droppedByImportance,
            droppedByDwell: filtered.droppedByDwell,
            droppedStationary: filtered.droppedStationary,
            // The promotion gate is unconditional, so an empty window has to
            // say whether it was empty or merely unpromoted — and
            // `unknownConfirmation` is the only line that would ever reveal a
            // port that stopped answering, leaving the gate inert.
            droppedUnconfirmed: filtered.droppedUnconfirmed,
            unknownConfirmation: filtered.unknownConfirmation,
          },
        })
        // Stamped anyway: the window WAS evaluated, and leaving it eligible
        // would re-scan the same empty range every minute forever.
        if (opts.stamp) await this.deps.store.markGenerated(rule.id, window.endMs)
        return {
          produced: 0,
          window,
          tiles: 0,
          cameras: 0,
          matched: 0,
          droppedStationary: filtered.droppedStationary,
        }
      }

      const tileLoad = await this.loadTiles({
        rule,
        preferred: selection.tiles,
        // Refill from the FILTERED list, never the raw subjects: a refill must
        // not bring back what the filter dropped.
        refill: remainingSummaryCandidates(filtered.kept, selection.tiles, rule.rank),
        maxTiles: rule.maxTiles,
      })
      const loaded = tileLoad.tiles
      const detections: DetectionCounts = countDetections({
        tracks: selection.tiles.map((t) => ({
          firstSeen: t.firstSeen,
          lastSeen: t.lastSeen,
          className: t.className,
        })),
      })

      const names = await this.resolveDeviceNames(loaded.map((t) => t.candidate.deviceId))
      const mosaic = await this.renderAndPublish(rule, window, loaded, names)

      // THE AI PASS, and its position is deliberate: after the artefact is
      // rendered, filed and published, before anything is enqueued. The model
      // call is the only step here measured in minutes, and putting it last
      // means a hub that dies mid-generation still leaves the mosaic on the
      // retained shelf.
      const ai = await this.analyse(rule, window, loaded, names)
      if (!ai.deliver) {
        this.deps.logger.warn(
          'summary WITHHELD — the AI pass gave no answer and the rule says skip',
          {
            meta: { ...meta, tiles: loaded.length, cause: ai.aiFailure },
          },
        )
        // Stamped. `skip` is a policy the operator chose, not a failure of
        // production: leaving the window eligible would re-render and re-ask
        // every minute for as long as the model stays down.
        if (opts.stamp) await this.deps.store.markGenerated(rule.id, window.endMs)
        return {
          produced: 0,
          window,
          tiles: loaded.length,
          droppedStationary: filtered.droppedStationary,
          skippedByAi: true,
          ...(ai.aiFailure !== undefined ? { aiFailure: ai.aiFailure } : {}),
          ...(ai.aiImages !== undefined ? { aiImages: ai.aiImages } : {}),
        }
      }

      const rows = buildSummaryOutboxInputs({
        texts: this.texts,
        ruleId: rule.id,
        ruleName: rule.name,
        window,
        deviceIds: rule.deviceIds,
        primaryDeviceId: rule.deviceIds[0] ?? 0,
        targets: rule.targets as readonly NcRuleTarget[],
        ...(this.deps.disabledTargetIds !== undefined
          ? { disabledTargetIds: this.deps.disabledTargetIds(rule.id) }
          : {}),
        priority: rule.priority,
        tileCount: loaded.length,
        cameraCount: new Set(loaded.map((t) => t.candidate.deviceId)).size,
        matchedCount: filtered.kept.length,
        detections,
        ...(mosaic.ref !== null ? { mosaic: mosaic.ref } : {}),
        generatedAt: this.deps.now(),
        ...(rule.template !== undefined ? { template: rule.template } : {}),
        ...(ai.aiText !== undefined ? { aiText: ai.aiText } : {}),
      })
      const enqueued = await this.deps.enqueue(rows)
      if (opts.stamp) await this.deps.store.markGenerated(rule.id, window.endMs)

      this.deps.logger.info('summary produced', {
        meta: {
          ...meta,
          scanned: candidates.length,
          matched: filtered.kept.length,
          // A drop this large has to be visible: it is the difference between
          // "the night was quiet" and "the night was a car park".
          droppedStationary: filtered.droppedStationary,
          droppedUnconfirmed: filtered.droppedUnconfirmed,
          unknownConfirmation: filtered.unknownConfirmation,
          droppedByClass: filtered.droppedByClass,
          tiles: loaded.length,
          cameras: new Set(loaded.map((t) => t.candidate.deviceId)).size,
          camerasDropped: selection.camerasDropped,
          // TRACKS the ladder could not serve a picture for — reported by the
          // loop that did the refusing, never re-derived from the tile count.
          droppedNoMedia: tileLoad.droppedNoMedia,
          droppedDuplicateFrame: tileLoad.droppedDuplicateFrame,
          mosaicBytes: mosaic.bytes,
          mosaicPublished: mosaic.ref !== null,
          enqueued,
          stamped: opts.stamp,
          aiImages: ai.aiImages ?? 0,
          aiDescribed: ai.aiText !== undefined,
          ...(ai.aiFailure !== undefined ? { aiFailure: ai.aiFailure } : {}),
        },
      })
      return {
        produced: 1,
        window,
        tiles: loaded.length,
        cameras: new Set(loaded.map((t) => t.candidate.deviceId)).size,
        matched: filtered.kept.length,
        droppedStationary: filtered.droppedStationary,
        enqueued,
        ...(mosaic.bytes > 0 ? { mosaicBytes: mosaic.bytes } : {}),
        ...(mosaic.ref !== null ? { mosaicUrl: mosaic.ref.url } : {}),
        ...(ai.aiText !== undefined ? { aiText: ai.aiText } : {}),
        ...(ai.aiFailure !== undefined ? { aiFailure: ai.aiFailure } : {}),
        ...(ai.aiImages !== undefined ? { aiImages: ai.aiImages } : {}),
      }
    } catch (err: unknown) {
      // Named, never silent: a window that produced nothing and said nothing is
      // indistinguishable from a night nobody configured.
      this.deps.logger.warn('summary not produced — the window stays eligible', {
        meta: { ...meta, error: String(err) },
      })
      return {
        produced: 0,
        window,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Every camera's tracks in the window, capped per camera and counted. */
  private async collectCandidates(
    rule: NcSummaryRule,
    window: ClosedWindow,
  ): Promise<readonly SummaryCandidate[]> {
    const all: SummaryCandidate[] = []
    for (const deviceId of rule.deviceIds) {
      try {
        const rows = await this.deps.listTracks({
          deviceId,
          sinceMs: window.startMs,
          untilMs: window.endMs,
          limit: SUMMARY_TRACK_QUERY_LIMIT,
        })
        if (rows.length >= SUMMARY_TRACK_QUERY_LIMIT) {
          // A truncated window must SAY so: otherwise the digest represents the
          // tail of the window and reads as the whole of it.
          this.deps.logger.warn('summary track scan hit the per-camera ceiling', {
            tags: { deviceId },
            meta: { ruleId: rule.id, limit: SUMMARY_TRACK_QUERY_LIMIT },
          })
        }
        all.push(...rows)
      } catch (err: unknown) {
        // One unreadable camera must not cost the whole digest — but it must
        // never be invisible either.
        this.deps.logger.warn('summary could not read a camera for this window', {
          tags: { deviceId },
          meta: { ruleId: rule.id, error: String(err) },
        })
      }
    }
    return all
  }

  /** One blob per tile — the cheap question (index rows) always first.
   *  Duplicate camera-seconds are skipped so tracker ID churn cannot paint
   *  the same driveway eleven times; leftover ranked candidates refill.
   *
   *  It COUNTS what it drops, per reason, because only this loop knows: the
   *  caller sees tiles and has no way to tell a track that had no picture from
   *  a rule whose quota was simply larger than the night. */
  private async loadTiles(input: LoadTilesInput): Promise<LoadTilesOutcome> {
    const tiles: LoadedSummaryTile[] = []
    // WHICH RUNG served each tile. The ladder's head is meant to be a crop of
    // the subject and its foot is the whole scene, and which one a track got
    // decides what the model can even see — yet nothing said so. Diagnosing a
    // run of summaries that described whole car parks meant downloading the
    // blobs and reading their JPEG headers by hand (2026-09-16). One line.
    const rungs = new Map<string, number>()
    const seenFrames = new Set<string>()
    const seenIds = new Set<string>()
    let droppedNoMedia = 0
    let droppedDuplicateFrame = 0
    const queue = [...input.preferred, ...input.refill]
    for (const candidate of queue) {
      if (tiles.length >= input.maxTiles) break
      if (seenIds.has(candidate.trackId)) continue
      seenIds.add(candidate.trackId)
      const tags = { deviceId: candidate.deviceId }
      try {
        const rows = await this.deps.listMediaInfo(candidate.trackId)
        const picked = pickSummaryMedia(rows, (candidate.firstSeen + candidate.lastSeen) / 2)
        if (picked === null) {
          droppedNoMedia += 1
          // A track with no usable media is DROPPED, never rendered as an empty
          // cell — a black square reads as "the camera saw nothing". Usable
          // means a subject crop, else the clean whole scene.
          //
          // `info`, not `debug`, and the level is the point: this is the ONLY
          // line that can answer "why does 102 render fewer tiles than 101?",
          // and at `debug` it never reached the log pipeline — three days of
          // whole-frame digests produced no evidence at all. `mediaKinds` is
          // carried because "the track had 9 rows and the ladder refused all
          // of them" and "the track had nothing" are different faults.
          this.deps.logger.info('summary tile dropped: the track carries no clean media', {
            tags,
            meta: {
              ruleId: input.rule.id,
              trackId: candidate.trackId,
              mediaRows: rows.length,
              mediaKinds: [...new Set(rows.map((row) => row.kind))].sort(),
            },
          })
          continue
        }
        const frameKey = frameDedupeKey(candidate.deviceId, picked.timestamp)
        if (seenFrames.has(frameKey)) {
          // NOT `droppedNoMedia`: this track had a picture and we chose not to
          // paint it twice. Folding the two together is what made the old
          // number unreadable.
          droppedDuplicateFrame += 1
          this.deps.logger.info('summary tile dropped: same frame as an earlier tile', {
            tags,
            meta: {
              ruleId: input.rule.id,
              trackId: candidate.trackId,
              frameKey,
            },
          })
          continue
        }
        const jpeg = await this.deps.readMedia(picked.mediaId)
        if (jpeg === null || jpeg.byteLength === 0) {
          droppedNoMedia += 1
          this.deps.logger.info('summary tile dropped: the media blob could not be read', {
            tags,
            meta: {
              ruleId: input.rule.id,
              trackId: candidate.trackId,
              mediaId: picked.mediaId,
              mediaKind: picked.kind,
            },
          })
          continue
        }
        seenFrames.add(frameKey)
        rungs.set(picked.kind, (rungs.get(picked.kind) ?? 0) + 1)
        tiles.push({ candidate, jpeg })
      } catch (err: unknown) {
        droppedNoMedia += 1
        this.deps.logger.warn('summary tile dropped: reading its media threw', {
          tags,
          meta: {
            ruleId: input.rule.id,
            trackId: candidate.trackId,
            error: String(err),
          },
        })
      }
    }
    // A subject CROP and a whole scene are different pictures and produce
    // different sentences; `SUMMARY_SUBJECT_CROP_RUNGS` says the head of the
    // ladder must be a crop, and this is the only line that can say whether it
    // was — per rung, so "the crop was refused" and "the track had nothing"
    // stay different faults.
    if (tiles.length > 0) {
      this.deps.logger.info('summary tiles: media rungs served', {
        meta: {
          ruleId: input.rule.id,
          tiles: tiles.length,
          rungs: Object.fromEntries([...rungs.entries()].sort()),
          subjectCrops: [...rungs.entries()]
            .filter(([kind]) => isSubjectCropRung(kind))
            .reduce((n, [, count]) => n + count, 0),
        },
      })
    }
    return { tiles, droppedNoMedia, droppedDuplicateFrame }
  }

  /**
   * Render the mosaic, file it where event media lives, and mint the public
   * link the notifier BACKEND will fetch.
   *
   * Every step is best-effort in the delivery direction: a mosaic that could
   * not be rendered, filed or published still leaves a digest with correct
   * counts, and that is worth more than silence.
   */
  private async renderAndPublish(
    rule: NcSummaryRule,
    window: ClosedWindow,
    tiles: readonly {
      readonly candidate: SummaryCandidate
      readonly jpeg: Buffer
    }[],
    names: ReadonlyMap<number, string>,
  ): Promise<{
    readonly ref: SummaryArtifactRef | null
    readonly bytes: number
  }> {
    if (tiles.length === 0) return { ref: null, bytes: 0 }
    let rendered: Awaited<ReturnType<typeof renderMosaic>>
    try {
      // The rule decides, and the DEFAULT is pictures only. Nothing is composed
      // that will not be drawn: `mosaicTextPlan` is asked once here so a
      // `none` digest never even builds the label strings, and the renderer
      // asks it again as the backstop.
      const plan = mosaicTextPlan(rule.captions)
      rendered = await renderMosaic(
        {
          purpose: 'summary',
          tiles: tiles.map(({ candidate, jpeg }) => ({
            jpeg,
            ...(plan.tileLabels
              ? {
                  label: `${names.get(candidate.deviceId) ?? candidate.deviceId} · ${clockOf(candidate.firstSeen)} · ${candidate.className}`,
                }
              : {}),
            deviceId: candidate.deviceId,
            sourceId: candidate.trackId,
          })),
          captions: rule.captions,
          ...(plan.titleBand
            ? {
                caption: summaryCaptionText({
                  ...(rule.captionText !== undefined ? { captionText: rule.captionText } : {}),
                  ruleName: rule.name,
                  window,
                }),
              }
            : {}),
        },
        this.deps.logger,
      )
    } catch (err: unknown) {
      this.deps.logger.warn('summary mosaic could not be composed — delivering the counts alone', {
        meta: { ruleId: rule.id, tiles: tiles.length, error: String(err) },
      })
      return { ref: null, bytes: 0 }
    }

    // Filed where EVENT MEDIA lives — same structure, same location, no second
    // retained store (operator directive). Best-effort by construction.
    const file = this.deps.storeMosaic
    if (file !== undefined) {
      try {
        await file({
          deviceId: rule.deviceIds[0] ?? 0,
          ruleId: rule.id,
          timestamp: window.endMs,
          jpeg: rendered.jpeg,
        })
      } catch (err: unknown) {
        this.deps.logger.warn('summary mosaic was not filed — the notification still ships', {
          meta: { ruleId: rule.id, error: String(err) },
        })
      }
    }

    // sharp answers a Buffer, and a Buffer that crosses a transport throws
    // `Trying to deserialize unknown typed array` on the far side — superjson
    // registers typed-array constructor names and `Buffer` is not one of them.
    // The copy is the guard, not a detail.
    const bytes = new Uint8Array(rendered.jpeg.byteLength)
    bytes.set(rendered.jpeg)
    // A digest is CROSS-CAMERA: it is filed under the rule's first camera —
    // the same camera its outbox row uses — and carries the cameras that
    // actually produced a tile for display. Filing it under whichever camera
    // was busiest that night would scatter a rule's history.
    const { url } = await this.deps.publish(bytes, 'image/jpeg', {
      kind: 'summary-mosaic',
      deviceId: rule.deviceIds[0] ?? null,
      deviceIds: [...new Set(tiles.map((t) => t.candidate.deviceId))],
      capturedAt: window.endMs,
      ruleId: rule.id,
      ruleName: rule.name,
      ...(rule.ownerUserId !== undefined ? { ownerUserId: rule.ownerUserId } : {}),
    })
    if (url === null) {
      this.deps.logger.warn('summary mosaic not published: no reachable public endpoint', {
        meta: { ruleId: rule.id },
      })
      return { ref: null, bytes: bytes.byteLength }
    }
    return {
      ref: { url, mime: 'image/jpeg', name: 'summary.jpg' },
      bytes: bytes.byteLength,
    }
  }

  /**
   * Every contributing camera's name, resolved ONCE.
   *
   * Shared by the mosaic labels and the AI prompt so the two cannot disagree
   * about what a camera is called — and so a digest costs one name lookup per
   * camera rather than two.
   */
  private async resolveDeviceNames(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const names = new Map<number, string>()
    for (const deviceId of deviceIds) {
      if (names.has(deviceId)) continue
      const get = this.deps.getDeviceName
      const name = get === undefined ? null : await get(deviceId).catch(() => null)
      names.set(deviceId, name ?? `camera ${String(deviceId)}`)
    }
    return names
  }

  /**
   * The operator's location label per contributing camera, for the AI roster.
   *
   * Same shape as {@link resolveDeviceNames} but a separate map, because the
   * two degrade differently: a camera with no NAME still needs a label (the
   * fallback `camera <id>`), while a camera with no LOCATION simply has none —
   * an entry is only present when the operator wrote one, so the frame builder
   * can omit the field outright.
   */
  private async resolveDeviceLocations(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    const locations = new Map<number, string>()
    const get = this.deps.getDeviceLocation
    if (get === undefined) return locations
    for (const deviceId of new Set(deviceIds)) {
      const location = await get(deviceId).catch(() => null)
      if (location !== null && location.trim().length > 0) {
        locations.set(deviceId, location)
      }
    }
    return locations
  }

  /**
   * The joint AI pass over the frames that became tiles (#35 P2).
   *
   * Every early return is a NON-EVENT rather than a failure: no analyst wired,
   * no `ai` section, `enabled: false`, or no tiles at all. None of them logs a
   * warning, because none of them is wrong — and the operator who DID switch it
   * on learns from the analyst's own counted fail-open line.
   *
   * The `catch` is the load-bearing part. `analyseAi` reaches another addon
   * through `ctx.api`, and a cross-addon call can throw for reasons that have
   * nothing to do with this window (the AI addon not installed, a runner
   * respawning mid-call). A throw here must cost the SENTENCE, never the
   * digest — which is the same fail-open the analyst applies internally, held
   * one level higher so it also covers the transport.
   */
  private async analyse(
    rule: NcSummaryRule,
    window: ClosedWindow,
    tiles: readonly { readonly candidate: SummaryCandidate; readonly jpeg: Buffer }[],
    names: ReadonlyMap<number, string>,
  ): Promise<{
    readonly deliver: boolean
    readonly aiText?: string
    readonly aiFailure?: string
    readonly aiImages?: number
  }> {
    const analyse = this.deps.analyseAi
    if (analyse === undefined || rule.ai?.enabled !== true || tiles.length === 0) {
      return { deliver: true }
    }
    // Capped HERE, not only inside the analyst: the tiles arrive in the
    // selection's rank order, so the first `maxAiImages` are the most relevant
    // ones — and copying bytes for frames that will never be sent is exactly
    // the "read the media before knowing you need it" the rest of this file
    // avoids. The analyst re-applies the same bound; that one is the backstop.
    const capped = tiles.slice(0, Math.max(0, rule.maxAiImages))
    // WHERE each camera is, from the device model — resolved only for the
    // frames that actually go up, and only when the wiring provides the port.
    const locations = await this.resolveDeviceLocations(capped.map((t) => t.candidate.deviceId))
    // What the PLACES are, operator-authored. Read whole, once.
    // ONE store read per digest, never one per location: that thread is
    // synchronous, and D447 is this repo's record of a settings store queueing
    // behind a reader that asked per key.
    const describeAll = this.deps.locationDescriptions
    const placeText =
      describeAll === undefined
        ? new Map<string, string>()
        : await describeAll().catch(() => new Map<string, string>())
    // The picture the MODEL sees, subject boxed, cut from the snapshot whose
    // rectangle was recorded on the same frame. Counted, because a silently
    // unboxed run looks exactly like a boxed one from the outside and the
    // whole point is that the model can tell the subject from its neighbour.
    let boxed = 0
    let boxRefused = 0
    // Per SOURCE, because both end in a rectangle. `fromMediaBox` falling to
    // zero while `boxed` holds is the capture-time path going quiet — the one
    // failure the count alone cannot show.
    const boxedBySource = new Map<SubjectShotSource, number>()
    // WHY a frame went unboxed. The count alone said "some did not" and left
    // the next question — a track with no snapshot? a blob that would not
    // read? a box outside its own picture? — to be answered by hand.
    const unboxedWhy = new Map<string, number>()
    const noteUnboxed = (reason: string): void => {
      boxRefused += 1
      unboxedWhy.set(reason, (unboxedWhy.get(reason) ?? 0) + 1)
    }
    const aiJpegs = await Promise.all(
      capped.map(async ({ candidate, jpeg }) => {
        const pick = this.deps.subjectShotFor
        if (pick === undefined) return jpeg
        try {
          const shot = await pick(
            candidate.trackId,
            candidate.deviceId,
            // The same instant `pickSummaryMedia` aims at, so the boxed view
            // and the tile are pictures of the same moment.
            (candidate.firstSeen + candidate.lastSeen) / 2,
          )
          if (shot === null) {
            // Neither source could answer: no media row carrying its own box
            // (D510) AND no snapshot to pair. One reason, because from here
            // they are the same outcome — this track cannot be boxed at all.
            noteUnboxed('no-subject-box')
            return jpeg
          }
          const bytes = await this.deps.readMedia(shot.mediaId)
          if (bytes === null || bytes.byteLength === 0) {
            noteUnboxed('snapshot-unreadable')
            return jpeg
          }
          const view = await renderSubjectView(bytes, shot.bbox, shot.frameWidth, shot.frameHeight)
          if (view === null) {
            noteUnboxed('no-honest-view')
            return jpeg
          }
          boxed += 1
          boxedBySource.set(shot.source, (boxedBySource.get(shot.source) ?? 0) + 1)
          return view
        } catch (err) {
          // A picture we could not box is a picture, not a failure: the digest
          // ships with the crop it already had. Audible, because "the boxes
          // stopped" must never be silent.
          noteUnboxed('threw')
          this.deps.logger.info('summary ai: subject box skipped', {
            tags: { deviceId: candidate.deviceId },
            meta: { ruleId: rule.id, trackId: candidate.trackId, error: String(err) },
          })
          return jpeg
        }
      }),
    )
    this.deps.logger.info('summary ai: subject framing', {
      meta: {
        ruleId: rule.id,
        frames: capped.length,
        boxed,
        fromMediaBox: boxedBySource.get('media-box') ?? 0,
        fromSnapshot: boxedBySource.get('snapshot') ?? 0,
        unboxed: boxRefused,
        // ABSENT when nothing was refused, rather than an empty object: a line
        // about a clean run must not carry a field that reads as a fault.
        ...(unboxedWhy.size === 0 ? {} : { unboxedWhy: Object.fromEntries(unboxedWhy) }),
      },
    })
    const frames: readonly SummaryAiFrame[] = capped.map(({ candidate, jpeg }, i) => {
      // A Buffer IS a Uint8Array, but a Buffer that crosses a transport throws
      // `Trying to deserialize unknown typed array` on the far side — the same
      // copy the mosaic publish makes, for the same reason.
      const source = aiJpegs[i] ?? jpeg
      const bytes = new Uint8Array(source.byteLength)
      bytes.set(source)
      const location = locations.get(candidate.deviceId)
      // FOLDED, because the description hangs off the location itself and is
      // keyed the way the registry matches labels everywhere (trimmed,
      // lower-cased) while the camera carries the operator's own spelling. A
      // raw lookup misses on a case difference and degrades in silence — the
      // model is simply told the place name and nothing says a description
      // existed.
      const described =
        location === undefined ? undefined : placeText.get(location.trim().toLowerCase())
      return {
        deviceId: candidate.deviceId,
        deviceName: names.get(candidate.deviceId) ?? `camera ${String(candidate.deviceId)}`,
        className: candidate.className,
        // ABSENT when the camera has none — the frame must never carry a null
        // for the prompt to render.
        ...(location !== undefined ? { location } : {}),
        ...(described !== undefined && described.length > 0
          ? { locationDescription: described }
          : {}),
        atMs: candidate.firstSeen,
        jpeg: bytes,
      }
    })
    const input: NcSummaryAiInput = {
      ruleId: rule.id,
      ruleName: rule.name,
      ai: rule.ai,
      window: { startMs: window.startMs, endMs: window.endMs },
      frames,
      maxImages: rule.maxAiImages,
    }
    const outcome = await analyse(input).catch((err: unknown): NcSummaryAiOutcome => {
      this.deps.logger.warn('summary AI pass threw — delivering the digest without its text', {
        meta: { ruleId: rule.id, frames: frames.length, error: String(err) },
      })
      return {
        text: null,
        deliver: true,
        failure: 'error',
        reason: String(err),
        latencyMs: 0,
        images: 0,
      }
    })
    return {
      deliver: outcome.deliver,
      ...(outcome.text !== null ? { aiText: outcome.text } : {}),
      ...(outcome.failure !== undefined ? { aiFailure: outcome.failure } : {}),
      aiImages: outcome.images,
    }
  }
}

/** `HH:MM` in the host timezone — the two numbers a tile label needs. */
function clockOf(atMs: number): string {
  const d = new Date(atMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
