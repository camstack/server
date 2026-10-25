/**
 * `CameraStatusService` — the per-camera status aggregator (C12, smell #14).
 *
 * READ-ONLY over orchestrator state: it never mutates `assignments` /
 * `audioAssignments` / `cameraConfigs` / `pendingReasons`, only reads them
 * through the injected {@link CameraStatusServiceDeps} closures. It fans out
 * in parallel (bounded, per-stage graceful degradation) to broker / decoder /
 * motion / detection / audio / recording source caps via `ctx.api`, then
 * hands the collected per-stage results to the pure `composeCameraStatus`
 * composer (`camera-status/compose-camera-status.ts`).
 *
 * Extracted verbatim from `index.ts` (S5 refactor slice) — the 340-line
 * `getCameraStatus` body split into per-stage private builders
 * (`buildAssignmentContext` / `buildSourceStage` / `buildBrokerStage` /
 * `buildDecoderStage` / `buildMotionStage` / `buildDetectionStage` /
 * `buildAudioStage` / `buildRecordingStage`) that are composed by
 * `getCameraStatus` in the exact same order.
 *
 * Decoder truth: decode is NOT independently assignable — it is always
 * co-located with its frame consumer (the retained frame store is node-local; an
 * off-owner detection node decodes locally in its own session-decode worker).
 * So `pinned.decoder` is always false and `assignment.decoderNodeId` is BY
 * CONSTRUCTION the detection node; the broker decodes nothing (D762). The
 * former advisory decoder resolver + per-device decoder pin were removed with
 * the decoder scheduling surface.
 *
 * `this.ctx.*` / `this.<cachedMap>` accesses become `this.deps.*`. `api` is
 * captured EXACTLY ONCE per `getCameraStatus` call — `this.deps.api()`
 * (backed by the throwing `this.ctx.api` getter) is invoked a single time
 * and that one reference is threaded through every stage builder. A
 * shutdown landing inside an await window still sees the stale-but-valid
 * captured reference (graceful per-stage degradation via
 * `.catch(() => null)`) instead of a second live getter access throwing
 * synchronously and rejecting the whole call.
 */
import type {
  AddonApi,
  CameraSensorsStatus,
  CameraStatus,
  CameraStatusDegradation,
  CameraStatusDegradationReason,
  CameraStatusStage,
  CameraSwitchDerivationInput,
  CameraSwitchId,
  IScopedLogger,
  PipelineAssignment,
  ProfileSlot,
  RecordingStorageMode,
  RunnerCameraConfig,
} from '@camstack/types'
import { composeSwitchedOff, nodePin, RecordingStorageModeSchema } from '@camstack/types'
import {
  type AssignmentPinFlags,
  type AssignmentReasons,
  type BrokerProfileEntry,
  type BrokerResult,
  type AudioResult as CameraAudioResult,
  type ComposeInput,
  composeCameraStatus,
  type DecoderResult,
  type DetectionResult,
  type MotionResult,
  type RecordingResult,
  type SourceResult,
} from './camera-status/compose-camera-status.js'
import { FleetReadPass } from './camera-status/fleet-read-pass.js'
import type { AudioNodeAssignment } from './orchestrator-types.js'
import type { RepeatWarnSampler } from './repeat-warn-sampler.js'

/** WebRTC consumer kinds counted toward `BrokerResult.webrtcSessions`. */
const WEBRTC_KINDS: ReadonlySet<string> = new Set([
  'webrtc-browser',
  'webrtc-mobile',
  'webrtc-whep',
])

/** Shape the `recording.getStatus` cap response is narrowed to via {@link isRecordingStatus}. */
interface RecordingStatusShape {
  readonly activeMode: RecordingStorageMode
  readonly enabled: boolean
  readonly storageBytes: number
}

/**
 * `recording.getStatus` returns `unknown` in the generated router
 * (DEVICE_STATUS_METHOD) — narrow it via a named type-guard instead of an
 * unsafe cast.
 */
function isRecordingStatus(v: unknown): v is RecordingStatusShape {
  return (
    v !== null &&
    typeof v === 'object' &&
    'activeMode' in v &&
    // The MODE list is the schema's, never a copy: a guard that hard-codes it
    // rejects the whole status block the day a mode is added, and a rejected
    // block renders as "no recording cap" — not-yet-known as not-installed.
    RecordingStorageModeSchema.safeParse(v.activeMode).success &&
    'enabled' in v &&
    typeof (v as { enabled: unknown }).enabled === 'boolean' &&
    'storageBytes' in v &&
    typeof (v as { storageBytes: unknown }).storageBytes === 'number'
  )
}

/** Reported engine `{ backend, device }` for a camera's detection stage. */
interface ReportedEngine {
  readonly backend: string
  readonly device: string
}

