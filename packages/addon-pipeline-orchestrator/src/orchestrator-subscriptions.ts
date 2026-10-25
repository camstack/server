/**
 * `wireOrchestratorSubscriptions` — the ten detection-wiring event-bus
 * subscription closures formerly inline in `onInitialize` (S9 extraction).
 *
 * These used to live in the kernel `DetectionWiringService`, then moved
 * inline into the orchestrator's `onInitialize`. Extracted here verbatim
 * (mechanical, zero logic change) — every handler body, log message, and
 * guard condition is unchanged; only the storage backing differs:
 *
 *  - The ten `unsub*` fields (`unsubDeviceRegistered` … `unsubMotionAnalysis`)
 *    and the `profileSlotTimers` field are replaced by local closure
 *    variables — nothing outside this module ever read them.
 *  - The `if (this.unsub<X> === null) return` post-shutdown guards (blocks
 *    4, 5, 7 — the debounced/async handlers whose callback can fire after
 *    the addon starts tearing down) collapse to a single shared
 *    `isTornDown` flag set at the top of the returned composite unsubscribe.
 *    This is behavior-preserving: in the original code all ten fields are
 *    nulled back-to-back with zero `await` between them (see `onShutdown`),
 *    so no callback could ever observe one field nulled and another not —
 *    the guards were already collectively equivalent to one flag.
 *
 * `wireOrchestratorSubscriptions` must be called LAST in `onInitialize`
 * (after `ReconcileController`/`NodeLifecycleHandler`/every other
 * controller exists) — every handler body below is a one-line delegate
 * onto an already-constructed target via `deps`.
 */
import type {
  CameraDetectionConfig,
  CameraMetrics,
  CameraPipelineConfig,
  IEventBus,
  MotionSource,
  MotionTriggeredBy,
  PipelineInferenceResultPayload,
  Unsubscribe,
} from '@camstack/types'
import {
  createEvent,
  EventCategory,
  errMsg,
  type IScopedLogger,
  isEvent,
  isSourceCap,
  MotionSourceEnum,
  ProviderMotionDataSchema,
  RecordingSignalStatusSchema,
  readMotionTriggeredBy,
  recordingSignalCapability,
} from '@camstack/types'
import {
  DEVICE_ACTIVITY_SOURCE,
  DeviceActivitySource,
  sustainIntervalMs,
} from './device-activity-source.js'
import type { CameraSensorsController } from './camera-sensors/controller.js'
import type { CameraMotionSlice } from './camera-sensors/motion-slice.js'
import type { WatchdogStage } from './pipeline-watchdog.js'
import { RepeatWarnSampler } from './repeat-warn-sampler.js'

export interface OrchestratorSubscriptionsDeps {
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /** Thin seam onto `ReconcileController.scheduleReconcile`. */
  readonly scheduleReconcile: () => void
  /** C14 detection-wiring handlers — stay on the addon class. */
  readonly handleDeviceRegistered: (deviceId: number) => Promise<void>
  readonly handleDeviceUnregistered: (deviceId: number) => Promise<void>
  readonly handleSettingsChanged: (deviceId: number) => Promise<void>
  readonly handlePipelineCameraUpdated: (
    deviceId: number,
    config: CameraPipelineConfig,
  ) => Promise<void>
  readonly handleInferenceResult: (payload: PipelineInferenceResultPayload) => Promise<void>
  /** Thin seam onto `LoadShedController.noteMetrics`. */
  readonly noteMetrics: (
    deviceId: number,
    nodeId: string | undefined,
    metrics: CameraMetrics,
  ) => void
  /** Thin seam onto `AudioSubscriptionController.handleLazyAudioMotion`. */
  readonly handleLazyAudioMotion: (
    deviceId: number,
    detected: boolean,
    config: CameraDetectionConfig,
  ) => Promise<void>
  /** Live read accessor — `this.activeDetections.get(deviceId)` on the addon. */
  readonly getActiveDetectionConfig: (deviceId: number) => CameraDetectionConfig | undefined
  /** Phase 3 slice 2 session dispatch/teardown gate — stays on the addon. */
  readonly handleSessionMotion: (
    deviceId: number,
    detected: boolean,
    emittedAt: number | undefined,
    trigger: MotionSource,
    triggeredBy: MotionTriggeredBy,
  ) => Promise<void>
  /**
   * Session-hold liveness tap — seam onto
   * `SessionDispatchController.noteSubjectPresent`. Fed from the
   * `PipelineAnalyticsFrameTracked` event whenever a frame still has a
   * TRACKED subject on it, moving or stopped.
   */
  readonly noteSessionSubjectPresent: (deviceId: number) => void
  /**
   * Close-line diagnostics tap — seam onto
   * `SessionDispatchController.noteTrackedFrame`. Fed from EVERY
   * `PipelineAnalyticsFrameTracked` that carries `liveTrackCount`, still
   * subjects included (D652). Decides nothing.
   */
  readonly noteSessionTrackedFrame: (deviceId: number, liveTrackCount: number) => void
  /** Thin seam onto `PipelineWatchdog.noteSignal`. */
  readonly noteWatchdogSignal: (deviceId: number, stage: WatchdogStage) => void
  /** Attached sensors as the camera's onboard motion (D672) — block 13. */
  readonly cameraSensors: CameraSensorsController
  /** The camera's `motion` slice, written only here, with the effective motion (D696) — block 9d. */
  readonly cameraMotionSlice: CameraMotionSlice
}

