export enum EventCategory {
  // System
  SystemBoot = 'system.boot',
  SystemAddonsReady = 'system.addons-ready',
  SystemRestarting = 'system.restarting',
  /**
   * Fired exactly once after the hub finishes booting following a
   * restart that was triggered by `RestartCoordinator` (today: framework
   * live-update). Payload is the marker that was on disk at boot
   * (`PendingRestartMarkerPayload`); admin UI listens for it to display a
   * success toast describing what changed.
   *
   * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
   */
  SystemRestartCompleted = 'system.restart-completed',
  /**
   * The hub reissued its own TLS certificate at boot (`ensureTlsCert`).
   * Emitted only when the material on disk actually changed, so an
   * operator who trusted the old certificate by hand is told rather than
   * discovering it as a browser error. Payload `TlsCertChangedPayload`.
   *
   * Rule: docs/decisions/adr-0227-*.md
   */
  SystemTlsCertChanged = 'system.tls-cert-changed',
  /**
   * A newer addon or server-root package version was found by the
   * authoritative registry check. Emitted once when any observed
   * `latestVersion` changes (or a package/node first appears behind);
   * the payload carries the full currently-available list. Repeated
   * polling of the same latests is silent.
   */
  UpdateAvailable = 'update.available',
  /**
   * Readiness transition for a capability provider. Every producer emits
   * this event on `onInitialize` completion, `onDestroy`, and
   * `$node.reconnect`; every consumer that needs to gate on a cross-process
   * cap subscribes via the kernel's readiness module (`awaitReady` /
   * `onReadyState`) instead of polling. Payload is
   * `SystemReadyStatePayload` — see event-bus.ts.
   */
  SystemReadyState = 'system.ready-state',

  // Addon lifecycle
  AddonStarted = 'addon.started',
  AddonStopped = 'addon.stopped',
  AddonRestarted = 'addon.restarted',
  AddonUpdated = 'addon.updated',
  AddonInstalled = 'addon.installed',
  AddonUninstalled = 'addon.uninstalled',
  AddonCrashed = 'addon.crashed',
  /**
   * A RUNNER the D6 crash circuit-breaker gave up on — terminal.
   *
   * `AddonCrashed` is the routine, self-healing fact ("it crashed; it is being
   * respawned"); this is the one that never resolves itself. Emitted exactly
   * once per trip, by `process-service.ts`, carrying the node, the runner, the
   * addons it hosted and the crash count that tripped the breaker.
   *
   * It exists because a runner marked terminally `failed` used to be SILENT:
   * on 2026-08-18 the `recorder` runner died of three unhandled ffmpeg spawn
   * errors, the breaker stopped respawning it (correctly), `/health` kept
   * returning 200, and fleet-wide recording was gone for 3h15 before the
   * operator's phone told him. The Notification Center's system-event intake
   * consumes this category and maps it to the `addon-crash-loop` kind.
   */
  AddonRunnerFailed = 'addon.runner-failed',
  /**
   * A runner whose addon refused to start with a typed reason (D877) - parked
   * in `refused`, never counted by the crash breaker, retried on operator
   * action. One event per refusal.
   */
  AddonRunnerRefused = 'addon.runner-refused',
  /**
   * A runner settled on a state (D877): `running` (READY), `crashed`, `failed` or
   * `refused`. In-process telemetry for the boot check (re-evaluate while any
   * runner is still pending) and the alert centre (close a recovered runner).
   */
  ProcessStateChanged = 'process.state-changed',
  /**
   * The node's one-shot runner boot check (D877): planned runners against the
   * process service, `degraded` when any is failed, refused or missing. The
   * alert centre turns it into one critical alert.
   */
  SystemRunnerCheck = 'system.runner-check',
  /**
   * An alert EPISODE opened or closed, emitted by the alert centre for alerts
   * of severity `critical` or `error` (`AlertEpisodePayload`). The alert
   * centre sends no notification of its own: Notification Center turns this
   * into the `alert-critical` / `alert-error` / `alert-critical-resolved`
   * system-event kinds, and reconciles from the alerts store because a bus
   * event may be dropped (D8, D11).
   */
  AlertEpisode = 'alert.episode',
  AddonError = 'addon.error',
  AddonPageReady = 'addon.page-ready',
  AddonWidgetReady = 'addon.widget-ready',
  /**
   * Addon failed to load (import or initialize). Emitted by the kernel's
   * AddonHealthMonitor only AFTER the boot grace period ends — failures
   * during the first 5 minutes are silently retried without alerting
   * (slow-starting addons must have time to come up). Post-grace, this
   * event is emitted exactly once per failure-streak; AlertCenter
   * consumes it to create a persistent operator-visible alert.
   *
   * Payload: `{ packageName, addonId?, error: { message, stack }, retryCount, nextRetryAt }`.
   */
  AddonLoadFailed = 'addon.load-failed',

