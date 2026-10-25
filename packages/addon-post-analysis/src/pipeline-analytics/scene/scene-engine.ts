// ---------------------------------------------------------------------------
// Scene engine — similarity-mode reference-region state (pipeline-analytics)
// ---------------------------------------------------------------------------
//
// Revived from the retired enrichment-engine `SceneStateWorker` with BOTH dead
// wires fixed during the move into pipeline-analytics:
//   1. Encoder wire — the old local-registry `getCollection('embedding-encoder')`
//      (always empty across the process boundary) becomes the cross-process
//      `EmbeddingEncoderClient` (ctx.api.embeddingEncoder.*).
//   2. Snapshot wire — the phantom `streamBrokerRegistry.getSnapshot` (always
//      null) becomes `ctx.fetchDevice(id).snapshot.getSnapshot`, injected here
//      as `getSnapshot`. The snapshot cap returns an ENCODED image, so the crop
//      path decodes via sharp (auto-detect) rather than the raw-RGB
//      `extractCrop` the shm frame plane uses.
//
// Scoring/hysteresis are the pure `scene-scoring` helpers; the current condition
// (day/night) comes from the layered `condition-resolver`. The engine is
// decoupled from persistence: it reads scenes via an injected `listAllScenes`
// and pushes results via an injected `applyEngineResult` (the scene-monitor
// provider owns the runtimeState mirror + the EnrichmentSceneStateChanged emit).

import type {
  IScopedLogger,
  SceneCondition,
  SceneMonitor,
  SceneUnavailable,
  SceneVerdict,
} from '@camstack/types'
import { SCENE_DIVERGED } from '@camstack/types'
import type { EmbeddingEncoderClient } from '../embedding/embedding-dispatcher.js'
import type { Coordinates } from './condition-resolver.js'
import { resolveCondition } from './condition-resolver.js'
import type { SceneConfirmGate } from './scene-confirm-gate.js'
import { anchorFrame, chromaSpread, cropSnapshotRoi } from './scene-crop.js'
import type { LlmVisionClient } from './scene-llm-adapter.js'
import { checkSceneLlm } from './scene-llm-adapter.js'
import type { HysteresisState } from './scene-scoring.js'
import {
  cosineSimilarity,
  coveredConditions,
  scoreStates,
  stepHysteresis,
} from './scene-scoring.js'

/**
 * Similarity-mode default cadence. 60 s, not the 10 s the original spec chose:
 * "is the bin still out" has a latency budget of minutes, and 60 s costs 1 440
 * crop-encodes a day per scene (≈ 20 s of accelerator time) against 8 640 at
 * 10 s. The periodic tick is also the safety net that makes the motion path
 * allowed to miss.
 */
const SIMILARITY_DEFAULT_INTERVAL_SEC = 60

/** How long the encoder's model identity is trusted between reads. */
const ENCODER_INFO_TTL_MS = 60_000

/** Snapshot image as returned by the `snapshot` cap. */
export interface SnapshotImage {
  readonly base64: string
  readonly contentType: string
}

/** One enabled scene resolved from persistence, device-scoped. */
export interface SceneDeviceMonitor {
  readonly deviceId: number
  readonly monitor: SceneMonitor
}

/** Result pushed to the provider on a transition / verdict / availability change.
 *
 *  The engine reports the OBSERVATION. It does not own the latch: `latched`,
 *  `armedAt`, `divergedAt` and `restoredAt` live in the provider's durable
 *  ledger, because a latch is a fact only that component ever held and nothing
 *  else can regenerate "the operator has not acknowledged this yet". */
