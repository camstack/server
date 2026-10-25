/**
 * `DetectionWiringController` — the detection-wiring coordination layer
 * (C14, S11 Task 3 extraction). This is THE coordinator: it owns
 * `activeDetections` (the per-device active-detection-config cache) and the
 * full device-lifecycle handler surface that used to live inline in
 * `index.ts` (moved from the kernel `DetectionWiringService` originally).
 *
 * Owns:
 *  - `activeDetections` — set on `startDetection`, cleared on `stopDetection`
 *    (via `SessionDispatchController.stopForDevice`'s `dropActiveDetection`
 *    closure, which now resolves here — see the C1 note on
 *    {@link DetectionWiringControllerDeps.session} below).
 *  - The device-lifecycle cap/event surface: `handleDeviceRegistered`,
 *    `handleDeviceUnregistered`, `handleSettingsChanged`,
 *    `handlePipelineCameraUpdated`, `handleInferenceResult`,
 *    `startDetection`, `stopDetection`.
 *  - The detection-config derivation pipeline: `buildDetectionConfig`,
 *    `fetchAssignedProfiles`, the I/O half of `resolveDeviceDetectionSettings`
 *    (hands off to the pure `resolveDetectionSettings` in
 *    `device-detection-settings.ts`, S3), plus the two detection-only I/O
 *    helpers `lookupDeviceFeatures` and `isDetectionPipelineActive`/
 *    `isMotionDetectionActive`.
 *  - `buildWatchdogCamera` (pure) and `recoverPipelineStage` (the watchdog
 *    recovery callback).
 *
 * Extracted verbatim (mechanical, zero logic change) from `index.ts` — every
 * method body, log message, and control-flow branch is unchanged; only the
 * storage backing (`this.activeDetections` → `this.activeDetections` on this
 * class, `this.X` addon calls → `this.deps.X` injected closures/instances)
 * differs.
 *
 * **Shared-helper split:** `isCapActiveForDevice` and `deviceHasOnboardMotionCap`
 * are read by BOTH this controller (via `isDetectionPipelineActive`/
 * `isMotionDetectionActive`/`resolveDeviceDetectionSettings`) AND
 * `DeviceConfigContributions` (device-settings-contribution surface) — they
 * stay on `index.ts` as shared helpers; this controller reaches them via
 * `deps.isCapActiveForDevice`/`deps.deviceHasOnboardMotionCap`.
 * `lookupDeviceFeatures` is read ONLY by this controller's
 * `resolveDeviceDetectionSettings`, so it moved here outright.
 *
 * **Construction order (CRITICAL):** this controller depends on every other
 * controller (`ledger`/`placement`/`audio`/`session`/`settingsStore`/
 * `reconcile`/`loadShed`), so it is constructed LAST in
 * `buildOrchestratorControllers` (`orchestrator-bootstrap.ts`, the former
 * `onInitialize` body — S11 Task 4) — after `wireOrchestratorSubscriptions`
 * and the eager `reconcile.scheduleReconcile()` call, immediately before
 * the `return`. Every controller constructed EARLIER that needs to reach
 * `activeDetections` (`AudioSubscriptionController`, `SessionDispatchController`,
 * `ReconcileController`, `wireOrchestratorSubscriptions`) receives a LAZY
 * closure — `(deviceId) => detectionWiring!.getActiveDetectionConfig(deviceId)`
 * — rather than a direct reference. This is boot-safe: none of those
 * closures are ever INVOKED synchronously during the bootstrap (they only
 * fire later, off event-bus subscriptions / timers / RPC handlers), so by
 * the time any of them actually runs, `detectionWiring` is always set.
 * Mirrors the same forward-reference pattern already used for `session`'s
 * `dispatchCamera`/`buildWatchdogCamera`/etc. closures onto `placement`
 * (constructed one statement earlier) and for `loadShed`'s `attach`/`detach`
 * closures onto `placement` (constructed one statement LATER).
 *
 * **C1 safety (CRITICAL — read before touching `SessionDispatchController`):**
 * `SessionDispatchController.stopForDevice` deletes this controller's
 * `activeDetections` entry (via `deps.dropActiveDetection`, now
 * `(deviceId) => detectionWiring!.dropActiveDetection(deviceId)`) INSIDE
 * the SAME session-lock critical section as the session detach/deregister,
 * and `handleSessionMotion`'s `'dispatch'` branch RE-READS `activeDetections`
 * (via `deps.getActiveDetectionConfig`, now
 * `(deviceId) => detectionWiring!.getActiveDetectionConfig(deviceId)`)
 * INSIDE the same lock before dispatching. Both closures resolve to THIS
 * controller's map — the SAME `Map` instance the addon's `activeDetections`
 * field used to be — so the lock+re-read+delete-under-lock ordering that
 * closes the C1 race is byte-for-byte unchanged; only the storage object the
 * closures point at moved (from `this` to `this.detectionWiring`).
 */
import type {
  AddonApi,
  AddonContext,
  CameraDetectionConfig,
  CameraPipelineConfig,
  CamProfile,
  ConfigUISchema,
  IEventBus,
  PipelineInferenceResultPayload,
  ProfileSlot,
  RunnerCameraConfig,
  Zone,
} from '@camstack/types'
import {
  EventCategory,
  errMsg,
  hydrateSchema,
  type IScopedLogger,
  makeSourceBrokerId,
  NativeObjectDetectionStatusSchema,
} from '@camstack/types'
import type { AudioSubscriptionController } from './audio-subscription-controller.js'
import type { DetectionBlindMonitor } from './detection-blind-monitor.js'
import {
  buildDetectionConfigFromInputs,
  buildRunnerConfig,
  detectionConfigEquals,
  type ResolvedDetectionSettings,
  resolveDetectionSettings,
} from './device-detection-settings.js'
import { DeviceFeaturesMirror } from './device-features-mirror.js'
import type { LoadShedController } from './load-shed-controller.js'
import type { NodeStressController } from './node-stress-controller.js'
import {
  DETECTION_SOURCES_WHEN_ABSENT,
  reconcileOnboardForwarding,
  type OnboardForwardingOutcome,
} from './onboard-forwarding-reconcile.js'
import { type DetectionConfigResult, TRANSIENT_SLOT_READ } from './orchestrator-types.js'
import type { PipelineSettingsStore } from './pipeline-settings-store.js'
import type { PipelineWatchdog, WatchdogCamera, WatchdogStage } from './pipeline-watchdog.js'
import type { PlacementLedger } from './placement-ledger.js'
import type { PlacementService } from './placement-service.js'
import type { ReconcileController } from './reconcile-controller.js'
import type { SessionDispatchController } from './session-dispatch-controller.js'
import { buildWatchdogCamera, type WatchdogAudioSource } from './watchdog-camera.js'

