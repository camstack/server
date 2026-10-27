/**
 * Subscription wiring (S7) — the addon's COMPLETE event-bus topology in one
 * place. Owns ONLY which categories are subscribed and how a raw bus event is
 * routed to its handler (payload narrowing, source gates, timestamp
 * normalization); ALL handler logic stays on the addon and is deps-injected.
 *
 * Two tiers, exactly as before the extraction:
 *  - the six PROCESSING subscriptions (inference/audio/motion/onboard-motion/
 *    native-detection/sensor-state) install ONLY on the designated
 *    post-processing node — every other node stays fully inert, which is what
 *    prevents the multi-node split-brain;
 *  - the two LIFECYCLE subscriptions (bindings-changed / device-unregistered)
 *    install on EVERY node so per-device state is dropped everywhere.
 *
 * Returns the unsubscribe list; `onShutdown` iterates it.
 */
import type {
  IEventBus,
  MotionAnalysisPayload,
  MotionOnMotionChangedPayload,
  PipelineAudioInferenceResultPayload,
  PipelineInferenceResultPayload,
  SystemEvent,
  Unsubscribe,
} from '@camstack/types'
import { EVENT_KIND_BY_CAP, EventCategory } from '@camstack/types'
import { parseTopologySnapshotNodes, type NodeLivenessNode } from './node-liveness.js'

/** `DeviceBindingsChanged` payload as consumed by the analytics addon.
 *  Type alias (not interface) so the bus payload cast keeps the implicit
 *  index-signature comparability the pre-S7 inline cast relied on. */
export type BindingsChangedData = {
  readonly deviceId: number
  readonly capName: string
  readonly reason:
    | 'native-registered'
    | 'native-unregistered'
    | 'wrapper-activated'
    | 'wrapper-deactivated'
}

/** `DeviceStateChanged` payload as consumed by the sensor-event ingest.
 *  Type alias for the same cast-comparability reason as above. */
export type SensorStateChangedData = {
  readonly deviceId: number
  readonly capName: string
  readonly slice?: unknown
}

/**
 * Every category the Notification Center's system-event intake can turn into a
 * notification (`notification-center/event-intake.ts` → `incomingFromSystemEvent`).
 *
 * It is a LIST OF SUBSCRIPTIONS, not a filter: each entry gets its OWN
 * `subscribe` call below. One call carrying all of them is what this list
 * exists to prevent — the bus keys handlers by a single category pattern per
 * call (`extractCategoryPattern`), an array collapses to its FIRST element, and
 * a child runner reports exactly its key set to the parent as its forwarding
 * interest. A ten-category array therefore subscribed one category, declared
 * one category, and the parent never forwarded the other nine across the UDS
 * boundary: the Notification Center saw `device.online` and nothing else, with
 * no error and no log to say so.
 */
export const NC_SYSTEM_EVENT_CATEGORIES: readonly EventCategory[] = [
  EventCategory.DeviceOnline,
  EventCategory.DeviceOffline,
  EventCategory.DeviceStateChanged,
  // The operator's per-camera switch. Emitted by `deviceManager.setDisabled`
  // in `@camstack/system`, which travels inside the published server closure —
  // so these two categories may simply never arrive until a server carrying
  // that emission is installed. Subscribing to a category nobody emits costs
  // one map key and nothing else.
  EventCategory.DeviceDisabled,
  EventCategory.DeviceEnabled,
  EventCategory.StreamOnline,
  EventCategory.StreamOffline,
  EventCategory.AgentOnline,
  EventCategory.AgentOffline,
  EventCategory.WorkerOnline,
  EventCategory.WorkerOffline,
  // Both emitted by addon-pipeline-orchestrator: a node whose every enabled
  // accelerator is unavailable (and is therefore no longer placed on), and a
  // camera whose open detection session has produced nothing for the blind
  // threshold.
  EventCategory.PipelineNodeInferenceUnavailable,
  EventCategory.PipelineDetectionBlind,
  // Constant motion with no subject, and its recovery (D907).
  EventCategory.PipelineMotionNoisy,
  EventCategory.PipelineMotionCalm,
  // Package LLM confirm silent / answering again (D931). One edge per camera.
  EventCategory.PipelinePackageLlmSilent,
  EventCategory.PipelinePackageLlmAnswered,
  // Recording health (stall / recover / restart-storm) — emitted by the
  // recorder once it lands; subscribe early so a deploy order cannot miss them.
  EventCategory.RecordingHealthStalled,
  EventCategory.RecordingHealthOk,
  EventCategory.RecordingHealthDegraded,
  // Storage location capacity bands — emitted by storage-orchestrator.
  EventCategory.StorageLocationLow,
  EventCategory.StorageLocationCritical,
  EventCategory.StorageLocationOk,
  // A notification rule that cannot work, and its clear (D905) — emitted by
  // this addon's own notification centre on the evaluating node.
  EventCategory.NotificationRuleBroken,
  EventCategory.NotificationRuleRepaired,
  // The D6 crash circuit-breaker giving up on a runner, emitted hub-side by
  // `process-service.ts` in `@camstack/system` — so, like the two switch
  // categories above, it cannot arrive until a server carrying that emission
  // is installed. Subscribing early costs one map key.
  EventCategory.AddonRunnerFailed,
  // What REVIVES a crash-looped runner or a node that could not infer, for the
  // state summary's ledger (D647 review I5). Never notified.
  EventCategory.AddonStarted,
  EventCategory.AddonRestarted,
  EventCategory.PipelineCameraAssigned,
  EventCategory.UpdateAvailable,
  EventCategory.AddonUpdated,
  EventCategory.SystemRestartCompleted,
  // A node announcing its own restart (D723) — `node-restarting` /
  // `node-updating`. Declared here or it never crosses: since D718 the event
  // planes FILTER every category no subscriber declared, and an agent's
  // announcement reaches this runner only through the hub's UDS fan-out.
  EventCategory.SystemRestarting,
  EventCategory.RecordingExportCompleted,
  EventCategory.BackupRunCompleted,
  // The alert centre's announcement of an alert episode opening or closing —
  // the alert centre sends no notification of its own (`alert-critical`,
  // `alert-error`, `alert-critical-resolved`). The reconcile from the alerts
  // store covers the events this subscription may drop (D8, D11).
  EventCategory.AlertEpisode,
]