  /**
   * A keychain value was stored or removed (D787). Carries the ref, its
   * owner and the new version — NEVER the value. A process holding the ref
   * drops its cached copy and the owning `BaseAddon` re-resolves its config.
   * Telemetry (D8): a process that misses it still revalidates by version.
   */
  KeychainChanged = 'keychain.changed',
  /**
   * Addon recovered from a previous failure. Emitted when an addon
   * transitions from `failed` back to `healthy` (typically via the
   * monitor's auto-retry loop, or after manual `addons.retryLoad`).
   * AlertCenter dismisses the corresponding `AddonLoadFailed` alert
   * on this event.
   */
  AddonLoadRecovered = 'addon.load-recovered',
  /**
   * Monitor scheduled the next retry for a failed addon. Transient —
   * surfaced to the UI for live-updating the "next retry in Ns"
   * countdown on the Addons page row, NOT persisted as an alert.
   */
  AddonRetryScheduled = 'addon.retry-scheduled',
  /**
   * A liveness invariant of this node is false — it has no devices, every
   * camera is offline, or a camera that was recording has stopped producing
   * segments. Emitted by the `liveness-monitor` builtin, once per fault (the
   * `findingId` is stable across ticks), only after its boot grace period.
   * AlertCenter raises a persistent operator-visible alert.
   *
   * It exists because on 2026-08-03 the hub ran four hours with zero devices
   * and zero recordings while every surface stayed quiet.
   *
   * Payload: `{ findingId, severity, title, message, deviceId? }`.
   */
  SystemLivenessFailed = 'system.liveness-failed',
  /**
   * A previously reported liveness fault is true again. AlertCenter dismisses
   * the matching `SystemLivenessFailed` alert.
   *
   * Payload: `{ findingId }`.
   */
  SystemLivenessRecovered = 'system.liveness-recovered',
  /**
   * Monitor is attempting to reload a failed addon NOW. UI uses this
   * to show a spinner during the retry attempt. Same transient nature
   * as AddonRetryScheduled.
   */
  AddonRetryAttempting = 'addon.retry-attempting',

  // Device
  DeviceRegistered = 'device.registered',
  DeviceUnregistered = 'device.unregistered',
  DeviceEnabled = 'device.enabled',
  DeviceDisabled = 'device.disabled',
  DeviceSettingsUpdated = 'device.settings-updated',
  /**
   * Emitted when the set of native capability providers bound to a device
   * changes — e.g. an addon registers a new native cap via
   * `DeviceContext.registerNativeCap`, or all native bindings for a device
   * are cleared on removal. Hub consumers re-resolve device-proxy routes
   * when this fires.
   */
  DeviceBindingsChanged = 'device.bindings-changed',
  /**
   * Emitted when the operator-organisational meta surface changes
   * (`name` / `location` / `disabled`). Payload: `{deviceId, field,
   * value}`. Live consumers (UI device list, alert center) react
   * without polling. Distinct from `DeviceSettingsUpdated` which
   * fires on hardware-config changes (host/port/credentials/etc).
   */
  DeviceMetaChanged = 'device.meta-changed',
  /**
   * Emitted by `BaseDevice.updateSourceInfo()` after a successful patch
   * to the device's upstream-system identity / rendering envelope. The
   * full new SourceInfo travels in the payload so cross-process listeners
   * (UI, export adapters) don't need to re-read the meta blob.
   *
   * Payload: `{deviceId, sourceInfo}`.
   *
   * Distinct from `DeviceMetaChanged` which covers the operator-edited
   * surface (`name` / `location` / `disabled`). The two share the
   * persistence layer (both ride on `device-manager.setMetadata` for
   * SourceInfo, or `setName`/`setLocation`/`setDisabled` for the meta
   * fields) but consumers care about different subsets.
   */
  DeviceSourceInfoChanged = 'device.source-info-changed',
  /**
   * Emitted by DeviceStreamWiringService after a successful
   * `stream-broker.registerDeviceStreams` call. Payload includes
   * deviceId — consumers look up the full registered device info via
   * `brokerManager.getRegisteredDevice(deviceId)`.
   *
   * Replaces the legacy `StreamRouterService.onDeviceRegistered` callback.
   */
  DeviceStreamsRegistered = 'device.streams-registered',
  /**
   * Device-level "fully provisioned" signal — the EXPORT trigger. Emitted once
   * a device's persisted export-relevant shape (its `DeviceFeature` set) is
   * established or changes, carrying `{deviceId, fingerprint, generation}`.
   * Export adapters (Alexa / HAP) react to THIS instead of the chatty per-cap
   * `DeviceBindingsChanged`, turning a boot's incomplete→complete trickle into
   * one clean delta. `fingerprint` is `canonicalDeviceFingerprint(shape)`.
   *
   * Spec: docs/superpowers/specs/2026-06-01-alexa-hap-export-reconciler-design.md
   */
  DeviceProvisioned = 'device.provisioned',
  /**
   * Fires once when a device's initial feature-probe completes successfully
   * (lastProbedAt 0→>0); exported shape is now stable. Telemetry (may be
   * dropped) — consumers MUST also gate on the device record's `probed` flag.
   */
  DeviceReady = 'device.ready',

  // Integration
  IntegrationEnabled = 'integration.enabled',
  IntegrationDisabled = 'integration.disabled',
  IntegrationDeleted = 'integration.deleted',