export interface SceneEngineResult {
  readonly currentStateId: string | null
  readonly previousStateId: string | null
  readonly lastConfidence: number | null
  readonly currentCondition: SceneCondition
  /** The live boolean, as a projection of `currentStateId`. */
  readonly verdict: SceneVerdict
  /** Named cause when `verdict === 'unknown'`. */
  readonly unavailable: SceneUnavailable | null
  readonly availability: 'ok' | 'unavailable'
  readonly unavailableReason: string | null
  /** Conditions with at least one COMPARABLE reference — the coverage line. */
  readonly coveredConditions: readonly SceneCondition[]
  /**
   * Set when this "check" was SAT OUT because the current light has no
   * reference of its own and the scene's `onUncoveredCondition` is `skip`.
   *
   * It is not a verdict and it is not an availability: every other field on the
   * result is carried over unchanged, and the provider is required to treat it
   * as a non-observation — no latch write of any kind. `null` on every real
   * check, which is also what clears the marker again.
   */
  readonly suspendedCondition: SceneCondition | null
  readonly transitioned: boolean
  readonly checkedAt: number
}

export interface ConditionContext {
  readonly forcedMode?: 'day' | 'night'
  readonly coordinates?: Coordinates
}

export interface SceneEngineDeps {
  readonly encoder: EmbeddingEncoderClient
  /** `ctx.fetchDevice(id).snapshot.getSnapshot({ force })`. */
  readonly getSnapshot: (deviceId: number, force: boolean) => Promise<SnapshotImage | null>
  /** Enabled scenes across all devices — the provider's persisted rows. */
  readonly listAllScenes: () => Promise<ReadonlyArray<SceneDeviceMonitor>>
  /** Push a transition / availability change back to the provider. */
  readonly applyEngineResult: (
    deviceId: number,
    monitorId: string,
    result: SceneEngineResult,
  ) => Promise<void>
  /** Per-device condition inputs (day-night forced mode + install coordinates). */
  readonly resolveConditionContext: (deviceId: number) => Promise<ConditionContext>
  /**
   * "Has this device been busy within `quietMs`" — two `Map.get`s, no await.
   * The quiet gate reads it on EVERY check, so it must never be an I/O: a gate
   * that consults a store is a gate that fails when the store is slow (D49).
   * Absent ⇒ every observation counts, which is the old behaviour.
   */
  readonly isMotionActive?: (deviceId: number, atMs: number, quietMs: number) => boolean
  /**
   * Vision-model adjudicator, consulted ONLY on a candidate flip. Absent ⇒
   * CLIP alone decides, which is the correct behaviour on an install with no
   * vision profile — and is why a scene carrying `confirm.enabled` on a node
   * with no gate must never silently behave as if it had been confirmed.
   */
  readonly confirmGate?: SceneConfirmGate
  /**
   * Vision-LLM client for `llm`-mode scenes — `ctx.api.llm`.
   *
   * NOT WIRED by any production caller today: this engine is constructed only
   * by its own spec, so an `llm`-mode scene reports
   * `availability:'unavailable'` through the one adapter seam. Said plainly
   * rather than as "until the cap ships" — the `llm` cap SHIPPED; what is
   * missing is this engine's own wiring, and the two are different absences.
   */
  readonly llm?: LlmVisionClient | null
  readonly logger: IScopedLogger
  readonly defaultCheckIntervalSec?: number
}

interface MonitorRuntime {
  hysteresis: HysteresisState
  lastCheckAt: number
  /** When an observation last ADVANCED the pending count — the spacing gate's
   *  reference. Distinct from `lastCheckAt`, which every attempt updates. */
  lastCountedAt: number
  lastAvailability: 'ok' | 'unavailable'
  lastVerdict: SceneVerdict
  lastUnavailable: SceneUnavailable | null
  /** The light currently being sat out, so the pause is announced once per
   *  transition rather than once per tick. */
  suspendedCondition: SceneCondition | null
}

/**
 * The live boolean, as a PROJECTION of `currentStateId` — no second model, no
 * parallel `boolean` scene type (D62). A monitor with `baselineStateId` set is
 * the operator's boolean case; one with `baselineStateId: null` is the
 * multi-state case, where any real state is a match.
 */
function projectVerdict(
  currentStateId: string | null,
  baselineStateId: string | null,
): SceneVerdict {
  if (currentStateId === SCENE_DIVERGED) return 'diverged'
  if (currentStateId === null) return 'unknown'
  if (baselineStateId === null) return 'matched'
  return currentStateId === baselineStateId ? 'matched' : 'diverged'
}