export interface DetectionWiringControllerDeps {
  /** Throwing ctx accessor — mirrors the pre-extraction `this.ctx` getter (same object, same throw). */
  readonly ctx: () => AddonContext
  readonly ledger: PlacementLedger
  /** Thin seam onto `PlacementService.dispatchCamera`/`.releaseCamera` — called directly, bypassing the addon's own delegate. */
  readonly placement: PlacementService
  readonly audio: AudioSubscriptionController
  /**
   * Session-time dispatch controller — `ensureMotionWatch`/`stopForDevice`.
   * See the class doc's C1 note: `session`'s OWN deps (`getActiveDetectionConfig`/
   * `dropActiveDetection`, wired in `orchestrator-bootstrap.ts`) are lazy
   * closures back onto THIS controller, closing the loop.
   */
  readonly session: SessionDispatchController
  readonly settingsStore: PipelineSettingsStore
  readonly reconcile: ReconcileController
  readonly loadShed: LoadShedController
  readonly nodeStress: NodeStressController
  readonly watchdog: () => PipelineWatchdog | null
  /**
   * "Is this camera detecting anything?" — fed from EVERY inference result,
   * including the empty ones, which are the only evidence that separates a
   * blind camera from a detached one.
   */
  readonly blindMonitor: () => DetectionBlindMonitor | null
  readonly api: () => AddonApi | null
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /** Live read accessor — `this.localNodeId` on the addon. */
  readonly localNodeId: () => string
  /** Thin seam onto the addon's private `attachOn` (`PlacementService.attachOn` delegate). */
  readonly attachOn: (nodeId: string, config: RunnerCameraConfig) => Promise<void>
  /** `zonesProvider?.listZones({ deviceId }) ?? []` on the addon. */
  readonly listZones: (deviceId: number) => Promise<readonly Zone[]>
  /** `zonesProvider?.forgetDevice(deviceId)` on the addon. */
  readonly forgetDeviceZones: (deviceId: number) => void
  /** `zoneRulesProvider?.forgetDevice(deviceId)` on the addon. */
  readonly forgetDeviceZoneRules: (deviceId: number) => void
  /** Shared binding-gate helper — stays on the addon (also read by `isAudioAnalysisActive`). */
  readonly isCapActiveForDevice: (deviceId: number, capName: string) => Promise<boolean>
  /** Shared onboard-motion-cap probe — stays on the addon (also read by `DeviceConfigContributions`). */
  readonly deviceHasOnboardMotionCap: (deviceId: number) => Promise<boolean>
  /** `this.deviceHasActivitySignalCap(deviceId)` — the `recording-signal` cap probe. */
  readonly deviceHasActivitySignalCap: (deviceId: number) => Promise<boolean>
  /**
   * `this.deviceHasNativeObjectDetectionCap(deviceId)` — shared with
   * `DeviceConfigContributions`. Gates the onboard-forwarding reconcile so a
   * camera with no vendor mechanism is not probed on every attach.
   */
  readonly deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
  /** `this.deviceSettingsSchema()` on the addon — shared with `DeviceConfigContributions`. */
  readonly deviceSettingsSchema: () => ConfigUISchema
  /**
   * Enables the durable backing of {@link DeviceFeaturesMirror}: its rows live in
   * the orchestrator's per-device settings (D865). Absent ⇒ process-local, and
   * the cold-boot hole its docblock describes is back — so it is set in
   * production and omitted only where a test has no store.
   */
  readonly persistFeatures?: boolean
}

export class DetectionWiringController {
  /**
   * Per-device active detection config — set on `startDetection`, cleared on
   * `stopDetection`. `readonly` (not `private`) — mirrors the
   * `ReconcileController.remoteHealthAttempts` pattern: `index.ts` exposes
   * its own `protected get activeDetections()` test-seam compat accessor
   * onto this SAME map so `remote-health.spec.ts`'s subclass keeps
   * reading/writing real state after this extraction. Production code never
   * reaches this field directly — it goes through
   * `getActiveDetectionConfig`/`isDetectionActive`/`dropActiveDetection`/
   * `activeDeviceIds` below.
   */
  readonly activeDetections = new Map<number, CameraDetectionConfig>()

  /**
   * Last-known features per device, so a provider restart cannot briefly turn a
   * battery camera into an always-on one and wake it. See
   * `device-features-mirror.ts`.
   */
  private readonly featuresMirror: DeviceFeaturesMirror

  constructor(private readonly deps: DetectionWiringControllerDeps) {
    // Persisted through the standard per-device settings (D865); the retired
    // collection is only read, to migrate its rows.
    const settings = deps.persistFeatures === true ? deps.ctx().settings : undefined
    this.featuresMirror = new DeviceFeaturesMirror({
      logger: deps.logger,
      ...(settings !== undefined ? { settings } : {}),
    })
  }

  /**
   * Declare + seed the device-features mirror. Call once at boot, BEFORE the
   * first detection start — the restored row is worth nothing after the read
   * that would have needed it.
   */
  async hydrateFeaturesMirror(): Promise<void> {
    if (this.deps.persistFeatures !== true) return
    await this.featuresMirror.hydrate()
  }

