/**
 * `TrackDetailDispatcher` — the per-device coordinator that turns the pure
 * {@link DetailScheduler}'s decisions into actual `pipelineRunner.runDetailSubtree`
 * calls, bounds their concurrency, and routes the returned payloads into the
 * existing per-track consumers (face / clip / classifier-plate).
 *
 * Two-plane design (detail plane): the per-frame executor now runs ONLY the
 * root detector; face-embedding, clip-embedding, classifier and plate children
 * are served ON DEMAND per track via this dispatcher instead of on every frame.
 *
 * Responsibilities:
 *  - own one {@link DetailScheduler} per device (all cadence/announce policy
 *    lives in the scheduler — this class never re-implements any of it);
 *  - remember each live track's freshest `{frameHandle, bbox}` so a scheduled
 *    request is cut from the most recent frame;
 *  - detect a track's "candidate improved" moment (a strictly-higher detector
 *    confidence, via the shared {@link BestDetectionTracker} policy) and feed it
 *    to the scheduler so `improve`-cadence steps re-dispatch;
 *  - run a 1 s periodic tick (unref'd) per device while ≥1 track is live;
 *  - cap in-flight `runDetailSubtree` calls per device (default 2) via a simple
 *    counter + FIFO queue, dropping queued requests for tracks that already
 *    ended;
 *  - feed every result's top score back to the scheduler (`onResult`) so
 *    sticky/retry policy advances.
 *
 * Transport-free + deps-injected so it is unit-testable without a live broker:
 * the caller injects the pinned `runDetailSubtree` call, the result router, and
 * (optionally) the two fallback pixel sources (the PARKED key frame as
 * `frameJpeg`, then `cropJpeg`). Everything here is
 * best-effort telemetry (D8): a failed detail call is logged and fed to the
 * scheduler as a miss, never thrown to the event consumer.
 */
import type {
  DetailResult,
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
} from '@camstack/types'
import { isRootSuppliableStepId, rootSupplyServes } from '@camstack/types'
import { isDetailHandleExpiredRefusal, isDetailNotAttachedRefusal } from './detail-refusal.js'
import { type DetailRequest, DetailScheduler } from './detail-scheduler.js'
import { BestDetectionTracker } from './pipeline/best-detection-tracker.js'
import type { RootChildBox } from './pipeline/frame-processor.js'
import { CANDIDATE_IMPROVE_POLICY } from './pipeline/best-selection-policies.js'

/** The freshest frame association for a track — where the next detail crop is cut. */
export interface TrackDetailFrame {
  /** Shm-ring handle to the freshest decoded frame; absent on sources with no
   *  decoded frame (never scheduled). */
  readonly frameHandle?: FrameHandle
  /** Moleculer node id that owns the frame — the pin target for the call. */
  readonly nodeId?: string
  /** Parent detection bbox in FRAME-space pixels. */
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  readonly className: string
  readonly confidence: number
  readonly timestamp: number
  /**
   * Did the tracker MATCH this track to a detection in this frame? (D397)
   *
   * `false` means the box is coasted — a prediction carried forward because
   * the subject was not observed. Such a frame is media-INELIGIBLE, the same
   * rule `TrackedDetection.matchedThisFrame` already states and three sibling
   * media paths already honour: cropping a coasted box yields the empty scene.
   *
   * It is also the reason 78.8% of `native crop miss` lines on the live hub
   * say `no retained tile for this frame`: a frame that carried no detection
   * has no subject tile and no scene tile, and the only consumer that can name
   * such a frame is one asking about a track the frame did not observe.
   *
   * OPTIONAL, and absent is read as MATCHED — a producer that predates this
   * field must not have its whole detail plane silenced by an upgrade.
   */
  readonly matchedThisFrame?: boolean
  /**
   * Boxes the ROOT model drew inside this subject on this frame (D730) — a
   * plate in a vehicle — for a crop step the announce says the root supplies.
   * Dispatched to that step's served children INSTEAD of inferring the step.
   * Absent ⇒ none.
   */
  readonly rootChildBoxes?: readonly RootChildBox[]
}

/** A dispatch that reads the root's boxes instead of inferring the step. */
interface RootSuppliedDispatch {
  readonly steps: readonly string[]
  readonly supplied: NonNullable<RunDetailSubtreeInput['supplied']>
}

/** The parked key frame as the dispatcher consumes it. */
export interface ParkedDetailFrame {
  /** The parcel — a FULL native frame, base64 JPEG. The runner cuts. */
  readonly base64: string
  readonly width: number
  readonly height: number
  /** The subject's box in THIS image's pixels. */
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  /** The node holding the parcel — the pin for the dispatch. */
  readonly nodeId: string
  /** The frame instant the parcel shows — identifies the parcel. */
  readonly timestamp: number
}