  // Broker (unified pub/sub registry — MQTT / HA / future)
  /** Emitted when a broker connection's status flips (connected /
   *  disconnected / error). Carries `{ brokerId, status, error? }`. */
  BrokerStatusChanged = 'broker.status-changed',
  /** Emitted for every subscription-matched message routed by a
   *  broker provider. Carries `{ brokerId, subscriptionId, key, payload }`.
   *  Consumers filter by `brokerId` + `subscriptionId` in the handler. */
  BrokerMessage = 'broker.message',

  // Provider
  ProviderStarted = 'provider.started',
  ProviderStopped = 'provider.stopped',

  // Process
  ProcessCrashed = 'process.crashed',
  ProcessRestartScheduled = 'process.restart_scheduled',
  ProcessRestarted = 'process.restarted',

  // Storage
  /**
   * The SET of storage locations changed — one was created, edited, enabled,
   * disabled or deleted through `storage.upsertLocation` / `deleteLocation`.
   *
   * Telemetry, not a transaction (D8/D11): every consumer that re-resolves on
   * it must also converge on its own periodic path, because a dropped event
   * must not leave a node writing to yesterday's disk set forever. It exists
   * because there was NO signal at all — an operator who added a second
   * recordings disk in the admin UI got nothing, and the recorder kept its
   * resolved locations until something else happened to re-resolve them
   * (D387). Payload `StorageLocationsChangedPayload`.
   */
  StorageLocationsChanged = 'storage.locations-changed',

  // Recording
  RecordingStarted = 'recording.started',
  RecordingStopped = 'recording.stopped',
  RecordingError = 'recording.error',
  RecordingHealthDegraded = 'recording.health.degraded',
  /** Recording enabled but no segment finalized for the NC stall window. */
  RecordingHealthStalled = 'recording.health.stalled',
  /** Recovery from {@link RecordingHealthStalled}. */
  RecordingHealthOk = 'recording.health.ok',
  RecordingStorageCritical = 'recording.storage.critical',
  /** Free space on a storage location crossed the warn bar. */
  StorageLocationLow = 'storage.location.low',
  /** Free space at/under the critical bar, or capacity probe failed (`null`). */
  StorageLocationCritical = 'storage.location.critical',
  /** Recovery from low/critical on a storage location. */
  StorageLocationOk = 'storage.location.ok',
  RecordingSegmentWritten = 'recording.segment.written',
  RecordingPolicyFallback = 'recording.policy.fallback',
  RecordingRetentionCompleted = 'recording.retention.completed',
  /** Export render progress (0–100). Telemetry (D8): a lost tick is a stale
   *  progress bar the client reconciles via `recordingExport.getExport`. */
  RecordingExportProgress = 'recording.export.progress',
  RecordingExportCompleted = 'recording.export.completed',
  RecordingExportFailed = 'recording.export.failed',

  // Detection & analysis
  DetectionEvent = 'detection.event',

  // Session tracking
  SessionTrackNew = 'session.track.new',
  SessionTrackExpired = 'session.track.expired',

  // Benchmark
  BenchmarkProgress = 'benchmark.progress',

  // Platform probe
  PlatformProbePhase = 'platform-probe.phase',