  // ── activeDetections accessors (consumed by other controllers via closures) ──

  /** `activeDetections.get(deviceId)`. */
  getActiveDetectionConfig(deviceId: number): CameraDetectionConfig | undefined {
    return this.activeDetections.get(deviceId)
  }

  /** `activeDetections.has(deviceId)`. */
  isDetectionActive(deviceId: number): boolean {
    return this.activeDetections.has(deviceId)
  }

  /** `activeDetections.delete(deviceId)` — see the class doc's C1 note. */
  dropActiveDetection(deviceId: number): void {
    this.activeDetections.delete(deviceId)
  }

  /** `new Set(activeDetections.keys())` — read by `ReconcileController.activeDeviceIds`. */
  activeDeviceIds(): ReadonlySet<number> {
    return new Set(this.activeDetections.keys())
  }

  /** `activeDetections.size` — read by `dumpDiagnostics`. */
  get activeDetectionCount(): number {
    return this.activeDetections.size
  }

  /** `activeDetections.keys()` — read by the addon's `onShutdown` release loop. */
  activeDetectionDeviceIds(): IterableIterator<number> {
    return this.activeDetections.keys()
  }

  /** `activeDetections.clear()` — called by the addon's `onShutdown` after the release loop. */
  clear(): void {
    this.activeDetections.clear()
  }

  // ==========================================================================
  // Detection wiring handlers (moved from kernel DetectionWiringService)
  // ==========================================================================

  /**
   * True when `capName` is bound (`kind:'wrapped'`) for `deviceId` via
   * `device-manager.getBindings`. Detection-pipeline-only wrapper over the
   * shared `deps.isCapActiveForDevice` helper.
   */
  private isDetectionPipelineActive(deviceId: number): Promise<boolean> {
    return this.deps.isCapActiveForDevice(deviceId, 'detection-pipeline')
  }

  private isMotionDetectionActive(deviceId: number): Promise<boolean> {
    return this.deps.isCapActiveForDevice(deviceId, 'motion-detection')
  }

  /**
   * Resolve the device's feature array. Used by the resolver to pick
   * the right `DeviceProfile` when computing per-camera scheduling
   * defaults. Reads via the `device-manager.getDevice` cap because the
   * orchestrator may run on a different node from the live IDevice;
   * the live registry isn't available cross-process.
   *
   * The read is FALLIBLE and its failure is destructive: an empty feature
   * array makes `resolveDeviceProfile` return `null`, so a battery camera
   * silently loses `BATTERY_DEVICE_PROFILE` and `audioMode` falls back to
   * `'always-on'` — which subscribes the audio-analyzer, which is demand on
   * the substream, which dials the camera and WAKES it. Measured on the live
   * hub: 3 of 12 detection passes on device 106 did exactly that, each right
   * after a `provider-reolink` restart.
   *
   * So this reports UNKNOWN (`null`) distinctly from "no features" (`[]`), and
   * {@link DeviceFeaturesMirror} applies the D49 rule on top: a read that
   * fails changes nothing, and an empty read that contradicts the mirror needs
   * a second read to agree.
   */
  private lookupDeviceFeatures(deviceId: number): Promise<readonly string[]> {
    return this.featuresMirror.resolve(deviceId, async () => {
      const api = this.deps.api()
      if (!api) return null
      try {
        const dev = await api.deviceManager.getDevice.query({ deviceId })
        // A device that is not in the registry is UNKNOWN, not featureless —
        // this is the exact state a provider restart passes through.
        if (!dev) return null
        return dev.features ?? []
      } catch {
        return null
      }
    })
  }

  /**
   * I/O-gathering half of the former monolithic method (S3 refactor step —
   * zero behavior change). Reads the device store, hydrates it against the
   * device schema, and resolves the feature/binding lookups the decision
   * ladder needs, then hands everything to the pure `resolveDetectionSettings`
   * (`device-detection-settings.ts`) for the operator-wins → profile-default
   * → static-fallback derivation. Both the read and the derivation keep
   * their own try/catch — a failed store read never reaches the derivation,
   * and a malformed schema (missing leaf, invalid enum) is caught here and
   * logged the same way the original method's two catch blocks did.
   */
  private async resolveDeviceDetectionSettings(
    deviceId: number,
  ): Promise<ResolvedDetectionSettings | null> {
    const ctx = this.deps.ctx()
    if (!ctx?.settings) {
      return null
    }
    let raw: Record<string, unknown>
    try {
      raw = await this.deps.ctx().settings!.readDeviceStore(deviceId)
    } catch (err: unknown) {
      const msg = errMsg(err)
      this.deps.logger.error('resolveDeviceDetectionSettings failed', {
        tags: { deviceId },
        meta: { error: msg },
      })
      return null
    }

    // Hydrate the raw store with the device schema defaults so missing
    // keys (cameras with no overrides yet) come back populated. After
    // hydration, every leaf field has a `value`.
    const hydrated = hydrateSchema(this.deps.deviceSettingsSchema(), raw)
    const flat: Record<string, unknown> = {}
    for (const section of hydrated.sections) {
      for (const field of section.fields) {
        if (field.type === 'separator' || field.type === 'info' || field.type === 'button') continue
        if (field.type === 'group') continue // device schema has no groups today
        flat[field.key] = (field as { readonly value: unknown }).value
      }
    }

    try {
      const features = await this.lookupDeviceFeatures(deviceId)
      const hasOnboardMotion =
        raw['motionSources'] === undefined
          ? await this.deps.deviceHasOnboardMotionCap(deviceId)
          : false
      // Same shape, same reason: asked only when the operator has pinned
      // nothing, because it can only change a DEFAULT.
      const hasActivitySignal =
        raw['motionSources'] === undefined
          ? await this.deps.deviceHasActivitySignalCap(deviceId)
          : false
      const pipelineEnabled = await this.isDetectionPipelineActive(deviceId)
      const motionDetectionEnabled = await this.isMotionDetectionActive(deviceId)

      return resolveDetectionSettings({
        deviceId,
        raw,
        flat,
        features,
        hasOnboardMotion,
        hasActivitySignal,
        pipelineEnabled,
        motionDetectionEnabled,
      })
    } catch (err: unknown) {
      const msg = errMsg(err)
      this.deps.logger.error('resolveDeviceDetectionSettings narrowing failed', {
        tags: { deviceId },
        meta: { error: msg },
      })
      return null
    }
  }