/**
 * Parse a Phase 2 multi-device `deviceKey` (`<backend>:<device>`, e.g.
 * `edgetpu:usb`, `openvino:npu`, or a bare `cpu`) into the `{ backend, device }`
 * shape the detection status reports. The orchestrator can't import the
 * detection-pipeline's `resolveDeviceEngine` (cross-addon), and doesn't need to
 * — for STATUS reporting the honest surface is exactly WHICH device pool the
 * camera's sessions were routed to, which is the deviceKey verbatim.
 */
function parseDeviceKeyEngine(deviceKey: string): ReportedEngine {
  const colon = deviceKey.indexOf(':')
  return colon >= 0
    ? { backend: deviceKey.slice(0, colon), device: deviceKey.slice(colon + 1) }
    : { backend: deviceKey, device: '' }
}

/**
 * Per-call collector for the stages that could not be read.
 *
 * Mutable and threaded through the stage builders — the alternative is every
 * builder returning a second value and `getCameraStatus` re-assembling them,
 * which buys nothing. Nothing
 * outside one `getCameraStatus` call ever sees it: this is NOT a state store,
 * it is derived at the only place that knows a stage was cut short.
 */
interface DegradationSink {
  readonly entries: CameraStatusDegradation[]
}

/** Orchestrator-local (no remote call) placement context assembled before the bounded fan-out. */
interface AssignmentContext {
  readonly pipelineAssignment: PipelineAssignment | null
  readonly detectionNodeId: string | null
  readonly sourceNodeId: string
  readonly pinned: AssignmentPinFlags
  readonly detectionReason: string | undefined
  readonly audioNodeId: string | null
  readonly audioPinned: boolean
}

/**
 * Injected dependencies for {@link CameraStatusService}. All read-only
 * closures over the orchestrator's placement maps — the service never holds
 * or mutates `assignments` / `audioAssignments` / `cameraConfigs` /
 * `pendingReasons` itself.
 */
export interface CameraStatusServiceDeps {
  /** Live api accessor — mirrors the throwing `this.ctx.api` getter. */
  readonly api: () => AddonApi
  /**
   * Where a stage that was CUT SHORT is announced. Required, not optional: a
   * bound that drops work silently reads as "it never happened", and that is
   * how two cameras spent a full 3s inside this service on every status call
   * without producing one log line.
   */
  readonly logger: IScopedLogger
  /**
   * Bounds the record of a REPEATING degradation, per `(camera, stage, reason)`.
   *
   * `getCameraStatuses` composes this for every camera and the admin page polls
   * it every 5 seconds, so a fleet-wide fault does not write one line — it
   * writes `cameras × stages` lines twelve times a minute. It did: 337 WARN
   * lines in one minute on 2026-08-21, of which 120 came from this call site.
   *
   * The `degraded` ENTRY is never sampled — only the line is. A client reads the
   * entry to tell "we could not look" from "there is nothing there", and
   * dropping it to save log volume would make the payload lie.
   */
  readonly warnSampler: RepeatWarnSampler
  /** `this.assignments.get(deviceId)` (read-only). */
  readonly getAssignment: (deviceId: number) => PipelineAssignment | null
  /** `this.audioAssignments.get(deviceId)` (read-only). */
  readonly getAudioAssignment: (deviceId: number) => AudioNodeAssignment | null
  /** `this.cameraConfigs.get(deviceId)` (read-only). */
  readonly getCameraConfig: (deviceId: number) => RunnerCameraConfig | null
  /** `this.cameraConfigs.has(deviceId)` — whether the camera is known even if unassigned. */
  readonly hasCameraConfig: (deviceId: number) => boolean
  /**
   * Why a known-but-unassigned camera is stranded (T3): the ledger's pending
   * reason for a STANDING camera, or the session path's last REFUSAL for an
   * on-motion one (`SessionDispatchController.refusalReason`, D650 round 4).
   */
  readonly getPendingReason: (deviceId: number) => string | undefined
  /**
   * Whether this camera is ARMED on motion — dispatched per session rather
   * than standing.
   *
   * Needed because an armed camera between motion events holds NO
   * `cameraConfigs` entry: `SessionDispatchController.dispatchDetectionSession`
   * records an assignment without `ledger.setConfig` BY DESIGN (an entry there
   * wedges `decideSessionAction` into permanent `'ignore'`, and
   * `standing-machinery-on-motion-scope.spec.ts` guards it). So `hasCameraConfig`
   * is false for a perfectly healthy camera, and without this predicate the
   * status was byte-identical to a camera the orchestrator had never heard of.
   */
  readonly isSessionCamera: (deviceId: number) => boolean
  /** `this.assignSource(deviceId)` — the camera's source-owner node. */
  readonly assignSource: (deviceId: number) => string
  /** `[...this.assignments.keys()]` — default deviceIds for `getCameraStatuses`. */
  readonly listAssignedDeviceIds: () => readonly number[]
  /**
   * ONE bounded read of the AUTHORITIES that own each per-camera function
   * (`switch-authorities.ts`) — the source of the `switchedOff` block that
   * separates DISABLED from BROKEN on every status surface.
   *
   * The RAW authority facts, not a `CameraSwitchGroup`. The aggregate switch
   * group is a deprecated compatibility surface being withdrawn (D113), and the
   * badge must outlive it: composing from a group would make the field that
   * tells disabled from broken depend on a cap scheduled for deletion. The
   * pure `composeSwitchedOff` turns these facts into the badge here.
   *
   * The facts, not a pre-derived id list, because the ids alone cannot say
   * whether the read was COMPLETE. Each source is bounded INDIVIDUALLY, so one
   * `null` field means "we could not read that authority" — an id list derived
   * from that is a floor, not a total, and rendering it as "the operator turned
   * nothing off" is the 2026-08-08 inversion.
   */
  readonly switchAuthoritiesFor: (
    deviceId: number,
    pass: FleetReadPass,
  ) => Promise<CameraSwitchDerivationInput>
  /**
   * The camera's attached sensors (D672), from the camera-sensors controller's
   * MEMORY — no I/O on the status path, so a five-second poll costs nothing here.
   */
  readonly cameraSensorsFor: (deviceId: number) => CameraSensorsStatus
}

