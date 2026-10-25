/**
 * The BUDGET on a pre-roll catch-up burst — and the accounting that makes one
 * reportable in a single line.
 *
 * ## What this bounds
 *
 * A detection session that asks the broker for history gets it: the restreamer
 * replays a keyframe-aligned window (`stream-broker/pre-roll.ts`) and the
 * decode worker decodes all of it, as fast as it can, before it ever reaches
 * the live edge. Measured on device 102: `preRollSpanMs=3994`,
 * `detectionPreRollServed=true`. At a session's detection fps that is tens of
 * frames arriving inside a few hundred milliseconds of wall clock.
 *
 * Inferring all of them, unbounded, is an inference storm — worse when several
 * cameras open on the same motion event. So the burst is bounded three ways,
 * and every one of them is a DROP that gets counted:
 *
 *   - a MEDIA stride (`plan.strideMs`) that subsamples the window,
 *   - a frame budget (`maxFrames`),
 *   - a wall-clock budget (`maxWallMs`).
 *
 * ## Why subsample rather than truncate
 *
 * When the window holds more frames than the budget, the stride widens so the
 * admitted frames span the WHOLE window. Dropping the oldest instead would
 * keep only the newest second of history — the frames the live path was about
 * to see anyway — and would therefore fix nothing. The measured miss is at the
 * OLD end: a cyclist scored `vehicle 0.5669`, above the 0.50 floor, 1.68 s
 * BEFORE the live track was born. A budget that cannot reach him is a budget
 * spent on nothing.
 *
 * ## Why media time and not wall clock
 *
 * Both throttles this burst replaces are wall-clock:
 * `FrameSlot.publish`'s `minIntervalMs` (fed `Date.now()`) and the runner's
 * `reserveDetectionFrame` governor interval. During catch-up, wall clock is
 * meaningless — 4 s of media arrives in ~0.2 s of wall — so a wall-clock
 * throttle admits one or two frames and frees the rest. That is where the
 * pre-roll dies today. The stride here is measured in the frames' own media
 * time, which is the only clock on which "one frame every 333 ms of footage"
 * means what it says.
 *
 * ## What this does NOT decide
 *
 * Priority. A pre-roll frame must never delay a live one; that rule belongs to
 * the consumer that holds both (the runner's detection lane), not here. This
 * module only ever says whether a frame is INSIDE the budget.
 */

/** Why a pre-roll frame was not inferred. Every branch that drops work names itself. */
export type PreRollDropReason = 'stride' | 'budget-frames' | 'budget-wall-ms' | 'live-edge'

/** The two hard ceilings on one session's burst. */
export interface PreRollBudget {
  /** Most frames this burst may send to inference. `0` disables the burst. */
  readonly maxFrames: number
  /** Wall-clock ms after which the remaining history is abandoned. */
  readonly maxWallMs: number
}

/** Inputs to {@link planPreRollBurst}. */
export interface PreRollPlanInput {
  /** Width of the retained window this session will replay, in ms of media. */
  readonly spanMs: number
  /** The session's detection fps — the cadence the window would otherwise yield. */
  readonly detectionFps: number
  readonly maxFrames: number
}

/** How wide the burst's media stride has to be to fit the frame budget. */
export interface PreRollPlan {
  /** Minimum media-time gap between two admitted pre-roll frames. */
  readonly strideMs: number
  /** How many frames the stride yields over the window. */
  readonly plannedFrames: number
  /** True when the stride had to be widened past the session's detection cadence. */
  readonly subsampled: boolean
}

/** One session's burst, as the log line reports it. */
export interface PreRollBurstReport {
  readonly offered: number
  readonly inferred: number
  readonly dropped: number
  readonly droppedByReason: Readonly<Record<PreRollDropReason, number>>
  readonly strideMs: number
  readonly subsampled: boolean
}

/** The answer to "may this frame reach inference". */
export interface PreRollVerdict {
  readonly admitted: boolean
  readonly reason?: PreRollDropReason
}

/** Construction inputs for {@link PreRollBurst}. */
export interface PreRollBurstInput {
  readonly budget: PreRollBudget
  readonly plan: PreRollPlan
  /** Wall clock at which the burst began (the session's first decoded frame). */
  readonly startedAtWall: number
}