export interface DetailDispatcherDeps {
  /**
   * Run the detail subtree on the frame's owning node (pinned by `nodeId`).
   * Injected so the dispatcher stays transport-free + unit-testable. Returns
   * `null` when neither frame source resolves (evicted handle, no crop).
   */
  runDetailSubtree(
    input: RunDetailSubtreeInput,
    nodeId: string | undefined,
  ): Promise<RunDetailSubtreeResult | null>
  /**
   * Route the returned detail payloads into the existing consumers
   * (face-embedding → FaceRecognizer, clip-embedding → object-embedding store,
   * classifier/plate label → track enrichment). Best-effort; may throw and the
   * dispatcher will log + continue.
   */
  routeResults(
    deviceId: number,
    trackId: string,
    details: readonly DetailResult[],
    frame: TrackDetailFrame,
  ): Promise<void>
  /**
   * Optional: capture a base64 JPEG crop of the parent bbox from the freshest
   * frame, used for the LAST `cropJpeg` retry when the frameHandle lease is gone.
   * Absent ⇒ that rung is skipped.
   *
   * Note what this can and cannot do: the real implementation is NATIVE-STRICT,
   * so it returns `null` on precisely the lease miss that sent the dispatch here.
   * It is not an independent fallback — {@link captureFullFrameBase64} is.
   */
  captureCropBase64?(frame: TrackDetailFrame): Promise<string | null>
  /**
   * Optional: the track's PARKED key frame (D422) — the full native frame the
   * owning node copied the instant the track's best was decided, retrieved by
   * `(deviceId, trackId)`. This is the rung that survives a lease miss, and it
   * cannot miss on AGE: the pixels were parked before they could expire.
   *
   * The `bbox` comes back already scaled into the parcel's pixel space (the
   * hub kept the subject's detection-space box beside the parcel): the runner
   * reads `parent.bbox` as pixels of the image it is handed and derives the
   * crop rectangle itself (D52). `nodeId` is where the parcel lives — the
   * pin for the dispatch. `timestamp` is the parked instant, which is what
   * "already enriched" is keyed on.
   *
   * Absent ⇒ the rung is skipped (a caller that has no parcel source). It is
   * NEVER substituted with a by-handle fetch — that is the design D422 retired.
   */
  captureParkedFrame?(deviceId: number, trackId: string): Promise<ParkedDetailFrame | null>
  /**
   * Does this track already carry a resolved identity label? Injected (rather
   * than importing the track store) to keep the dispatcher transport-free and
   * unit-testable. Consulted ONLY to decide whether a PERIODIC face-detection
   * refresh may skip the ArcFace embedding (see {@link composeDetailSteps}).
   * Absent ⇒ treated as "no label" (embedding always rides along — safe default).
   */
  hasTrackLabel?(trackId: string): boolean
  readonly logger: IScopedLogger
  /** Max concurrent `runDetailSubtree` calls per device (default 2). */
  readonly maxInFlightPerDevice?: number
  /** Periodic tick interval ms (default 1000). */
  readonly tickIntervalMs?: number
}

/**
 * Compose the `steps` list sent to `runDetailSubtree` for one request —
 * chain-aware for the multi-step detail subtrees.
 *
 * A `face-detection` request ALSO includes `'face-embedding'` (the full
 * detect→recognize chain) EXCEPT when it is a PERIODIC geometry refresh on a
 * track that already carries an identity label: re-embedding a known face every
 * second is wasted ArcFace inference (250-1900ms per call on N100 agents), so
 * that case runs the detector geometry ALONE. Every recognition-bearing reason
 * (new-track / improve / retry) keeps the embedding regardless of the label.
 *
 * A `plate-detection` request ALWAYS includes `'plate-ocr'` — symmetric to the
 * face chain. Without `'plate-ocr'` in the array the pipeline's strict-`steps`
 * pruning (`pruneChildStepsToRequested`) drops the OCR child, so a detected
 * plate never gets read and no plate text is ever produced. (The dispatcher
 * cannot import the pipeline catalog to derive the child chain — this hardcode
 * mirrors it; keep the two in sync when the catalog's plate subtree changes.)
 *
 * Other steps are unchanged (`[req.stepId]`). Pairs with the pipeline's
 * strict-`steps` pruning — naming the nested child here is what keeps it in the
 * executed chain.
 */
export function composeDetailSteps(
  req: DetailRequest,
  hasTrackLabel: (trackId: string) => boolean,
): string[] {
  if (req.stepId === 'face-detection') {
    const skipEmbedding = req.reason === 'periodic' && hasTrackLabel(req.trackId)
    return skipEmbedding ? ['face-detection'] : ['face-detection', 'face-embedding']
  }
  if (req.stepId === 'plate-detection') {
    return ['plate-detection', 'plate-ocr']
  }
  return [req.stepId]
}

