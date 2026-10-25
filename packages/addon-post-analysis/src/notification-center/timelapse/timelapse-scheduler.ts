/**
 * TimelapseScheduler — the post-hoc producer's loop.
 *
 * It answers five questions per (rule, camera) and nothing else:
 *   1. has a window CLOSED?           `findLastClosedWindow`
 *   2. has it SETTLED?                `now >= close + TIMELAPSE_SETTLE_MS`
 *   3. is the close above this pair's ELIGIBILITY FLOOR?  {@link timelapseEligibilityFloor}
 *   4. has this pair already produced it?  `readTimelapseGeneratedAt`
 *   5. did the render AND the enqueue both succeed?  → stamp, and only then
 *
 * Point 5 is the whole reason this module is shaped the way it is. The
 * predecessor design closed the window and stamped the rule, and then
 * rendered: one ffmpeg failure cost the entire night, permanently, because a
 * closed window does not come back. The stamp is now the LAST thing that
 * happens, per (rule, device), and a failure leaves the pair eligible for the
 * next tick.
 *
 * Restart is cheap by construction. "Which window closed while we were down"
 * is a pure function of the schedule and the clock, and the per-pair stamp
 * says whether it was produced — so boot is just a tick, and because
 * `findLastClosedWindow` only ever reports the MOST RECENT close, a hub that
 * was down for a week back-fills one window, not seven.
 *
 * Point 3 is what keeps that back-fill honest. It is right for a restart and
 * wrong for a NEW rule: an unstamped pair looks identical either way, so a rule
 * created this morning reached back to a window that closed before it existed
 * and retried it every single tick, forever (live: rule 16fa78ac / camera 1441,
 * created ~10:45, warn-logging `no footage for 1441 in …` against the
 * 21:00→07:00 window that had already closed). The floor separates "we missed
 * it" from "it was never ours".
 *
 * Every log line carries `tags: { deviceId }`.
 */

import type { IScopedLogger, NcRuleTarget, TimelapseRule } from '@camstack/types'
import { readTimelapseGeneratedAt } from '@camstack/types'
import type { NcOutboxEnqueueInput } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'
import { buildTimelapseOutboxInputs, timelapsePreviewText } from './timelapse-delivery.js'
import type { TimelapseRenderOutcome, TimelapseRenderRequest } from './timelapse-renderer.js'
import type { TimelapseStore } from './timelapse-store.js'
import { type ClosedWindow, findLastClosedWindow } from './window-bounds.js'

/**
 * How long after a window closes before it is rendered.
 *
 * A track is persisted when it CLOSES, and a track that was open at 06:00
 * lands minutes later. Rendering at the stroke of the boundary would miss
 * exactly the tracks the dense plan is built from — the ones still moving when
 * the window ended.
 */
export const TIMELAPSE_SETTLE_MS = 5 * 60_000

/**
 * How far back a tick may look for a close.
 *
 * Eight days, so a hub that was down over a long weekend still finds last
 * night. The scan short-circuits at the first close it meets, so a rule with a
 * nightly window costs about a day's worth of minute steps, not eight.
 */
export const TIMELAPSE_LOOKBACK_MS = 8 * 86_400_000

/** How often the scheduler ticks once started. */
const TIMELAPSE_TICK_MS = 60_000

/**
 * The earliest window CLOSE a (rule, device) pair may ever be offered.
 *
 * `max(this device's last generation, the rule's birth)`:
 *  - the per-device stamp is the re-generation guard — a window already
 *    produced for THIS camera is done (and a sibling camera's success says
 *    nothing about it, hence `readTimelapseGeneratedAt` and not the rule-wide
 *    field);
 *  - `createdAt` is what stops a brand-new rule mining the past. Without it an
 *    unstamped pair is indistinguishable from one the hub was down for, and
 *    the back-fill happily reaches back a full lookback for footage no rule was
 *    ever recording against.
 *
 * The comparison is against the window's CLOSE, matching the stamp guard: a
 * rule created mid-window still gets that window (its footage exists), a rule
 * created after the close never does.
 *
 * RULE-LEVEL, deliberately. `TimelapseRule.deviceIds` is a plain array that a
 * patch replaces wholesale, so there is no per-device add time to floor
 * against; a camera added to an old rule may therefore be offered the one
 * window that closed before it joined. That over-produces at most a single
 * video, whereas the defect this function exists to stop is unbounded — an
 * every-minute retry of a window nothing can satisfy. If a per-device add time
 * is ever persisted, raise the floor to `max(…, addedAt)` here and nowhere
 * else.
 */