/**
 * How far a frame's own moment may fall BEHIND the wall clock and still count
 * as catch-up.
 *
 * The live edge is measured, not declared: while the decoder races through
 * buffered media it produces frames faster than real time, so each frame's
 * moment runs ahead of the clock; when the two converge the decoder has caught
 * up. The slack is for decode jitter — a single slow frame must not be read as
 * "we are live", because the burst never restarts once it ends.
 */
export const LIVE_EDGE_SLACK_MS = 100

const ADMITTED: PreRollVerdict = { admitted: true }

/**
 * Choose the media stride for one burst.
 *
 * `plannedFrames` is what the stride actually yields, so a caller can log the
 * intent next to the outcome — a budget that is never reached and a budget that
 * is always hit are different problems and used to read the same.
 */
export function planPreRollBurst(input: PreRollPlanInput): PreRollPlan {
  const span = Number.isFinite(input.spanMs) && input.spanMs > 0 ? input.spanMs : 0
  const fps = Number.isFinite(input.detectionFps) && input.detectionFps > 0 ? input.detectionFps : 1
  const maxFrames = Number.isFinite(input.maxFrames) && input.maxFrames > 0 ? input.maxFrames : 0
  if (span === 0 || maxFrames === 0) {
    return { strideMs: Number.POSITIVE_INFINITY, plannedFrames: 0, subsampled: false }
  }
  const cadenceMs = 1000 / fps
  const budgetStrideMs = span / maxFrames
  const subsampled = budgetStrideMs > cadenceMs
  const strideMs = subsampled ? budgetStrideMs : cadenceMs
  const plannedFrames = Math.min(maxFrames, Math.max(1, Math.floor(span / strideMs)))
  return { strideMs, plannedFrames, subsampled }
}

/** Inputs to {@link planPreRollWithinHold}. */
export interface PreRollHoldPlanInput {
  /** The operator's `preRollInferenceFrames` for this camera. */
  readonly requestedFrames: number
  /** The session's detection cadence, in ms of media. */
  readonly cadenceMs: number
  /** The session's native hold depth (`nativeLeaseHoldFrames`). */
  readonly holdFrames: number
  /** `false` when the hold is off (`nativeLeaseBudgetMb: 0`) — nothing to overflow. */
  readonly holdEnabled: boolean
}

/** What one burst may send to inference, and how it samples the window. */
export interface PreRollHoldPlan {
  /** Frames the burst may send to inference — never more than the hold keeps. */
  readonly budgetFrames: number
  readonly plan: PreRollPlan
  /** True when the hold, not the operator's number, set `budgetFrames`. */
  readonly holdCapped: boolean
}

/**
 * Fit a burst inside the hold its frames live in (D652), without shrinking the
 * history it covers.
 *
 * Every pre-roll frame the runner admits is a lazy ref: its pixels are a frame
 * the worker HOLDS until inference reads it, and the hold keeps
 * `holdFrames`. A burst of 12 into a hold of 8, read oldest-first by the lane,
 * evicts its own oldest frames before inference reaches them — 54 of 55 live
 * `toBuffer miss … released/hold-full` lines named a frameId ≤ 12. So the burst
 * sends at most `holdFrames - 1` frames (the ceiling D367 already gives the
 * runner's in-flight frames, leaving the newest slot to the first live frame).
 *
 * The REACH is kept: the window handed to the planner is still
 * `requestedFrames × cadence`, so the capped frames are spread across the same
 * span of media the operator asked for (D382 — a consumer is served the history
 * it asked for), sampled less densely. The alternative, raising the hold for the
 * burst, would pin up to `requestedFrames - holdFrames + 1` extra native rasters
 * (~24 MB each at 4K) on every session open.
 */