/** The children a root-supplied crop step still feeds (`rootSupplyServes`). */
function servedChildren(stepId: string): readonly string[] {
  if (!isRootSuppliableStepId(stepId)) return []
  if (stepId !== 'plate-detection' && stepId !== 'face-detection') return []
  return rootSupplyServes(stepId)
}

type DetailBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * Carry the root's frame-space boxes into a parcel's pixel space, by the same
 * mapping that took the subject's box there (`parked.bbox` is `frame.bbox`
 * rescaled). Pure.
 */
export function suppliedInParcel(
  supplied: NonNullable<RunDetailSubtreeInput['supplied']>,
  frameBox: DetailBox,
  parcelBox: DetailBox,
): NonNullable<RunDetailSubtreeInput['supplied']> {
  const sx = frameBox.w > 0 ? parcelBox.w / frameBox.w : 1
  const sy = frameBox.h > 0 ? parcelBox.h / frameBox.h : 1
  const [first, ...rest] = supplied.boxes.map((b) => ({
    score: b.score,
    bbox: {
      x: parcelBox.x + (b.bbox.x - frameBox.x) * sx,
      y: parcelBox.y + (b.bbox.y - frameBox.y) * sy,
      w: b.bbox.w * sx,
      h: b.bbox.h * sy,
    },
  }))
  if (first === undefined) return supplied
  return { ...supplied, boxes: [first, ...rest] }
}

/**
 * Does `steps` name a nested-enrichment chain (root detector + a child that
 * produces a `label`/`embedding`), i.e. more than the bare root step? Used to
 * surface a silent enrichment miss (BUG C): a plate detected but never read, a
 * face detected but never embedded — the root detail still routes so the miss
 * is otherwise invisible. `['plate-detection']` alone is NOT a chain.
 */
function isEnrichmentChain(steps: readonly string[]): boolean {
  return steps.length > 1
}

/** Does any returned detail carry the enrichment a chain request asked for? */
function detailsCarryEnrichment(details: readonly DetailResult[]): boolean {
  return details.some((d) => d.label !== undefined || d.embedding !== undefined)
}

/** Throttle for the per-device "detail call failed" warn — one line / minute. */
const FAIL_WARN_THROTTLE_MS = 60_000

/** How often a camera reports the coasted frames its detail plane ignored (D397). */
const COASTED_REPORT_INTERVAL_MS = 60_000

interface DeviceState {
  readonly scheduler: DetailScheduler
  /** Freshest frame association per live track. */
  readonly tracks: Map<string, TrackDetailFrame>
  /**
   * Per track, per step: the parked instant already enriched through the
   * parcel rung. A parcel is enriched ONCE per step — the periodic tick on a
   * coasting track (whose handle is frozen and misses every second, D397)
   * would otherwise re-run the same face on the same image at 1 Hz. A NEWER
   * parcel (a later best) is enriched again.
   */
  readonly parcelEnriched: Map<string, Map<string, number>>
  /** Shared best-detection policy → the "candidate improved" signal per track. */
  readonly candidateBest: BestDetectionTracker
  readonly queue: DetailRequest[]
  /**
   * Coasted frames this device offered and this dispatcher ignored (D397).
   * Read by the addon's own report line: a branch that drops work is never
   * silent, and this one drops the majority of frames of a coasting track.
   */
  coastedFramesIgnored: number
  /** Value and instant of the last coasted report — the window this one covers. */
  coastedReportedAt: { count: number; at: number }
  inFlight: number
  timer: ReturnType<typeof setInterval> | null
  lastFailWarnAt: number
  /** Throttle for the "chain ran but produced no enrichment" warn (BUG C). */
  lastEnrichWarnAt: number
  /**
   * `${trackId}:${stepId}` already told "the root drew no box on this frame"
   * (D730) — one line per (track, step), never one per tick.
   */
  readonly rootBoxMissLogged: Set<string>
}

export class TrackDetailDispatcher {
  private readonly devices = new Map<number, DeviceState>()
  private readonly maxInFlight: number
  private readonly tickIntervalMs: number
  private disposed = false

  constructor(private readonly deps: DetailDispatcherDeps) {
    this.maxInFlight = deps.maxInFlightPerDevice ?? 2
    this.tickIntervalMs = deps.tickIntervalMs ?? 1000
  }