  /**
   * Fetch the current profile-slot map for a device from the system
   * stream-broker cap (`listAllProfileSlots`). Returns a map of
   * `CamProfile → sourceCamStreamId` so callers can both check which
   * profiles are live AND resolve a profile to the cam-stream-keyed
   * brokerId (`${deviceId}/${camStreamId}`) used by the broker.
   *
   * Public because the AUDIO plane needs the same answer, from the same read:
   * `selectAudioCamStream` picks the lowest NATIVE rung, and a second reader
   * of the slot table would be a second authority on which rung is backed by
   * which cam-stream.
   */
  async fetchAssignedProfiles(deviceId: number): Promise<ReadonlyMap<CamProfile, string> | null> {
    const api = this.deps.api()
    if (!api) return null
    try {
      const slots: readonly ProfileSlot[] = await api.streamBroker.listAllProfileSlots.query()
      const out = new Map<CamProfile, string>()
      for (const slot of slots) {
        if (slot.deviceId !== deviceId) continue
        if (slot.sourceCamStreamId === null) continue
        out.set(slot.profile, slot.sourceCamStreamId)
      }
      return out
    } catch (err: unknown) {
      // Transient RPC failure (e.g. `listAllProfileSlots` discovery timeout
      // while the stream-broker is (re)starting). Return `null` — NOT an empty
      // map — so `buildDetectionConfig` can signal TRANSIENT_SLOT_READ and the
      // caller keeps active detection instead of mistaking it for "no slots"
      // and stopping it (the cam-104-only regression after a broker churn).
      this.deps.logger.debug(
        'fetchAssignedProfiles: slot read failed (transient) — treating as unknown',
        {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        },
      )
      return null
    }
  }

  /**
   * Build a `CameraDetectionConfig` from the resolved per-device
   * orchestrator settings + the device's currently-assigned profile
   * slots. Returns `null` when the device has no assigned slot or when
   * settings cannot be resolved.
   */
  async buildDetectionConfig(deviceId: number): Promise<DetectionConfigResult> {
    const assigned = await this.fetchAssignedProfiles(deviceId)
    // `null` = the slot READ failed transiently — signal it distinctly so the
    // caller does NOT stop active detection (unlike a successful empty read).
    if (assigned === null) return TRANSIENT_SLOT_READ
    if (assigned.size === 0) return null

    const resolved = await this.resolveDeviceDetectionSettings(deviceId)
    if (!resolved) return null

    return buildDetectionConfigFromInputs(resolved, assigned)
  }

  /**
   * Make the vendor's onboard-AI forwarding flag agree with this camera's
   * `detectionSources` pick — in both directions. See
   * `onboard-forwarding-reconcile.ts` for why the save-time write is not
   * enough (the flag is device state and a provider restart re-seeds it OFF,
   * measured on all seven Reolink cameras of the live hub).
   *
   * Never throws: a mechanism that could not be reached is reported, it does
   * not fail the camera's attach.
   */
  private async reconcileOnboardForwarding(
    deviceId: number,
    detectionSources: readonly string[],
  ): Promise<OnboardForwardingOutcome> {
    return reconcileOnboardForwarding(
      { deviceId, detectionSources },
      {
        hasNativeObjectDetectionCap: (id) => this.deps.deviceHasNativeObjectDetectionCap(id),
        readForwardingEnabled: async (id) => {
          const api = this.deps.api()
          if (!api)
            throw new Error('orchestrator: no api — cannot read the onboard forwarding flag')
          const raw = await api.nativeObjectDetection.getStatus.query({ deviceId: id })
          // Validated at the boundary rather than asserted: a status that does
          // not carry the flag is an unreadable flag, and an unreadable flag
          // must not look like `false`.
          const parsed = NativeObjectDetectionStatusSchema.safeParse(raw)
          if (!parsed.success) {
            throw new Error(
              `orchestrator: nativeObjectDetection.getStatus returned an unusable status — ${parsed.error.message}`,
            )
          }
          return parsed.data.enabled
        },
        writeForwardingEnabled: async (id, enabled) => {
          const api = this.deps.api()
          if (!api)
            throw new Error('orchestrator: no api — cannot write the onboard forwarding flag')
          await api.nativeObjectDetection.setEnabled.mutate({ deviceId: id, enabled })
        },
        logger: this.deps.logger,
      },
    )
  }