  // Pipeline & inference
  PipelineProgress = 'pipeline.progress',
  /** Per-frame execution trace emitted by the pipeline executor for live observability. */
  PipelineTrace = 'pipeline.trace',
  /**
   * Raw inference output emitted by `addon-pipeline-runner` after running the
   * detection pipeline on a frame. Carries the `FrameResult` (with
   * `detections[]`, `width`/`height`, timing debug) — never the frame
   * buffer itself. Hub-side consumers (analysis pipeline, class filters,
   * notifications) subscribe to this and re-emit `detection.result` after
   * post-processing.
   */
  PipelineInferenceResult = 'pipeline.inference-result',
  /**
   * Camera lifecycle event emitted by `addon-pipeline-orchestrator` when it
   * assigns or unassigns a camera to/from an agent. Carries no frame data;
   * pure observability for UI dashboards and metrics consumers.
   */
  PipelineCameraAssigned = 'pipeline.camera-assigned',
  PipelineCameraUnassigned = 'pipeline.camera-unassigned',
  /**
   * A node the orchestrator would otherwise place cameras on has NO usable
   * inference device: the operator enabled one or more accelerators there and
   * the live probe reports every one of them unavailable. Emitted once per
   * TRANSITION into that state (never per dispatch), and the node is dropped
   * from the placement candidate set for as long as it holds.
   *
   * This exists because the state was previously invisible: agent-a
   * absorbed 283k inference errors in a day while still being handed cameras,
   * and nothing in the system said so.
   *
   * A node with no accelerators configured at all is NOT this — its devices
   * are `disabled`, not `unavailable`, and the runner's default CPU pool
   * serves it exactly as before.
   */
  PipelineNodeInferenceUnavailable = 'pipeline.node-inference-unavailable',
  /**
   * A camera has an OPEN detection session and has produced no detection at
   * all for longer than the blind threshold — the camera is being decoded and
   * inferred and is returning nothing. Emitted once per transition into blind,
   * per camera.
   *
   * The failure it reports: a 1h43 detection blackout on the entrance camera
   * that nobody noticed, because "a camera that detects nothing" and "a quiet
   * camera" produce byte-identical silence.
   */
  PipelineDetectionBlind = 'pipeline.detection-blind',
  /**
   * A camera's motion source has fired constantly with no subject for an hour
   * (motion duty or session count over the bar, zero detections) — it is not
   * blind, its motion zones or sensitivity want tuning (D907). Paired with
   * {@link PipelineMotionCalm}.
   */
  PipelineMotionNoisy = 'pipeline.motion-noisy',
  /** The recovery edge of {@link PipelineMotionNoisy}: the motion fell back, or a detection arrived. */
  PipelineMotionCalm = 'pipeline.motion-calm',
  /**
   * Per-camera pipeline config was mutated by the orchestrator
   * (a settings change via `setAgentInferenceDevices` /
   * `setCameraStepToggle` / `setCameraStepSettings`). Orchestrator
   * subscribes to its own emission to hot-reload the assigned runner
   * via `attachCamera` so the next frame executes against the new
   * engine/steps without waiting for a rebalance or the next
   * `DeviceStreamsRegistered` cycle.
   */
  PipelineCameraUpdated = 'pipeline.camera-updated',
  /**
   * The cluster camera-source OWNER changed (`clusterRoles.ingestNode`).
   * Emitted by addon-pipeline-orchestrator whenever it (re)derives node
   * capabilities — at boot, on agent online/offline, and on an ingest-node
   * flip. Carries the resolved `ownerNodeId`. The stream-broker consumes it to
   * keep its ingest-owner-gate decision current WITHOUT a per-`ensureBroker`
   * cross-process `getIngestOwner` query (push the authority's decision instead
   * of polling it on the hot path). Idempotent state — re-emitted on every
   * topology change, so a dropped event self-heals on the next one (plus the
   * broker's long backstop reconcile query).
   */
  PipelineIngestOwnerChanged = 'pipeline.ingest-owner-changed',
  /**
   * Periodic snapshot of per-node pipeline-runner load
   * (`RunnerLocalLoad`). Emitted ~1Hz by every runner so UI dashboards
   * subscribe instead of polling `pipelineRunner.getLocalLoad`.
   * `nodeId` carried in the payload + on `event.source.nodeId`.
   */
  PipelineRunnerLoadSnapshot = 'pipeline.runner-load-snapshot',
  /**
   * Periodic snapshot of per-camera pipeline metrics (`CameraMetrics`
   * + `deviceId` + `nodeId`). Emitted ~1Hz by every runner for each
   * attached camera. UI subscribes to drive overlay phase / fps /
   * inference time without polling `getCameraMetrics`.
   */
  PipelineCameraMetricsSnapshot = 'pipeline.camera-metrics-snapshot',
  /**
   * Periodic snapshot of stream-broker per-broker statistics (input
   * fps, decoded fps, bitrate, codec). Emitted ~1Hz by every
   * stream-broker process for each active broker so the UI can drive
   * the Stream / Cluster dashboards without polling
   * `streamBroker.listAllProfileSlots` and friends.
   */
  StreamBrokerMetricsSnapshot = 'stream-broker.metrics-snapshot',
  /**
   * Cap event fired by `stream-broker` when a profile slot enters
   * "demanded" state — a cam stream has been assigned and at least one
   * consumer (RTSP restream, decoded subscriber, WebRTC session, …) is
   * present. Camera-provider addons (Reolink Baichuan push, …)
   * subscribe to this category to start their underlying transport
   * lazily. Payload: `{ deviceId, camStreamId, profile }`.
   */
  StreamBrokerOnCamStreamDemand = 'stream-broker.onCamStreamDemand',
  /**
   * Cap event fired by `stream-broker` when the last consumer leaves a
   * previously-demanded cam stream. Providers tear down their
   * underlying transport on receipt. Payload: `{ deviceId, camStreamId }`.
   */
  StreamBrokerOnCamStreamIdle = 'stream-broker.onCamStreamIdle',
  /**
   * Cap event fired by `stream-broker` when a broker fails to dial a
   * managed-loopback source (today: `pull-rfc4571`) and the publisher
   * needs to refresh the cached URL. The lib's TCP server idle-tears-down
   * on its own schedule, so a re-publish with a fresh `host:port` is the
   * only way to keep the broker dialable. Camera providers (Reolink
   * Baichuan native, …) subscribe and respond by re-running their publish
   * pipeline.
   * Payload: `{ deviceId, camStreamId, brokerId }`.
   */
  StreamBrokerOnRequestStreamSourceRefresh = 'stream-broker.onRequestStreamSourceRefresh',
  /**
   * A camera provider changed a device's stream parameters (codec /
   * resolution / bitrate / a stream added or removed). A LOW-LATENCY NUDGE
   * for the stream-broker's catalog reconcile: it carries NO authoritative
   * data — the broker re-PULLS that device's `stream-catalog` cap on receipt
   * (the 30s reconcile poll is the backstop if this nudge is dropped). Emitted
   * by providers from `stream-params.setProfile`. Payload: `{ deviceId }`.
   */
  StreamParamsChanged = 'stream-params.changed',
  /**
   * Generic per-device runtime-state change. Fired by `device-manager`
   * whenever a persisted slice in any cap's `runtimeState` shape
   * mutates. Payload: `{deviceId, capName, slice}`. Subscribers are
   * the `deviceState` cap router (cross-process listeners) and the
   * deviceProxy reactive bindings (`device.state.<capName>.value`).
   * Cap-specific events (`battery.onStatusChanged`, …) still fire
   * — they're authoritative for callers that want a typed payload
   * without filtering on `capName`.
   */
  DeviceStateChanged = 'device.state-changed',
  /**
   * The NATIVE shadow of a cap a composition has claimed fields of moved
   * (D663). Payload: `{ deviceId, capName, native }` — what the provider
   * wrote, BEFORE the owned fields are overlaid. Owner-only (D224): it is for
   * the composer's native self-reads, and the public event routers refuse it
   * (`isOwnerOnlyEventCategory`) so no consumer surface ever shows a second
   * truth beside the merged `DeviceStateChanged.slice`. Emitted only under a
   * `replace` claim, one per native write of that cap.
   */
  DeviceNativeShadowChanged = 'device.native-shadow-changed',
  /**
   * Frame occupancy for a camera CHANGED — a tracked object was gained or
   * lost. Carries `{ deviceId, totalObjects, byClass, zones }`.
   *
   * Emitted only on a change, so a steady scene is silent. It exists so a
   * client can stop polling `zoneAnalytics.getCurrentSnapshot`: that was the
   * one live badge with no push signal at all, and it cost a request every
   * four seconds per visible camera.
   *
   * Like every event it is telemetry and may be dropped ([D8]) — a consumer
   * keeps a slow reconcile rather than trusting it alone.
   */
  ZoneAnalyticsOccupancyChanged = 'zone-analytics.occupancy-changed',
  /**
   * Cap event fired by every device that registers the `battery`
   * capability. Mirrors the cap definition's `onStatusChanged`. Carries
   * `{ deviceId, status: BatteryStatus }`. Subscribers (alert center,
   * snapshot wrapper, UI) react to charge/sleep transitions without
   * polling `batteryCapability.getStatus`.
   */
  BatteryOnStatusChanged = 'battery.onStatusChanged',
  /**
   * Cap event fired by every device that registers the `network-link`
   * capability. Mirrors the cap definition's `onStatusChanged`. Carries
   * `{ deviceId, status: NetworkLinkStatus }` — a link switch or a signal
   * reading that moved.
   */
  NetworkLinkOnStatusChanged = 'network-link.onStatusChanged',
  /**
   * Emitted by the battery cap provider WHEN `wakeForStream` enters the
   * "wake in progress" window — between the Baichuan wake-up issue and
   * the camera's first dialed-back RTP packet. The stream-broker
   * manager subscribes to flip the per-broker placeholder reason to
   * `'waking'` so viewers see a labelled "WAKING UP" tile instead of
   * the generic `'reconnecting'` frame. Carries `{ deviceId }`. The
   * complementary "wake complete" signal is the existing
   * `BatteryOnStatusChanged { sleeping: false }` event.
   */
  BatteryOnWakeStarted = 'battery.onWakeStarted',
  /**
   * Cap event fired by every device that registers the `doorbell`
   * capability. Mirrors `doorbellCapability.events.onPressed`. Carries
   * `{ deviceId, timestamp }`. Operators consuming the UI subscribe
   * here to render transient ring toasts and a "Recent presses" row
   * on the device detail page.
   */
  DoorbellOnPressed = 'doorbell.onPressed',
  /** Mirrors `runningStateCapability.events.onStarted`. */
  RunningStarted = 'running.started',
  /** Mirrors `runningStateCapability.events.onFinished`. */
  RunningFinished = 'running.finished',
  /**
   * Cap event fired by every device that registers the `event-emitter`
   * capability. Mirrors `eventEmitterCapability.events.onEvent`. Carries
   * `{ deviceId, eventType, data, timestamp, seq }` — the device's EXACT
   * declared event verbatim (NO normalization). Subscribers (UI event
   * stream, advanced-notifier rules) react to fired events without
   * holding a cap reference.
   */
  EventEmitted = 'event-emitter.event',
  /**
   * Periodic snapshot of the per-node detection-pipeline engine
   * registry (loaded engines, models resident, in-use cameras, idle
   * TTL). Emitted ~0.2Hz (every 5 s) by every detection-pipeline
   * process. The Engines tab subscribes to drive its inventory view
   * without polling `pipelineExecutor.listLoadedEngines`.
   */
  PipelineEngineMetricsSnapshot = 'pipeline.engine-metrics-snapshot',
  /**
   * Per-node detection-engine runtime-provisioning transition. Emitted by
   * the detection-pipeline provider on every state change of its lazy
   * engine-provisioning machine (idle → installing → verifying → ready,
   * or → failed with a `nextRetryAt`). Payload is the
   * `EngineProvisioningState` snapshot; `event.source.nodeId` carries the
   * node. The Pipeline page subscribes to drive a live "installing
   * OpenVINO… / ready" indicator per node without polling
   * `pipelineExecutor.getEngineProvisioning`. Telemetry-grade (D8): the UI
   * also reads the cap snapshot on mount / reconnect. Phase 2.
   */
  PipelineEngineProvisioning = 'pipeline.engine-provisioning',
  /**
   * Cluster topology snapshot. Carries the same payload returned by
   * `nodes.topology` (every reachable node + addons + processes).
   * Emitted by the hub on any agent / addon lifecycle change
   * (debounced) plus a periodic safety net. Replaces UI polling on
   * `nodes.topology` — admin-ui dashboards subscribe to drive the
   * cluster view directly from the event payload.
   */
  ClusterTopologySnapshot = 'cluster.topology-snapshot',
  /**
   * Periodic per-node system metrics snapshot (CPU / memory / GPU /
   * disk / network). Emitted ~0.2 Hz by the metrics-provider addon
   * for each node. Drives the dashboard SystemStatus / ProcessResources
   * widgets without polling `metricsProvider.getCurrent`.
   */
  MetricsNodeResourcesSnapshot = 'metrics.node-resources-snapshot',
  /**
   * Periodic per-node process-tree snapshot (camstack-related pids
   * with root / managed / system classification). Emitted ~0.2 Hz by
   * the metrics-provider addon. Drives the Cluster → Processes tab
   * without polling `metricsProvider.listNodeProcesses`.
   */
  MetricsNodeProcessesSnapshot = 'metrics.node-processes-snapshot',
  /**
   * Capability binding change event emitted by `addon-pipeline-orchestrator`
   * when a user changes which addon implements a cap on a node. Subscribed
   * by every kernel process to update its local `preferredProviderRegistry`
   * so future capability lookups respect the new binding.
   */
  /**
   * A capability binding was changed for a node — addon X now provides
   * capability `cap` on node `nodeId`. Lives under the generic
   * `capability.*` namespace because capability bindings are a kernel-
   * level concept used by many addons, not strictly pipeline-scoped.
   */
  CapabilityBindingChanged = 'capability.binding-changed',
  ModelDownloadProgress = 'model.download.progress',