  /** A track appeared: record its frame, seed its best-confidence, and dispatch
   *  the scheduler's immediate (new-track) requests. */
  onTrackStarted(
    deviceId: number,
    trackId: string,
    className: string,
    announce: readonly DetailStepAnnounce[],
    frame: TrackDetailFrame,
    nowMs: number,
  ): void {
    if (this.disposed) return
    const dev = this.ensureDevice(deviceId)
    dev.tracks.set(trackId, frame)
    // Seed the peak with the start-frame confidence so the SAME frame's later
    // `onFrame` doesn't re-fire as an "improvement" (the new-track request has
    // already been enqueued for this frame).
    dev.candidateBest.observe(trackId, frame.confidence, frame.timestamp)
    const requests = dev.scheduler.onTrackStarted(trackId, className, announce, nowMs)
    this.enqueue(deviceId, dev, requests)
    this.ensureTimer(deviceId, dev)
  }

  /** A subsequent frame for a live track: refresh its frame + fire
   *  `improve`-cadence steps when the detector confidence strictly improves.
   *
   *  `announce` is the frame's currently-announced detail chain. When a track
   *  is alive but has NO dispatcher state yet — it existed before `detailSteps`
   *  first appeared (a mid-track redeploy / config change) — this adopts it as a
   *  new track so it starts getting scheduled instead of starving for its whole
   *  life. Idempotent: guarded by the per-track state check, so a track that
   *  already has state is never reset. */
  onFrame(
    deviceId: number,
    trackId: string,
    announce: readonly DetailStepAnnounce[],
    frame: TrackDetailFrame,
    nowMs: number,
  ): void {
    if (this.disposed) return
    // A COASTED frame is not an observation (D397). It neither refreshes the
    // track's frame association nor counts as an improvement, and it cannot
    // adopt an unknown track: a predicted box is not a birth.
    //
    // Refreshing on it is the defect this guard removes. It replaced the last
    // frame the subject was actually IN with a frame that carried no detection
    // of it — a frame for which no subject tile and no scene tile was ever cut,
    // which is why 78.8% of the hub's `native crop miss` lines said "no
    // retained tile for this frame". And on the frames where such an ask HIT,
    // it enriched the wrong instant into the same vector index, erroring
    // nowhere.
    if (frame.matchedThisFrame === false) {
      const known = this.devices.get(deviceId)
      if (known) known.coastedFramesIgnored += 1
      return
    }
    const dev = this.devices.get(deviceId)
    if (!dev || !dev.tracks.has(trackId)) {
      // No dispatcher state for this (device, track): bootstrap it as a new
      // track when the frame carries a non-empty announce. Otherwise no-op.
      if (announce.length > 0) {
        this.onTrackStarted(deviceId, trackId, frame.className, announce, frame, nowMs)
      }
      return
    }
    dev.tracks.set(trackId, frame)
    const improved = dev.candidateBest.observe(trackId, frame.confidence, frame.timestamp)
    if (!improved) return
    const requests = dev.scheduler.onCandidateImproved(trackId, nowMs)
    this.enqueue(deviceId, dev, requests)
  }

  /**
   * Coasted frames ignored for one device since this dispatcher started.
   *
   * Exposed rather than logged from here: the dispatcher has no cadence of its
   * own to report on, and the addon already emits a per-camera line where this
   * belongs beside the numbers it explains.
   */
  coastedFramesIgnored(deviceId: number): number {
    return this.devices.get(deviceId)?.coastedFramesIgnored ?? 0
  }

  /** A track ended (durable TTL expiry): drop its scheduler + frame state. Any
   *  queued request for it is discarded at dequeue. */
  onTrackEnded(deviceId: number, trackId: string): void {
    const dev = this.devices.get(deviceId)
    if (!dev) return
    dev.scheduler.onTrackEnded(trackId)
    dev.tracks.delete(trackId)
    dev.parcelEnriched.delete(trackId)
    for (const key of dev.rootBoxMissLogged) {
      if (key.startsWith(`${trackId}:`)) dev.rootBoxMissLogged.delete(key)
    }
    dev.candidateBest.delete(trackId)
    if (dev.tracks.size === 0) this.clearTimer(dev)
  }

  dispose(): void {
    this.disposed = true
    for (const dev of this.devices.values()) {
      this.clearTimer(dev)
      dev.queue.length = 0
      dev.tracks.clear()
      dev.parcelEnriched.clear()
      dev.candidateBest.clear()
    }
    this.devices.clear()
  }

  // ── internals ───────────────────────────────────────────────────────

  private ensureDevice(deviceId: number): DeviceState {
    let dev = this.devices.get(deviceId)
    if (!dev) {
      dev = {
        scheduler: new DetailScheduler(),
        tracks: new Map(),
        parcelEnriched: new Map(),
        candidateBest: new BestDetectionTracker(CANDIDATE_IMPROVE_POLICY),
        queue: [],
        coastedFramesIgnored: 0,
        coastedReportedAt: { count: 0, at: Date.now() },
        inFlight: 0,
        timer: null,
        lastFailWarnAt: 0,
        lastEnrichWarnAt: 0,
        rootBoxMissLogged: new Set(),
      }
      this.devices.set(deviceId, dev)
    }
    return dev
  }