/** A `DeviceStateChanged` slice is an object; anything else carries no level. */
function isSlice(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Debounce window for `CameraStreamsProfileSlotsChanged` coalescing (block 4). */
const PROFILE_SLOTS_DEBOUNCE_MS = 200

export function wireOrchestratorSubscriptions(deps: OrchestratorSubscriptionsDeps): Unsubscribe {
  let isTornDown = false
  const dropSampler = new RepeatWarnSampler()
  const profileSlotTimers = new Map<number, ReturnType<typeof setTimeout>>()

  // 1. Raw camera motion (D673). A provider's onboard push arrives on
  //    `ProviderMotion`; the camera-sensors bridge is the ONE emitter of the
  //    camera's effective `MotionOnMotionChanged { source: 'onboard' }` — a
  //    pass-through for a camera with no attached sensor. Only `onboard` is a
  //    camera push; anything else is said and dropped. Parsed, never spread:
  //    the payload carries no `triggeredBy` and the bridge names one.
  const unsubProviderMotion = deps.eventBus.subscribe(
    { category: EventCategory.ProviderMotion },
    (event) => {
      if (!isEvent(event, EventCategory.ProviderMotion)) return
      const parsed = ProviderMotionDataSchema.safeParse(event.data)
      if (!parsed.success || parsed.data.source !== 'onboard') {
        const deviceId = typeof event.data.deviceId === 'number' ? event.data.deviceId : undefined
        const reason = parsed.success ? 'not-onboard' : 'malformed'
        // Sampled per (camera, reason): a misbehaving emitter at frame rate must not flood WARN.
        const decision = dropSampler.record(`provider-motion:${deviceId ?? 'unknown'}:${reason}`)
        if (decision.logExample || decision.summaryCount !== null) {
          deps.logger.warn('provider motion dropped — not an onboard camera push', {
            ...(deviceId === undefined ? {} : { tags: { deviceId } }),
            meta: {
              source: event.data.source,
              reason,
              ...(decision.summaryCount === null ? {} : { suppressed: decision.summaryCount }),
            },
          })
        }
        return
      }
      const { deviceId, detected, timestamp, regions } = parsed.data
      deps.cameraSensors.onCameraMotion({
        deviceId,
        detected,
        timestamp,
        ...(regions === undefined ? {} : { regions }),
      })
    },
  ) as Unsubscribe

  // 2. Provider-detection events → re-emit as detection.camera-native
  //    (camera-native events that bypass the inference pipeline entirely).
  const unsubProviderDetection = deps.eventBus.subscribe(
    { category: EventCategory.ProviderDetection },
    (event) => {
      deps.eventBus.emit({
        id: `native-det-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date(),
        source: {
          type: 'device' as const,
          id: event.source.id,
          nodeId: 'hub',
        },
        category: EventCategory.DetectionCameraNative,
        data: {
          cameraId: Number(event.source.id),
          detections: event.data,
          source: 'camera-native' as const,
        },
      })
    },
  ) as Unsubscribe

  // 3. Pipeline inference results → run hub-side post-processing (analysis
  //    pipeline → notifications → emit detection.result event).
  const unsubInferenceResult = deps.eventBus.subscribe(
    { category: EventCategory.PipelineInferenceResult },
    (event) => {
      if (!isEvent(event, EventCategory.PipelineInferenceResult)) return
      void deps.handleInferenceResult(event.data).catch((err: unknown) => {
        const msg = errMsg(err)
        deps.logger.error('PipelineInferenceResult post-processing failed', {
          tags: { deviceId: event.data.deviceId },
          meta: { error: msg },
        })
      })
    },
  ) as Unsubscribe

  // 4. Profile slot mutations (publish / assign / unassign / retract) →
  //    start or restart detection for the device. The stream-broker
  //    emits `camera-streams.onProfileSlotsChanged` on every mutation;
  //    the orchestrator reacts by reading the current slot set via the
  //    camera-streams cap and rebuilding the detection config.
  // Debounce ProfileSlotsChanged per-device. Provider-rtsp publishes
  // streams one at a time (stream-1, stream-2, stream-3) and each
  // mutation in the broker emits its own event — without coalescing,
  // `handleDeviceRegistered` runs N times per camera, each call
  // tearing down + restarting detection. The 200ms window is short
  // enough to feel instantaneous yet long enough to absorb a multi-
  // stream republish burst.
  const unsubDeviceRegistered = deps.eventBus.subscribe(
    { category: EventCategory.CameraStreamsProfileSlotsChanged },
    (event) => {
      const data = event.data as { deviceId?: unknown }
      if (typeof data?.deviceId !== 'number') return
      const deviceId = data.deviceId
      const existing = profileSlotTimers.get(deviceId)
      if (existing) clearTimeout(existing)
      profileSlotTimers.set(
        deviceId,
        setTimeout(() => {
          profileSlotTimers.delete(deviceId)
          // Guard against post-shutdown firing — the test harness
          // tears down the addon while debounced timers are still
          // pending, and `this.ctx` throws when accessed after
          // onShutdown nulls the internal _ctx field.
          if (isTornDown) return
          deps.logger.info('received onProfileSlotsChanged', {
            tags: { deviceId },
          })
          void deps.handleDeviceRegistered(deviceId).catch((err: unknown) => {
            if (isTornDown) return
            const msg = errMsg(err)
            deps.logger.error('handleDeviceRegistered failed', {
              tags: { deviceId },
              meta: { error: msg },
            })
          })
        }, PROFILE_SLOTS_DEBOUNCE_MS),
      )
      // Also schedule a fleet-level reconcile so sibling cameras whose
      // slot-changed broadcast was dropped are caught by the RPC diff.
      deps.scheduleReconcile()
    },
  ) as Unsubscribe

  const unsubDeviceUnregistered = deps.eventBus.subscribe(
    { category: EventCategory.DeviceUnregistered },
    (event) => {
      const { deviceId } = event.data
      void deps.handleDeviceUnregistered(deviceId).catch((err: unknown) => {
        const msg = errMsg(err)
        deps.logger.error('handleDeviceUnregistered failed', {
          tags: { deviceId },
          meta: { error: msg },
        })
      })
    },
  ) as Unsubscribe

  // 5. Per-device orchestration settings updates → restart detection.
  const unsubSettingsChanged = deps.eventBus.subscribe(
    { category: EventCategory.OrchestrationSettingsUpdated },
    (event) => {
      if (isTornDown) return
      const { deviceId } = event.data
      deps.cameraSensors.requestCamera(deviceId, 'settings-updated')
      void deps.handleSettingsChanged(deviceId).catch((err: unknown) => {
        // Same post-shutdown guard as the binding-changed handler —
        // pending promise rejections after onShutdown would otherwise
        // throw on `this.ctx.logger` access.
        if (isTornDown) return
        const msg = errMsg(err)
        deps.logger.error('handleSettingsChanged failed', {
          tags: { deviceId },
          meta: { error: msg },
        })
      })
    },
  ) as Unsubscribe

  // 6. Per-camera pipeline config updates → hot-reload the runner on the
  //    currently-assigned node so the next frame executes against the new
  //    engine/steps. When the camera has no live assignment yet (edit
  //    arriving before first DeviceStreamsRegistered), the event is a
  //    no-op — dispatchCamera will pick up the fresh pipelines[deviceId]
  //    entry from the store when it runs.
  const unsubCameraUpdated = deps.eventBus.subscribe(
    { category: EventCategory.PipelineCameraUpdated },
    (event) => {
      if (!isEvent(event, EventCategory.PipelineCameraUpdated)) return
      void deps
        .handlePipelineCameraUpdated(event.data.deviceId, event.data.config)
        .catch((err: unknown) => {
          const msg = errMsg(err)
          deps.logger.error('handlePipelineCameraUpdated failed', {
            tags: { deviceId: event.data.deviceId },
            meta: { error: msg },
          })
        })
    },
  ) as Unsubscribe

  // 7. Per-device binding toggles for caps we runtime-gate on
  //    (detection-pipeline / audio-analysis). The operator flips a
  //    wrapper via device-manager.setWrapperActive; device-manager
  //    emits DeviceBindingsChanged; we re-dispatch the camera so the
  //    runner attach payload (steps + audio) + the audio subscription
  //    reflect the new binding state immediately, instead of only
  //    after the next settings-changed / restart event.
  const unsubBindingsChanged = deps.eventBus.subscribe(
    { category: EventCategory.DeviceBindingsChanged },
    (event) => {
      // Guard against in-flight events delivered after onShutdown
      // has unsubscribed + torn down ctx. The fake harness emits
      // DeviceBindingsChanged during afterEach which can race the
      // shutdown; skipping here keeps the test run silent.
      if (isTornDown) return
      const { deviceId, capName, reason } = event.data
      // Only react to operator toggles of the caps we gate on.
      // Native-registered/-unregistered events fire on every device
      // provider boot and would cause spurious dispatch storms.
      const isWrapperToggle = reason === 'wrapper-activated' || reason === 'wrapper-deactivated'
      const isGateCap =
        capName === 'detection-pipeline' ||
        capName === 'audio-analysis' ||
        capName === 'motion-detection'
      if (!isWrapperToggle || !isGateCap) return
      void deps.handleSettingsChanged(deviceId).catch((err: unknown) => {
        // After shutdown `this.ctx` throws — swallow so the harness
        // doesn't surface post-teardown noise as an unhandled rejection.
        if (isTornDown) return
        const msg = errMsg(err)
        deps.logger.error('binding-changed re-dispatch failed', {
          tags: { deviceId },
          meta: { capName, reason, error: msg },
        })
      })
    },
  ) as Unsubscribe

  // 8. Camera metrics → load management enforcement.
  const unsubCameraMetrics = deps.eventBus.subscribe(
    { category: EventCategory.PipelineCameraMetricsSnapshot },
    (event) => {
      if (!isEvent(event, EventCategory.PipelineCameraMetricsSnapshot)) return
      const { deviceId, nodeId, metrics } = event.data
      if (typeof deviceId !== 'number') return
      deps.noteMetrics(deviceId, nodeId, metrics)
    },
  ) as Unsubscribe

  // 9. Motion phase → lazy audio gate. When `audioMode === 'on-motion'`
  //    and motion fires for a device, open the audio subscription on
  //    demand. It is closed by the QUIET WINDOW (`audioMotionWindowMs`,
  //    rearmed by each motion event) — NOT by a falling edge, which
  //    camera-native providers never send. A falling edge, when an
  //    analyzer does produce one, closes earlier via `motionCooldownMs`.
  //    See `handleLazyAudioMotion`. (D170)
  const unsubLazyAudioMotion = deps.eventBus.subscribe(
    { category: EventCategory.MotionOnMotionChanged },
    (event) => {
      if (!isEvent(event, EventCategory.MotionOnMotionChanged)) return
      const { deviceId, detected } = event.data
      if (typeof deviceId !== 'number') return
      const config = deps.getActiveDetectionConfig(deviceId)
      if (!config || config.audioMode !== 'on-motion') return
      void deps.handleLazyAudioMotion(deviceId, detected, config).catch((err) => {
        deps.logger.warn('lazy audio motion handler failed', {
          tags: { deviceId },
          meta: { detected, error: errMsg(err) },
        })
      })
    },
  ) as Unsubscribe

  // 9b. Motion phase → session dispatch/teardown (Phase 3 slice 2). LIVE as
  //     of Task 2 — `startDetection` no longer standing-attaches on-motion
  //     cameras, so `decideSessionAction` now actually dispatches/tears down
  //     sessions here (it still returns 'ignore' for always-on cameras,
  //     which keep the standing attach).
  const unsubSessionMotion = deps.eventBus.subscribe(
    { category: EventCategory.MotionOnMotionChanged },
    (event) => {
      if (!isEvent(event, EventCategory.MotionOnMotionChanged)) return
      const { deviceId, detected, timestamp } = event.data
      if (typeof deviceId !== 'number') return
      // `timestamp` is stamped by the motion SOURCE, so passing it through
      // lets the dispatcher separate "the edge reached us late" from "we were
      // slow once we had it" — the ambiguity that left the 2026-07-30 16.8 s
      // dispatch on device 101 unexplained.
      // The TRIGGER travels with the event: the rate a session opens at
      // depends on what opened it (`detectionFpsForTrigger`, D392).
      // Parsed, never cast. The dispatcher gates on the camera's own
      // `motionSources`, so it needs a source it can reason about.
      const parsedSource = MotionSourceEnum.safeParse(event.data.source)
      if (!parsedSource.success) {
        // A NEWER node's source reaching this orchestrator: no consumer here
        // can reason about it, and forwarding it as "no trigger" dispatched it
        // at the camera rate. Said, then dropped.
        deps.logger.warn('session motion dropped — unknown source', {
          tags: { deviceId },
          meta: { source: event.data.source, detected },
        })
        return
      }
      // What raised it (D672). Absent is the camera itself; a present value
      // that does not parse is SAID and read as the camera, never dropped.
      const provenance = readMotionTriggeredBy(event.data.triggeredBy)
      if (provenance.malformed) {
        deps.logger.warn('session motion: triggeredBy malformed — attributed to the camera', {
          tags: { deviceId },
          meta: { trigger: parsedSource.data, triggeredBy: event.data.triggeredBy },
        })
      }
      // An UNSPLIT provider (D673 C13): `onboard` with no `triggeredBy` — the
      // bridge always names one. Its consumers already have it; the bridge
      // notes the camera's level and reports that Confirm/Replace are not
      // enforced on this camera. It goes to the session as before (fail open).
      if (parsedSource.data === 'onboard' && event.data.triggeredBy === undefined) {
        deps.cameraSensors.noteDirectCameraMotion(deviceId, detected)
        // The in-addition hold, for this path only (D672): an unsplit camera's clear does not reach the
        // session while an attached sensor still sees motion — the bridge's sensor false closes it.
        // Remove only when no unsplit emitter remains in the tree (`MOTION_EMITTERS_DEFERRED` in
        // scripts/onboard-motion-emitters-guard.ts is empty) AND the minimum provider versions carry Task 14
        // (a provider-only rollback recreates unsplit providers).
        if (!detected && deps.cameraSensors.sensorHolds(deviceId)) {
          const decision = dropSampler.record(`unsplit-clear-held:${deviceId}`)
          if (decision.logExample || decision.summaryCount !== null) {
            deps.logger.info(
              'session motion: camera clear held back — an attached sensor still sees motion',
              {
                tags: { deviceId },
                meta: {
                  trigger: parsedSource.data,
                  ...(decision.summaryCount === null ? {} : { suppressed: decision.summaryCount }),
                },
              },
            )
          }
          return
        }
      }
      void deps
        .handleSessionMotion(
          deviceId,
          detected,
          typeof timestamp === 'number' ? timestamp : undefined,
          parsedSource.data,
          provenance.triggeredBy,
        )
        .catch((err) => {
          deps.logger.warn('session motion handler failed', {
            tags: { deviceId },
            meta: { detected, error: errMsg(err) },
          })
        })
    },
  ) as Unsubscribe

  // 9d. Motion → the camera's `motion` runtime slice (D696). The orchestrator
  //     is the slice's ONLY writer, with the EFFECTIVE motion, alongside the
  //     event every other consumer reads: the bridge's events (a split camera,
  //     `triggeredBy` present), an unsplit emitter's direct `onboard` event,
  //     the analyzer and device activity. The camera's `motionSources` decides
  //     which count (`camera-sensors/motion-slice.ts`). Memory only here; the
  //     write is queued, and it waits for the writer gate (no runner older than
  //     D696 still writing). A source this orchestrator cannot reason about is
  //     said and dropped, like 9b does.
  const unsubMotionSlice = deps.eventBus.subscribe(
    { category: EventCategory.MotionOnMotionChanged },
    (event) => {
      if (!isEvent(event, EventCategory.MotionOnMotionChanged)) return
      const { deviceId, detected, timestamp } = event.data
      if (typeof deviceId !== 'number' || typeof detected !== 'boolean') return
      const source = MotionSourceEnum.safeParse(event.data.source)
      if (!source.success) {
        const decision = dropSampler.record(`motion-slice-source:${deviceId}`)
        if (decision.logExample || decision.summaryCount !== null) {
          deps.logger.warn('camera motion slice: event dropped — unknown source', {
            tags: { deviceId },
            meta: {
              source: event.data.source,
              ...(decision.summaryCount === null ? {} : { suppressed: decision.summaryCount }),
            },
          })
        }
        return
      }
      deps.cameraMotionSlice.onMotion({
        deviceId,
        detected,
        timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
        source: source.data,
        viaBridge: event.data.triggeredBy !== undefined,
      })
    },
  ) as Unsubscribe

  // 9c. Tracked frames → session-hold PRESENCE tap. The analytics addon emits
  //     `PipelineAnalyticsFrameTracked` per tracked frame with `hasLiveTrack`
  //     set when ≥1 object is still tracked — moving OR stopped. Each such
  //     frame resets the on-motion session's close clock (bounded by the
  //     per-camera `maxSessionHoldMs`), so a subject that stops re-triggering
  //     the camera's VMD keeps its detection session while it is still there.
  //
  //     The gate used to be `hasMovingTrack !== true`, and that was the second
  //     half of the unreachable-promotion defect: a MOVING-only predicate can
  //     never hold a session open for a subject that has STOPPED, which is
  //     exactly the subject the stationary registry needs to watch for 30 s
  //     before it can promote it. What ends the hold now is the promotion
  //     itself — a promoted object is dropped by the tracker and suppressed
  //     from the next frame on, so it stops being present.
  //     `noteSubjectPresent` is a no-op when no session is active, so
  //     idle/always-on cameras cost nothing here.
  const unsubFrameTracked = deps.eventBus.subscribe(
    { category: EventCategory.PipelineAnalyticsFrameTracked },
    (event) => {
      if (!isEvent(event, EventCategory.PipelineAnalyticsFrameTracked)) return
      const deviceId = event.data.deviceId
      if (typeof deviceId !== 'number') return
      // Every tracked frame, before the presence gate: a STILL subject is
      // exactly the one `hasLiveTrack` leaves out, and the one the close line
      // needs to name (D652).
      const liveTrackCount = event.data.liveTrackCount
      if (typeof liveTrackCount === 'number') deps.noteSessionTrackedFrame(deviceId, liveTrackCount)
      if (event.data.hasLiveTrack !== true) return
      deps.noteSessionSubjectPresent(deviceId)
    },
  ) as Unsubscribe

  // 10. Motion analyzer frames → watchdog liveness tap. The runner emits
  //     `MotionAnalysis` per analyzed frame; deviceId rides on the event
  //     `source` (the payload itself carries no deviceId). One tap per
  //     analyzer frame keeps the watchdog's `motion` stage fresh.
  const unsubMotionAnalysis = deps.eventBus.subscribe(
    { category: EventCategory.MotionAnalysis },
    (event) => {
      if (!isEvent(event, EventCategory.MotionAnalysis)) return
      const deviceId = event.source.deviceId
      if (typeof deviceId === 'number') {
        deps.noteWatchdogSignal(deviceId, 'motion')
      }
    },
  ) as Unsubscribe

  // 11. Audio windows → watchdog liveness tap (D461).
  //
  //     Until the relay was removed this tap sat on the CHUNK, inside the
  //     orchestrator's own poll loop. The orchestrator no longer sees a chunk:
  //     `audio-analyzer` pulls its own audio and emits one
  //     `PipelineAudioInferenceResult` per ~1 s window, so this event IS the
  //     camera saying its audio is flowing — and it is the only thing that can
  //     say so from here.
  //
  //     Three things make that a safe substitution rather than a weakening.
  //     The stage threshold is 90 s against roughly one event per second, so
  //     the margin is ninety, not one. The event is emitted for EVERY window
  //     the analyzer flushes, level-only windows included — a classify that
  //     throws still returns a level, so a camera that is merely silent keeps
  //     signalling. And what the tap now proves is strictly MORE than before:
  //     a chunk arriving proved only that the broker was delivering, while a
  //     window arriving proves the whole path, the analyzer included.
  //
  //     What it costs: events are droppable telemetry (D8), and for a camera
  //     dispatched to an agent this one crosses the mesh. Ninety consecutive
  //     losses would fake a stall — and a stall costs a bounded re-attach
  //     (three fast attempts, then a slow retry), not a teardown.
  const unsubAudioWatchdog = deps.eventBus.subscribe(
    { category: EventCategory.PipelineAudioInferenceResult },
    (event) => {
      if (!isEvent(event, EventCategory.PipelineAudioInferenceResult)) return
      deps.noteWatchdogSignal(event.data.deviceId, 'audio')
    },
  ) as Unsubscribe

  // 12. DEVICE ACTIVITY → motion. The camera's own `recording-signal` LEVEL —
  //     the one the recorder already records against (D380) — republished as
  //     `MotionOnMotionChanged` with `source: 'device-activity'`, so a device
  //     that says it is working drives the detection pipeline through exactly
  //     the path firmware motion takes. Nothing robot-specific reaches the
  //     runner: the source owns the level mirror + the sustain tick, and this
  //     handler only decodes the slice (D392).
  const activitySource = new DeviceActivitySource({
    logger: deps.logger,
    emitMotion: (deviceId, detected, timestamp) => {
      if (isTornDown) return
      deps.eventBus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: deviceId, deviceId },
          { deviceId, detected, timestamp, source: DEVICE_ACTIVITY_SOURCE },
        ),
      )
    },
    motionSourcesFor: (deviceId) => deps.getActiveDetectionConfig(deviceId)?.motionSources ?? null,
    // A tick must land BEFORE the dispatcher's teardown clock (half of
    // `motionCooldownMs`) AND before the post-analysis episode closes on its
    // quiet timer (half of `MOTION_CLOSE_AFTER_MS`) — `sustainIntervalMs`
    // takes the smaller of the two (D392, D672).
    sustainMsFor: (deviceId) =>
      sustainIntervalMs(deps.getActiveDetectionConfig(deviceId)?.motionCooldownMs),
  })
  const unsubDeviceActivity = deps.eventBus.subscribe(
    { category: EventCategory.DeviceStateChanged },
    (event) => {
      const data = event.data
      if (typeof data !== 'object' || data === null) return
      // The cheap gate first: every other cap's churn on this category exits
      // on the name compare before the slice is parsed (the recorder's own
      // signal subscription is shaped the same way).
      if (data['capName'] !== recordingSignalCapability.name) return
      const deviceId = data['deviceId']
      if (typeof deviceId !== 'number') return
      const level = RecordingSignalStatusSchema.safeParse(data['slice'])
      if (!level.success) {
        // A slice that does not parse is not a level. Dropping it in silence
        // would read as "the device never said anything".
        deps.logger.warn('device-activity: signal slice does not parse — ignored', {
          tags: { deviceId },
          meta: { slice: data['slice'] },
        })
        return
      }
      const atMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Date.now()
      activitySource.onSignalLevel(deviceId, level.data.active, level.data.reason, atMs)
    },
  ) as Unsubscribe

  // 13. CAMERA SENSORS (D672). A sensor the operator attached to a camera is
  //     part of that camera's `onboard` motion. The hot path is synchronous and
  //     in-memory; every refresh below is lifecycle-driven and coalesced.
  // (No `as Unsubscribe`: `subscribe` already returns `() => void`.)
  const unsubCameraSensorState: Unsubscribe = deps.eventBus.subscribe(
    { category: EventCategory.DeviceStateChanged },
    (event) => {
      const data = event.data
      if (typeof data !== 'object' || data === null) return
      const deviceId = data['deviceId']
      const capName = data['capName']
      if (typeof deviceId !== 'number' || typeof capName !== 'string') return
      if (!isSourceCap(capName) || !deps.cameraSensors.watches(deviceId)) return
      const slice = data['slice']
      if (!isSlice(slice)) return
      deps.cameraSensors.onSensorState({
        sensorId: deviceId,
        capName,
        slice,
        observedAtMs: event.timestamp instanceof Date ? event.timestamp.getTime() : Date.now(),
      })
    },
  )
  const unsubCameraSensorLifecycle: readonly Unsubscribe[] = [
    deps.eventBus.subscribe({ category: EventCategory.DeviceRegistered }, (event) => {
      if (isEvent(event, EventCategory.DeviceRegistered)) {
        deps.cameraSensors.requestAddon(event.data.providerId)
      }
    }),
    deps.eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
      if (!isEvent(event, EventCategory.DeviceUnregistered)) return
      deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-unregistered')
      deps.cameraSensors.forgetCamera(event.data.deviceId)
    }),
    deps.eventBus.subscribe({ category: EventCategory.DeviceOnline }, (event) => {
      if (isEvent(event, EventCategory.DeviceOnline)) {
        deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-online-changed')
      }
    }),
    deps.eventBus.subscribe({ category: EventCategory.DeviceOffline }, (event) => {
      if (isEvent(event, EventCategory.DeviceOffline)) {
        deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-online-changed')
      }
    }),
    // A soft-disable does not un-route (R10) but must not read `ready` (D62).
    deps.eventBus.subscribe({ category: EventCategory.DeviceDisabled }, (event) => {
      if (isEvent(event, EventCategory.DeviceDisabled)) {
        deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-enabled-changed')
      }
    }),
    deps.eventBus.subscribe({ category: EventCategory.DeviceEnabled }, (event) => {
      if (isEvent(event, EventCategory.DeviceEnabled)) {
        deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-enabled-changed')
      }
    }),
    deps.eventBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (event) => {
      if (isEvent(event, EventCategory.DeviceBindingsChanged) && isSourceCap(event.data.capName)) {
        deps.cameraSensors.requestSensor(event.data.deviceId, 'sensor-bindings-changed')
      }
    }),
  ]

  return () => {
    isTornDown = true
    activitySource.stop()
    deps.cameraSensors.stop()
    deps.cameraMotionSlice.stop()
    for (const t of profileSlotTimers.values()) clearTimeout(t)
    profileSlotTimers.clear()
    // Same order as the former explicit ten-field unsub sequence in `onShutdown`.
    unsubDeviceRegistered()
    unsubDeviceUnregistered()
    unsubSettingsChanged()
    unsubInferenceResult()
    unsubProviderDetection()
    unsubProviderMotion()
    unsubMotionSlice()
    unsubCameraUpdated()
    unsubBindingsChanged()
    unsubCameraMetrics()
    unsubLazyAudioMotion()
    unsubSessionMotion()
    unsubFrameTracked()
    unsubMotionAnalysis()
    unsubAudioWatchdog()
    unsubDeviceActivity()
    unsubCameraSensorState()
    for (const unsub of unsubCameraSensorLifecycle) unsub()
  }
}