/** Per-stage timeout applied by `boundedStage` to every remote-fetch stage. */
const STAGE_TIMEOUT_MS = 3_000

/** The one line this service writes about a cut-short stage; named so the sampler key is stable. */
const STAGE_UNREAD_MESSAGE = 'camera status stage could not be read'

/**
 * Every switch whose OFF position leaves audio analysis with nothing to
 * analyse — the camera not capturing, this server not distributing, or the
 * analyzer not running. Named once because `CameraStatus.audio.enabled` must
 * agree with all three, and a list rebuilt at the call site is a list that
 * will miss the next one.
 */
const AUDIO_SILENCING_SWITCH_IDS: readonly CameraSwitchId[] = [
  'device-audio',
  'broker-audio',
  'audio-analysis',
]

/**
 * Sentinel resolved by the per-stage timer. A unique symbol rather than `null`
 * so the race result can be narrowed WITHOUT a cast — and, more to the point,
 * so a stage that legitimately resolves `null` is never mistaken for one that
 * ran out of time.
 */
const STAGE_TIMED_OUT: unique symbol = Symbol('camera-status-stage-timeout')

export class CameraStatusService {
  constructor(private readonly deps: CameraStatusServiceDeps) {}

  /**
   * Record — and ANNOUNCE — a stage whose value could not be trusted.
   *
   * Both halves matter. The entry is what a client reads to tell a `null` that
   * means "we could not look" from a `null` that means "there is nothing
   * there"; the `warn` is what makes the next hang findable at all. The line
   * carries `tags.deviceId` with the numeric id because the question is always
   * per-camera ("why is 105 worse than 101?") and a line without the tag
   * cannot be grouped to answer it.
   */
  private recordDegraded(
    sink: DegradationSink,
    deviceId: number,
    stage: CameraStatusStage,
    reason: CameraStatusDegradationReason,
    elapsedMs: number,
    extraMeta: Record<string, unknown> = {},
  ): void {
    // The payload entry ALWAYS goes in. It is what tells a client that this
    // `null` means "we could not look", and sampling it would make the payload
    // claim a stage was fine because the log had already said so once.
    sink.entries.push({ stage, reason, elapsedMs })
    const meta: Record<string, unknown> = { stage, reason, elapsedMs, ...extraMeta }
    // The LINE is sampled per `(camera, stage, reason)`. First occurrence in
    // full; after that a counter, so the rate survives without the flood.
    const decision = this.deps.warnSampler.record(`${deviceId}:${stage}:${reason}`)
    if (decision.logExample) {
      this.deps.logger.warn(STAGE_UNREAD_MESSAGE, { tags: { deviceId }, meta })
      return
    }
    if (decision.summaryCount === null) return
    this.deps.logger.warn(STAGE_UNREAD_MESSAGE, {
      tags: { deviceId },
      meta: { ...meta, suppressedSinceLastLine: decision.summaryCount },
    })
  }