  private ensureTimer(deviceId: number, dev: DeviceState): void {
    if (dev.timer) return
    const timer = setInterval(() => this.tick(deviceId, dev), this.tickIntervalMs)
    // Never keep the process alive for a periodic detail tick.
    if (typeof timer.unref === 'function') timer.unref()
    dev.timer = timer
  }

  private clearTimer(dev: DeviceState): void {
    if (dev.timer) {
      clearInterval(dev.timer)
      dev.timer = null
    }
  }

  private tick(deviceId: number, dev: DeviceState): void {
    if (this.disposed) return
    const now = Date.now()
    this.reportCoasted(deviceId, dev, now)
    const requests = dev.scheduler.tick(now)
    this.enqueue(deviceId, dev, requests)
  }

  /**
   * Say how many coasted frames this camera's detail plane ignored (D397),
   * once per {@link COASTED_REPORT_INTERVAL_MS}, and only when there were any.
   *
   * Per camera and per interval rather than per frame: a coasting track offers
   * one of these several times a second, and the question this answers is
   * always "why is 102 worse than 101?".
   */
  private reportCoasted(deviceId: number, dev: DeviceState, now: number): void {
    const ignored = dev.coastedFramesIgnored - dev.coastedReportedAt.count
    if (ignored <= 0) {
      dev.coastedReportedAt = { count: dev.coastedFramesIgnored, at: now }
      return
    }
    if (now - dev.coastedReportedAt.at < COASTED_REPORT_INTERVAL_MS) return
    this.deps.logger.info(
      'detail dispatch: coasted frames ignored — the subject was not observed in them',
      {
        tags: { deviceId },
        meta: { ignored, windowMs: now - dev.coastedReportedAt.at, liveTracks: dev.tracks.size },
      },
    )
    dev.coastedReportedAt = { count: dev.coastedFramesIgnored, at: now }
  }

  private enqueue(deviceId: number, dev: DeviceState, requests: readonly DetailRequest[]): void {
    if (requests.length === 0) return
    for (const r of requests) {
      if (this.skipFilled(deviceId, dev, r)) continue
      dev.queue.push(r)
    }
    this.pump(deviceId, dev)
  }

  /**
   * D730: the root model supplies this step (the announce's `filledBy`), so it
   * is never inferred as-is. A LABEL supply — or a crop supply none of whose
   * children the root's box can feed — has nothing left to dispatch: the step
   * is settled for the track, which is what makes the line below fire once per
   * (track, step). A crop supply WITH served children (a plate → its reader, a
   * face → refinement + embedder) is dispatched, with the root's box.
   */
  private skipFilled(deviceId: number, dev: DeviceState, req: DetailRequest): boolean {
    const supply = dev.scheduler.rootSupply(req.trackId, req.stepId)
    if (supply === undefined) return false
    if (supply.kind === 'crop' && servedChildren(req.stepId).length > 0) return false
    dev.scheduler.markFilled(req.trackId, req.stepId)
    this.deps.logger.info('detail step not dispatched — the root model supplies it', {
      tags: { deviceId },
      meta: {
        trackId: req.trackId,
        stepId: req.stepId,
        filledBy: supply.modelId,
        kind: supply.kind,
        reason: req.reason,
      },
    })
    return true
  }

  /**
   * The root-supplied form of a crop request (D730): the step plus the
   * children its root box serves, and that box. `'no-box'` when the root drew
   * none inside this subject on its freshest frame — the same outcome as the
   * step's own model finding nothing, so the scheduler retries per cadence.
   * `undefined` for every request the root does not supply.
   */
  private rootSuppliedDispatch(
    dev: DeviceState,
    req: DetailRequest,
    frame: TrackDetailFrame,
  ): RootSuppliedDispatch | 'no-box' | undefined {
    const supply = dev.scheduler.rootSupply(req.trackId, req.stepId)
    if (supply?.kind !== 'crop') return undefined
    const served = servedChildren(req.stepId)
    const composed = composeDetailSteps(req, (id) => this.deps.hasTrackLabel?.(id) ?? false)
    const boxes = (frame.rootChildBoxes ?? []).filter((b) => b.stepId === req.stepId)
    const [first, ...rest] = boxes.map((b) => ({ bbox: { ...b.bbox }, score: b.score }))
    if (first === undefined) return 'no-box'
    return {
      steps: [req.stepId, ...composed.filter((s) => served.includes(s))],
      supplied: { stepId: req.stepId, modelId: supply.modelId, boxes: [first, ...rest] },
    }
  }