  // Agent
  AgentRegistered = 'agent.registered',
  AgentUnregistered = 'agent.unregistered',
  AgentOnline = 'agent.online',
  AgentOffline = 'agent.offline',
  /** Forked worker process (e.g. hub/pipeline) connected to the broker. */
  WorkerOnline = 'worker.online',
  /** Forked worker process disconnected from the broker. */
  WorkerOffline = 'worker.offline',
  AgentTaskDispatched = 'agent.task.dispatched',
  AgentTaskAssigned = 'agent.task.assigned',
  AgentTrpcConnected = 'agent.trpc.connected',
  AgentWsConnected = 'agent.ws.connected',
  AgentWsDisconnected = 'agent.ws.disconnected',
  AgentBackupActivated = 'agent.backup.activated',

  // Detection settings
  OrchestrationSettingsUpdated = 'orchestration.settings-updated',

  // Motion analysis
  MotionAnalysis = 'detection.motion-analysis',
  /** All raw motion zones from CCL before minArea filter — for UI debug overlay. */
  MotionZonesRaw = 'detection.motion-zones-raw',
  /**
   * Per-camera motion phase transition (`watching ↔ active`) emitted
   * by the runner. Mirrors the `motion.onMotionChanged` cap event
   * surface — payload `MotionOnMotionChangedPayload` carries
   * `{deviceId, detected, timestamp, source, regions?}`. Subscribers
   * include addons that need to react to motion state without
   * polling the runtime-state mirror.
   */
  MotionOnMotionChanged = 'motion.on-motion-changed',