  /**
   * Races a promise against a timeout. Returns `null` on timeout OR rejection —
   * but the two are no longer the same event: whichever happened is pushed to
   * `sink` (and logged) under `stage`, so the `null` that reaches the payload
   * arrives with its cause attached.
   *
   * Never throws — individual stage failures become `null` in the aggregate.
   *
   * @param p         The stage fetch promise.
   * @param ms        Timeout in milliseconds.
   * @param stage     Which stage this is, as it appears in `CameraStatus.degraded`.
   * @param deviceId  The camera — every line about it carries the tag.
   * @param sink      Per-call collector for stages that could not be read.
   */
  private boundedStage<T>(
    p: Promise<T>,
    ms: number,
    stage: CameraStatusStage,
    deviceId: number,
    sink: DegradationSink,
  ): Promise<T | null> {
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof STAGE_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(STAGE_TIMED_OUT), ms)
    })
    return Promise.race<T | typeof STAGE_TIMED_OUT>([p, timeout])
      .then((value): T | null => {
        if (value === STAGE_TIMED_OUT) {
          this.recordDegraded(sink, deviceId, stage, 'timeout', Date.now() - startedAt, {
            timeoutMs: ms,
          })
          return null
        }
        return value
      })
      .catch((err: unknown): null => {
        this.recordDegraded(sink, deviceId, stage, 'error', Date.now() - startedAt, {
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
  }

  /**
   * Orchestrator-local placement context: pipeline assignment, source node,
   * audio assignment. Pure reads over the injected closures — no remote
   * call, so it is assembled synchronously at the top of `getCameraStatus`
   * before any stage promise is created.
   */
  private buildAssignmentContext(deviceId: number): AssignmentContext {
    const pipelineAssignment = this.deps.getAssignment(deviceId)
    const detectionNodeId = pipelineAssignment?.agentNodeId ?? null
    // The node that OWNS this camera's physical source pull — the cluster ingest
    // owner today (per-camera once source assignment lands). All stream-broker
    // reads below are PINNED to it so the broker/source blocks reflect the node
    // ACTUALLY dialing the camera (the hub singleton is dormant when ingest is
    // off-hub — that was the "shows idle off-hub" gap). At ingest=hub this pins
    // to 'hub' → byte-identical to before.
    const sourceNodeId = this.deps.assignSource(deviceId)

    const audioAssignment = this.deps.getAudioAssignment(deviceId)
    const audioNodeId = audioAssignment?.nodeId ?? null
    const audioPinned = audioAssignment?.pinned ?? false

    // Decoder placement is NOT independently assignable — decode is always
    // co-located with its frame consumer (the retained frame store is node-local; an
    // off-owner detection node decodes locally via its satellite plane), so
    // `pinned.decoder` is always false and the reported decoder node is BY
    // CONSTRUCTION the detection node, upgraded to the broker's live
    // decode-session node when one is observed (T6 in `getCameraStatus`).
    const pinned: AssignmentPinFlags = {
      detection: pipelineAssignment?.pinned ?? false,
      decoder: false,
      audio: audioPinned,
    }
    // Detection reason. Three DIFFERENT unassigned situations used to arrive
    // as the same empty `reasons: {}`, which made an armed camera and a camera
    // nobody has ever dispatched pixel-identical on every surface:
    //
    //   `<reason>`         — placed; the live assignment reason.
    //   `pending:<reason>` — a STANDING camera we know and could not place
    //                        (T3, e.g. `pending:over-cap`) — or an ON-MOTION
    //                        camera whose last session was REFUSED (D650:
    //                        `pending:root-unrunnable:<node>/<device>`). An
    //                        armed camera that detects nothing must not look
    //                        like one waiting for motion.
    //   `armed:on-motion`  — an ON-MOTION camera between motion events. Healthy
    //                        and waiting: it holds no cached config by design
    //                        (see `isSessionCamera` on the deps).
    //   undefined          — genuinely unknown to the orchestrator.
    //
    // All of this is SYNCHRONOUS orchestrator-local state — no remote call, no
    // bound, so none of it can ever appear in `CameraStatus.degraded`. An armed
    // camera was READ; it is simply idle. `reasons.detection` is a free string
    // on the cap schema, so no codegen change is needed.
    const pendingReason = this.deps.getPendingReason(deviceId)
    const detectionReason: string | undefined =
      pipelineAssignment !== null
        ? pipelineAssignment.reason
        : this.deps.hasCameraConfig(deviceId)
          ? `pending:${pendingReason ?? 'pending'}`
          : this.deps.isSessionCamera(deviceId)
            ? pendingReason !== undefined
              ? `pending:${pendingReason}`
              : 'armed:on-motion'
            : undefined

    return {
      pipelineAssignment,
      detectionNodeId,
      sourceNodeId,
      pinned,
      detectionReason,
      audioNodeId,
      audioPinned,
    }
  }

  /**
   * Source stage (stream-catalog via broker profile slots). Derives source
   * streams from the broker's profile slots for this device (filtered by
   * deviceId). `allSlotsFetch` is shared with the broker stage — fetched
   * ONCE by the caller — so this stage never issues its own round-trip.
   */
  private buildSourceStage(
    api: AddonApi | null,
    allSlotsFetch: Promise<readonly ProfileSlot[]> | null,
    deviceId: number,
    sink: DegradationSink,
  ): Promise<SourceResult | null> {
    if (!api || !allSlotsFetch) return Promise.resolve(null)
    return this.boundedStage(
      allSlotsFetch.then((slots): SourceResult => {
        const deviceSlots = slots.filter((s) => s.deviceId === deviceId)
        return {
          streams: deviceSlots.map((s) => ({
            camStreamId: s.sourceCamStreamId ?? s.brokerId,
            codec: s.codec ?? '',
            width: s.resolution?.width ?? 0,
            height: s.resolution?.height ?? 0,
            fps: 0, // ProfileSlot has no fps field — honest default
            kind: s.profile,
          })),
        }
      }),
      STAGE_TIMEOUT_MS,
      'source',
      deviceId,
      sink,
    )
  }

  /**
   * Broker stage (per-profile slot stats + client counts). Reuses
   * `allSlotsFetch` (fetched once by the caller) to avoid a second
   * round-trip. Per-slot `getBrokerStats` + `listClients` are fetched in
   * parallel. WebRTC sessions are counted by filtering `encoded[]` entries
   * whose `attribution.kind` is one of the `WEBRTC_KINDS`.
   */
  private buildBrokerStage(
    api: AddonApi | null,
    allSlotsFetch: Promise<readonly ProfileSlot[]> | null,
    deviceId: number,
    sourceNodeId: string,
    pass: FleetReadPass,
    sink: DegradationSink,
  ): Promise<BrokerResult | null> {
    if (!api || !allSlotsFetch) return Promise.resolve(null)
    return this.boundedStage(
      allSlotsFetch.then(async (slots): Promise<BrokerResult> => {
        const deviceSlots = slots.filter((s) => s.deviceId === deviceId)
        if (deviceSlots.length === 0) {
          return { profiles: [], webrtcSessions: 0, rtspRestream: false }
        }
        const [statsAndClients, rtspEntry] = await Promise.all([
          Promise.all(
            deviceSlots.map(async (slot) => {
              // CONCURRENT, not sequential. These are two independent reads of
              // one broker and neither needs the other's answer; awaiting them
              // in turn doubled the depth of the only leg in this stage that
              // scales with the camera's profile count.
              const [stats, clients] = await Promise.all([
                api.streamBroker.getBrokerStats
                  .query({ brokerId: slot.brokerId }, nodePin(sourceNodeId))
                  .catch(() => null),
                api.streamBroker.listClients
                  .query({ brokerId: slot.brokerId }, nodePin(sourceNodeId))
                  .catch(() => null),
              ])
              return { slot, stats, clients } as const
            }),
          ),
          // The node's WHOLE restream table — one answer for every camera it
          // serves, so the pass issues it once per source node.
          pass.rtspEntries(api, sourceNodeId).catch(() => null),
        ])
        const profileDetails: BrokerProfileEntry[] = statsAndClients.map(
          ({ slot, stats, clients }): BrokerProfileEntry => ({
            profile: slot.profile,
            status: slot.status,
            codec: stats?.codec ?? slot.codec ?? '',
            width: slot.resolution?.width ?? 0,
            height: slot.resolution?.height ?? 0,
            subscribers: clients?.encodedSubscribers ?? 0,
            // A failed stats read is unknown, not a 0-fps stall (D393). No
            // output rate: the broker decodes nothing (D758).
            inFps: stats?.inputFps ?? null,
          }),
        )
        // Count WebRTC sessions by aggregating across all profile slots:
        // encoded[] entries whose attribution.kind is a WebRTC consumer kind.
        const webrtcSessions = statsAndClients.reduce((total, { clients }) => {
          if (!clients) return total
          return total + clients.encoded.filter((c) => WEBRTC_KINDS.has(c.attribution.kind)).length
        }, 0)
        const hasRtsp =
          rtspEntry?.some((e) => {
            const parts = e.brokerId.split('/')
            return parts[0] === String(deviceId) && e.enabled
          }) ?? false
        return {
          profiles: profileDetails,
          webrtcSessions,
          rtspRestream: hasRtsp,
        }
      }),
      STAGE_TIMEOUT_MS,
      'broker',
      deviceId,
      sink,
    )
  }

  /**
   * Decoder stage: the node decode runs on BY CONSTRUCTION — the detection
   * node (decode is always co-located with its frame consumer). Unassigned
   * camera → null. (The ASSIGNMENT block upgrades to the broker's live session
   * node when observed — see the T6 post-processing in `getCameraStatus`.)
   *
   * No counter rides along. This block used to serve shared-memory ring stats,
   * session count and formats hard-coded to 0 / [] after the SHM frame plane
   * was retired (frames live in the in-RAM RetainedFrameStore), and the admin
   * UI raised "decode path stalled" on every active camera from those zeros.
   * Frames reaching the detector are read from `detection.actualFps`.
   */
  private buildDecoderStage(detectionNodeId: string | null): Promise<DecoderResult | null> {
    return Promise.resolve(detectionNodeId ? { nodeId: detectionNodeId } : null)
  }

  /**
   * Motion stage (from cached runner config). Motion configuration lives in
   * the orchestrator's cached `RunnerCameraConfig`. No remote call needed —
   * this is always up-to-date if the camera is attached.
   */
  private buildMotionStage(deviceId: number): MotionResult | null {
    const config = this.deps.getCameraConfig(deviceId)
    if (!config) return null
    return {
      enabled:
        config.motionSources.includes('analyzer') || config.motionSources.includes('onboard'),
      fps: config.motionFps,
    }
  }

  /** Detection stage (pipeline-executor + runner metrics). */
  private buildDetectionStage(
    api: AddonApi | null,
    detectionNodeId: string | null,
    deviceId: number,
    pass: FleetReadPass,
    sink: DegradationSink,
  ): Promise<DetectionResult | null> {
    if (!api || !detectionNodeId) return Promise.resolve(null)
    // The engine pair describes the NODE (`getSelectedEngine` does not even
    // take a device), so the pass reads it once per detection node instead of
    // once per camera. The runner metrics are the camera's own and stay per
    // camera — and they are issued CONCURRENTLY with the pair now: they never
    // needed its answer, and awaiting them after it made every camera's
    // detection stage two round trips deep for no reason.
    return this.boundedStage(
      Promise.all([
        pass.engineProvisioning(api, detectionNodeId).catch(() => null),
        pass.selectedEngine(api, detectionNodeId).catch(() => null),
        api.pipelineRunner.getCameraMetrics
          .query({ deviceId, nodeId: detectionNodeId })
          .catch(() => null),
      ]).then(async ([provisioning, engine, metrics]): Promise<DetectionResult> => {
        // Map pipeline-executor provisioning state → CameraDetectionProvisioningState
        // The states match exactly: idle/installing/verifying/ready/failed.
        const phase = (() => {
          const p = metrics?.phase
          if (p === 'active') return 'active' as const
          if (p === 'idle') return 'idle' as const
          return 'watching' as const
        })()
        // Engine reported must reflect the pool THIS camera's sessions actually
        // run on, not the node's default/current engine. When the camera has an
        // elected `deviceKey` (Phase 2 multi-device, e.g. `edgetpu:usb`), its
        // frames are routed to that device pool via `runPipeline({deviceKey})`
        // + `resolveDeviceFactory` — NOT the node's `getSelectedEngine` pool.
        // Reading `getSelectedEngine` here reported the node default (e.g.
        // `openvino:npu`) for a Coral-pinned camera, masking WHICH device the
        // session used (and, when that pool fails to init, masking that it is
        // producing nothing). Prefer the camera's own deviceKey.
        const deviceKey = this.deps.getCameraConfig(deviceId)?.deviceKey
        const reportedEngine = deviceKey
          ? parseDeviceKeyEngine(deviceKey)
          : { backend: engine?.backend ?? '', device: engine?.device ?? '' }
        return {
          nodeId: detectionNodeId,
          engine: reportedEngine,
          phase,
          configuredFps: metrics?.configuredFps ?? 0,
          actualFps: metrics?.actualFps ?? 0,
          queueDepth: metrics?.queueDepth ?? 0,
          avgInferenceMs: metrics?.avgInferenceTimeMs ?? 0,
          provisioning: {
            state: provisioning?.state ?? 'idle',
            ...(provisioning?.error !== undefined ? { error: provisioning.error } : {}),
          },
        }
      }),
      STAGE_TIMEOUT_MS,
      'detection',
      deviceId,
      sink,
    )
  }

  /**
   * Audio stage. `nodeId` is orchestrator-local (the cached assignment);
   * `enabled` is the REAL `audio-analysis` switch.
   *
   * It used to be a hardcoded `true` whenever an audio node was assigned — so
   * a camera whose operator had turned audio off reported `audio.enabled:
   * true` and produced nothing, which is indistinguishable from broken. That
   * is precisely the failure the switch group exists to remove, and leaving
   * the lie in place would have made the group's own status block disagree
   * with it.
   *
   * THREE switches can silence this stage, not one (D83). `audio-analysis`
   * stops the analyzer; `device-audio` stops the camera capturing; and
   * `broker-audio` stops this server distributing. Any of them leaves the
   * analyzer with nothing, and reporting `enabled: true` for the other two
   * would reintroduce the exact hardcoded lie the previous paragraph is about
   * — one row further down the group.
   *
   * `enabled` is a boolean and cannot say "unknown", so when the switch read
   * was cut short or partial this block is OPTIMISTIC by construction. That is
   * survivable only because `CameraStatus.degraded` names `'switches'` in
   * exactly those cases — a surface drawing "audio is running" from this field
   * must consult it first.
   */
  private buildAudioStage(
    audioNodeId: string | null,
    switchedOff: readonly CameraSwitchId[],
  ): CameraAudioResult | null {
    if (audioNodeId === null) return null
    const silenced = AUDIO_SILENCING_SWITCH_IDS.some((id) => switchedOff.includes(id))
    return { nodeId: audioNodeId, enabled: !silenced }
  }

  /**
   * Recording stage (recording cap getStatus). `recording.getStatus` is
   * auto-injected by codegen from the cap's `status` schema. It accepts
   * `{ deviceId }` and returns `RecordingStatus`, typed `unknown` in the
   * generated router (DEVICE_STATUS_METHOD) — narrowed via
   * {@link isRecordingStatus} instead of an unsafe cast.
   *
   * There is deliberately NO `.catch(() => null)` on the query any more: it
   * swallowed the rejection before `boundedStage` could see it, so a recording
   * source that was refusing every call produced the same anonymous `null` as
   * a camera that simply records nothing.
   */
  private buildRecordingStage(
    api: AddonApi | null,
    deviceId: number,
    sink: DegradationSink,
  ): Promise<RecordingResult | null> {
    if (!api) return Promise.resolve(null)
    return this.boundedStage(
      api.recordingArchive.getStatus
        .query({ deviceId })
        .then((rawStatus): RecordingResult | null => {
          if (!isRecordingStatus(rawStatus)) return null
          return {
            mode: rawStatus.activeMode,
            active: rawStatus.enabled && rawStatus.activeMode !== 'off',
            storageBytes: rawStatus.storageBytes,
          }
        }),
      STAGE_TIMEOUT_MS,
      'recording',
      deviceId,
      sink,
    )
  }

  /**
   * The functions an operator turned off, read STRAIGHT FROM THE AUTHORITIES
   * (D113) and bounded like every other stage.
   *
   * No switch group in the middle. `pipelineOrchestrator.getCameraSwitches` is a
   * deprecated compatibility surface with a deletion date; this badge has none,
   * because "a disabled function must be visible as DISABLED, not merely quiet"
   * is a rule about status. So the stage reads the wrapper bindings,
   * `RecordingConfig.enabled`, the notification mute, the broker's audio policy
   * and the camera's own microphone, and `composeSwitchedOff` turns those facts
   * into the badge.
   *
   * Three outcomes, and they must not collapse into one:
   *
   *  - READ — every authority answered. The list is a TOTAL, and an empty one
   *    really does mean the operator turned nothing off.
   *  - PARTIAL — at least one authority did not answer (`composeSwitchedOff`
   *    names it in `unreadable`). Each source is bounded individually, so a slow
   *    one costs only its own fact; the list is then a FLOOR. Marked
   *    `'partial'`.
   *  - NOT READ — the whole read timed out or rejected. Marked by `boundedStage`
   *    itself.
   *
   * In the last two the returned list is `[]`, and `[]` was once handed to the
   * payload as the positive claim "the operator has switched nothing off".
   * Measured on the live hub 2026-08-08: `getCameraStatus(105)` said
   * `switchedOff: []` at the very moment `stream-broker` AND `recording` were
   * switched off by the operator — the camera read as BROKEN because it was
   * switched OFF. The list stays empty (a guess would put a permanent "off"
   * badge on a working camera); what matters is that the emptiness travels with
   * the reason it is empty.
   */
  private buildSwitchStage(
    deviceId: number,
    pass: FleetReadPass,
    sink: DegradationSink,
  ): Promise<readonly CameraSwitchId[]> {
    const startedAt = Date.now()
    return this.boundedStage(
      this.deps.switchAuthoritiesFor(deviceId, pass),
      STAGE_TIMEOUT_MS,
      'switches',
      deviceId,
      sink,
    ).then((reads): readonly CameraSwitchId[] => {
      if (reads === null) return []
      const { switchedOff, unreadable } = composeSwitchedOff(reads)
      if (unreadable.length > 0) {
        this.recordDegraded(sink, deviceId, 'switches', 'partial', Date.now() - startedAt, {
          unreadableAuthorities: unreadable,
        })
      }
      return switchedOff
    })
  }

  /**
   * Server-composed aggregated status for a single camera.
   *
   * Fans out in parallel (bounded, per-stage graceful degradation) to
   * broker / decoder / motion / detection / audio / recording source caps
   * via `ctx.api`. A stage whose source errors or times out becomes `null`
   * in the returned payload — one slow agent never breaks the whole call —
   * and is NAMED in `degraded`, so a consumer can tell that `null` from the
   * `null` of a camera that legitimately has no such stage.
   */
  async getCameraStatus(deviceId: number): Promise<CameraStatus> {
    return this.composeOne(deviceId, new FleetReadPass({ deviceIds: [deviceId] }))
  }

  /**
   * One camera's status, composed WITHIN a pass.
   *
   * Everything the camera alone can answer is fetched here; everything the pass
   * already knows (a node's slot table, the fleet's mute list, a device type's
   * bindable caps) is asked of `pass`, which issues it once for the whole call.
   */
  private async composeOne(deviceId: number, pass: FleetReadPass): Promise<CameraStatus> {
    const api = this.deps.api()

    // Per-call collector. Every stage that is cut short lands here and is
    // logged at the same moment — see `recordDegraded`.
    const degradations: DegradationSink = { entries: [] }

    const { detectionNodeId, sourceNodeId, pinned, detectionReason, audioNodeId, audioPinned } =
      this.buildAssignmentContext(deviceId)

    // ── Profile slots (shared between source + broker stages) ─────────
    // The slot table is a question about the NODE, not about the camera: one
    // answer describes every camera the node serves. It used to be fetched once
    // per `getCameraStatus`, so a 29-camera poll asked for the same table 29
    // times. `pass.profileSlots` issues it once per source node and hands the
    // same promise to every camera. Do NOT catch here — boundedStage (which
    // wraps sourceFetch/brokerFetch) already catches both rejections and
    // timeouts, producing null for each stage independently.
    const allSlotsFetch = api ? pass.profileSlots(api, sourceNodeId) : null

    const sourceFetch = this.buildSourceStage(api, allSlotsFetch, deviceId, degradations)
    const brokerFetch = this.buildBrokerStage(
      api,
      allSlotsFetch,
      deviceId,
      sourceNodeId,
      pass,
      degradations,
    )
    const decoderFetch = this.buildDecoderStage(detectionNodeId)
    const motionResult = this.buildMotionStage(deviceId)
    const detectionFetch = this.buildDetectionStage(
      api,
      detectionNodeId,
      deviceId,
      pass,
      degradations,
    )
    const recordingFetch = this.buildRecordingStage(api, deviceId, degradations)
    // The operator's switches — bounded like every other stage, and, when the
    // read is incomplete, marked as such rather than reported as "nothing is
    // off". See `buildSwitchStage`.
    const switchesFetch = this.buildSwitchStage(deviceId, pass, degradations)

    // ── Fan-out (parallel, bounded) ────────────────────────────────────
    const [
      sourceResult,
      brokerResult,
      decoderResult,
      detectionResult,
      recordingResult,
      switchedOff,
    ] = await Promise.all([
      sourceFetch,
      brokerFetch,
      decoderFetch,
      detectionFetch,
      recordingFetch,
      switchesFetch,
    ])
    const audioResult = this.buildAudioStage(audioNodeId, switchedOff)

    // ── Decoder truth ──────────────────────────────────────────────────
    // Decode runs in the detection node's session-decode workers, so
    // `assignment.decoderNodeId` IS the detection node by construction. The
    // broker decodes nothing (D762) and is never asked.
    const decoderNodeId = detectionNodeId
    const decoderReason: string | undefined = decoderNodeId !== null ? 'co-located' : undefined
    const reasons: AssignmentReasons = {
      detection: detectionReason,
      decoder: decoderReason,
      audio: audioPinned ? 'manual' : undefined,
    }

    const composeInput: ComposeInput = {
      deviceId,
      fetchedAt: Date.now(),
      detectionNodeId,
      decoderNodeId,
      audioNodeId,
      sourceNodeId,
      pinned,
      reasons,
      sourceResult,
      brokerResult,
      decoderResult,
      motionResult,
      detectionResult,
      audioResult,
      recordingResult,
      switchedOff,
      cameraSensors: this.deps.cameraSensorsFor(deviceId),
      // Snapshotted AFTER the fan-out settled: every stage has finished
      // pushing by the time `Promise.all` above resolved.
      degraded: [...degradations.entries],
    }

    return composeCameraStatus(composeInput)
  }

  /**
   * Server-composed aggregated status for multiple cameras in one call.
   *
   * `deviceIds` defaults to all cameras currently tracked by the
   * orchestrator's assignment map when omitted.
   *
   * The whole call runs inside ONE {@link FleetReadPass}, and that is what
   * makes a five-second poll affordable. Composing a camera reaches seven
   * stages, but six of the questions those stages ask are about a NODE, a
   * device TYPE or the whole FLEET — the slot table, the restream table, the
   * mute list, the engine pair, the bindable caps — and asking them per camera
   * meant N identical round trips for N identical answers. Two more (the device
   * row, the binding table) are per-camera questions the device manager already
   * answers for a set. The pass asks each exactly once and shares the promise;
   * it holds nothing between calls, so the next poll asks again from scratch.
   *
   * What is left is genuinely per camera and stays per camera: the broker slot
   * stats, the runner metrics, the recorder, the broker mute and the camera's
   * own privacy provider. Collapsing any of those would be a narrower answer,
   * not a cheaper one.
   *
   * `Promise.all` over per-device composition (no concurrency cap). The fan-out
   * is now ~8 round trips per camera rather than ~16, and the six fleet reads
   * no longer multiply — which is the part that made the count grow with the
   * fleet twice over.
   */
  async getCameraStatuses(deviceIds?: readonly number[]): Promise<readonly CameraStatus[]> {
    const ids =
      deviceIds !== undefined && deviceIds.length > 0
        ? deviceIds
        : this.deps.listAssignedDeviceIds()
    const pass = new FleetReadPass({ deviceIds: ids })
    return Promise.all(ids.map((deviceId) => this.composeOne(deviceId, pass)))
  }
}