  private pump(deviceId: number, dev: DeviceState): void {
    while (dev.inFlight < this.maxInFlight && dev.queue.length > 0) {
      const req = dev.queue.shift()
      if (req === undefined) break
      const frame = dev.tracks.get(req.trackId)
      // Track ended between enqueue and dispatch → drop (no result to feed).
      if (frame === undefined) continue
      dev.inFlight += 1
      void this.dispatch(deviceId, dev, req, frame).finally(() => {
        dev.inFlight -= 1
        this.pump(deviceId, dev)
      })
    }
  }

  private async dispatch(
    deviceId: number,
    dev: DeviceState,
    req: DetailRequest,
    frame: TrackDetailFrame,
  ): Promise<void> {
    const rootSupplied = this.rootSuppliedDispatch(dev, req, frame)
    if (rootSupplied === 'no-box') {
      const key = `${req.trackId}:${req.stepId}`
      if (!dev.rootBoxMissLogged.has(key)) {
        dev.rootBoxMissLogged.add(key)
        this.deps.logger.info(
          'detail step waits — the root model drew no box in this subject yet',
          {
            tags: { deviceId },
            meta: { trackId: req.trackId, stepId: req.stepId, reason: req.reason },
          },
        )
      }
      dev.scheduler.onResult(req.trackId, req.stepId, null, Date.now())
      return
    }
    const details = await this.runOnce(deviceId, dev, req, frame, rootSupplied)
    // A frame-plane miss (frame handle lease evicted AND no crop fallback — the
    // "frame + crop both missed" outcome) can never recover from this request:
    // the decode lease TTL is ~500ms and the retry re-cuts from the same evicted
    // handle. Feed it to the scheduler's BOUNDED give-up path (onFrameMiss)
    // instead of the unbounded null-confidence retry, so a permanently-stale
    // track stops re-scheduling instead of looping every tick forever.
    if (details === null) {
      dev.scheduler.onFrameMiss(req.trackId, req.stepId, Date.now())
      return
    }
    let topScore: number | null = null
    if (details.length > 0) {
      topScore = details.reduce(
        (max, d) => (d.score > max ? d.score : max),
        Number.NEGATIVE_INFINITY,
      )
      // BUG C: a nested-enrichment chain (plate-detection→plate-ocr,
      // face-detection→face-embedding) whose ROOT produced a detail but whose
      // enrichment child produced nothing (a swallowed child inference error /
      // empty output) would route silently and feed the scheduler a "success".
      // Surface it (throttled) so a regression like the OCR shape mismatch is
      // never invisible again.
      const steps = composeDetailSteps(req, (id) => this.deps.hasTrackLabel?.(id) ?? false)
      if (isEnrichmentChain(steps) && !detailsCarryEnrichment(details)) {
        this.warnEnrichmentMissThrottled(deviceId, dev, req, steps)
      }
      try {
        await this.deps.routeResults(deviceId, req.trackId, details, frame)
      } catch (err) {
        this.deps.logger.warn('detail result routing failed', {
          tags: { deviceId },
          meta: { trackId: req.trackId, stepId: req.stepId, error: String(err) },
        })
      }
    }
    // Feed the scheduler AFTER routing so sticky/retry reflect the real outcome.
    // The frame plane RESOLVED here (a hard miss returned above via onFrameMiss);
    // an empty detection feeds `null` topScore, which the scheduler treats as a
    // retry-eligible failure per the step's cadence policy.
    dev.scheduler.onResult(req.trackId, req.stepId, topScore, Date.now())
  }