  /**
   * Start detection for a camera: dispatch to runner via the orchestrator
   * local path and subscribe to the audio broker if audio is enabled.
   */
  async startDetection(deviceId: number, config: CameraDetectionConfig): Promise<void> {
    const ctx = this.deps.ctx()
    if (!ctx) throw new Error('PipelineOrchestrator: startDetection called before initialize')
    const log = this.deps.logger.withTags({ deviceId })

    if (this.activeDetections.has(deviceId)) {
      log.warn('Detection already active — stopping first')
      await this.stopDetection(deviceId)
    }
    this.activeDetections.set(deviceId, config)

    // The camera's pick owns the function; the vendor flag only mirrors it.
    // Put the mirror back BEFORE any of the mode branches below — the pick is
    // just as real on a camera that holds no standing attach, and a provider
    // restart is exactly what loses the flag.
    await this.reconcileOnboardForwarding(
      deviceId,
      config.detectionSources ?? DETECTION_SOURCES_WHEN_ABSENT,
    )

    if (!config.pipelineEnabled || config.detectionMode === 'disabled') {
      // Object detection is switched off for this camera — produce NOTHING.
      //
      // `pipelineEnabled` comes from the `object-detection` switch's own
      // authority (the `detection-pipeline` wrapper binding, D62), and until
      // now it was carried all the way into `RunnerCameraConfig` and then
      // read by NOBODY: `grep pipelineEnabled packages/addon-pipeline` is
      // empty. A dead flag that names the right gate is worse than no flag —
      // it reads as enforcement. So a switched-off camera still dialled its
      // RTSP, still spawned ffmpeg and still opened a decode session, and the
      // only thing the switch bought was that nothing consumed the frames.
      // Observed on camera 3218 with the switch off: `ffmpeg source:
      // streaming`, `RTSP client connected`, then `session-decode-coordinator
      // … waitedMs=40001`.
      //
      // Gating HERE rather than in the runner is what makes the saving real:
      // no standing attach and no motion watch means no grey-decode analyzer
      // either, so the camera costs nothing instead of costing a decoder
      // whose output is discarded.
      //
      // `detectionMode: 'disabled'` is the SECOND doorway into the same bug.
      // It is a legal `PipelinePhaseMode` the operator picks from the
      // detection-mode selector, and it used to fall through to the trailing
      // `else` below — so "no detection" bought a standing attach, a dial and
      // a decode session whose frames nobody read. Only `pipelineEnabled` (the
      // switch) was gated; the MODE was not. The two are logged distinctly
      // because they are different operator actions with the same cost: the
      // switch is the `detection-pipeline` binding, the mode is a setting.
      //
      // Audio is deliberately NOT gated here — see the audio block below; it
      // is a separate branch behind its own `audio-analysis` binding, and it
      // is subscribed OUTSIDE this branch, so an audio-on camera with
      // detection disabled keeps classifying.
      if (!config.pipelineEnabled) {
        log.info('object detection switched off — no attach, no decode session', {
          meta: { detectionMode: config.detectionMode },
        })
      } else {
        log.info('detection mode disabled — no standing attach, no decode session', {
          meta: { detectionMode: config.detectionMode, audioMode: config.audioMode },
        })
      }
    } else if (config.detectionMode === 'on-motion') {
      // Session-time model (Phase 3 slice 2, Task 2): NO standing detection
      // attach. Analyzer-class cameras get a watch-only attach on the
      // singleton `motionNode` role so the grey-decode motion analyzer keeps
      // emitting `MotionOnMotionChanged` while idle; onboard-only cameras
      // need nothing (firmware emits motion to the bus itself). The
      // already-wired `handleSessionMotion` subscriber (Task 1) now owns
      // this device's dispatch/teardown lifecycle — idle holds no
      // placement, motion dispatches a session via `dispatchDetectionSession`.
      if (config.motionSources.includes('analyzer')) {
        try {
          await this.deps.session.ensureMotionWatch(deviceId, config)
        } catch (err: unknown) {
          log.error('ensureMotionWatch failed', { meta: { error: errMsg(err) } })
        }
      }
      log.info('detection armed (session-time) — watching for motion', {
        meta: { motion: config.motionSources.join('+') },
      })
    } else {
      // EXISTING standing path (always-on / anything non-on-motion) — unchanged.

      // A PLACEHOLDER pipeline for the ledger, read from the CACHED catalog
      // only — it never waits for a node (D650 round 2). It is resolved before
      // any node or device is elected (node default format, no roster), so it
      // is never what attaches: `dispatchCamera` resolves the attach pipeline
      // AFTER election, for the elected device and its jump roster
      // (`resolveAttachPipeline`, D650), and ignores these steps. A cold cache
      // yields an empty placeholder; the readiness re-attach skips an
      // unplaced config with no elected device, so an empty one can never be
      // attached to the hub behind the balancer's back.
      const placeholderNode =
        this.deps.ledger.getAssignment(deviceId)?.agentNodeId ?? this.deps.localNodeId()
      const placeholder = await this.deps.settingsStore.resolvePipelineForDeviceIfCatalogCached(
        deviceId,
        placeholderNode,
        undefined,
        [],
      )
      const pipelineConfig =
        placeholder.kind === 'resolved' ? placeholder.config : { steps: [], audio: null }

      const zones = await this.deps.listZones(deviceId)
      const runnerConfig: RunnerCameraConfig = buildRunnerConfig(
        { deviceId, config, zones },
        { steps: pipelineConfig.steps, audio: pipelineConfig.audio ?? null },
      )

      // The dispatch resolves the pipeline for the node AND device it elects,
      // so there is no post-dispatch re-resolve: the correction that used to
      // follow re-resolved only when the node changed or the steps were empty,
      // and left a tflite-default node's CPU-elected camera without faces.
      try {
        await this.deps.placement.dispatchCamera(runnerConfig)
      } catch (err: unknown) {
        const msg = errMsg(err)
        log.error('dispatchCamera failed', { meta: { error: msg } })
      }
    }

    // Audio subscription. Deliberately OUTSIDE the detectionMode branch above
    // — audio classification is a separate pipeline branch gated by its OWN
    // `audioMode` (independent of `detectionMode`; e.g. an on-motion-detection
    // camera commonly runs always-on audio). Independent of `pipelineEnabled` (the
    // detection-pipeline binding) — audio classification is a separate
    // pipeline branch and must not be dragged off when only object
    // detection is disabled. The two relevant gates are:
    //   - the `audio-analysis` wrapper binding (cap mounted at all),
    //     enforced inside `subscribeAudioStream` via
    //     `isAudioAnalysisActive`. Operator unbinds the wrapper →
    //     cap fully dismounted → audio off regardless of mode.
    //   - the operator-facing `audioMode` carried on the runner
    //     config, also enforced inside `subscribeAudioStream`.
    try {
      // Drop any prior audio subscription for this device before opening
      // a new one. `dispatchCamera` can fire multiple times in a camera's
      // lifecycle (agent reassignment, pipeline reconfig, audio stream
      // profile change); without this cleanup, each pass appends a new
      // `{tag: 'audio-analyzer'}` subscriber on the broker without
      // releasing the old one. Collapsed resubscribe sequence (smell #7) —
      // see `AudioSubscriptionController.resubscribe`'s doc comment.
      await this.deps.audio.resubscribe(deviceId, config)
    } catch (err: unknown) {
      const msg = errMsg(err)
      log.error('subscribeAudioStream failed', { meta: { error: msg } })
    }

    if (config.detectionMode !== 'on-motion') {
      log.info('Detection dispatched', {
        meta: {
          motion: config.motionSources.join('+'),
          pipeline: config.pipelineEnabled ? 'on' : 'off',
          motionFps: config.motionFps,
          detectionFps: config.detectionFps,
        },
      })
    }
  }