/** Handler surface the addon injects — methods stay on the addon class. */
export interface WireSubscriptionsDeps {
  readonly eventBus: IEventBus
  /** True only on the cluster's designated post-processing node. */
  readonly isPostProcessingNode: boolean
  readonly onInferenceResult: (data: PipelineInferenceResultPayload) => Promise<void>
  readonly onAudioResult: (data: PipelineAudioInferenceResultPayload) => Promise<void>
  readonly onMotionAnalysis: (
    deviceId: number,
    data: MotionAnalysisPayload,
    timestampMs: number,
  ) => Promise<void>
  readonly onOnboardMotion: (
    deviceId: number,
    data: MotionOnMotionChangedPayload,
    timestampMs: number,
  ) => Promise<void>
  /**
   * Long-term-statistics tap for BATTERY LEVEL.
   *
   * Deliberately taken BEFORE the `EVENT_KIND_BY_CAP` gate below, which
   * excludes `battery` by design (a percentage moving is not a sensor EVENT).
   * A battery slice is the only always-on producer of the one series whose
   * whole value is measured in weeks — a 7-day event window can never show a
   * discharge curve.
   */
  readonly onBatterySample?: (deviceId: number, percentage: number, at: number) => void
  readonly onSensorStateChanged: (
    data: SensorStateChangedData,
    timestampMs: number,
  ) => Promise<void>
  readonly onBindingsChanged: (data: BindingsChangedData) => void
  readonly onDeviceUnregistered: (deviceId: number) => void
  /**
   * The cluster registry's own liveness view, pushed (never polled).
   *
   * Media capture fetches every pixel by handle from the node that produced
   * the frame; when that node goes away the fetch throws `node-offline` for
   * every target of every frame. This is how the addon learns to stop asking
   * — see `runtime/node-liveness.ts`. Only meaningful on the post-processing
   * node, which is the only node that captures anything.
   */
  readonly onClusterTopology: (nodes: readonly NodeLivenessNode[]) => void
  /** Notification Center infrastructure/liveness/update intake. */
  readonly onSystemEvent: (event: SystemEvent) => void
}

/**
 * Install the addon's bus subscriptions. Identical set + relative order to the
 * pre-S7 inline wiring; the caller stores the returned list and iterates it on
 * shutdown.
 */