  /**
   * Walk the crop-source ladder for one request, stopping at the first rung that
   * produces a result. Returns the detail list, or `null` when every rung failed.
   *
   * 1. `frameHandle` — cheapest when it hits: no payload moves and the runner's
   *    leaf children re-cut their ROI at native resolution. Tried first, always.
   * 2. `frameJpeg` — the track's PARKED key frame (D422): the full native frame
   *    the owning node copied at the best instant, retrieved by track and handed
   *    to the runner UNCUT, so the rectangle still comes from the single
   *    derivation (D52). This rung exists because rung 1 is structurally
   *    unreachable for most dispatches — a tick + inference routinely lands
   *    outside the lease — and it cannot miss on age. It runs ONCE per parcel
   *    per step; a dispatch that finds the same parcel already enriched skips
   *    it, so a coasting track does not re-embed the same image every second.
   * 3. `cropJpeg` — the pre-cut tile. Last, because the caller decided its
   *    rectangle and because in practice the same native miss that emptied rung 1
   *    empties this one too.
   *
   * On D9/D18: the payload that crosses in rung 2 is a COMPRESSED JPEG retrieved
   * on demand, per TRACK per dispatch (≤2 in flight per device, ~1 Hz) and only
   * after rung 1 missed — never a frame-rate stream, and never raw pixels.
   *
   * ONE outcome stops the ladder cold: the runner's typed `not-attached`
   * refusal (`detail-refusal.ts`). It names the camera's SESSION state, not
   * this frame — the session closed and the runner's detail park grace has
   * lapsed — so the two remaining rungs are structurally doomed (the retained
   * store is purged with the session; `captureCrop` is native-strict against
   * the same missing lease). Walking them anyway is what burned two extra
   * cross-node RPCs per refusal, ~600–900 times an hour fleet-wide.
   */
  private async runOnce(
    deviceId: number,
    dev: DeviceState,
    req: DetailRequest,
    frame: TrackDetailFrame,
    rootSupplied?: RootSuppliedDispatch,
  ): Promise<readonly DetailResult[] | null> {
    const parent = { bbox: { ...frame.bbox }, className: frame.className }
    const steps = rootSupplied
      ? [...rootSupplied.steps]
      : composeDetailSteps(req, (trackId) => this.deps.hasTrackLabel?.(trackId) ?? false)
    // The root's boxes are frame-space, like `parent` — every rung that sends
    // `parent` sends them as they are; the parcel rung rescales both.
    const supplied = rootSupplied ? { supplied: rootSupplied.supplied } : {}
    // Set when the runner refuses THIS dispatch's handle as expired: the
    // native-strict crop rung below would name the same handle and be refused
    // the same way, so it is skipped (D688).
    let handleRefused = false

    if (frame.frameHandle !== undefined) {
      try {
        const primary = await this.deps.runDetailSubtree(
          { deviceId, frameHandle: frame.frameHandle, parent, steps, ...supplied },
          frame.nodeId,
        )
        if (primary !== null) return primary.details
      } catch (err) {
        if (isDetailNotAttachedRefusal(err)) {
          this.warnNotAttachedThrottled(deviceId, dev, req)
          return null
        }
        if (isDetailHandleExpiredRefusal(err)) {
          handleRefused = true
          this.retireRefusedHandle(deviceId, dev, req, frame)
        } else {
          this.deps.logger.debug('detail primary call failed — trying frame fallback', {
            tags: { deviceId },
            meta: { trackId: req.trackId, stepId: req.stepId, error: String(err) },
          })
        }
      }
    }

    if (this.deps.captureParkedFrame !== undefined) {
      try {
        const parked = await this.deps.captureParkedFrame(deviceId, req.trackId)
        if (parked !== null) {
          const enrichedAt = dev.parcelEnriched.get(req.trackId)?.get(req.stepId)
          if (enrichedAt === parked.timestamp) {
            // Same parcel, same step: the answer would be the one already
            // routed. Not a miss of the frame plane — but nothing new either,
            // so the ladder continues to its last rung and the scheduler's
            // bounded give-up.
            this.deps.logger.debug('detail parcel already enriched for this step — skipping', {
              tags: { deviceId },
              meta: { trackId: req.trackId, stepId: req.stepId, parkedTimestamp: parked.timestamp },
            })
          } else {
            // The runner reads `parent.bbox` as pixels of THIS image; the box
            // arrives already in the parcel's space, and the rectangle is
            // still the runner's to derive (D52).
            const derived = await this.deps.runDetailSubtree(
              {
                deviceId,
                frameJpeg: parked.base64,
                parent: { bbox: { ...parked.bbox }, className: frame.className },
                steps,
                ...(rootSupplied
                  ? { supplied: suppliedInParcel(rootSupplied.supplied, frame.bbox, parked.bbox) }
                  : {}),
              },
              parked.nodeId,
            )
            if (derived !== null) {
              const perStep = dev.parcelEnriched.get(req.trackId) ?? new Map<string, number>()
              perStep.set(req.stepId, parked.timestamp)
              dev.parcelEnriched.set(req.trackId, perStep)
              return derived.details
            }
          }
        }
      } catch (err) {
        if (isDetailNotAttachedRefusal(err)) {
          this.warnNotAttachedThrottled(deviceId, dev, req)
          return null
        }
        this.deps.logger.debug('detail parked-frame rung failed', {
          tags: { deviceId },
          meta: { trackId: req.trackId, stepId: req.stepId, error: String(err) },
        })
      }
    }

    // The crop rung cuts from `frame.frameHandle` (native-strict): with no
    // handle — or one just refused — it has nothing it could name.
    if (
      this.deps.captureCropBase64 !== undefined &&
      frame.frameHandle !== undefined &&
      !handleRefused
    ) {
      try {
        const cropJpeg = await this.deps.captureCropBase64(frame)
        if (cropJpeg !== null) {
          const retry = await this.deps.runDetailSubtree(
            { deviceId, cropJpeg, parent, steps, ...supplied },
            frame.nodeId,
          )
          if (retry !== null) return retry.details
        }
      } catch (err) {
        if (isDetailNotAttachedRefusal(err)) {
          this.warnNotAttachedThrottled(deviceId, dev, req)
          return null
        }
        this.deps.logger.debug('detail crop-fallback call failed', {
          tags: { deviceId },
          meta: { trackId: req.trackId, stepId: req.stepId, error: String(err) },
        })
      }
    }

    this.warnFailThrottled(deviceId, dev, req)
    return null
  }