function timelapseEligibilityFloor(rule: TimelapseRule, deviceId: number): number {
  return Math.max(readTimelapseGeneratedAt(rule, deviceId), rule.createdAt)
}

/** The renderer, as a function — the scheduler never constructs one. */
export type TimelapseRenderFn = (request: TimelapseRenderRequest) => Promise<TimelapseRenderOutcome>

export interface TimelapseSchedulerDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly store: TimelapseStore
  readonly render: TimelapseRenderFn
  /**
   * The hub's words. OPTIONAL, defaulting to the shipped English bundle for
   * the same reason the dispatcher's is: a catalog with no snapshot IS a
   * complete text set, so a producer wired without one speaks rather than
   * printing keys.
   */
  readonly texts?: NcTextCatalog
  /** `NcOutbox.enqueue` — the SAME durable queue a detection rule uses. */
  readonly enqueue: (inputs: readonly NcOutboxEnqueueInput[]) => Promise<number>
  /** Display name for the body; best-effort. */
  readonly getDeviceName?: (deviceId: number) => Promise<string | null>
  /** Per-target opt-out set for this rule (mirrors `NcRule.disabledTargetIds`). */
  readonly disabledTargetIds?: (ruleId: string) => readonly string[]
  readonly settleMs?: number
  readonly lookbackMs?: number
  readonly tickMs?: number
}

/** What one tick did — the shape the tests and the log line both read. */
export interface TimelapseTickReport {
  readonly produced: number
  /** Pairs whose window has closed but not yet settled. */
  readonly waiting: number
  /** Pairs whose window was already produced. */
  readonly alreadyDone: number
  /**
   * Pairs whose last closed window sits BELOW the eligibility floor — the
   * window closed before the rule existed. Counted apart from `alreadyDone`
   * because it is a different fact: nothing was produced and nothing is owed.
   */
  readonly beforeFloor: number
  /** Pairs whose render or enqueue failed (and stay eligible). */
  readonly failed: number
  /** Pairs with no closed window in the lookback. */
  readonly idle: number
  /** Pairs already rendering from a previous tick — not started again. */
  readonly skippedInFlight: number
}

export interface TimelapseRunNowInput {
  readonly ruleId: string
  readonly deviceId: number
}

export interface TimelapseRunNowResult {
  readonly produced: number
  readonly window: ClosedWindow | null
  readonly exportId?: string
  readonly coveragePercent?: number
  readonly enqueued?: number
  readonly error?: string
}

interface MutableReport {
  produced: number
  waiting: number
  alreadyDone: number
  beforeFloor: number
  failed: number
  idle: number
  skippedInFlight: number
}

const EMPTY_REPORT: TimelapseTickReport = {
  produced: 0,
  waiting: 0,
  alreadyDone: 0,
  beforeFloor: 0,
  failed: 0,
  idle: 0,
  skippedInFlight: 0,
}

/** One render this process is currently waiting on. */
export interface TimelapseRenderInFlight {
  readonly ruleId: string
  readonly deviceId: number
  readonly window: ClosedWindow
  /** When `produce` started it — what "rendering since …" reads. */
  readonly startedAt: number
}

/** The in-flight map's key. One render per (rule, camera) pair by construction. */
function renderFlightKey(ruleId: string, deviceId: number): string {
  return `${ruleId}:${String(deviceId)}`
}