  /** Stop detection for a camera: release via releaseCamera + audio cleanup. */
  async stopDetection(deviceId: number): Promise<void> {
    const ctx = this.deps.ctx()
    if (!ctx) return

    try {
      await this.deps.placement.releaseCamera({ deviceId })
    } catch (err: unknown) {
      const msg = errMsg(err)
      this.deps.logger.error('releaseCamera failed', {
        tags: { deviceId },
        meta: { error: msg },
      })
    }

    // Tear down through the per-device lock so it can't race a concurrent
    // subscribe (which would re-store a handle this teardown never sees).
    await this.deps.audio.stopForDevice(deviceId)

    // Session + motion-watch teardown (Phase 3 slice 2, Task 2; moved to
    // `SessionDispatchController.stopForDevice` in S11 Task 2 — see its doc
    // comment for the full C1 race it closes and why the `activeDetections`
    // delete must run INSIDE the same session lock as the session
    // detach/deregister). `releaseCamera` above already detached whatever is
    // in the placement ledger's assignments (which covers an active
    // session's runner attach), but it knows nothing about the session
    // registry or the motion-watch attach — this call closes both.
    await this.deps.session.stopForDevice(deviceId)

    this.deps.logger.info('Detection stopped', { tags: { deviceId } })
  }

  /** Stop detection and purge all persisted config for a removed device. */
  async handleDeviceUnregistered(deviceId: number): Promise<void> {
    this.deps.reconcile.clearSlotReadRetry(deviceId)
    await this.stopDetection(deviceId)
    this.deps.forgetDeviceZones(deviceId)
    this.deps.forgetDeviceZoneRules(deviceId)
    // S8 leak fix: the former dynamic-property `_loadMgmt_firstSeen_*` hack
    // never freed this key on device removal — see `LoadShedController`'s
    // class doc. Free it here now that it's a real `Map` entry.
    this.deps.loadShed.forgetDevice(deviceId)
    // Same reason: a removed device must not age into a node's stress verdict.
    this.deps.nodeStress.forgetDevice(deviceId)

    const settings = this.deps.ctx().settings
    if (!settings) return

    // Drop this device's entry through the durable handle (whole-blob
    // round-trip) so the purge can never clobber another device's settings.
    await this.deps.settingsStore.deleteCameraSettings(deviceId)

    // …and this addon's OWN per-device store row (detection mode, motion
    // sources, fps, audio mode). It used to survive the deletion, which is why
    // a resurrected device came back FULLY CONFIGURED instead of inert — the
    // strongest signal that it had never really been deleted. Failure is
    // logged, never thrown: the rest of the teardown already happened.
    try {
      await settings.clearDeviceStore(deviceId)
    } catch (err: unknown) {
      this.deps.logger.warn('failed to clear per-device orchestrator settings on removal', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }

    this.deps.logger.info('Purged pipeline config for removed device', {
      tags: { deviceId },
    })
  }

  /**
   * True ONLY when the device registry positively answered "this device does
   * not exist" (`getDevice` → `null`, per the cap contract).
   *
   * A FAILED read answers `false` — D49: a read that fails changes nothing, and
   * the destructive direction here is refusing to run a live camera.
   * Deliberately NOT routed through {@link lookupDeviceFeatures}'s mirror: that
   * one treats missing-as-unknown on purpose (a provider restart passes through
   * exactly that state and must not re-derive a battery camera's profile), and
   * conflating the two would make a provider restart look like a deletion.
   */
  private async isDeviceDeleted(deviceId: number): Promise<boolean> {
    const api = this.deps.api()
    if (!api) return false
    try {
      const device = await api.deviceManager.getDevice.query({ deviceId })
      return device === null
    } catch (err: unknown) {
      this.deps.logger.debug('device existence check failed — proceeding as before', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return false
    }
  }

  /**
   * Handle a profile-slot change: build a fresh detection config from
   * per-device settings and start detection if motion is enabled.
   * Fires on `camera-streams.onProfileSlotsChanged` — any publish,
   * retract, or assignment mutation in the stream-broker lands here.
   */
  async handleDeviceRegistered(deviceId: number): Promise<void> {
    const ctx = this.deps.ctx()
    if (!ctx) return

    const log = this.deps.logger.withTags({ deviceId })
    log.info('handleDeviceRegistered', {
      meta: { phase: 'handleDeviceRegistered' },
    })

    // The funnel: EVERY dispatch of this device passes here (live slot events,
    // the reconcile gap-fill, the slot-read retry), and until now none of them
    // asked whether the device still exists. The broker keeps a deleted
    // device's profile slots forever, so a deleted camera kept arriving here
    // and kept being started.
    if (await this.isDeviceDeleted(deviceId)) {
      log.warn('device no longer exists — refusing to start detection')
      await this.handleDeviceUnregistered(deviceId)
      return
    }

    // Phase 2f: no per-camera pipeline seed on registration — fresh
    // cameras inherit the node's accelerator provisioning on every read. A
    // camera only turns steps on or off (`setCameraStepToggle`, D927).

    const config = await this.buildDetectionConfig(deviceId)
    if (config === TRANSIENT_SLOT_READ) {
      // The profile-slot READ failed transiently (broker discovery blip) — do
      // NOT stop a running camera on a read error. Keep detection as-is and
      // retry shortly; a bounded backoff re-arms cameras that weren't started
      // yet. Root-cause fix for the "only 104 attached after broker churn".
      log.warn('Profile-slot read failed transiently — keeping detection, scheduling retry')
      this.deps.reconcile.scheduleSlotReadRetry(deviceId)
      return
    }
    // Successful read (config or genuinely-null) — clear any pending retry budget.
    this.deps.reconcile.clearSlotReadRetry(deviceId)
    log.info(
      '[pipeline-orchestrator] buildDetectionConfig',
      config
        ? {
            meta: {
              enabled: config.enabled,
              motionStreamId: config.motionStreamId,
              detectionStreamId: config.detectionStreamId,
            },
          }
        : { meta: { config: null } },
    )
    if (!config) {
      // No assigned slot (a SUCCESSFUL empty read). If detection was running, stop it.
      if (this.activeDetections.has(deviceId)) {
        log.info('Profile slot lost — stopping detection')
        await this.stopDetection(deviceId)
      } else {
        log.debug('No assigned profile slot for detection — skipping')
      }
      return
    }
    if (!config.enabled) {
      if (this.activeDetections.has(deviceId)) {
        log.info('Motion detection disabled — stopping')
        await this.stopDetection(deviceId)
      } else {
        log.debug('Motion detection disabled — not starting')
      }
      return
    }

    // Idempotence: when the new config matches the running config bit-
    // for-bit, skip the stop+start cycle. ProfileSlotsChanged fires for
    // any broker mutation (publish, retract, assign, re-publish on
    // provider reconnect); only the subset that actually changes the
    // detection inputs (stream IDs, fps, cooldown, sources) needs a
    // restart. Without this guard each spurious emit surfaces as a
    // `PipelineCameraUnassigned`+`PipelineCameraAssigned` pair in the UI.
    const current = this.activeDetections.get(deviceId)
    if (current && detectionConfigEquals(current, config)) {
      log.debug('Profile slot unchanged — detection already in sync, skipping restart')
      return
    }

    if (current) {
      log.info('Profile slot changed — restarting detection with fresh brokers')
      await this.stopDetection(deviceId)
    }

    log.info('Starting detection', {
      meta: {
        motionStreamId: config.motionStreamId,
        detectionStreamId: config.detectionStreamId,
      },
    })
    await this.startDetection(deviceId, config)
  }

  /**
   * Handle an orchestration settings update: rebuild the config and restart
   * detection with the new values.
   */
  async handleSettingsChanged(deviceId: number): Promise<void> {
    const ctx = this.deps.ctx()
    if (!ctx) return
    const log = this.deps.logger.withTags({ deviceId })

    if (this.activeDetections.has(deviceId)) {
      await this.stopDetection(deviceId)
    }

    const config = await this.buildDetectionConfig(deviceId)
    if (config === TRANSIENT_SLOT_READ) {
      log.warn('Settings changed — slot read failed transiently, scheduling retry')
      this.deps.reconcile.scheduleSlotReadRetry(deviceId)
      return
    }
    this.deps.reconcile.clearSlotReadRetry(deviceId)
    if (!config) {
      log.info('Settings changed — no assigned slot, detection stopped')
      return
    }
    if (!config.enabled) {
      log.info('Settings changed — motion detection disabled')
      return
    }

    log.info('Settings changed — restarting detection')
    await this.startDetection(deviceId, config)
  }

  /**
   * Hot-reload the runner currently hosting `deviceId` with a fresh
   * pipeline config. Called from the `PipelineCameraUpdated` subscriber —
   * any mutation to `pipelines[deviceId]` flows through this path so the
   * operator's edit reaches the next frame without a rebalance or a full
   * detection restart.
   *
   * No-ops (with a debug log) when the camera has no cached
   * RunnerCameraConfig — means the camera either isn't registered yet or
   * isn't assigned to a runner. The next DeviceStreamsRegistered cycle
   * will read the fresh config from the store and dispatch normally.
   */
  async handlePipelineCameraUpdated(deviceId: number, config: CameraPipelineConfig): Promise<void> {
    const log = this.deps.logger.withTags({ deviceId })

    const cached = this.deps.ledger.getConfig(deviceId)
    const assignment = this.deps.ledger.getAssignment(deviceId)
    if (!cached || !assignment) {
      log.debug(
        'pipeline.camera-updated: no cached RunnerCameraConfig or assignment — deferring to next DeviceStreamsRegistered',
      )
      return
    }

    // Keep the scheduling fields (motion/detection FPS, streams, priority)
    // exactly as cached — the pipeline edit only touches steps + audio
    // (data only, no engine). Store the merged config back into
    // cameraConfigs so future rebalance passes carry the updated content too.
    const nextConfig: RunnerCameraConfig = {
      ...cached,
      steps: config.steps,
      audio: config.audio ?? null,
    }
    this.deps.ledger.setConfig(deviceId, nextConfig)

    try {
      await this.deps.attachOn(assignment.agentNodeId, nextConfig)
      log.info('pipeline.camera-updated: hot-reloaded', {
        tags: { nodeId: assignment.agentNodeId },
      })
    } catch (err: unknown) {
      const msg = errMsg(err)
      log.error('pipeline.camera-updated: attachOn failed', {
        tags: { nodeId: assignment.agentNodeId },
        meta: { error: msg },
      })
    }
  }

  /**
   * Re-emit `PipelineInferenceResult` as `DetectionResult` when the
   * frame carries detections. Kept deliberately thin: refinement
   * (tracking, zone/state analysis, per-kind event persistence) is now
   * owned end-to-end by `addon-pipeline-analytics`, which subscribes to
   * `PipelineInferenceResult` directly. Consumers that want
   * enriched-event-driven notifications subscribe to
   * `pipeline-analytics.detection-event` + drive `notificationOutput`
   * themselves.
   */
  async handleInferenceResult(payload: PipelineInferenceResultPayload): Promise<void> {
    const ctx = this.deps.ctx()
    if (!ctx) return
    const { deviceId, frame, frameHandle, capturedAt } = payload
    // Watchdog liveness tap: an inference result arrived (even with zero
    // detections, the detection pipeline IS running) → mark the stage fresh
    // BEFORE the empty-detections early-return below.
    this.deps.watchdog()?.noteSignal(deviceId, 'detection')
    // Blind-camera tap. Also BEFORE the empty-detections early-return, and for
    // the same reason the watchdog tap is: an empty frame is the signal.
    this.deps
      .blindMonitor()
      ?.noteFrame(
        deviceId,
        { detections: frame.detections.length, discarded: frame.discarded?.length ?? 0 },
        Date.now(),
      )
    // Empty frames are not re-emitted — EXCEPT when the frame carries a
    // discard trail (`FrameResult.discarded`, always populated on a drop):
    // a frame where EVERYTHING was discarded is the single most interesting
    // case for the ghost-box overlay, and this early return used to swallow it.
    if (frame.detections.length === 0 && (frame.discarded?.length ?? 0) === 0) return
    this.deps.eventBus.emit({
      id: `detection-${deviceId}-${Date.now()}`,
      category: EventCategory.DetectionResult,
      source: {
        type: 'device' as const,
        id: deviceId,
        nodeId: 'hub',
        addonId: 'pipeline-orchestrator',
        deviceId,
      },
      timestamp: new Date(),
      // Forward the upstream shm-ring `frameHandle` so post-analysis
      // consumers (Task 8) can resolve the original frame zero-copy, and
      // `capturedAt` (shm-commit wall-clock) so a UI/probe consumer can
      // measure true frame-capture → delivery latency.
      data: {
        frame,
        analysisResults: [],
        frameHandle,
        ...(typeof capturedAt === 'number' ? { capturedAt } : {}),
      },
    })
  }

  /**
   * Derive the watchdog camera descriptor from a runner config — thin delegate
   * onto the pure `buildWatchdogCamera` (`watchdog-camera.ts`), where the
   * arming rules live (a switched-off camera arms nothing; the audio stage
   * needs evidence of an audio track).
   *
   * Public — `PlacementService`'s `buildWatchdogCamera` closure (wired in
   * `orchestrator-bootstrap.ts`) calls straight through to this method; the
   * caller resolves the {@link WatchdogAudioSource} once per dispatch.
   */
  buildWatchdogCamera(
    config: RunnerCameraConfig,
    deviceName: string,
    audio: WatchdogAudioSource,
  ): WatchdogCamera {
    return buildWatchdogCamera(config, deviceName, audio)
  }

  /**
   * Watchdog recovery callback. Invoked when a camera's continuous stage
   * has gone stale past its threshold (bounded by `maxRecoveryAttempts`).
   * Audio is orchestrator-owned (tear down + re-create its subscription in
   * case the poller subscription itself died); every stage then requests a
   * source refresh on ITS OWN stream so a dropped rfc4571 source
   * re-materializes and the runner's frame poller resumes.
   *
   * Public — `PipelineWatchdog`'s `recover` closure (wired in
   * `orchestrator-bootstrap.ts`) calls straight through to this method.
   */
  recoverPipelineStage(
    deviceId: number,
    stage: WatchdogStage,
    streamId: string,
    attempt: number,
  ): void {
    if (stage === 'audio') {
      const cfg = this.deps.ledger.getConfig(deviceId)
      // `subscribeAudioStream` wants a `CameraDetectionConfig`; the cached
      // runner config carries every field except `enabled` (it tracks
      // `pipelineEnabled`). Derive `enabled` from it for the audio sub.
      const audioCfg: CameraDetectionConfig | undefined = cfg
        ? { ...cfg, enabled: cfg.pipelineEnabled }
        : undefined
      // Collapsed resubscribe sequence (smell #7) — `cfg?` undefined still
      // tears down any existing (possibly-stale/dead) handle but skips the
      // subscribe, matching the original's unconditional-teardown behavior
      // exactly. See `AudioSubscriptionController.resubscribe`'s doc comment.
      void this.deps.audio.resubscribe(deviceId, audioCfg).catch((err: unknown) => {
        this.deps.logger.warn('watchdog audio re-subscribe failed', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      })
    }
    // Refresh THIS stage's own stream — audio/motion/detection are
    // independently configurable and may sit on different camStreamIds.
    //
    // Logged because this emit is where the recovery attempt ENDS as far as the
    // orchestrator can see: `StreamBrokerOnRequestStreamSourceRefresh` has no
    // observable handler for every camera, so a stage can be "recovered" N
    // times with nothing whatsoever happening downstream. Without this line the
    // only evidence is the watchdog heartbeat, which cannot tell a refresh that
    // was never requested from one nobody acted on.
    this.deps.logger.debug('watchdog recovery: requesting source refresh', {
      tags: { deviceId },
      meta: { stage, camStreamId: streamId, attempt },
    })
    this.deps.eventBus.emit({
      id: `watchdog-refresh-${deviceId}-${Date.now()}`,
      timestamp: new Date(),
      source: {
        type: 'device' as const,
        id: deviceId,
        nodeId: 'hub',
        addonId: 'pipeline-orchestrator',
        deviceId,
      },
      category: EventCategory.StreamBrokerOnRequestStreamSourceRefresh,
      data: { deviceId, camStreamId: streamId, brokerId: makeSourceBrokerId(deviceId, streamId) },
    })
  }
}