  /**
   * The runner refused `frame`'s handle as past the lease age bound (D688).
   * That verdict is final for the handle, so the track's stored association
   * loses it: later dispatches skip rung 1 and the native-strict crop rung
   * (both would name the same handle and be refused again — ~7 times per
   * handle on the live fleet) and go straight to the parked frame, until a
   * newly OBSERVED frame brings a fresh handle via {@link onFrame}.
   *
   * Only the refused handle is dropped: if a newer frame replaced it while the
   * dispatch was in flight, that one stands. The line is therefore emitted once
   * per (track, handle) — a concurrent dispatch refused on the same handle
   * finds it already gone and says nothing.
   */
  private retireRefusedHandle(
    deviceId: number,
    dev: DeviceState,
    req: DetailRequest,
    frame: TrackDetailFrame,
  ): void {
    const current = dev.tracks.get(req.trackId)
    if (current === undefined || current.frameHandle !== frame.frameHandle) return
    const { frameHandle: refused, ...withoutHandle } = current
    dev.tracks.set(req.trackId, withoutHandle)
    this.deps.logger.info(
      'detail dispatch: frame handle refused as expired — retired for this track, parked frame only until a fresh observation',
      {
        tags: { deviceId },
        meta: {
          trackId: req.trackId,
          stepId: req.stepId,
          reason: 'handle-expired',
          // Same spelling as the runner's `native crop refused` line, so the
          // two halves can be joined.
          handle: refused === undefined ? null : `${refused.shmId}#${refused.slot}#${refused.seq}`,
          parkedFrameRung: this.deps.captureParkedFrame !== undefined,
        },
      },
    )
  }

  /**
   * The typed refusal is EXPECTED for a track that outlives the runner's
   * detail park grace (a closing track's last dispatches), so it logs its own
   * line — the reason is knowable, unlike the every-rung-missed warn — and
   * shares the per-device throttle. Never silent: this branch drops the
   * track's enrichment for good once the give-up bound is reached.
   */
  private warnNotAttachedThrottled(deviceId: number, dev: DeviceState, req: DetailRequest): void {
    const now = Date.now()
    if (now - dev.lastFailWarnAt < FAIL_WARN_THROTTLE_MS) return
    dev.lastFailWarnAt = now
    this.deps.logger.warn(
      'detail dispatch refused: camera not attached (park grace lapsed) — skipping fallback rungs',
      {
        tags: { deviceId },
        meta: { trackId: req.trackId, stepId: req.stepId, reason: req.reason },
      },
    )
  }

  private warnFailThrottled(deviceId: number, dev: DeviceState, req: DetailRequest): void {
    const now = Date.now()
    if (now - dev.lastFailWarnAt < FAIL_WARN_THROTTLE_MS) return
    dev.lastFailWarnAt = now
    this.deps.logger.warn('runDetailSubtree produced no result (every crop source missed)', {
      tags: { deviceId },
      meta: {
        trackId: req.trackId,
        stepId: req.stepId,
        reason: req.reason,
        // WHICH rungs were even available. A dispatch that never had a full
        // frame to offer is a wiring problem; one that offered all three and
        // still got nothing is a frame-plane problem.
        triedParkedFrame: this.deps.captureParkedFrame !== undefined,
        triedCropJpeg: this.deps.captureCropBase64 !== undefined,
      },
    })
  }

  private warnEnrichmentMissThrottled(
    deviceId: number,
    dev: DeviceState,
    req: DetailRequest,
    steps: readonly string[],
  ): void {
    const now = Date.now()
    if (now - dev.lastEnrichWarnAt < FAIL_WARN_THROTTLE_MS) return
    dev.lastEnrichWarnAt = now
    this.deps.logger.warn(
      'detail chain ran but produced no enrichment (root detected, child yielded no label/embedding)',
      {
        tags: { deviceId },
        meta: { trackId: req.trackId, stepId: req.stepId, reason: req.reason, steps },
      },
    )
  }
}