export function planPreRollWithinHold(input: PreRollHoldPlanInput): PreRollHoldPlan {
  const requested =
    Number.isFinite(input.requestedFrames) && input.requestedFrames > 0
      ? Math.floor(input.requestedFrames)
      : 0
  const holdCeiling = Math.max(1, Math.floor(input.holdFrames) - 1)
  const budgetFrames = input.holdEnabled ? Math.min(requested, holdCeiling) : requested
  const cadenceMs = Number.isFinite(input.cadenceMs) && input.cadenceMs > 0 ? input.cadenceMs : 1000
  return {
    budgetFrames,
    holdCapped: budgetFrames < requested,
    plan: planPreRollBurst({
      spanMs: requested * cadenceMs,
      detectionFps: 1000 / cadenceMs,
      maxFrames: budgetFrames,
    }),
  }
}

/**
 * The live, per-session budget. Stateful by necessity — a stride is a decision
 * about the PREVIOUS admission — and deliberately free of any clock of its own:
 * both times are passed in, so a test can drive a catch-up burst without
 * pretending 4 s of media takes 4 s to decode.
 */
export class PreRollBurst {
  private readonly budget: PreRollBudget
  private readonly plan: PreRollPlan
  private readonly startedAtWall: number
  /** Widest lead a frame's moment took over the wall clock — the SERVED span. */
  private maxLeadMs = 0
  private lastAdmittedMediaWall: number | null = null
  private offered = 0
  private inferred = 0
  private done = false
  private readonly drops: Record<PreRollDropReason, number> = {
    stride: 0,
    'budget-frames': 0,
    'budget-wall-ms': 0,
    'live-edge': 0,
  }

  constructor(input: PreRollBurstInput) {
    this.budget = input.budget
    this.plan = input.plan
    this.startedAtWall = input.startedAtWall
  }

  /**
   * How much history this burst actually carried, in ms of media — the number
   * the broker knows as `preRollSpanMs` and that never reached this process.
   *
   * `null` until a frame has led the wall clock: a burst that saw none did not
   * measure a short span, it measured NOTHING, and the difference is the whole
   * reason the anchor was left alone rather than fabricated (D393).
   */
  servedSpanMs(): number | null {
    return this.maxLeadMs > 0 ? this.maxLeadMs : null
  }

  /** True once the burst has ended — by budget, or by reaching the live edge. */
  get finished(): boolean {
    return this.done
  }

  /**
   * Offer one decoded history frame.
   *
   * `mediaWall` is the frame's OWN moment (see `media-clock.ts`); `nowWall` is
   * the wall clock of the offer. The two are different by construction during
   * catch-up, which is the whole reason this class exists.
   */
  offer(mediaWall: number, nowWall: number): PreRollVerdict {
    this.offered++
    if (this.done) return this.drop('budget-frames')
    // THE measured live edge. A frame whose own moment no longer leads the
    // wall clock is not history — the decoder has caught up with the camera.
    const leadMs = mediaWall - nowWall
    // …but not before the media has HAD a chance to lead. The session's first
    // frame is anchored at the wall clock, so its lead is zero by
    // construction; ending on it would end every burst on its first frame.
    if (this.maxLeadMs > 0 && leadMs <= LIVE_EDGE_SLACK_MS) {
      this.done = true
      return this.drop('live-edge')
    }
    if (leadMs > this.maxLeadMs) this.maxLeadMs = leadMs
    if (nowWall - this.startedAtWall >= this.budget.maxWallMs) {
      this.done = true
      return this.drop('budget-wall-ms')
    }
    if (this.inferred >= this.budget.maxFrames) {
      this.done = true
      return this.drop('budget-frames')
    }
    if (
      this.lastAdmittedMediaWall !== null &&
      mediaWall - this.lastAdmittedMediaWall < this.plan.strideMs
    ) {
      return this.drop('stride')
    }
    this.lastAdmittedMediaWall = mediaWall
    this.inferred++
    return ADMITTED
  }

  /** End the burst without offering a frame (session torn down, decode ended). */
  finish(): void {
    this.done = true
  }

  report(): PreRollBurstReport {
    return {
      offered: this.offered,
      inferred: this.inferred,
      dropped: this.offered - this.inferred,
      droppedByReason: { ...this.drops },
      strideMs: Math.round(this.plan.strideMs),
      subsampled: this.plan.subsampled,
    }
  }

  private drop(reason: PreRollDropReason): PreRollVerdict {
    this.drops[reason]++
    return { admitted: false, reason }
  }
}