/**
 * Why nothing was comparable. The discriminator is whether the scene holds ANY
 * reference tagged with the current condition: if it does and none survived the
 * gate, the encoder moved under us; if it does not, the operator has simply
 * never captured this scene in this light. The two need different words,
 * because they need different fixes.
 */
function unknownCause(monitor: SceneMonitor, condition: SceneCondition): SceneUnavailable {
  const hasRefForCondition = monitor.states.some((s) =>
    s.references.some((r) => r.condition === condition),
  )
  return hasRefForCondition ? 'encoder-model-changed' : 'no-reference-for-condition'
}

/**
 * Scene engine — one `setInterval` tick fans out to every DUE periodic scene;
 * `onMotion` re-checks on-motion scenes (debounced by the per-scene interval
 * floor); `recheck` forces an out-of-cycle check. Runs on exactly one node
 * (the caller gates on `isPostProcessingNode`).
 */
export class SceneEngine {
  private readonly deps: SceneEngineDeps
  private readonly runtime = new Map<string, MonitorRuntime>()
  /** Last observed motion per device — the quiet-edge trigger's only input. */
  private readonly lastMotionAt = new Map<number, number>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private encoderInfoCache: {
    info: { modelId: string; embeddingDim: number }
    at: number
  } | null = null

  constructor(deps: SceneEngineDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.tickTimer) return
    // 1s base tick; each scene is gated by its own interval floor.
    this.tickTimer = setInterval(() => {
      void this.runDue()
    }, 1000)
    this.deps.logger.info('SceneEngine started')
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /** Belt for the tick fan-out: ONE scene's failure is that scene's problem —
   *  never the sibling checks', and never the runner's (`void runDue()` has
   *  nobody above it to catch). */
  private async checkOnceGuarded(deviceId: number, monitor: SceneMonitor): Promise<void> {
    try {
      await this.checkOnce(deviceId, monitor)
    } catch (err) {
      this.deps.logger.warn('SceneEngine check failed — skipped this cycle', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, error: String(err) },
      })
    }
  }

  private key(deviceId: number, monitorId: string): string {
    return `${deviceId}:${monitorId}`
  }

  private intervalMs(monitor: SceneMonitor): number {
    const sec =
      monitor.checkIntervalSec ??
      this.deps.defaultCheckIntervalSec ??
      SIMILARITY_DEFAULT_INTERVAL_SEC
    return sec * 1000
  }

  /**
   * Motion was observed on a device. Recorded, NOT acted on.
   *
   * The on-motion trigger fires on the QUIET EDGE, not on motion: last motion
   * at `T` ⇒ check at `T + quietSeconds`. Checking during motion would be
   * checking the van parked in front of the bin.
   *
   * This is the same idea as `MotionSettleGovernor` in `addon-pipeline` and it
   * is deliberately NOT the same code: addons never import each other, the
   * governor also owns a burst and a poll safety net a scene does not want, and
   * what a scene needs is only the quiet-edge half. Said out loud so the
   * duplication is a decision rather than an accident.
   */
  noteMotion(deviceId: number, atMs: number): void {
    this.lastMotionAt.set(deviceId, atMs)
  }

  /**
   * Base tick. A scene is due when EITHER its periodic interval elapsed, or its
   * device's motion has been quiet for `quietSeconds` and that quiet edge has
   * not been served yet.
   *
   * The quiet edge is computed here rather than on a per-device timer because
   * the tick already runs: a timer would be a second scheduler that can drift,
   * miss on a restart, and disagree with the interval floor it shares a monitor
   * with.
   */
  private async runDue(): Promise<void> {
    const now = Date.now()
    let scenes: ReadonlyArray<SceneDeviceMonitor>
    try {
      scenes = await this.deps.listAllScenes()
    } catch (err) {
      this.deps.logger.warn('SceneEngine listAllScenes failed', { meta: { error: String(err) } })
      return
    }
    await Promise.all(
      scenes.map(async ({ deviceId, monitor }) => {
        if (!monitor.enabled) return
        const rt = this.runtime.get(this.key(deviceId, monitor.id))
        const lastCheckAt = rt?.lastCheckAt ?? 0
        const periodic = monitor.triggerMode === 'periodic' || monitor.triggerMode === 'both'
        const onMotion = monitor.triggerMode === 'on-motion' || monitor.triggerMode === 'both'

        if (periodic && now - lastCheckAt >= this.intervalMs(monitor)) {
          await this.checkOnceGuarded(deviceId, monitor)
          return
        }
        if (!onMotion) return
        const motionAt = this.lastMotionAt.get(deviceId)
        if (motionAt === undefined) return
        // The quiet edge has to be AHEAD of the last check, or one motion
        // episode would be served on every tick for the rest of the hour.
        if (motionAt <= lastCheckAt) return
        if (now - motionAt < monitor.quietSeconds * 1000) return
        await this.checkOnceGuarded(deviceId, monitor)
      }),
    )
  }

  /**
   * Drop every in-flight observation for a monitor and re-seed it at
   * `currentStateId`. Called on reset: the pending hysteresis run belonged to
   * the world BEFORE the operator declared a new normal, and letting it survive
   * would let two divergence observations from last week's baseline flip the
   * scene one check after a reset.
   */
  resetMonitor(deviceId: number, monitorId: string, currentStateId: string | null): void {
    this.runtime.set(this.key(deviceId, monitorId), {
      hysteresis: { currentStateId, pendingStateId: null, pendingCount: 0 },
      lastCheckAt: 0,
      lastCountedAt: 0,
      lastAvailability: 'ok',
      lastVerdict: currentStateId === null ? 'unknown' : 'matched',
      lastUnavailable: null,
      suspendedCondition: null,
    })
  }

  /** Force an out-of-cycle check for a single monitor. */
  async recheck(deviceId: number, monitorId: string): Promise<void> {
    const scenes = await this.deps.listAllScenes()
    const found = scenes.find((s) => s.deviceId === deviceId && s.monitor.id === monitorId)
    if (found) await this.checkOnce(deviceId, found.monitor)
  }

  /** Single scene check — resolve condition, then similarity-score or (llm)
   *  report unavailable. Pushes a result on a transition / availability flip. */
  async checkOnce(deviceId: number, monitor: SceneMonitor): Promise<void> {
    const now = Date.now()
    const k = this.key(deviceId, monitor.id)
    const rt = this.runtime.get(k) ?? {
      hysteresis: {
        currentStateId: monitor.currentStateId,
        pendingStateId: null,
        pendingCount: 0,
      },
      lastCheckAt: 0,
      lastCountedAt: 0,
      lastAvailability: monitor.availability,
      lastVerdict: monitor.verdict,
      lastUnavailable: monitor.unavailable,
      suspendedCondition: monitor.suspendedCondition,
    }
    rt.lastCheckAt = now
    this.runtime.set(k, rt)

    // ---- The quiet gate. A check is only COUNTED when the frame was quiet. ----
    // Motion during the observation window does not merely DELAY the check, it
    // DISCARDS it: a car pulling up in front of the bin must not be able to
    // spend hysteresis credit, and three "diverged" reads taken while a van sat
    // in the ROI are three readings of the van.
    const quietMs = monitor.quietSeconds * 1000
    if (quietMs > 0 && this.deps.isMotionActive?.(deviceId, now, quietMs) === true) {
      this.deps.logger.debug('scene observation discarded — device not quiet', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, quietSeconds: monitor.quietSeconds },
      })
      return
    }

    const condCtx = await this.deps.resolveConditionContext(deviceId)

    if (monitor.check.mode === 'llm') {
      const condition = resolveCondition({ ...condCtx, now: new Date(now) })
      // The vision-LLM judgment goes through the ONE adapter seam. No caller
      // supplies `deps.llm` yet, so `checkSceneLlm` returns `unavailable`; when
      // the crop IS needed (llm present) it is fetched lazily, so a null llm
      // never wakes a battery cam.
      const llm = this.deps.llm ?? null
      let crop: Uint8Array = new Uint8Array(0)
      if (llm !== null) {
        const snap = await this.deps.getSnapshot(deviceId, false).catch(() => null)
        if (!snap) return
        const cropped = await cropSnapshotRoi(
          Buffer.from(snap.base64, 'base64'),
          monitor.roi,
        ).catch(() => null)
        if (!cropped) return
        crop = cropped.crop
      }
      const llmResult = await checkSceneLlm({
        llm,
        crop,
        prompt: monitor.check.prompt,
        ...(monitor.check.profileId !== undefined ? { profileId: monitor.check.profileId } : {}),
      })
      if (llmResult.availability === 'unavailable') {
        // Emit once on the availability flip (avoids spamming an unchanged state).
        if (rt.lastAvailability !== 'unavailable') {
          rt.lastAvailability = 'unavailable'
          rt.lastVerdict = 'unknown'
          rt.lastUnavailable = 'no-vision-profile'
          await this.deps.applyEngineResult(deviceId, monitor.id, {
            currentStateId: rt.hysteresis.currentStateId,
            previousStateId: rt.hysteresis.currentStateId,
            lastConfidence: null,
            currentCondition: condition,
            verdict: 'unknown',
            unavailable: 'no-vision-profile',
            availability: 'unavailable',
            unavailableReason: llmResult.reason,
            coveredConditions: [],
            suspendedCondition: null,
            transitioned: false,
            checkedAt: now,
          })
        }
        return
      }
      // availability:'ok' path — only reachable once a caller wires a real llm
      // client. The active/inactive judgment maps to the scene's designated
      // state; that mapping lands with the wiring and its engine test.
      rt.lastAvailability = 'ok'
      this.runtime.set(k, rt)
      return
    }

    // Similarity mode.
    let snap: SnapshotImage | null
    try {
      snap = await this.deps.getSnapshot(deviceId, false)
    } catch (err) {
      this.deps.logger.warn('SceneEngine snapshot failed', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, error: String(err) },
      })
      return
    }
    if (!snap) return

    const encoded = Buffer.from(snap.base64, 'base64')
    let crop: Buffer
    let cropWidth: number
    let cropHeight: number
    // The condition comes from the FRAME (measured IR), not the clock — so it
    // is resolved here, after the decode, rather than before the snapshot.
    let condition: SceneCondition
    try {
      const cropped = await cropSnapshotRoi(encoded, monitor.roi)
      crop = cropped.crop
      cropWidth = cropped.width
      cropHeight = cropped.height
      const spread = await chromaSpread(encoded).catch(() => undefined)
      condition = resolveCondition({
        ...condCtx,
        ...(spread !== undefined ? { chromaSpread: spread } : {}),
        now: new Date(now),
      })
    } catch (err) {
      this.deps.logger.warn('SceneEngine crop failed', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, error: String(err) },
      })
      return
    }

    if (monitor.check.mode !== 'similarity') return

    // The encoder is a separate process serving a model that can be RETIRED
    // under us (2026-08-21: the onnx clip artifacts were withdrawn and this
    // await's rejection killed the whole analytics runner every 60s via
    // `void runDue()` → unhandledRejection). A dead encoder skips the check,
    // loudly — it must never cost more than the check it was for.
    let embedding: readonly number[]
    let info: { modelId: string; embeddingDim: number }
    try {
      const encoded = await this.deps.encoder.encode(crop, cropWidth, cropHeight)
      embedding = encoded.embedding
      info = await this.encoderInfo()
    } catch (err) {
      this.deps.logger.warn('SceneEngine encode failed — check skipped', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, error: String(err) },
      })
      return
    }
    const { bestStateId, bestScore } = scoreStates(
      monitor.states,
      embedding,
      condition,
      info.modelId,
      info.embeddingDim,
      { crossConditionFallback: monitor.onUncoveredCondition === 'judge-anyway' },
    )
    const covered = [...coveredConditions(monitor.states, info.modelId, info.embeddingDim)]

    // ---- Nothing was comparable → `unknown`. Never a guess, never a latch. ----
    // This branch used to be a bare `return` shared with the below-threshold
    // case, which made "I cannot judge" and "it no longer matches" the same
    // silent non-event.
    if (bestScore === null) {
      const cause = unknownCause(monitor, condition)
      rt.lastAvailability = 'ok'
      this.runtime.set(k, rt)
      // ---- The night half is OPTIONAL. ----
      // A scene armed in SOME light but not this one is not broken: almost
      // nobody stands outside at 22:00 to capture the IR reference, and plenty
      // of scenes are daytime questions that never need one. Under `skip` the
      // check is simply not made — no verdict, no `unknown`, no latch, no
      // hysteresis credit spent or cleared — and the scene resumes by itself at
      // first light. `covered.length > 0` is the discriminator that keeps this
      // from swallowing a scene nobody ever captured at all, which IS something
      // the operator still has to do.
      if (
        cause === 'no-reference-for-condition' &&
        covered.length > 0 &&
        monitor.onUncoveredCondition === 'skip'
      ) {
        await this.reportSuspended(deviceId, monitor, rt, { condition, covered, now })
        return
      }
      await this.reportUnknown(deviceId, monitor, rt, {
        condition,
        cause,
        covered,
        now,
      })
      return
    }

    // ---- The fix: "no match" is a FIRST-CLASS candidate. ----
    // A below-threshold check produces the synthetic `SCENE_DIVERGED` and feeds
    // it through the SAME two-sided hysteresis machine, so leaving a state
    // costs exactly the same N agreeing observations as entering one. The
    // machine was always two-sided; it was simply never given the second input.
    const candidate =
      bestStateId !== null && bestScore >= monitor.check.threshold ? bestStateId : SCENE_DIVERGED

    // ---- Observation SPACING. ----
    // At 60 s with `hysteresisCount: 3`, three consecutive polls span three
    // minutes — long enough for a person to walk past, short enough for a van
    // to sit in front of the bin for the whole run. An observation only
    // advances the pending count when it is at least `minObservationSpacingSec`
    // from the previously COUNTED one, so N agreeing reads span real time
    // rather than N adjacent polls inside one occlusion.
    const spacingMs = monitor.minObservationSpacingSec * 1000
    const sinceCounted = now - rt.lastCountedAt
    if (
      spacingMs > 0 &&
      rt.lastCountedAt > 0 &&
      sinceCounted < spacingMs &&
      candidate !== rt.hysteresis.currentStateId
    ) {
      this.deps.logger.debug('scene observation not counted — too close to the previous one', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, sinceCountedMs: sinceCounted, spacingMs },
      })
      return
    }

    const previousStateId = rt.hysteresis.currentStateId
    const step = stepHysteresis(rt.hysteresis, candidate, monitor.check.hysteresisCount)

    // ---- The view-shift anchor, checked LAZILY on a candidate flip. ----
    // Bump the camera, run a PTZ preset or have an installer re-aim it and the
    // normalized rect now frames a different piece of world: the scene diverges
    // and stays diverged forever, with a perfectly plausible cosine. One extra
    // encode per candidate transition — not per poll, the same discipline the
    // LLM confirm gets — turns a moved camera into "I can no longer trust this
    // scene" instead of a theft.
    if (step.transitioned) {
      const anchorOk = await this.anchorAgrees(deviceId, monitor, encoded, info)
      if (!anchorOk) {
        rt.lastCountedAt = now
        this.runtime.set(k, rt)
        await this.reportUnknown(deviceId, monitor, rt, {
          condition,
          cause: 'view-shifted',
          covered,
          now,
        })
        return
      }

      // ---- CLIP proposes, the vision model adjudicates. ----
      // Asked ONLY here — never on a poll. That single placement is what turns
      // a 1 440-call/day feature into a ~2-call/week one, while the operator's
      // own semantics ("is the bin there") govern every state change that
      // actually reaches them. The anchor runs FIRST so a moved camera never
      // costs a vision call.
      const confirm = monitor.confirm
      const gate = this.deps.confirmGate
      if (confirm !== undefined && confirm.enabled && gate !== undefined) {
        const direction = candidate === SCENE_DIVERGED ? 'diverged' : 'restored'
        const verdict = await gate.judge({
          deviceId,
          monitorId: monitor.id,
          direction,
          // `new Uint8Array(crop)` normalizes the sharp Buffer to an
          // ArrayBuffer-backed view (the llm cap's exact input type) — a
          // negligible copy on a path that runs ~twice a week.
          image: new Uint8Array(crop),
          confirm,
        })
        if (verdict.decision === 'held') {
          // The flip does NOT commit — and the pending run is dropped, so the
          // scene must earn its N observations again rather than flipping on
          // the very next check the moment the model comes back.
          rt.hysteresis = {
            currentStateId: rt.hysteresis.currentStateId,
            pendingStateId: null,
            pendingCount: 0,
          }
          rt.lastCountedAt = now
          this.runtime.set(k, rt)
          return
        }
      }
    }

    rt.hysteresis = {
      currentStateId: step.currentStateId,
      pendingStateId: step.pendingStateId,
      pendingCount: step.pendingCount,
    }
    rt.lastCountedAt = now
    rt.lastAvailability = 'ok'
    this.runtime.set(k, rt)

    const verdict = projectVerdict(step.currentStateId, monitor.baselineStateId)
    // A scene that was sitting a light out has just checked for real. That is a
    // change the card has to hear about even when the verdict is the same one
    // it paused on, or "checks paused" would stay on screen until the next
    // transition — which for a scene that never diverges is never.
    const resumed = rt.suspendedCondition !== null
    const changed =
      step.transitioned ||
      verdict !== rt.lastVerdict ||
      rt.lastAvailability !== monitor.availability ||
      rt.lastUnavailable !== null ||
      resumed
    rt.lastVerdict = verdict
    rt.lastUnavailable = null
    rt.suspendedCondition = null
    this.runtime.set(k, rt)

    if (changed) {
      await this.deps.applyEngineResult(deviceId, monitor.id, {
        currentStateId: step.currentStateId,
        previousStateId,
        lastConfidence: bestScore,
        currentCondition: condition,
        verdict,
        unavailable: null,
        availability: 'ok',
        unavailableReason: null,
        coveredConditions: covered,
        suspendedCondition: null,
        transitioned: step.transitioned,
        checkedAt: now,
      })
    }
  }

  /**
   * Announce that this scene is SITTING OUT the current light — once per
   * transition into it, never once per tick. At a 60 s cadence a per-tick line
   * would be ~480 lines a night per scene, which is how a log stops being read
   * at all.
   *
   * `info`, not `warn`: nothing is wrong. The operator chose not to capture
   * this light, or has not got round to it, and either way the scene is doing
   * exactly what it was configured to do. A branch that drops work still has to
   * SAY so — silence reads as "never happened" — but saying it at warning level
   * would train the operator to ignore the one channel that reports real
   * faults.
   */
  private async reportSuspended(
    deviceId: number,
    monitor: SceneMonitor,
    rt: MonitorRuntime,
    input: { condition: SceneCondition; covered: readonly SceneCondition[]; now: number },
  ): Promise<void> {
    if (rt.suspendedCondition === input.condition) return
    rt.suspendedCondition = input.condition
    this.deps.logger.info('scene checks paused — nothing captured in this light', {
      tags: { deviceId },
      meta: {
        monitorId: monitor.id,
        condition: input.condition,
        covered: input.covered.join(','),
      },
    })
    // Every judgment field is carried over UNCHANGED. The provider treats a
    // result with `suspendedCondition` set as a non-observation and writes no
    // latch, so these values are only here to keep the shape honest.
    await this.deps.applyEngineResult(deviceId, monitor.id, {
      currentStateId: rt.hysteresis.currentStateId,
      previousStateId: rt.hysteresis.currentStateId,
      lastConfidence: null,
      currentCondition: input.condition,
      verdict: rt.lastVerdict,
      unavailable: rt.lastUnavailable,
      availability: 'ok',
      unavailableReason: null,
      coveredConditions: input.covered,
      suspendedCondition: input.condition,
      transitioned: false,
      checkedAt: input.now,
    })
  }

  /**
   * Push an `unknown` verdict — once per transition, not once per poll. The
   * held state is deliberately NOT destroyed: a scene that cannot judge is a
   * scene that has not observed anything, and an observation it could not make
   * must never spend or clear hysteresis credit in either direction.
   */
  private async reportUnknown(
    deviceId: number,
    monitor: SceneMonitor,
    rt: MonitorRuntime,
    input: {
      condition: SceneCondition
      cause: SceneUnavailable
      covered: readonly SceneCondition[]
      now: number
    },
  ): Promise<void> {
    if (
      rt.lastVerdict === 'unknown' &&
      rt.lastUnavailable === input.cause &&
      rt.suspendedCondition === null
    ) {
      return
    }
    rt.lastVerdict = 'unknown'
    rt.lastUnavailable = input.cause
    rt.suspendedCondition = null
    // A branch that drops work silently reads as "never happened". This one is
    // the whole failure mode of the feature, so it says so, per-camera.
    this.deps.logger.warn('scene cannot judge — reporting unknown', {
      tags: { deviceId },
      meta: {
        monitorId: monitor.id,
        condition: input.condition,
        cause: input.cause,
        covered: input.covered.join(','),
      },
    })
    await this.deps.applyEngineResult(deviceId, monitor.id, {
      currentStateId: rt.hysteresis.currentStateId,
      previousStateId: rt.hysteresis.currentStateId,
      lastConfidence: null,
      currentCondition: input.condition,
      verdict: 'unknown',
      unavailable: input.cause,
      availability: 'ok',
      unavailableReason: `no comparable reference for "${input.condition}"`,
      coveredConditions: input.covered,
      suspendedCondition: null,
      transitioned: false,
      checkedAt: input.now,
    })
  }

  /**
   * Does the whole frame still look like the view the references were captured
   * from?
   *
   * A scene with NO stored anchor answers `true` — a reference captured before
   * the anchor existed must not become unusable, and "no guard" is honest
   * degradation where "refuse everything" would be a silent outage. Vendor- and
   * PTZ-agnostic on purpose: most cameras here expose no usable position
   * feedback, and the ones that do disagree about what a preset means.
   */
  private async anchorAgrees(
    deviceId: number,
    monitor: SceneMonitor,
    encoded: Buffer,
    info: { modelId: string; embeddingDim: number },
  ): Promise<boolean> {
    const anchors = monitor.states
      .flatMap((s) => s.references)
      .filter(
        (r) =>
          r.anchorEmbedding !== undefined &&
          r.modelId === info.modelId &&
          r.anchorEmbedding.length === info.embeddingDim,
      )
    if (anchors.length === 0) return true
    try {
      const frame = await anchorFrame(encoded)
      const { embedding } = await this.deps.encoder.encode(frame.crop, frame.width, frame.height)
      let best = -1
      for (const a of anchors) {
        const sim = cosineSimilarity(embedding, a.anchorEmbedding ?? [])
        if (sim > best) best = sim
      }
      if (best >= monitor.anchorThreshold) return true
      this.deps.logger.warn('scene flip REFUSED — the camera view has shifted', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, anchorScore: best, threshold: monitor.anchorThreshold },
      })
      return false
    } catch (err) {
      // A failed anchor read must not be able to destroy a flip the pixels
      // earned. Fail toward trusting the observation, and say so.
      this.deps.logger.warn('scene anchor check failed — allowing the flip unguarded', {
        tags: { deviceId },
        meta: { monitorId: monitor.id, error: String(err) },
      })
      return true
    }
  }

  /**
   * `embeddingEncoder.getInfo` measured **1.42 s** cross-process on the live
   * hub. At a 60 s cadence across N scenes that is the dominant cost of the
   * whole feature, so it is cached — and short enough that a model swap is
   * noticed within a minute and reported as `encoder-model-changed`.
   */
  private async encoderInfo(): Promise<{ modelId: string; embeddingDim: number }> {
    const now = Date.now()
    const cached = this.encoderInfoCache
    if (cached !== null && now - cached.at < ENCODER_INFO_TTL_MS) return cached.info
    const info = await this.deps.encoder.getInfo()
    const value = { modelId: info.modelId, embeddingDim: info.embeddingDim }
    this.encoderInfoCache = { info: value, at: now }
    return value
  }
}