  // Detection extended
  DetectionResult = 'detection.result',
  DetectionRaw = 'detection.raw',
  DetectionCameraNative = 'detection.camera-native',
  /**
   * Canonical per-chunk live audio pipeline output. Payload is
   * `PipelineAudioInferenceResultPayload` carrying a full `AudioResult`
   * (level + detections + debug). Lives on the pipeline.* namespace
   * alongside `pipeline.inference-result` (video) for symmetry.
   */
  PipelineAudioInferenceResult = 'pipeline.audio-inference-result',
  DetectionPhaseTransition = 'detection.phase-transition',
  /**
   * A camera provider's RAW onboard motion push (D673): the `MotionOnMotionChanged`
   * data shape without `triggeredBy`, built by `providerMotionEvent`. Its one
   * consumer is the orchestrator's camera-sensors bridge, which re-emits the
   * camera's EFFECTIVE onboard motion as `MotionOnMotionChanged` (a pass-through
   * for a camera with no attached sensor). Providers must not emit
   * `MotionOnMotionChanged` themselves; `scripts/check-onboard-motion-emitters.ts`
   * keeps it so (camera-grid is a named, deferred exception).
   */
  ProviderMotion = 'provider.motion',
  ProviderDetection = 'provider.detection',

  // Enrichment
  EnrichmentEmbeddingStored = 'enrichment.embedding.stored',
  EnrichmentSceneStateChanged = 'enrichment.scene.state-changed',
  EnrichmentActivitySummary = 'enrichment.activity.summary',