export function wireSubscriptions(deps: WireSubscriptionsDeps): Unsubscribe[] {
  const unsubs: Unsubscribe[] = []

  // Processing subscriptions — ONLY on the designated post-processing node.
  // On every other node the addon stays fully inert (no event/media/audio/
  // motion generation), which is what prevents the multi-node split-brain.
  if (deps.isPostProcessingNode) {
    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.PipelineInferenceResult }, (ev) => {
        void deps.onInferenceResult(ev.data as PipelineInferenceResultPayload)
      }),
    )

    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.PipelineAudioInferenceResult }, (ev) => {
        void deps.onAudioResult(ev.data as PipelineAudioInferenceResultPayload)
      }),
    )

    // Motion-analysis subscriber — emitted by the pipeline runner on
    // every analyzer pass with a `device` source whose `deviceId` is
    // the originating camera. Persisted via `EventStore.insertMotion`
    // following the same heartbeat-throttling pattern as audio.
    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.MotionAnalysis }, (ev) => {
        const src = ev.source as { type?: string; deviceId?: number }
        if (src?.type !== 'device' || typeof src.deviceId !== 'number') return
        void deps.onMotionAnalysis(
          src.deviceId,
          ev.data as MotionAnalysisPayload,
          ev.timestamp instanceof Date ? ev.timestamp.getTime() : Date.now(),
        )
      }),
    )

    // Onboard / firmware-driven motion subscriber — providers that
    // produce motion without a frame-diff analyzer (Reolink Baichuan
    // simpleEvent, Hikvision ISAPI alarm stream, ONVIF analytics)
    // emit `MotionOnMotionChanged` with `source !== 'analyzer'` and
    // never fire `MotionAnalysis`. Without this subscription their
    // motion never lands in the SQL store, leaving
    // `getMotionEvents` empty and the history chart blank for any
    // camera configured with `motionSources: ['onboard']`.
    //
    // Analyzer-source events are skipped here — the runner already
    // emits a parallel `MotionAnalysis` event per frame which the
    // handler above persists with full region payload. Routing
    // analyzer through both paths would double-count (and lose
    // region detail since onboard payloads don't carry frame
    // dimensions).
    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.MotionOnMotionChanged }, (ev) => {
        const data = ev.data as MotionOnMotionChangedPayload
        if (data.source === 'analyzer') return
        const timestamp =
          typeof data.timestamp === 'number'
            ? data.timestamp
            : ev.timestamp instanceof Date
              ? ev.timestamp.getTime()
              : Date.now()
        void deps.onOnboardMotion(data.deviceId, data, timestamp)
      }),
    )

    // `DetectionCameraNative` is NOT subscribed here any more. It was a
    // PARALLEL detection source — a second door into the same analysis layers
    // — and the price was everything the pipeline plane carries: the
    // `detailSteps` announce, the subject tiles, the birth evidence and the
    // frame handle, none of which exist in this process. The camera's
    // detections are now admitted by the RUNNER, which holds the decoded
    // frame, and arrive on `PipelineInferenceResult` with `source: 'onboard'`.

    // Sensor-event ingest (Part B): a runtime-state change of a device that
    // is LINKED to ≥1 camera and exposes a mapped sensor cap lands one
    // history row per linked camera. Telemetry-lossy by design (D8) — a
    // dropped event is a missing history row, never wrong durable state.
    // The EVENT_KIND_BY_CAP gate runs FIRST so non-sensor cap churn
    // (battery, motion, …) exits before any async work.
    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.DeviceStateChanged }, (ev) => {
        const data = ev.data as SensorStateChangedData
        const timestamp = ev.timestamp instanceof Date ? ev.timestamp.getTime() : Date.now()
        // BEFORE the gate: `battery` is excluded from it on purpose, and it is
        // the LTS series that most needs a long baseline.
        if (data.capName === 'battery') {
          const percentage = batteryPercentage(data.slice)
          if (percentage !== null) deps.onBatterySample?.(data.deviceId, percentage, timestamp)
        }
        if (EVENT_KIND_BY_CAP[data.capName] === undefined) return
        void deps.onSensorStateChanged(data, timestamp)
      }),
    )

    // Cluster topology — the hub's `HubNodeRegistry` view, pushed on every
    // agent/addon lifecycle change (debounced 200 ms) plus a 30 s heartbeat.
    // Consumed ONLY to stop dispatching captures at a node the registry has
    // already called dead. A type GUARD, not a cast: a version-skewed emitter
    // must leave the mirror untouched rather than gate media on `undefined`.
    unsubs.push(
      deps.eventBus.subscribe({ category: EventCategory.ClusterTopologySnapshot }, (ev) => {
        const nodes = parseTopologySnapshotNodes(ev.data)
        if (nodes === null) return
        deps.onClusterTopology(nodes)
      }),
    )

    // ONE subscribe per category — see {@link NC_SYSTEM_EVENT_CATEGORIES} for
    // why this may never be collapsed back into a single array filter.
    for (const category of NC_SYSTEM_EVENT_CATEGORIES) {
      unsubs.push(deps.eventBus.subscribe({ category }, (ev) => deps.onSystemEvent(ev)))
    }
  } // end if (isPostProcessingNode)

  unsubs.push(
    deps.eventBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (ev) => {
      deps.onBindingsChanged(ev.data as BindingsChangedData)
    }),
  )

  unsubs.push(
    deps.eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (ev) => {
      // A GUARD, not a cast: this event drives the notification centre's
      // deleted-device prune, and a skewed payload must reach nothing.
      const deviceId = unregisteredDeviceId(ev.data)
      if (deviceId !== null) deps.onDeviceUnregistered(deviceId)
    }),
  )

  return unsubs
}

/** The deleted device's id out of a `DeviceUnregistered` payload, or `null`. */
function unregisteredDeviceId(data: Readonly<Record<string, unknown>>): number | null {
  const deviceId = data['deviceId']
  return typeof deviceId === 'number' && Number.isInteger(deviceId) ? deviceId : null
}

/**
 * The percentage out of a `battery` runtime-state slice, or `null`.
 *
 * A type GUARD, not a cast: a version-skewed emitter, or a slice that carries
 * only `lastUpdated` (which the census measured happening 526 times in 25
 * minutes without one percentage moving), must contribute NO sample rather
 * than a zero — a fabricated 0% in a discharge chart is worse than a gap.
 */
function batteryPercentage(slice: unknown): number | null {
  if (typeof slice !== 'object' || slice === null) return null
  const raw = (slice as Record<string, unknown>)['level']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}