export class TimelapseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  /** True only while this tick is scanning eligibility — not while ffmpeg runs. */
  private scanning = false
  private readonly inFlight = new Map<string, TimelapseRenderInFlight>()
  private readonly settleMs: number
  private readonly lookbackMs: number
  private readonly tickMs: number
  private readonly texts: NcTextCatalog

  constructor(private readonly deps: TimelapseSchedulerDeps) {
    this.settleMs = deps.settleMs ?? TIMELAPSE_SETTLE_MS
    this.lookbackMs = deps.lookbackMs ?? TIMELAPSE_LOOKBACK_MS
    this.tickMs = deps.tickMs ?? TIMELAPSE_TICK_MS
    this.texts = deps.texts ?? new NcTextCatalog()
  }

  /**
   * Boot: arm the interval, then fire the back-fill tick WITHOUT waiting on it.
   *
   * The back-fill needs no special path — it IS a tick. A window that closed
   * while the process was down is simply a window whose pair has no stamp.
   *
   * `start()` resolving must mean "the producer is running", never "the
   * back-fill has finished". A back-fill tick renders video: one window can sit
   * in `awaitReady` for the full `RENDER_TIMEOUT_MS` (30 min), once per (rule,
   * camera) pair. Awaiting it here held `NotificationCenter.start()`, which held
   * the addon's `initialize()`, which is what publishes the runner's capability
   * manifest — so on 2026-08-14 a single 10-hour timelapse window took
   * `notification-rules`, `videoclips`, `face-gallery`, `plate-gallery`,
   * `zone-analytics`, `audio-metrics` and `pipeline-analytics` off the cluster
   * entirely, and the admin UI answered "provider not available".
   *
   * `tick()` never throws for a render failure — `produce()` swallows those and
   * leaves the pair unstamped — so the catch here only covers a store read that
   * fails, and it must not become an unhandled rejection.
   */
  async start(): Promise<void> {
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    void this.tick().catch((err: unknown) => {
      this.deps.logger.warn('timelapse back-fill tick failed', { meta: { error: String(err) } })
    })
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * One pass over every enabled rule × camera.
   *
   * Eligibility is scanned under a short `scanning` lock so two ticks do not
   * double-launch the same pair. Renders themselves are started together —
   * awaiting them one-by-one made camera B wait for camera A's ffmpeg
   * (live: 1441 until 08:39, 101 until 08:46, both windows closed at 07:00).
   * A later tick that meets a pair already in `inFlight` counts it and
   * moves on, so a 30-minute render does not make the producer go deaf.
   */
  async tick(): Promise<TimelapseTickReport> {
    if (this.scanning) {
      return { ...EMPTY_REPORT }
    }
    this.scanning = true
    const report: MutableReport = {
      produced: 0,
      waiting: 0,
      alreadyDone: 0,
      beforeFloor: 0,
      failed: 0,
      idle: 0,
      skippedInFlight: 0,
    }
    const jobs: Promise<void>[] = []
    try {
      const now = this.deps.now()
      for (const rule of this.deps.store.listEnabled()) {
        const window = findLastClosedWindow({
          schedule: rule.schedule,
          nowMs: now,
          lookbackMs: this.lookbackMs,
        })
        if (window === null) {
          report.idle += rule.deviceIds.length
          continue
        }
        if (now < window.endMs + this.settleMs) {
          report.waiting += rule.deviceIds.length
          continue
        }
        for (const deviceId of rule.deviceIds) {
          if (readTimelapseGeneratedAt(rule, deviceId) >= window.endMs) {
            report.alreadyDone += 1
            continue
          }
          if (timelapseEligibilityFloor(rule, deviceId) >= window.endMs) {
            // Not silent — a skipped pair must be explainable — but not a warn
            // either: this is the correct outcome, and it recurs every tick
            // until the rule's first real window closes.
            report.beforeFloor += 1
            this.deps.logger.debug('timelapse window predates the rule — not attempted', {
              tags: { deviceId },
              meta: {
                ruleId: rule.id,
                windowStart: window.startMs,
                windowEnd: window.endMs,
                createdAt: rule.createdAt,
              },
            })
            continue
          }
          if (this.inFlight.has(renderFlightKey(rule.id, deviceId))) {
            report.skippedInFlight += 1
            continue
          }
          jobs.push(
            this.produce(rule, deviceId, window, { stamp: true }).then((ok) => {
              if (ok.produced > 0) report.produced += 1
              else report.failed += 1
            }),
          )
        }
      }
    } finally {
      this.scanning = false
    }
    await Promise.all(jobs)
    return report
  }

  /**
   * The operator's Test button: produce the last closed window for one camera
   * of one rule, ignoring the settle delay and the guard.
   *
   * It DELIVERS — same as `nc.injectTestEvent`, and for the same reason: a
   * test that stops short of the notifier does not test the thing that breaks.
   * It deliberately does NOT stamp: pressing Test at noon must not cancel
   * tonight's scheduled run.
   *
   * It also ignores the eligibility floor. The floor exists to stop an
   * UNATTENDED loop mining the past; an operator who presses Test on a rule
   * created an hour ago is asking exactly that question, and gets the honest
   * answer (`no footage …`) once, not every minute.
   */
  async runNow(input: TimelapseRunNowInput): Promise<TimelapseRunNowResult> {
    const rule = this.deps.store.get(input.ruleId)
    if (rule === null) throw new Error(`timelapse rule not found: ${input.ruleId}`)
    if (!rule.deviceIds.includes(input.deviceId)) {
      throw new Error(`rule ${rule.name} does not cover camera ${input.deviceId}`)
    }
    const window = findLastClosedWindow({
      schedule: rule.schedule,
      nowMs: this.deps.now(),
      lookbackMs: this.lookbackMs,
    })
    if (window === null) {
      return { produced: 0, window: null, error: 'no schedule window has closed recently' }
    }
    return this.produce(rule, input.deviceId, window, { stamp: false })
  }

  /**
   * Render → enqueue → (optionally) stamp. Never throws.
   *
   * The stamp is LAST and conditional on both steps: a render that failed, or
   * a queue that refused the rows, must leave the pair eligible. A window does
   * not come back.
   */
  private async produce(
    rule: TimelapseRule,
    deviceId: number,
    window: ClosedWindow,
    opts: { readonly stamp: boolean },
  ): Promise<TimelapseRunNowResult> {
    const tags = { deviceId }
    // A render is the longest thing this addon does — up to `RENDER_TIMEOUT_MS`
    // (30 min) of ffmpeg on the recording node — and for that whole time the
    // rule looks, from every read surface, exactly like a rule that produced
    // nothing. The entry is what lets the editor say "rendering since 05:12"
    // instead of "never generated". Bounded by construction: it is deleted in
    // the `finally`, and it holds only renders THIS process started (an export
    // owed by a previous one is picked up by the renderer's own adoption).
    const flightKey = renderFlightKey(rule.id, deviceId)
    this.inFlight.set(flightKey, {
      ruleId: rule.id,
      deviceId,
      window,
      startedAt: this.deps.now(),
    })
    try {
      // The display name is resolved BEFORE the render, not after: the preview
      // caption is `{{camera}}` and the renderer is the thing that burns it in.
      // Resolving it afterwards would mean either a second render or a caption
      // that says `camera 101`.
      const deviceName = await this.resolveDeviceName(deviceId)
      const outcome = await this.deps.render({
        ruleId: rule.id,
        ruleName: rule.name,
        deviceId,
        window,
        cadenceSec: rule.cadenceSec,
        framerate: rule.framerate,
        ...(rule.denseCadenceSec !== undefined ? { denseCadenceSec: rule.denseCadenceSec } : {}),
        ...(rule.minDwellSec !== undefined ? { minDwellSec: rule.minDwellSec } : {}),
        // The export TITLE is clocked in the rule's own zone. The hub runs on
        // UTC, so deriving it host-locally titled this deployment's 21:00→07:00
        // windows `19:00→05:00` — the label was two hours off while the window
        // itself was always right.
        ...(rule.schedule.timezone !== undefined ? { timezone: rule.schedule.timezone } : {}),
        previewText: timelapsePreviewText({
          deviceId,
          ...(deviceName !== null ? { deviceName } : {}),
          ruleName: rule.name,
          window,
          ...(rule.previewText !== undefined ? { text: rule.previewText } : {}),
        }),
        previewMode: rule.previewMode,
        ...(rule.reportClasses !== undefined ? { reportClasses: rule.reportClasses } : {}),
        // Carried so the artefact inherits the RULE's visibility: a personal
        // rule's timelapse must not appear in another user's library.
        ...(rule.ownerUserId !== undefined ? { ownerUserId: rule.ownerUserId } : {}),
      })
      const rows = buildTimelapseOutboxInputs({
        // Frozen HERE, language included — see `TimelapseDeliveryInput.texts`.
        texts: this.texts,
        ruleId: rule.id,
        ruleName: rule.name,
        deviceId,
        ...(deviceName !== null ? { deviceName } : {}),
        window,
        targets: rule.targets as readonly NcRuleTarget[],
        ...(this.deps.disabledTargetIds !== undefined
          ? { disabledTargetIds: this.deps.disabledTargetIds(rule.id) }
          : {}),
        priority: rule.priority,
        coverage: outcome.coverage,
        ...(outcome.artifact !== null ? { artifact: outcome.artifact } : {}),
        ...(outcome.preview !== null ? { preview: outcome.preview } : {}),
        ...(outcome.downloadUrl !== null ? { clickUrl: outcome.downloadUrl } : {}),
        exportId: outcome.exportId,
        denseRanges: outcome.plan.ranges.length,
        detections: outcome.detections,
        ...(outcome.plan.capped ? { denseCapped: true } : {}),
        generatedAt: this.deps.now(),
        ...(rule.template !== undefined ? { template: rule.template } : {}),
      })
      const enqueued = await this.deps.enqueue(rows)
      if (opts.stamp) await this.deps.store.markGenerated(rule.id, deviceId, this.deps.now())
      this.deps.logger.info('timelapse produced', {
        tags,
        meta: {
          ruleId: rule.id,
          exportId: outcome.exportId,
          windowStart: window.startMs,
          windowEnd: window.endMs,
          coveragePct: outcome.coverage.percent,
          denseRanges: outcome.plan.ranges.length,
          detections: outcome.detections.total,
          enqueued,
          stamped: opts.stamp,
          ...(outcome.artifact === null ? { artifact: 'none' } : {}),
          ...(outcome.preview === null ? { preview: 'none' } : {}),
        },
      })
      return {
        produced: 1,
        window,
        exportId: outcome.exportId,
        coveragePercent: outcome.coverage.percent,
        enqueued,
      }
    } catch (err: unknown) {
      // Named, not silent: a window that produced nothing and said nothing is
      // indistinguishable from a night nobody configured.
      this.deps.logger.warn('timelapse not produced — the window stays eligible', {
        tags,
        meta: {
          ruleId: rule.id,
          windowStart: window.startMs,
          windowEnd: window.endMs,
          error: String(err),
        },
      })
      return { produced: 0, window, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  /** Renders this process currently owes, newest last. Read by the rule-status
   *  surface; never a decision input for the scheduler itself. */
  renderInFlight(): readonly TimelapseRenderInFlight[] {
    return [...this.inFlight.values()]
  }

  private async resolveDeviceName(deviceId: number): Promise<string | null> {
    const get = this.deps.getDeviceName
    if (get === undefined) return null
    return get(deviceId).catch(() => null)
  }
}