  // Pipeline analytics
  /**
   * Unified track-lifecycle event: ONE category carrying `phase:
   * 'start' | 'update' | 'end'` with a rich, typed
   * `PipelineAnalyticsTrackLifecyclePayload`. Supersedes the thin
   * `PipelineAnalyticsTrackStarted` / `PipelineAnalyticsTrackEnded`
   * pair — a consumer subscribes once and branches on `phase`.
   */
  PipelineAnalyticsTrackLifecycle = 'pipeline-analytics.track-lifecycle',
  /**
   * @deprecated Superseded by {@link PipelineAnalyticsTrackLifecycle}
   * (`phase:'start'`). Kept as a soft alias — no known subscribers.
   */
  PipelineAnalyticsTrackStarted = 'pipeline-analytics.track-started',
  /**
   * @deprecated Superseded by {@link PipelineAnalyticsTrackLifecycle}
   * (`phase:'end'`). Kept as a soft alias — no known subscribers.
   */
  PipelineAnalyticsTrackEnded = 'pipeline-analytics.track-ended',
  PipelineAnalyticsDetectionEvent = 'pipeline-analytics.detection-event',
  PipelineAnalyticsFrameTracked = 'pipeline-analytics.frame-tracked',
  /**
   * Fired by `addon-post-analysis` when a parked (stationary) object appears
   * (a track was promoted to a stationary-registry entry) or departs (the
   * object moved / was removed). Telemetry (D8): lossy, drives a UI refresh of
   * the dedicated "Stationary" section — never the live event feed. Payload:
   * `{ deviceId, entryId, className, phase:'appeared'|'departed', timestamp }`.
   */
  PipelineAnalyticsStationaryChanged = 'pipeline-analytics.stationary-changed',
  /**
   * Fired by `addon-post-analysis` when a package-drop is confirmed inside
   * a package zone — a newly-appeared stationary object of a package class
   * that cleared the class / zone / dwell / size gates. Payload:
   * `PipelineAnalyticsPackageDeliveredPayload` carrying `{ deviceId,
   * entryId, className, zoneIds, keyFrameMediaId?, bbox, timestamp }`.
   * Telemetry (D8): the durable record is the `package-events` store row;
   * this bus topic drives notifier rules + live UI. See
   * docs/superpowers/specs/2026-07-17-package-zones-design.md §5.1.
   */
  PipelineAnalyticsPackageDelivered = 'pipeline-analytics.package-delivered',
  /**
   * Fired by `addon-post-analysis` when a previously-delivered package
   * leaves its zone (the stationary entry departed — moved or swept).
   * Payload: `PipelineAnalyticsPackagePickedUpPayload` carrying
   * `{ deviceId, entryId, deliveredEventId, className, timestamp }`.
   * Telemetry (D8). See package-zones-design §5.2.
   */
  PipelineAnalyticsPackagePickedUp = 'pipeline-analytics.package-picked-up',
  /**
   * Fired by `addon-post-analysis` whenever a gallery face row changes:
   * `kind:'buffered'` a new detected face was persisted, `'assigned'` /
   * `'unassigned'` its identity link changed, `'deleted'` the row was
   * removed. Telemetry semantics (D8): a lost event only delays a refresh,
   * never a correctness issue. Payload `PipelineAnalyticsFaceGalleryChangedPayload`.
   */
  PipelineAnalyticsFaceGalleryChanged = 'pipeline-analytics.face-gallery-changed',
  /**
   * Fired by `addon-post-analysis` whenever a gallery plate row changes:
   * `kind:'buffered'` a new read was persisted (`PlateRecognizer.onTrackEnd`),
   * `'assigned'` / `'unassigned'` its vehicle link changed
   * (`PlateGalleryProvider`), `'deleted'` the row was removed. Telemetry
   * semantics (D8): a lost event only delays a refresh, never a correctness
   * issue. Payload `PipelineAnalyticsPlateGalleryChangedPayload`.
   */
  PipelineAnalyticsPlateGalleryChanged = 'pipeline-analytics.plate-gallery-changed',

  // Camera streams
  CameraStreamsProfileSlotsChanged = 'camera-streams.onProfileSlotsChanged',
  /**
   * Stream-broker health watchdog. Per-broker (deviceId/profile) emission.
   * `stream.offline` fires after STREAM_STALE_TIMEOUT_MS without an encoded
   * packet on an active broker. `stream.online` fires on first packet
   * after a stale gap (or on initial first packet). Payload includes
   * the assigned camStreamId as `profileKey`.
   */
  StreamOnline = 'stream.online',
  StreamOffline = 'stream.offline',

  // Network
  NetworkTunnelStarted = 'network.tunnel.started',
  NetworkTunnelStopped = 'network.tunnel.stopped',
  /** Fired by the `local-network` cap when the host's interface set
   *  changes (new IP from DHCP, VPN connect, docker bridge added). */
  LocalNetworkChanged = 'network.local.changed',
  /**
   * Fired by a `mesh-network` provider (Tailscale, …) when its
   * mesh-reachable host changes (join / leave / MagicDNS or 100.x IP
   * change). Lets `local-network` fold the mesh endpoint into its
   * connection-endpoint list without a cross-package import. Payload
   * carries the preferred host (`host: ''` = no longer reachable),
   * the hub port, and the scheme. Telemetry-grade (D8): consumers
   * pull-reconcile from the provider's `getStatus` on reconnect. */
  MeshNetworkChanged = 'network.mesh.changed',

  // Backup
  BackupCompleted = 'backup.completed',
  /**
   * A whole backup RUN finished — every destination attempted, win or lose.
   *
   * `backup.completed` fires once per DESTINATION, which is the right grain for
   * a progress UI and the wrong one for a notification: an operator with three
   * destinations would be told three times. And a run where two of three
   * destinations succeeded is not a clean success — a single "backup
   * completed" that hid the failed one would be a lie, so the count of each is
   * carried here and the message says both.
   *
   * Emitted by the backup orchestrator only after the destination loop, so a
   * run that dies during the BUILD phase produces no completion at all.
   */
  BackupRunCompleted = 'backup.run-completed',
  BackupRestored = 'backup.restored',

  // Notification
  NotificationDispatched = 'notification.dispatched',
  NotificationFailed = 'notification.failed',
  /**
   * A notification rule that cannot work (D905): its stored row does not load,
   * or it still names a device / delivery target the prune CONFIRMED deleted.
   * One edge per rule per distinct set of reasons; never on an unanswered read.
   */
  NotificationRuleBroken = 'notification.rule-broken',
  /** The clear of {@link NotificationRuleBroken}: the rule loads and names nothing deleted. */
  NotificationRuleRepaired = 'notification.rule-repaired',

  // Device extended
  DeviceUpdated = 'device.updated',
  /**
   * Transport-level connectivity. Emitted by the device driver when
   * the underlying control socket actually connects / disconnects
   * (Baichuan TCP, ONVIF probe response, RTSP DESCRIBE, …) — NOT for
   * power-state transitions on a battery camera. For battery wake /
   * doze cycles see `DeviceAwake` / `DeviceSleeping`.
   */
  DeviceOnline = 'device.online',
  /**
   * Stream-broker watchdog — emitted when no encoded packet has been
   * received for STREAM_STALE_TIMEOUT_MS on an active broker (rtsp or
   * push). Paired with DeviceOnline which fires on first packet after
   * a stale gap. Payload: DeviceStreamHealthPayload.
   */
  DeviceOffline = 'device.offline',
  /**
   * Battery cam woke up — physical power-state transition reported
   * by the device firmware. Distinct from `DeviceOnline` so a UI panel
   * watching power state doesn't flap on every UDP socket reconnect.
   */
  DeviceAwake = 'device.awake',
  /**
   * Battery cam went to sleep. See `DeviceAwake`.
   */
  DeviceSleeping = 'device.sleeping',

  // Retention
  RetentionCleanup = 'retention.cleanup',

  // Bulk update
  /**
   * Legacy bulk-update progress snapshot (payload `BulkUpdateState`). No longer
   * emitted — F3 removed the coordinator that produced it; "Update all" now runs
   * as one lifecycle engine job (`AddonsJobProgress`/`AddonsJobLog`). Retained
   * (with `BulkUpdateState`) only to avoid regenerating the event maps; removed
   * in F4 once live bulk progress is re-implemented over the engine events.
   */
  AddonsBulkUpdateProgress = 'addons.bulk-update-progress',
  AddonsJobProgress = 'addons.job-progress',
  AddonsJobLog = 'addons.job-log',

  // Accessories (container child fan-out)
  /**
   * A container's child visibility toggled (hidden/shown). Emitted by the
   * `accessories` cap when a child device is hidden or revealed.
   * Payload: `{ deviceId, childDeviceId, hidden }`.
   */
  AccessoriesChildVisibilityChanged = 'accessories.onChildVisibilityChanged',
  /**
   * A container's child set changed (children added/removed/reordered).
   * Payload: `{ deviceId, childDeviceIds, hiddenChildIds }`.
   */
  AccessoriesChanged = 'accessories.onAccessoriesChanged',

  // Model conversion (P3)
  /**
   * Progress update from a running model conversion job.
   * Payload: `{ kind: 'model-convert', phase, sessionId?, pct?, detail? }`.
   * Emitted by `addon-model-studio` on the converting node.
   */
  ModelConvertProgress = 'model-convert.progress',
}

/**
 * Categories that never leave the hub's trusted addon closure: the public
 * event routers (`systemEvents.*`, `live.*`) refuse them in every path, so a
 * UI or a share-scope subscriber cannot receive them by omitting the category
 * filter. Add a category here when its payload is a truth only one owner may
 * read (D224).
 */
export const OWNER_ONLY_EVENT_CATEGORIES: ReadonlySet<string> = new Set<string>([
  EventCategory.DeviceNativeShadowChanged,
])

export function isOwnerOnlyEventCategory(category: string): boolean {
  return OWNER_ONLY_EVENT_CATEGORIES.has(category)
}

/**
 * Every category a PUBLIC surface may offer or show — the enum minus the
 * owner-only set, unique, sorted. A picker built from the raw enum would offer
 * a filter that can never match, because the routers refuse that category.
 */
export function publicEventCategories(): readonly string[] {
  const all = Object.values(EventCategory).filter(
    (value): value is EventCategory => typeof value === 'string',
  )
  return [...new Set<string>(all)].filter((c) => !isOwnerOnlyEventCategory(c)).toSorted()
}
