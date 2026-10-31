import type {
  RetrainVerdict,
  AlarmArmMode,
  AlarmState,
  AudioEvent,
  CameraOccupancySnapshot,
  INotificationRulesProvider,
  IScopedLogger,
  MediaFileBytes,
  NcAlarmConfig,
  NcAlarmSensors,
  NcAlarmSensorsInput,
  NcAlarmSettingsPatch,
  NcAlarmProfilesView,
  NcAlarmSkipReason,
  NcClipRetentionAsk,
  NcConditions,
  NcOccupancyCondition,
  NcRule,
  NcRuleInput,
  NcRuleTarget,
  NcSnooze,
  NcSnoozeInput,
  NcTestResult,
  NotificationAction,
  ObjectEvent,
  SensorEvent,
  SystemEvent,
  TimelapseRule,
  Track,
} from '@camstack/types'
import { ActionTargetResolver, DETECTION_MACRO_CLASSES, ruleGroupingApplies } from '@camstack/types'
import {
  type NcActionGrant,
  NcActionTokenRegistry,
  type NcAddonUpdateGrant,
  type NcAlarmArmAnywayGrant,
  type NcAlarmBypassInputGrant,
  type NcAlarmGrant,
  type NcSequenceGrant,
  type NcServerUpdateGrant,
  type NcDetectionVerdictGrant,
  type NcSnoozeGrant,
} from './action-token.js'
import { toRetrainVerdict } from '../pipeline-analytics/retrain/retrain-pipeline-boxes.js'
import { type NcAddonUpdateReport } from './addon-update-apply.js'
import { type NcAlarmOpenDevice } from './alarm/alarm-arm-guard.js'
import { type NcPanelGateWords, panelAwareLookup } from './alarm/alarm-gate-words.js'
import {
  type NcAlarmModeCoverage,
  type NcArmAnnouncementText,
  type NcDeviceNameLookup,
} from './alarm/alarm-mode-coverage.js'
import { NcAlarmSensorsReadLog } from './alarm/alarm-sensors.js'
import { type NcAlarmLive } from './alarm/alarm-live.js'
import { NcAlarmLiveReadLog } from './alarm/alarm-live-read-log.js'
import {
  type NcAlarmArmGuardHook,
  type NcAlarmOpenings,
  type NcAlarmPublishReport,
  type NcAlarmRefusal,
  type NcObserveOpeningResult,
} from './alarm/alarm-panel-device.js'
import {
  type NcAlarmMatchPhase,
  type NcAlarmPushVerdict,
  type NcAlarmRowsHeard,
} from './alarm/alarm-push-policy.js'
import type { NcAlarmTransition } from './alarm/alarm-transitions.js'
import { NcAlertStore } from './alerts/alert-store.js'
import { consumableThresholdCensus } from './alerts/consumable-subject.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from './alerts/device-alerts.js'
import { type AudioSample, AudioWatcher } from './audio-rule-matcher.js'
import { type NcAlarmActionDeps } from './nc-actions.js'
import { clipRetentionSecFor, deriveClipRetentionAsks } from './clip-retention-ask.js'
import { downscaleJpeg, NcConfirmGate } from './confirm-gate.js'
import { NcDeviceDirectory, type NcDeviceIdentity } from './device-directory.js'
import { listNcDeviceData } from './device-data-removal.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import type { DurableKindDeps } from '../durable/durable-wiring.js'
import { NcSequenceStore } from './sequence-store.js'
import { NcDetectionVerdictLedger } from './detection-verdict-ledger.js'
import { NcPruneLedger, type NcPruneRecord } from './device-prune-ledger.js'
import { NcDeletedSubjectPruner } from './device-prune-runner.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import {
  type NcCooldownRelease,
  NcDispatcher,
  type NcMintButtonsInput,
  type NcSnoozeGateInput,
} from './dispatcher.js'
import {
  incomingFromAddonUpdates,
  type NcEventConsumer,
  type NcEventOrigin,
  type NcIncomingEvent,
  type NcIntakeControls,
  type NcIntakeReport,
  type NcRuleOutcome,
} from './event-intake.js'
import type {
  NcRecognitionOutlook,
  NcRecognitionOutlookQuery,
  NcTrackLabelChanged,
  NcTracksFused,
} from './grouped/grouped-inputs.js'
import { NcGroupedDelivery, type NcGroupedTrackLedger } from './grouped/grouped-delivery.js'
import { type NcGroupedFate } from './grouped/grouped-close-pass.js'
import {
  type NcGroupedCloseReason,
  type NcGroupedMember,
  type NcGroupedWindow,
} from './grouped/grouped-window-buffer.js'
import { NcJudgedTracks, NcNotifiedTracks } from './grouped/notified-tracks.js'
import {
  type NcGroupMemberFate,
  type NcGroupMemberRecord,
  type NcGroupQuery,
  type NcGroupRecord,
  NcGroupStore,
} from './grouped/nc-group-store.js'
import {
  DEVICE_LIVENESS_HOLDOFF_MS,
  DeviceLivenessHoldoff,
  type LivenessTiming,
  NODE_LIVENESS_HOLDOFF_MS,
} from './liveness-holdoff.js'
import { isLinkedStillId, type NcLinkedStills, NcLinkedStillShelf } from './linked-stills.js'
import { NcLivenessLedger } from './liveness-ledger.js'
import { NcAlertEpisodeLedger } from './alert-episode-ledger.js'
import { OccupancyStore } from './occupancy-store.js'
import {
  type OccupancyArmedFlip,
  type OccupancyEdge,
  type OccupancyEvidence,
  type OccupancyKeySpec,
  type OccupancyStateRow,
  OccupancyWatcher,
} from './occupancy-watcher.js'
import {
  type NcDeliverResult,
  NcOutbox,
  type NcOutboxEnqueueInput,
  type NcOutboxEntry,
} from './outbox.js'
import { NcRuleActionRunner } from './rule-actions.js'
import { NcRuleAiAnalyst } from './rule-ai-analyst.js'
import { NcRuleAiStore } from './rule-ai-store.js'
import {
  cooldownKey,
  isCoolingDown,
  type NcDeviceStateLookup,
  type NcEvaluation,
  type NcPackagePhase,
  type NcRuleFireRef,
  type NcRuleSubject,
  type NcSceneStateLookup,
  type NcSubjectKind,
  type NcSystemEventExcludingFilter,
  type NcTrackClosedInfo,
} from './rule-engine.js'
import { NcDeviceCompatWarnSampler } from './device-compat-guard.js'
import { type NcRuleStatus } from './rule-status.js'
import { NcRuleStore } from './rule-store.js'
import { type NcSceneObservation, NcSceneStateCache } from './scene-state-cache.js'
import { NcPlannedUpdateWindow } from './planned-update-window.js'
import { NcUpdateLandings } from './restart-supersede.js'
import { NcSnoozeStore } from './snooze-store.js'
import { type NcSnoozeVerdict, type NcSnoozeVerdictSuppressed } from './snooze-verdict.js'
import { isStillShelfId, NcStillShelf } from './still-shelf.js'
import { NcSummaryAiAnalyst } from './summary/summary-ai.js'
import { NcSummaryCollector } from './summary/summary-collector.js'
import { NcSummaryProducer, type SummaryRunResult } from './summary/summary-producer.js'
import { NcSummaryStore } from './summary/summary-store.js'
import { NcCalendarEventsStore } from './calendar-events/calendar-events-store.js'
import { NcCalendarEventsProducer } from './calendar-events/calendar-events-producer.js'
import { isSyntheticId, type NcTestEventInput, type NcTestEventResult } from './test-event.js'
import { NcTextCatalog } from './text-catalog.js'
import { NcTextCatalogEditor } from './text-catalog-editor.js'
import { NcTextCatalogStore } from './text-catalog-store.js'
import { TimelapseRenderer } from './timelapse/timelapse-renderer.js'
import {
  type TimelapseRunNowInput,
  type TimelapseRunNowResult,
  TimelapseScheduler,
} from './timelapse/timelapse-scheduler.js'
import { TimelapseStore } from './timelapse/timelapse-store.js'
import { type ClosedWindow } from './timelapse/window-bounds.js'
import { AddonUpdateCoalescer } from './update-complete-coalescer.js'
import {
  type NcStateSummaryEnqueued,
  type NcStateSummaryOrigin,
  NcStateSummaryService,
} from './state-summary/state-summary-service.js'
import type { NcStateSummaryTest } from './state-summary/state-summary-test.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { NcZoneOwnerLookup } from './zone-ownership.js'
import { NcRuleHealthMonitor } from './rule-health.js'
import {
  type AliasResolveFailure,
  resolveMediaOwnerId,
  sampledOnce,
} from '../pipeline-analytics/track-alias-resolution.js'
import { evaluateAndEnqueue as runEvaluateAndEnqueue } from './evaluate-and-enqueue.js'
import type { EvaluateAndEnqueueHost, NcBuildEntriesExtras } from './evaluate-and-enqueue.js'
import {
  closeGroupedPass as runCloseGroupedPass,
  snoozedAtClose as runSnoozedAtClose,
  judgeDropped as runJudgeDropped,
  sealGroupedWindow as runSealGroupedWindow,
  closeGroupedWindow as runCloseGroupedWindow,
  memberFates as runMemberFates,
} from './close-grouped-pass.js'
import type {
  CloseGroupedPassHost,
  NcGroupedSnoozeCover,
  NcGroupedCloseResult,
} from './close-grouped-pass.js'
import {
  mintButtons as runMintButtons,
  snoozeButtonLabel as runSnoozeButtonLabel,
} from './mint-buttons.js'
import type { MintButtonsHost } from './mint-buttons.js'
import {
  applyGrantedSnooze as runApplyGrantedSnooze,
  applyGrantedAlarm as runApplyGrantedAlarm,
  applyGrantedArmAnyway as runApplyGrantedArmAnyway,
  applyGrantedBypassInput as runApplyGrantedBypassInput,
  runGrantedAction as runRunGrantedAction,
  applyGrantedAddonUpdate as runApplyGrantedAddonUpdate,
  applyGrantedServerUpdate as runApplyGrantedServerUpdate,
  applyGrantedDetectionVerdict as runApplyGrantedDetectionVerdict,
  announceServerUpdate as runAnnounceServerUpdate,
  announceAddonUpdate as runAnnounceAddonUpdate,
  runGrantedSequence as runRunGrantedSequence,
} from './granted-actions.js'
import type { GrantedActionsHost } from './granted-actions.js'
import { buildProvider as runBuildProvider } from './rules-provider.js'
import type { RulesProviderHost, NcSnoozeCaller } from './rules-provider.js'
import {
  buildEntries as runBuildEntries,
  resolveUserTargets as runResolveUserTargets,
  reportMutedDrop as runReportMutedDrop,
  reportNoMatch as runReportNoMatch,
  reportRuleNonMatch as runReportRuleNonMatch,
} from './build-entries.js'
import type { BuildEntriesHost, NcUserGrant } from './build-entries.js'
import {
  onSystemEvent as runOnSystemEvent,
  admitAlertEpisode as runAdmitAlertEpisode,
  reconcileAlertEpisodes as runReconcileAlertEpisodes,
  reloadRules as runReloadRules,
  announceRuleHealth as runAnnounceRuleHealth,
} from './system-events.js'
import type { SystemEventsHost } from './system-events.js'
import {
  start as runStart,
  runBootBackfill as runRunBootBackfill,
  stop as runStop,
  closeGroupedWindowsOnStop as runCloseGroupedWindowsOnStop,
} from './boot-lifecycle.js'
import type { BootLifecycleHost } from './boot-lifecycle.js'
import {
  alarmActions as runAlarmActions,
  alarmOpenings as runAlarmOpenings,
  alarmLive as runAlarmLive,
  enqueueAlarmAnnouncement as runEnqueueAlarmAnnouncement,
  alarmAnnouncementText as runAlarmAnnouncementText,
  settleCombinedAlarm as runSettleCombinedAlarm,
  enqueuePickerTargets as runEnqueuePickerTargets,
  scheduleAlarmTransition as runScheduleAlarmTransition,
} from './alarm-runtime.js'
import type { AlarmRuntimeHost, NcAlarmAnnouncement } from './alarm-runtime.js'
import {
  observeOccupancy as runObserveOccupancy,
  refreshOccupancyWatch as runRefreshOccupancyWatch,
  observeAudio as runObserveAudio,
  reportAudioWatch as runReportAudioWatch,
  requestOccupancyLook as runRequestOccupancyLook,
  reportOccupancyWatch as runReportOccupancyWatch,
  onOccupancyEdge as runOnOccupancyEdge,
  persistSeededOccupancy as runPersistSeededOccupancy,
  persistOccupancyEdge as runPersistOccupancyEdge,
  persistOccupancyRow as runPersistOccupancyRow,
  occupancyStillOwner as runOccupancyStillOwner,
  ruleWantsOccupancyStill as runRuleWantsOccupancyStill,
  activeOccupancyKeys as runActiveOccupancyKeys,
} from './occupancy-watch.js'
import type { OccupancyWatchHost, NcAudioWatchEntry } from './occupancy-watch.js'
import {
  onObjectEventPersisted as runOnObjectEventPersisted,
  onTrackClosed as runOnTrackClosed,
  onSensorEventPersisted as runOnSensorEventPersisted,
  onSensorEvent as runOnSensorEvent,
  onAudioEventPersisted as runOnAudioEventPersisted,
  onPackageEventPersisted as runOnPackageEventPersisted,
  observeOpeningEvent as runObserveOpeningEvent,
  beginLinkedStills as runBeginLinkedStills,
  reportLinkedCameraMuted as runReportLinkedCameraMuted,
  audioStillOwner as runAudioStillOwner,
  onUnownedSensorEvent as runOnUnownedSensorEvent,
  recognitionOutlookFor as runRecognitionOutlookFor,
  consumeNodeLiveness as runConsumeNodeLiveness,
  readNodeDisplayName as runReadNodeDisplayName,
  announceLiftAfterEvaluation as runAnnounceLiftAfterEvaluation,
} from './live-intake.js'
import type { LiveIntakeHost, NcLinkedStillsRequest, NcSensorEventInput } from './live-intake.js'
import {
  reconcile as runReconcile,
  drainTick as runDrainTick,
  deliverDueDigests as runDeliverDueDigests,
  createSnooze as runCreateSnooze,
  snoozeDecision as runSnoozeDecision,
  snoozeGate as runSnoozeGate,
  recordSnoozeSuppression as runRecordSnoozeSuppression,
  cancelSnooze as runCancelSnooze,
  releaseCooldown as runReleaseCooldown,
  seedCooldowns as runSeedCooldowns,
  hydrateNotifiedTracks as runHydrateNotifiedTracks,
  readBootRecentRows as runReadBootRecentRows,
} from './drain-snooze.js'
import type { DrainSnoozeHost } from './drain-snooze.js'
import {
  dryRun as runDryRun,
  occupancyDryRun as runOccupancyDryRun,
  validateTargetRefs as runValidateTargetRefs,
} from './dry-run.js'
import type { DryRunHost } from './dry-run.js'
import {
  injectTestEvent as runInjectTestEvent,
  captureLiveStill as runCaptureLiveStill,
  pruneSyntheticMedia as runPruneSyntheticMedia,
} from './synthetic-event.js'
import type { SyntheticEventHost, NcTestInjectionDeps } from './synthetic-event.js'
import {
  runRuleActions as runRunRuleActions,
  autoTriggerAlarmPanel as runAutoTriggerAlarmPanel,
  alarmRowsHeard as runAlarmRowsHeard,
  alarmPushVerdict as runAlarmPushVerdict,
  alarmWindowScope as runAlarmWindowScope,
  intrusionLocationsOf as runIntrusionLocationsOf,
  noteGroupedAlarmPhase as runNoteGroupedAlarmPhase,
  groupedAlarmPhaseOf as runGroupedAlarmPhaseOf,
  deviceIdForRuleActions as runDeviceIdForRuleActions,
  evaluateGrouped as runEvaluateGrouped,
  groupedLedger as runGroupedLedger,
} from './rule-action-dispatch.js'
import type { RuleActionDispatchHost } from './rule-action-dispatch.js'
import {
  secureDevicesOnArm as runSecureDevicesOnArm,
  announceArmRefused as runAnnounceArmRefused,
  announceArmCheckFailed as runAnnounceArmCheckFailed,
  setAlarmConfig as runSetAlarmConfig,
  mutateAlarmProfile as runMutateAlarmProfile,
  alarmSensors as runAlarmSensors,
  alarmConfig as runAlarmConfig,
  coverageFor as runCoverageFor,
  alarmSkipReason as runAlarmSkipReason,
  actuateWithAttribution as runActuateWithAttribution,
  pressLocalPanel as runPressLocalPanel,
  observeAlarmOpenings as runObserveAlarmOpenings,
  pruneAlarmInputBypasses as runPruneAlarmInputBypasses,
} from './alarm-arm.js'
import type { AlarmArmHost } from './alarm-arm.js'
import {
  ruleStatusFor as runRuleStatusFor,
  timelapseStatusFor as runTimelapseStatusFor,
} from './live-rule-status.js'
import type { LiveRuleStatusHost, NcTimelapseArtifactLookup } from './live-rule-status.js'
export type { NcTimelapseArtifactLookup } from './live-rule-status.js'

export type { NcTestInjectionDeps } from './synthetic-event.js'

export { RECONCILE_SCAN_LIMIT, RECONCILE_OVERLAP_MS } from './drain-snooze.js'

export type { NcLinkedStillsRequest, NcSensorEventInput } from './live-intake.js'

export type { NcUserGrant } from './build-entries.js'

export type { NcSnoozeCaller } from './rules-provider.js'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './center-deps.js'
import {
  registerDepartureFallback as runRegisterDepartureFallback,
  departureFallbackMedia as runDepartureFallbackMedia,
  departureStillOwner as runDepartureStillOwner,
  reportNoDepartureStill as runReportNoDepartureStill,
} from './departure-fallback.js'
import type { DepartureFallbackHost } from './departure-fallback.js'
import {
  consumeEventAndReport as runConsumeEventAndReport,
  onChain as runOnChain,
  scheduleEvaluation as runScheduleEvaluation,
  deliverUnlessSuperseded as runDeliverUnlessSuperseded,
} from './evaluation-cycle.js'
import type { EvaluationCycleHost } from './evaluation-cycle.js'
import {
  enqueueStateSummary as runEnqueueStateSummary,
  reloadTexts as runReloadTexts,
  hydrateLiveness as runHydrateLiveness,
  reportLivenessDrop as runReportLivenessDrop,
  onDeviceDeleted as runOnDeviceDeleted,
  removeDeviceData as runRemoveDeviceData,
  onAlarmPublish as runOnAlarmPublish,
  reportSystemFilterExclusion as runReportSystemFilterExclusion,
  reportSceneSuppression as runReportSceneSuppression,
} from './boot-hydration.js'
import type { BootHydrationHost } from './boot-hydration.js'

export type {
  NcAlarmPanelPort,
  NcTimelapseRenderPorts,
  NotificationCenterDeps,
} from './center-deps.js'

/** Bound on the sampled "departed track alias resolution failed" memo
 *  (D683 × D691) — the alias-resolution call sites' own shape. */
const NC_DEPARTED_ALIAS_FAILURE_MEMO_MAX = 256

/**
 * What the sustained-state alerts run on when nothing wired the settings in.
 *
 * The SHIPPED DEFAULTS, not "off". A wiring that silently disabled the feature
 * would be indistinguishable from a hub with no low batteries on it, which is
 * the failure mode this whole family exists to end — and the recovery defaults
 * ON because that is what the operator chose.
 *
 * The values are restated rather than imported: `@camstack/types` is external
 * to this addon and the settings schema lives in `pipeline-analytics`, so an
 * import here would tie the centre to its host addon's settings module. The
 * numbers are pinned against that schema by
 * `alerts/__tests__/device-alert-fallback.spec.ts`.
 */
const NC_DEVICE_ALERT_FALLBACK: NcDeviceAlertSettings = {
  batteryLowPercent: 20,
  renotifyMinutes: 720,
  notifyRecovery: true,
}

/** The same constant, exported for the guard that pins it to the form. */
export const NC_DEVICE_ALERT_FALLBACK_FOR_TEST: NcDeviceAlertSettings = NC_DEVICE_ALERT_FALLBACK

export class NotificationCenter implements NcEventConsumer {
  private readonly logger: IScopedLogger
  private readonly rules: NcRuleStore
  private readonly outbox: NcOutbox
  private readonly dispatcher: NcDispatcher
  private readonly deps: NotificationCenterDeps
  private readonly now: () => number
  /** Samples the device-compat guard's "accepted unchecked" WARN per rule. */
  private readonly deviceCompatWarnSampler = new NcDeviceCompatWarnSampler()
  /**
   * Every word this centre can print, in the hub's language.
   *
   * ONE instance, shared by the dispatcher, the timelapse producer, the snooze
   * digest, the alarm announcement and the history projection — so a language
   * change reaches all six at once and none of them can be a sentence behind.
   * Fed by {@link textStore} on boot and on the reload tick.
   */
  private readonly texts = new NcTextCatalog()
  /** The durable `{ language, overrides }` document behind {@link texts}. */
  private readonly textStore: NcTextCatalogStore
  /**
   * The Phase 2 edit surface over {@link textStore} + {@link texts}. Held on
   * EVERY node, exactly like the rule and timelapse stores: the `nc.*` bridge
   * serves the Texts tab from wherever it is asked, and the write it performs
   * lands in the hub's centralized settings store either way.
   */
  private readonly textEditor: NcTextCatalogEditor
  /** Debounced occupancy edge state machine (pure) + its durable confirmed
   *  state. Fed in-process by {@link observeOccupancy} from ZoneAnalytics
   *  snapshots; watched keys are recomputed from the enabled occupancy rules. */
  private readonly occupancyWatcher = new OccupancyWatcher({
    // A key whose class scope the snapshots cannot key on counts nothing, on
    // every frame, forever — a DROPPED branch, and it was silent. The watcher
    // reports it once per key; the line is what turns "my rule never fired"
    // into an answer. `deviceId` tagged, because the question is always asked
    // per camera. The arrow defers the `this.logger` read to call time, which
    // is long after the constructor has assigned it.
    onImpossibleScope: (scope) => {
      this.logger.warn('occupancy key can never count — class is a sub-type, not a macro', {
        tags: { deviceId: scope.deviceId },
        meta: {
          key: scope.key,
          zoneId: scope.zoneId ?? '@frame',
          className: scope.className,
          threshold: scope.threshold,
          macros: [...DETECTION_MACRO_CLASSES].join(','),
        },
      })
    },
  })
  private readonly occupancyStore: OccupancyStore
  /** Rendered watched-occupancy-key set as last logged — the change gate for
   *  {@link reportOccupancyWatch} (it runs on every rule-reload tick). */
  private lastOccupancyWatchReport = ''
  /** Rendered watched-audio-spec set as last logged — the change gate for
   *  {@link reportAudioWatch}. */
  private lastAudioWatchReport = ''
  /**
   * The sustained-sound sampling-window matcher (pure). Fed in-process by
   * {@link observeAudio} from the pipeline's audio inference frames; watched
   * specs are recomputed from the enabled rules that declare an `audio`
   * condition. Deliberately NOT persisted — a window is at most
   * `samplingSeconds` of recent sound, and re-opening it after a restart costs
   * exactly that, so there is nothing worth a durable row.
   */
  private readonly audioWatcher = new AudioWatcher()
  /** Snooze windows + what they hid. Mirrored into RAM; the dispatcher's gate
   *  reads it with no I/O, the drain tick refreshes it. */
  private readonly snoozes: NcSnoozeStore
  /** The permanent per-camera notification off switch — see `device-mute-store.ts`. */
  private readonly deviceMutes: NcDeviceMuteStore
  /** Shared action sequences rules and buttons bind to by id. */
  private readonly sequences: NcSequenceStore
  /** The durable episode rows behind the sustained-state alerts. */
  private readonly alertStore: NcAlertStore
  /** Battery band → notification, and the reminder sweep. */
  private readonly deviceAlerts: NcDeviceAlerts
  /** The scheduled STATE SUMMARY of system rules (D647): its ledgers and its tick. */
  private readonly stateSummary: NcStateSummaryService
  /** Every `server-updated` heard, so a stale `node-updating` is not sent after it (D723). */
  private readonly updateLandings = new NcUpdateLandings()
  private readonly plannedUpdates = new NcPlannedUpdateWindow()
  /** States the `deviceState` rule gate reads. Refreshed on the reload tick;
   *  read with no I/O on the persist hook. */
  private readonly deviceStates: NcDeviceStateCache
  /** Scene verdicts + latches the `scene` rule gate reads. Same contract as
   *  {@link deviceStates}: refreshed on the reload tick and on the provider's
   *  in-process edge tap, read with no I/O on the persist hook (D49). */
  private readonly sceneStates: NcSceneStateCache
  /**
   * The last scene-gate answer REPORTED per rule, so the suppression line is
   * written on CHANGE rather than on every event.
   *
   * A branch that drops work silently must log it, and a gate that logged on
   * every detection on a busy camera would be a line nobody reads — which is
   * the same silence by a different route.
   */
  private readonly sceneGateReported = new Map<string, string>()
  /** The watched scene id set, as last REPORTED — so the line is written when it
   *  changes and not on every reload tick. `null` = never reported. */
  private sceneWatchSignature: string | null = null
  /** WHO each device id is (name + type). The system-event intake reads it with
   *  no I/O; the reload tick refreshes it — see `device-directory.ts`. */
  private readonly deviceDirectory: NcDeviceDirectory
  /** WHICH ZONES each camera owns, so a multi-camera rule scopes its `zones`
   *  condition per camera. Same contract as the two above: refreshed on the
   *  reload tick, read with no I/O inside the engine — see
   *  `zone-owner-cache.ts` / `zone-ownership.ts`. */
  private readonly zoneOwners: NcZoneOwnershipCache
  /** Runs a matched rule's action sequences. Null when no actuator is wired. */
  private readonly actionRunner: NcRuleActionRunner | null
  /** Domain action targets read from the registry (D983); null without a directory. */
  private readonly actionTargets: ActionTargetResolver | null
  /** Grants behind the tap-through buttons. In-process and single-use — read
   *  `action-token.ts` before assuming anything about what a tap proves. */
  private readonly actionTokens = new NcActionTokenRegistry()
  /**
   * The scheduled-timelapse rule set. Held on EVERY node so the bridge actions
   * can serve CRUD from wherever they are asked (same reasoning as the rule
   * store); only the hub, with `deps.timelapse` wired, gets a scheduler.
   */
  private readonly timelapseRules: TimelapseStore
  private readonly timelapseScheduler: TimelapseScheduler | null = null
  /**
   * The multi-camera digest rule set, and the producer that runs it. Held on
   * EVERY node for the same reason as {@link timelapseRules}: the bridge
   * actions serve CRUD from wherever they are asked. Only the hub, with
   * `deps.summary` wired, gets a producer.
   */
  private readonly summaryRules: NcSummaryStore
  private readonly summaryProducer: NcSummaryProducer | null = null
  /** Calendar-events digest rules + producer (hub-only producer). */
  private readonly calendarEventsRules: NcCalendarEventsStore
  private readonly calendarEventsProducer: NcCalendarEventsProducer | null = null
  /**
   * What the deleted-device / deleted-target prune did, and why — its
   * disable-once guard and the source of both UIs' banner. Loaded on EVERY
   * node (`nc.listPrunes` is served wherever it is asked); written only by the
   * evaluating one.
   */
  private readonly pruneLedger: NcPruneLedger
  private readonly verdicts: NcDetectionVerdictLedger
  /** D905: which rules cannot work, announced once per distinct reason. */
  private readonly ruleHealth = new NcRuleHealthMonitor()
  /** The prune itself — see `device-prune-runner.ts`. */
  private readonly pruner: NcDeletedSubjectPruner
  /**
   * The AI section of the ORDINARY rules, and the analyst that reads it.
   *
   * The store is held on EVERY node for the same reason {@link ruleStore} is —
   * the bridge actions serve CRUD from wherever they are asked. The analyst is
   * built only where a vision LLM is reachable, which is the same condition
   * {@link confirmGate} is built on: a node that can judge a notification can
   * also describe one, and a node that cannot does neither.
   */
  private readonly ruleAi: NcRuleAiStore
  private readonly ruleAiAnalyst: NcRuleAiAnalyst | null
  /** Held so its counters ride the start line — a fail-open that nobody can
   *  see is a feature nobody can tell is broken. */
  private readonly summaryAi: NcSummaryAiAnalyst | null = null
  /**
   * What the cameras are doing right now, for the digest windows.
   *
   * Constructed unconditionally and fed from the intake hooks even on a node
   * with no producer: the two `observe*` calls are a map write each, and a
   * collector that only started observing when a producer existed would give
   * the first window after a wiring change an empty barrier.
   */
  private readonly summaryCollector = new NcSummaryCollector()
  /** True when ≥1 enabled `device-event` rule declares an occupancy condition —
   *  the watcher is idle (zero per-frame cost) otherwise. */
  private occupancyEnabled = false
  /** True when ≥1 enabled `immediate` rule declares an `audio` condition. No
   *  such rule exists yet by design (the editors ship with P2/P3), so this is
   *  false on every live hub and {@link observeAudio} costs one boolean read
   *  per audio frame. */
  private audioEnabled = false
  /** The panel this node owns, or null. See {@link NcAlarmPanelPort}. */
  private alarmPanel: NcAlarmPanelPort | null = null
  /** The live view's read, logged on change only — see `alarm-live-read-log.ts`. */
  private readonly alarmLiveReadLog = new NcAlarmLiveReadLog()
  private readonly alarmSensorsReadLog = new NcAlarmSensorsReadLog()
  /**
   * The words the panel answers the `deviceState` gate with — its state, plus
   * the armed mode a `pending`/`triggered` belongs to (D630). Refreshed on
   * every publish, next to the one-word mirror; the lookup only uses them
   * while the mirror agrees on the state (`panelAwareLookup`).
   */
  private panelGateWords: NcPanelGateWords | null = null
  /** In-memory cooldown map — seeded from persisted outbox rows on start. */
  private readonly lastFiredAt = new Map<string, number>()
  /** D706: the alarm phase each grouped alarm rule's track last matched under (bounded). */
  private readonly groupedAlarmPhases = new Map<
    string,
    { readonly phase: NcAlarmMatchPhase; readonly at: number }
  >()
  /** The audit record behind a future timeline card. */
  private readonly groupStore: NcGroupStore
  /**
   * D692: the GROUPED windows of "immediate, grouped" rules. Every call into it runs on
   * {@link evalChain} (C13) — object events, the tracker hooks, track closes, the sweep.
   */
  private readonly grouped: NcGroupedDelivery
  /**
   * D692 §3.5: the tracks a grouped rule already notified (once per track per rule),
   * filled when a close inserted its row. RAM; Task 10 re-hydrates it at boot.
   */
  private readonly notifiedTracks = new NcNotifiedTracks(() => this.now())
  /**
   * D692 C10: the members a close judged unrecognised for a rule — their later events do
   * not re-open a window of that rule while still unrecognised. RAM, for the track's life.
   */
  private readonly judgedTracks = new NcJudgedTracks(() => this.now())
  /** True once the boot's notified-set hydration READ the outbox (review T10 LOW-A). */
  private notifiedHydrated = false
  /** A grouped sweep is already waiting on the chain (review T8 L-3). */
  private groupedSweepQueued = false
  /** The AI confirm gate, or null when this node has no vision LLM wired. */
  private readonly confirmGate: NcConfirmGate | null
  /**
   * The live snapshot a synthetic injection took, held for as long as the
   * outbox may still be retrying its rows. In RAM and only in RAM: a test that
   * left a media blob behind would be a test that persisted something, which
   * is the one thing the synthetic producer promises not to do.
   */
  private readonly syntheticMedia = new Map<
    string,
    { readonly files: readonly MediaFileBytes[]; readonly expiresAt: number }
  >()
  /**
   * The photograph a notification carries when the subject it is about is an
   * ABSENCE — a sound that owns no frame, an emptied occupancy scope that owns
   * no member. See `still-shelf.ts`. Null when this wiring has no snapshot cap,
   * which leaves those notifications text-only rather than broken.
   */
  private readonly stills: NcStillShelf | null
  /** Departed tracks whose ring still stands in when they resolve no media
   *  (D691 review M3), keyed by track id. */
  private readonly departureFallbacks = new Map<
    string,
    {
      readonly deviceId: number
      readonly atMs: number
      readonly expiresAt: number
      readonly ownerId: string | null
    }
  >()
  /** Cameras whose early-look ask has failed since its last success — the
   *  warn is said once per camera, not once per armed flip (review L1). */
  private readonly occupancyLookFailing = new Set<number>()
  /**
   * The photographs a SENSOR notification carries of every camera linking the
   * sensor (`linked-stills.ts`, ADR 0632). Null when this wiring has no
   * snapshot cap — such a notification then ships text-only.
   */
  private readonly linkedStills: NcLinkedStillShelf | null
  /**
   * Rate limit for the "matched NO rule" report — see `reportNoMatch`. Keyed by
   * {@link noMatchReportKey} (device + subject kind + class set), NOT by device:
   * a person's verdict must never consume the window a cat's verdict needed on
   * the same camera ([D390]).
   */
  private readonly lastNoMatchReportAt = new Map<string, number>()
  private readonly noMatchSuppressed = new Map<string, number>()
  /** Same rate-limit pair, same key, for the per-camera mute drop — see `reportMutedDrop`. */
  private readonly lastMutedReportAt = new Map<string, number>()
  private readonly mutedSuppressed = new Map<string, number>()
  /** Same pair, keyed by CAMERA, for a muted camera left out of a linked set —
   *  see `reportLinkedCameraMuted`. */
  private readonly lastLinkedMutedReportAt = new Map<number, number>()
  private readonly linkedMutedSuppressed = new Map<number, number>()
  /**
   * RAM-only same-edge dedup for the families the durable ledger does NOT
   * govern — stream health and the operator's disable switch. Both are already
   * gated where they are produced (a stream flip by its `reason`, the switch by
   * being emitted only on a transition of the flag), so a restart re-announces
   * neither and there is nothing durable to remember.
   */
  private readonly lastSystemLiveness = new Map<string, string>()
  /**
   * The DURABLE last-accepted liveness per subject — the memory whose absence
   * made a hub restart look like every camera coming back at once. See
   * `liveness-ledger.ts`; the rule is the occupancy one: the first observation
   * seeds, only a real flip notifies.
   */
  private readonly liveness: NcLivenessLedger
  /**
   * Which alert episodes were already notified (`alert-episode-ledger.ts`): the
   * alert centre sends nothing of its own, so this is what makes its bus
   * announcements and the reconcile from the alerts store safe to run together.
   */
  private readonly alertEpisodes: NcAlertEpisodeLedger
  /** The boot load of {@link alertEpisodes} has been ATTEMPTED (bus edges before it are the reconcile's). */
  private alertEpisodesLoaded = false
  private alertReconcileTimer: ReturnType<typeof setInterval> | null = null
  /** Batches `addon.updated` (version-bearing) into one notification per 30 s. */
  private readonly addonUpdates: AddonUpdateCoalescer
  /** Trailing 5 min hold-off for camera liveness flaps (plugin restart). */
  private readonly livenessHoldoff: DeviceLivenessHoldoff
  /** Trailing 60 s hold-off for node liveness (reconnect storms). */
  private readonly nodeLivenessHoldoff: DeviceLivenessHoldoff
  /**
   * Serialized evaluation chain. The persist hooks are fire-and-forget for
   * the frame path, but two concurrent evaluations of the same device
   * would BOTH pass the cooldown check before either records its fire —
   * so every evaluation (hooks + reconcile) runs through this single
   * promise chain, preserving the persist order.
   */
  private evalChain: Promise<void> = Promise.resolve()
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private reloadTimer: ReturnType<typeof setInterval> | null = null
  private drainTicks = 0
  private evaluationActive = false
  /**
   * The armed boot back-fill — see {@link runBootBackfill}. Held so
   * {@link whenHydrated} can be awaited by an operator surface or a test that
   * needs the durable state, and so nothing re-arms it.
   */
  private hydration: Promise<void> | null = null
  /**
   * The instant `start()` opened the intake. Everything persisted from here on
   * is evaluated live by THIS process, which is what bounds the boot reconcile
   * at its late end — see {@link reconcile}.
   */
  private intakeOpenedAt = 0
  private mintButtonsHost(): MintButtonsHost {
    const self = this
    return {
      get actionRunner() {
        return self.actionRunner
      },
      get actionTokens() {
        return self.actionTokens
      },
      get alarmPanel() {
        return self.alarmPanel
      },
      get deps() {
        return self.deps
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      get rules() {
        return self.rules
      },
      get sequenceActionsOf() {
        return self.sequenceActionsOf
      },
      get sequences() {
        return self.sequences
      },
      snoozeButtonLabel: (minutes) => self.snoozeButtonLabel(minutes),
      get texts() {
        return self.texts
      },
    }
  }

  async mintButtons(input: NcMintButtonsInput): Promise<readonly NotificationAction[]> {
    return runMintButtons(this.mintButtonsHost(), input)
  }

  private snoozeButtonLabel(minutes: number): string {
    return runSnoozeButtonLabel(this.mintButtonsHost(), minutes)
  }
  private grantedActionsHost(): GrantedActionsHost {
    const self = this
    return {
      get actionRunner() {
        return self.actionRunner
      },
      actuateWithAttribution: (input) => self.actuateWithAttribution(input),
      get alarmPanel() {
        return self.alarmPanel
      },
      announceAddonUpdate: (grant, sentence, vars, report, count) =>
        self.announceAddonUpdate(grant, sentence, vars, report, count),
      announceServerUpdate: (grant, sentence, vars) =>
        self.announceServerUpdate(grant, sentence, vars),
      applyGrantedAddonUpdate: (grant) => self.applyGrantedAddonUpdate(grant),
      applyGrantedAlarm: (grant) => self.applyGrantedAlarm(grant),
      applyGrantedArmAnyway: (panel, grant) => self.applyGrantedArmAnyway(panel, grant),
      applyGrantedBypassInput: (panel, grant) => self.applyGrantedBypassInput(panel, grant),
      applyGrantedServerUpdate: (grant) => self.applyGrantedServerUpdate(grant),
      applyGrantedDetectionVerdict: (grant) => self.applyGrantedDetectionVerdict(grant),
      now: self.now,
      get verdicts() {
        return self.verdicts
      },
      applyGrantedSnooze: (grant) => self.applyGrantedSnooze(grant),
      get deps() {
        return self.deps
      },
      get dispatcher() {
        return self.dispatcher
      },
      get logger() {
        return self.logger
      },
      get rules() {
        return self.rules
      },
      runGrantedSequence: (grant) => self.runGrantedSequence(grant),
      get sequenceActionsOf() {
        return self.sequenceActionsOf
      },
      get sequences() {
        return self.sequences
      },
      get snoozes() {
        return self.snoozes
      },
      get texts() {
        return self.texts
      },
    }
  }

  private async applyGrantedSnooze(grant: NcSnoozeGrant): Promise<void> {
    return runApplyGrantedSnooze(this.grantedActionsHost(), grant)
  }

  private async applyGrantedAlarm(grant: NcAlarmGrant): Promise<void> {
    return runApplyGrantedAlarm(this.grantedActionsHost(), grant)
  }

  private async applyGrantedArmAnyway(
    panel: NcAlarmPanelPort,
    grant: NcAlarmArmAnywayGrant,
  ): Promise<void> {
    return runApplyGrantedArmAnyway(this.grantedActionsHost(), panel, grant)
  }

  private async applyGrantedBypassInput(
    panel: NcAlarmPanelPort,
    grant: NcAlarmBypassInputGrant,
  ): Promise<void> {
    return runApplyGrantedBypassInput(this.grantedActionsHost(), panel, grant)
  }

  /** The registry the action plane claims against. */
  get actionTokenRegistry(): NcActionTokenRegistry {
    return this.actionTokens
  }

  async runGrantedAction(grant: NcActionGrant): Promise<void> {
    return runRunGrantedAction(this.grantedActionsHost(), grant)
  }

  private async applyGrantedAddonUpdate(grant: NcAddonUpdateGrant): Promise<void> {
    return runApplyGrantedAddonUpdate(this.grantedActionsHost(), grant)
  }

  private async applyGrantedDetectionVerdict(grant: NcDetectionVerdictGrant): Promise<void> {
    return runApplyGrantedDetectionVerdict(this.grantedActionsHost(), grant)
  }

  private async applyGrantedServerUpdate(grant: NcServerUpdateGrant): Promise<void> {
    return runApplyGrantedServerUpdate(this.grantedActionsHost(), grant)
  }

  private async announceServerUpdate(
    grant: NcServerUpdateGrant,
    sentence: 'started' | 'restarting' | 'uptodate' | 'unknown' | 'failed',
    vars: Readonly<Record<string, string>>,
  ): Promise<void> {
    return runAnnounceServerUpdate(this.grantedActionsHost(), grant, sentence, vars)
  }

  private async announceAddonUpdate(
    grant: NcAddonUpdateGrant,
    sentence: 'started' | 'uptodate' | 'done' | 'partial' | 'unknown',
    vars: Readonly<Record<string, string>>,
    report?: NcAddonUpdateReport,
    count?: number,
  ): Promise<void> {
    return runAnnounceAddonUpdate(this.grantedActionsHost(), grant, sentence, vars, report, count)
  }
  private async runGrantedSequence(grant: NcSequenceGrant): Promise<void> {
    return runRunGrantedSequence(this.grantedActionsHost(), grant)
  }

  constructor(deps: NotificationCenterDeps) {
    this.deps = deps
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    const durableStore = { records: deps.records }
    const getSnapshot = deps.getSnapshot
    this.stills =
      getSnapshot !== undefined
        ? new NcStillShelf({
            getSnapshot,
            ...(deps.getPastStill !== undefined ? { getPastStill: deps.getPastStill } : {}),
            logger: this.logger.child('still-shelf'),
            now: this.now,
          })
        : null
    // `isOnline` reads `deviceDirectory` at CALL time (it is built below), and
    // nothing calls it before the first sensor event.
    this.linkedStills =
      getSnapshot !== undefined
        ? new NcLinkedStillShelf({
            getSnapshot,
            ...(deps.getSnapshotState !== undefined
              ? { getSnapshotState: deps.getSnapshotState }
              : {}),
            ...(deps.getFrameCapturedAt !== undefined
              ? { getFrameCapturedAt: deps.getFrameCapturedAt }
              : {}),
            isOnline: (id) => this.deviceDirectory.get(id)?.online,
            logger: this.logger.child('linked-stills'),
            now: this.now,
          })
        : null
    this.rules = NcRuleStore.of(
      deps.records,
      this.logger.child('rules'),
      undefined,
      undefined,
      deps.identityIdsByName,
    )
    this.textStore = NcTextCatalogStore.of(deps.records, this.logger.child('texts'))
    this.textEditor = new NcTextCatalogEditor({
      store: this.textStore,
      // The SAME instance every producer reads — that is what makes a save take
      // effect on the next notification instead of the next reload tick.
      catalog: this.texts,
      logger: this.logger.child('texts'),
    })
    this.occupancyStore = new OccupancyStore({
      ...durableStore,
      logger: this.logger.child('occupancy'),
    })
    this.groupStore = new NcGroupStore({
      ...durableStore,
      logger: this.logger.child('groups'),
    })
    this.grouped = new NcGroupedDelivery({
      logger: this.logger.child('grouped'),
      now: this.now,
      evaluate: (rule, subject, relax) => this.evaluateGrouped(rule, subject, relax),
      outlook: (query) => this.recognitionOutlookFor(query),
      getRule: (ruleId) => this.rules.get(ruleId),
      ...(deps.resolveTrackAliasSync !== undefined
        ? { resolveTrackAliasSync: deps.resolveTrackAliasSync }
        : {}),
      ...(deps.resolveTrackAlias !== undefined
        ? { resolveTrackAlias: deps.resolveTrackAlias }
        : {}),
      runActions: (rule, subject, controls) => {
        const phase = this.runRuleActions(rule, subject, 'object-event', controls)
        this.noteGroupedAlarmPhase(rule, subject, phase)
      },
      cooldown: (rule, subject, now) => {
        const key = cooldownKey(rule, subject)
        return { key, cooling: isCoolingDown(rule, this.lastFiredAt.get(key), now) }
      },
      ledger: this.groupedLedger(),
      close: (window, reason) => this.closeGroupedWindow(window, reason),
      // D706: an alarm rule's window is the RULE's while the alarm is in its entry delay or
      // has triggered — one intrusion push names every camera's location in its time window.
      windowScope: (rule) => this.alarmWindowScope(rule),
      // Spec §5: the record is written at OPEN, best-effort and off the chain.
      record: (window) => {
        void this.groupStore.recordOpen(window)
      },
    })
    this.liveness = new NcLivenessLedger({
      ...durableStore,
      logger: this.logger.child('liveness'),
    })
    this.alertEpisodes = new NcAlertEpisodeLedger({
      ...durableStore,
      logger: this.logger.child('alert-episodes'),
    })
    this.addonUpdates = new AddonUpdateCoalescer((updates) => {
      const incoming = incomingFromAddonUpdates(
        {
          eventId: `addon-updated:${updates.map((u) => u.packageName).join(',')}`,
          timestamp: this.now(),
          category: 'addon.updated',
          data: { packages: updates },
        },
        updates,
      )
      if (incoming !== null) this.consumeEvent(incoming)
    })
    this.livenessHoldoff = new DeviceLivenessHoldoff((event) => this.consumeEvent(event), {
      // Production: 5 min. Vitest: 0 so existing suites keep asserting
      // immediate flips. An explicit `livenessHoldoffMs` always wins.
      delayMs: deps.livenessHoldoffMs ?? (process.env.VITEST ? 0 : DEVICE_LIVENESS_HOLDOFF_MS),
    })
    this.nodeLivenessHoldoff = new DeviceLivenessHoldoff(
      (event, timing) => this.consumeNodeLiveness(event, timing),
      {
        delayMs: deps.nodeLivenessHoldoffMs ?? (process.env.VITEST ? 0 : NODE_LIVENESS_HOLDOFF_MS),
      },
    )
    const targets =
      deps.actionTargetDirectory !== undefined
        ? new ActionTargetResolver(deps.actionTargetDirectory, this.logger.child('actions'))
        : null
    this.actionTargets = targets
    this.actionRunner =
      deps.actuate !== undefined && deps.isCapDeviceScoped !== undefined
        ? new NcRuleActionRunner({
            logger: this.logger.child('actions'),
            actuate: (input) => this.actuateWithAttribution(input),
            ...(targets !== null
              ? {
                  resolveTarget: (target, actionId, owner) =>
                    targets.resolve(target, actionId, {}, { actionId, owner }),
                }
              : {}),
            isDeviceScoped: deps.isCapDeviceScoped,
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          })
        : null
    this.deviceStates = new NcDeviceStateCache({
      logger: this.logger.child('device-state'),
      readStates:
        deps.readDeviceStates ?? (async (): Promise<ReadonlyMap<number, string>> => new Map()),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.sceneStates = new NcSceneStateCache({
      logger: this.logger.child('scene-state'),
      // No wiring = a permanently cold mirror = no scene-gated rule ever fires.
      // Fail closed; see the dep's docblock.
      readScenes: deps.readSceneStates ?? ((): readonly NcSceneObservation[] => []),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.deviceDirectory = new NcDeviceDirectory({
      logger: this.logger.child('device-directory'),
      listDevices:
        deps.listDeviceIdentities ??
        (async (): Promise<readonly NcDeviceIdentity[]> => {
          // No wiring = an empty directory = no device event is ever worded as
          // a camera. Fail closed; see the dep's docblock.
          return []
        }),
    })
    this.zoneOwners = new NcZoneOwnershipCache({
      logger: this.logger.child('zone-ownership'),
      readZoneIds:
        deps.readDeviceZoneIds ??
        // No wiring = no ownership = the flat, pre-scoping verdict everywhere.
        (async (): Promise<ReadonlyMap<number, readonly string[]>> => new Map()),
    })
    this.snoozes = new NcSnoozeStore({
      ...durableStore,
      logger: this.logger.child('snooze'),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.deviceMutes = new NcDeviceMuteStore({
      settings: deps.deviceSettings,
      logger: this.logger.child('device-mute'),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.sequences = NcSequenceStore.of(deps.records, this.logger.child('sequences'), deps.now)
    this.alertStore = new NcAlertStore({
      ...durableStore,
      logger: this.logger.child('device-alerts'),
    })
    this.deviceAlerts = new NcDeviceAlerts({
      // The ONE door. A reminder re-enters through `consumeEvent` exactly as
      // the first notification did, so the per-camera mute, the snooze, the
      // rule conditions and the rule's schedule all still apply to it.
      //
      // It is the REPORTING form of the door, because a raise that no rule
      // matched must stay pending rather than be recorded as announced
      // (D636) — the live `battery:3615` reached reminder r45 without one
      // notification ever leaving the hub.
      emit: async (event) => {
        const report = await this.consumeEventAndReport(event)
        return report.outcomes.some((outcome) => outcome.matched)
      },
      rulesVersion: () => this.rulesFingerprint(),
      // Each RULE's consumable threshold (D642), from the RAM rule mirror —
      // `null` until the mirror has been read once, so a boot race judges
      // nothing rather than judging against an empty rule set (D49).
      consumableThresholds: () =>
        this.rules.isLoaded() ? consumableThresholdCensus(this.rules.list()) : null,
      settings: () => this.deviceAlertSettings(),
      lookup: (deviceId) => this.deviceDirectory.get(deviceId),
      rows: this.alertStore.port(),
      logger: this.logger.child('device-alerts'),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.stateSummary = new NcStateSummaryService({
      ...durableStore,
      logger: this.logger.child('state-summary'),
      now: () => this.now(),
      rules: () => this.rules.listEnabled('system-event'),
      alerts: () => this.deviceAlerts.openEpisodes(),
      liveness: () => (this.liveness.hasAnswered() ? this.liveness.snapshot() : null),
      lookup: (deviceId) => this.deviceDirectory.get(deviceId),
      devicesAnswered: () => this.deviceDirectory.isWarm(),
      ...(deps.readNodeDirectory !== undefined ? { readNodes: deps.readNodeDirectory } : {}),
      ...(deps.readRunnerStates !== undefined ? { readRunners: deps.readRunnerStates } : {}),
      // The instant path's hold-off: a device offline for less than it has not
      // been announced, and is not in a summary either.
      livenessHoldoffMs: deps.livenessHoldoffMs ?? DEVICE_LIVENESS_HOLDOFF_MS,
      isMuted: (deviceId) => this.deviceMutes.isMuted(deviceId),
      texts: () => this.texts,
      enqueue: (rule, subject, origin) => this.enqueueStateSummary(rule, subject, origin),
    })
    this.confirmGate =
      deps.generateVision !== undefined
        ? new NcConfirmGate({
            logger: this.logger.child('confirm'),
            generateVision: deps.generateVision,
            ...(deps.cancelVision !== undefined ? { cancelVision: deps.cancelVision } : {}),
            downscale: downscaleJpeg,
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          })
        : null
    const confirmGate = this.confirmGate
    this.ruleAi = NcRuleAiStore.of(deps.records, this.logger.child('rule-ai'), deps.now)
    // THE NARRATION ANALYST — same seam, same condition as the confirm gate.
    // Absent `generateVision` is the feature switched off cleanly: no analyst
    // is constructed, `ruleAi` never reaches the dispatcher, and a rule that
    // asks for a sentence delivers exactly as it did before.
    this.ruleAiAnalyst =
      deps.generateVision === undefined
        ? null
        : new NcRuleAiAnalyst({
            logger: this.logger.child('rule-ai'),
            generateVision: deps.generateVision,
            ...(deps.cancelVision !== undefined ? { cancelVision: deps.cancelVision } : {}),
            downscale: downscaleJpeg,
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          })
    const ruleAiAnalyst = this.ruleAiAnalyst
    this.dispatcher = new NcDispatcher({
      ...deps.dispatcher,
      logger: this.logger.child('dispatch'),
      texts: this.texts,
      // The ONE place a synthetic event differs from a real one downstream —
      // and it is a LOOKUP, not a branch in the dispatcher. A synthetic record
      // has no row in the media store, so its live snapshot is served from RAM
      // under the same `(ownerKind, ownerId)` contract; every ladder, every
      // policy and every degrade decision above it is the production code
      // running on production inputs. Non-synthetic ids never reach the map.
      //
      // The STILL SHELF rides the same seam, and for the same reason: a sound
      // owns no frame and an emptied occupancy scope owns no member, so their
      // picture is a photograph held in RAM rather than a row in the media store
      // (`still-shelf.ts`). Two RAM substrates, ONE contract — the dispatcher
      // has a branch for neither, and none per trigger.
      getMediaForOwner: async (ownerKind, ownerId, eventScope) => {
        const held = isSyntheticId(ownerId) ? this.syntheticMedia.get(ownerId) : undefined
        if (held !== undefined) return held.files
        const shelved = isStillShelfId(ownerId) ? this.stills?.get(ownerId) : undefined
        if (shelved !== undefined) return shelved
        const linked = isLinkedStillId(ownerId) ? this.linkedStills?.get(ownerId) : undefined
        if (linked !== undefined) return linked
        // A DEPARTED track (D691) is read through the alias store first
        // (D683): fused away, its picture is its survivor's — the ring still
        // below is only for a subject nobody owns.
        const departed = ownerKind === 'track' && this.departureFallbacks.has(ownerId)
        const owner = departed ? await this.resolveDepartedTrack(ownerId) : ownerId
        const files = await deps.dispatcher.getMediaForOwner(ownerKind, owner, eventScope)
        if (files.length > 0 || !departed) return files
        // A departed track that owns nothing: its ring still (D691 review M3).
        return this.departureFallbackMedia(ownerId) ?? files
      },
      // ONE clock. The snooze gate compares a window against the instant the
      // dispatcher stamps, and a window created on the center's clock but
      // judged on `Date.now()` is a window that never matches — silently, and
      // only where the two differ.
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      // How much history THIS camera's ring holds — the same derivation the
      // broker is served through `getClipRetentionAsks`, read locally so the
      // "can the ring still serve this moment" decision and the retention that
      // decides it can never be two different numbers again (they were: 25 here
      // against 60 in the broker).
      ringRetentionSecFor: (deviceId) => clipRetentionSecFor(this.clipRetentionAsks(), deviceId),
      // Send-time per-target opt-out (rule.disabledTargetIds), read from the
      // local rule store — a benign skip, honored for admin AND personal rules.
      isRuleTargetDisabled: (ruleId, targetId) => this.rules.isRuleTargetDisabled(ruleId, targetId),
      snoozeGate: (input) => this.snoozeGate(input),
      // AI CONFIRM — only when a vision LLM is actually reachable from here.
      ...(confirmGate !== null
        ? {
            confirmGate: (input) => confirmGate.judge(input),
            confirmStats: () => confirmGate.stats(),
          }
        : {}),
      // AI NARRATION — on the same terms, and never a suppression.
      ...(ruleAiAnalyst !== null
        ? {
            ruleAi: (input) => ruleAiAnalyst.analyse(input),
            ruleAiStats: () => ruleAiAnalyst.stats(),
          }
        : {}),
      releaseCooldown: (input) => this.releaseCooldown(input),
      // Default tap target bases — the public endpoint ladder the artifact
      // plane uses, and the notification-taps role, passed through from the
      // addon wiring.
      ...(deps.dispatcher.publicUrlBase !== undefined
        ? { publicUrlBase: deps.dispatcher.publicUrlBase }
        : {}),
      ...(deps.dispatcher.tapBase !== undefined ? { tapBase: deps.dispatcher.tapBase } : {}),
    })
    this.outbox = new NcOutbox({
      ...durableStore,
      logger: this.logger.child('outbox'),
      deliver: (entry) => this.deliverUnlessSuperseded(entry),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    this.timelapseRules = TimelapseStore.of(deps.records, this.logger.child('timelapse'), deps.now)
    const timelapsePorts = deps.timelapse
    if (timelapsePorts !== undefined) {
      const logger = this.logger.child('timelapse')
      const renderer = new TimelapseRenderer({
        ...timelapsePorts,
        logger,
        now: this.now,
        // A real wait, deliberately: the export renders in another process on
        // (possibly) another node, and polling it in a tight loop would spend
        // the hub's CPU asking a question whose answer takes minutes.
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })
      this.timelapseScheduler = new TimelapseScheduler({
        logger,
        now: this.now,
        texts: this.texts,
        store: this.timelapseRules,
        render: (request) => renderer.render(request),
        // The SAME durable queue a detection rule uses — the operator's
        // constraint, and the reason there is no timelapse send path.
        enqueue: (rows) => this.outbox.enqueue(rows),
        getDeviceName: (deviceId) => deps.dispatcher.getDeviceName(deviceId),
      })
    }
    this.summaryRules = NcSummaryStore.of(deps.records, this.logger.child('summary'), deps.now)
    this.calendarEventsRules = NcCalendarEventsStore.of(
      deps.records,
      this.logger.child('calendar-events'),
      deps.now,
    )
    this.verdicts = new NcDetectionVerdictLedger({
      ...durableStore,
      logger: this.logger.child('detection-verdicts'),
    })
    this.pruneLedger = new NcPruneLedger({
      ...durableStore,
      logger: this.logger.child('device-prune'),
    })
    this.pruner = new NcDeletedSubjectPruner({
      logger: this.logger.child('device-prune'),
      now: this.now,
      ledger: this.pruneLedger,
      rules: this.rules,
      timelapse: this.timelapseRules,
      summary: this.summaryRules,
      mutes: this.deviceMutes,
      alarm: () => this.alarmPanel,
      // Battery and consumable rows of a deleted device go with it (D636).
      // …and so do its open system states (D647's ledger).
      alerts: {
        deviceIds: () => [
          ...new Set([...this.deviceAlerts.deviceIds(), ...this.stateSummary.ledger.deviceIds()]),
        ],
        forget: async (deviceId) =>
          (await this.deviceAlerts.forget(deviceId)) +
          this.stateSummary.ledger.forgetDevice(deviceId),
      },
      directory: this.deviceDirectory,
      isDeviceDeleted: deps.isDeviceDeleted,
      targetCatalog: () => this.dispatcher.catalogSnapshot(),
    })
    const summaryPorts = deps.summary
    if (summaryPorts !== undefined) {
      // THE AI PASS (#35 P2). Built on the SAME vision seam the confirm gate
      // rides, so a node that can judge a notification can also describe a
      // digest — and a node that cannot does neither, rather than one of the
      // two. Absent leaves `analyseAi` unset and the producer delivers P1.
      const visionForSummary = deps.generateVision
      const summaryAi =
        visionForSummary === undefined
          ? null
          : new NcSummaryAiAnalyst({
              logger: this.logger.child('summary-ai'),
              generateVision: visionForSummary,
              ...(deps.cancelVision !== undefined ? { cancelVision: deps.cancelVision } : {}),
              downscale: downscaleJpeg,
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            })
      this.summaryAi = summaryAi
      this.summaryProducer = new NcSummaryProducer({
        ...summaryPorts,
        logger: this.logger.child('summary'),
        now: this.now,
        texts: this.texts,
        store: this.summaryRules,
        collector: this.summaryCollector,
        ...(summaryAi !== null ? { analyseAi: (input) => summaryAi.analyse(input) } : {}),
        // The SAME durable queue a detection rule uses — the operator's
        // constraint, and the reason there is no summary send path.
        enqueue: (rows) => this.outbox.enqueue(rows),
        getDeviceName: (deviceId) => deps.dispatcher.getDeviceName(deviceId),
        // WHERE each camera is — the AI roster's location label. The SAME dep
        // the dispatcher's narration pass reads, so the digest and an ordinary
        // rule can never disagree about where a camera is. Optional all the
        // way down: an older wiring simply produces yesterday's roster.
        ...(deps.dispatcher.getDeviceLocation !== undefined
          ? { getDeviceLocation: deps.dispatcher.getDeviceLocation }
          : {}),
        // The rule's flat zone list, scoped per camera. Reuses the SAME mirror
        // the matcher reads, never a second one.
        zoneOwner: this.zoneOwners.lookup(),
      })
    }
    const calendarsPort = deps.calendars
    if (calendarsPort !== undefined) {
      this.calendarEventsProducer = new NcCalendarEventsProducer({
        store: this.calendarEventsRules,
        outbox: this.outbox,
        calendars: calendarsPort,
        texts: this.texts,
        logger: this.logger.child('calendar-events'),
        now: this.now,
      })
    }
  }

  /**
   * The durable timelapse rule set — exposed for the `nc.*Timelapse*` bridge
   * actions, exactly as {@link ruleStore} is for the detection rules.
   */
  get timelapseStore(): TimelapseStore {
    return this.timelapseRules
  }

  /** The durable digest rule set — exposed for the `nc.*Summary*` bridge
   *  actions, on the same reasoning as {@link timelapseStore}. */
  get summaryStore(): NcSummaryStore {
    return this.summaryRules
  }

  /** The durable calendar-events rule set — exposed for the `nc.*CalendarEvents*` bridge. */
  get calendarEventsStore(): NcCalendarEventsStore {
    return this.calendarEventsRules
  }

  /**
   * Produce one digest window for one rule, right now.
   *
   * Throws when this node hosts no producer — an honest refusal beats a
   * `produced: 0` an operator reads as "there was nothing to make".
   */
  async runSummaryNow(input: {
    readonly ruleId: string
    readonly window?: ClosedWindow
  }): Promise<SummaryRunResult> {
    const producer = this.summaryProducer
    if (producer === null) {
      throw new Error('this node does not host the summary producer — produce it on the hub')
    }
    return producer.runNow(input)
  }

  /**
   * The text catalog's edit surface — exposed for the `nc.getTexts` /
   * `nc.setLanguage` / `nc.setTextOverrides` bridge actions, on the same
   * reasoning as {@link timelapseStore}: the admin UI must be able to read and
   * write the words from whichever node answers, and the document itself is
   * one row in the hub's centralized settings store.
   */
  get textCatalogEditor(): NcTextCatalogEditor {
    return this.textEditor
  }

  /** The live catalog every producer renders with — the preview must use the same one. */
  get textCatalog(): NcTextCatalog {
    return this.texts
  }

  /**
   * Produce the last closed window for one camera of one timelapse rule, now.
   *
   * Throws when this node hosts no producer — an honest refusal beats a
   * `produced: 0` an operator reads as "there was nothing to make".
   */
  async runTimelapseNow(input: TimelapseRunNowInput): Promise<TimelapseRunNowResult> {
    const scheduler = this.timelapseScheduler
    if (scheduler === null) {
      throw new Error('this node does not host the timelapse producer — produce it on the hub')
    }
    return scheduler.runNow(input)
  }

  /**
   * The durable rule store — exposed so the hub-only `nc.*` bridge actions
   * (`nc-actions.ts`, addonId `pipeline-analytics`) can serve the viewer's
   * ownership-scoped rule CRUD over `addons.custom`. Read/write goes through
   * the same write-through cache the evaluation path reads.
   */
  get ruleStore(): NcRuleStore {
    return this.rules
  }

  /**
   * The AI section of the ordinary rules — exposed for the `nc.getRuleAi` /
   * `nc.setRuleAi` bridge actions, exactly as {@link ruleStore} is for the
   * rules themselves. See `rule-ai.ts` for why it is a side table and not a
   * field on `NcRule`.
   */
  get ruleAiStore(): NcRuleAiStore {
    return this.ruleAi
  }

  /** Which devices the notification centre holds data for, per store. */
  listDeviceData(): ReturnType<typeof listNcDeviceData> {
    return listNcDeviceData(this.kindDeps())
  }

  /**
   * What every NC store reads and writes through: `ctx.records`. The centre
   * declares no collection: its kinds are declared by the addon
   * (`ncRecordKinds`, `ncDurableRecordKinds`).
   */
  private kindDeps(): DurableKindDeps {
    return { records: this.deps.records }
  }
  private bootLifecycleHost(): BootLifecycleHost {
    const self = this
    return {
      get addonUpdates() {
        return self.addonUpdates
      },
      get alertReconcileTimer() {
        return self.alertReconcileTimer
      },
      set alertReconcileTimer(value: ReturnType<typeof setInterval> | null) {
        self.alertReconcileTimer = value
      },
      get alertStore() {
        return self.alertStore
      },
      armBootBackfill: () => self.armBootBackfill(),
      closeGroupedWindowsOnStop: () => self.closeGroupedWindowsOnStop(),
      get deps() {
        return self.deps
      },
      get deviceDirectory() {
        return self.deviceDirectory
      },
      get deviceMutes() {
        return self.deviceMutes
      },
      get deviceStates() {
        return self.deviceStates
      },
      drainTick: () => self.drainTick(),
      get drainTimer() {
        return self.drainTimer
      },
      set drainTimer(value: ReturnType<typeof setInterval> | null) {
        self.drainTimer = value
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      set evaluationActive(value: boolean) {
        self.evaluationActive = value
      },
      get groupStore() {
        return self.groupStore
      },
      get grouped() {
        return self.grouped
      },
      hydrateAlertEpisodes: () => self.hydrateAlertEpisodes(),
      hydrateLiveness: () => self.hydrateLiveness(),
      hydrateNotifiedTracks: (rows) => self.hydrateNotifiedTracks(rows),
      hydrateOccupancy: () => self.hydrateOccupancy(),
      get hydration() {
        return self.hydration
      },
      set hydration(value: Promise<void> | null) {
        self.hydration = value
      },
      get intakeOpenedAt() {
        return self.intakeOpenedAt
      },
      set intakeOpenedAt(value: number) {
        self.intakeOpenedAt = value
      },
      get linkedStills() {
        return self.linkedStills
      },
      get livenessHoldoff() {
        return self.livenessHoldoff
      },
      get logger() {
        return self.logger
      },
      get nodeLivenessHoldoff() {
        return self.nodeLivenessHoldoff
      },
      noteInertGroupedRules: () => self.noteInertGroupedRules(),
      get now() {
        return self.now
      },
      onChain: (name, run, deviceId) => self.onChain(name, run, deviceId),
      get outbox() {
        return self.outbox
      },
      get pruneLedger() {
        return self.pruneLedger
      },
      readBootRecentRows: () => self.readBootRecentRows(),
      reconcile: () => self.reconcile(),
      reconcileAlertEpisodes: () => self.reconcileAlertEpisodes(),
      refreshOccupancyWatch: () => self.refreshOccupancyWatch(),
      reloadRules: () => self.reloadRules(),
      reloadTexts: () => self.reloadTexts(),
      get reloadTimer() {
        return self.reloadTimer
      },
      set reloadTimer(value: ReturnType<typeof setInterval> | null) {
        self.reloadTimer = value
      },
      get ruleAi() {
        return self.ruleAi
      },
      get rules() {
        return self.rules
      },
      get sceneStates() {
        return self.sceneStates
      },
      seedCooldowns: (rows) => self.seedCooldowns(rows),
      get sequences() {
        return self.sequences
      },
      get snoozes() {
        return self.snoozes
      },
      get stateSummary() {
        return self.stateSummary
      },
      get stills() {
        return self.stills
      },
      get summaryAi() {
        return self.summaryAi
      },
      get summaryProducer() {
        return self.summaryProducer
      },
      get summaryRules() {
        return self.summaryRules
      },
      get timelapseRules() {
        return self.timelapseRules
      },
      get timelapseScheduler() {
        return self.timelapseScheduler
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }

  async start(opts: { readonly evaluation: boolean }): Promise<void> {
    return runStart(this.bootLifecycleHost(), opts)
  }

  /**
   * The durable back-fill, finished.
   *
   * Resolves immediately when nothing was armed (a non-evaluation node, or a
   * centre that was never started). Never rejects — every phase owns its own
   * failure. Exists so a caller that genuinely needs the hydrated state — a
   * test asserting the reseed, an operator surface reporting readiness — can
   * ask for it instead of sleeping.
   */
  whenHydrated(): Promise<void> {
    return this.hydration ?? Promise.resolve()
  }

  /**
   * ONE drain pass, awaited — the interval's own tick, called directly.
   *
   * The same code path the timer drives, deliberately: a caller that flushes
   * the queue through a parallel implementation is testing the parallel
   * implementation.
   */
  async drainNow(): Promise<void> {
    await this.drainTick()
  }

  /**
   * FOR SPECS: one drain tick, then everything it appended to the evaluation chain (the
   * grouped sweep rides the chain, C13). The same body the timer drives — no bracket
   * access to private members (fresh review L-6).
   */
  async runDrainTickForTest(): Promise<void> {
    await this.drainTick()
    await this.evalChain
  }

  private armBootBackfill(): void {
    if (this.hydration !== null) return
    this.hydration = this.runBootBackfill().catch((err: unknown) => {
      // Every phase already swallows its own failure, so a throw ESCAPING here
      // is a bug in the arming path — and an unhandled rejection in a runner is
      // a silent one.
      this.logger.warn('notification back-fill could not be armed', {
        meta: { error: String(err) },
      })
    })
  }

  private async runBootBackfill(): Promise<void> {
    return runRunBootBackfill(this.bootLifecycleHost())
  }
  async stop(): Promise<void> {
    return runStop(this.bootLifecycleHost())
  }

  private async closeGroupedWindowsOnStop(): Promise<void> {
    return runCloseGroupedWindowsOnStop(this.bootLifecycleHost())
  }

  // ── The intake seam ─────────────────────────────────────────────────

  /**
   * Consume ONE event. THE entry point of the notification path — every
   * producer arrives here and nothing else does.
   *
   * Fire-and-forget: the frame path must never await a notification. The
   * evaluation is appended to the serialized chain, so consumption order is
   * persist order (see {@link evalChain}).
   *
   * It persists nothing about the event itself. Whether a durable row exists is
   * the PRODUCER's business — the tracker writes its tracks, the sensor ingest
   * its rows, the synthetic tester nothing at all — and the only thing written
   * from here on is the outbox row, which is the notification's own delivery
   * queue and not a record of the event.
   */
  consumeEvent(event: NcIncomingEvent): void {
    if (!this.evaluationActive) return
    this.scheduleEvaluation(event)
  }
  private liveIntakeHost(): LiveIntakeHost {
    const self = this
    return {
      get alarmPanel() {
        return self.alarmPanel
      },
      announceLiftAfterEvaluation: (lifted, event) =>
        self.announceLiftAfterEvaluation(lifted, event),
      audioStillOwner: (deviceId, atMs, mode) => self.audioStillOwner(deviceId, atMs, mode),
      consumeEvent: (event) => self.consumeEvent(event),
      get deps() {
        return self.deps
      },
      get deviceMutes() {
        return self.deviceMutes
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      get lastLinkedMutedReportAt() {
        return self.lastLinkedMutedReportAt
      },
      get linkedMutedSuppressed() {
        return self.linkedMutedSuppressed
      },
      get linkedStills() {
        return self.linkedStills
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      observeOpeningEvent: (event) => self.observeOpeningEvent(event),
      onChain: (name, run, deviceId) => self.onChain(name, run, deviceId),
      readNodeDisplayName: (nodeId) => self.readNodeDisplayName(nodeId),
      reportLinkedCameraMuted: (cameraId, sensorId) =>
        self.reportLinkedCameraMuted(cameraId, sensorId),
      get rules() {
        return self.rules
      },
      get stateSummary() {
        return self.stateSummary
      },
      get stills() {
        return self.stills
      },
      get summaryCollector() {
        return self.summaryCollector
      },
      unmutedCameras: (cameraIds) => self.unmutedCameras(cameraIds),
    }
  }

  private consumeNodeLiveness(event: NcIncomingEvent, timing: LivenessTiming): void {
    return runConsumeNodeLiveness(this.liveIntakeHost(), event, timing)
  }
  private readNodeDisplayName(nodeId: string | undefined): Promise<string | undefined> {
    return runReadNodeDisplayName(this.liveIntakeHost(), nodeId)
  }
  private evaluationCycleHost(): EvaluationCycleHost {
    const self = this
    return {
      get dispatcher() {
        return self.dispatcher
      },
      get evalChain() {
        return self.evalChain
      },
      set evalChain(value: Promise<void>) {
        self.evalChain = value
      },
      evaluateAndEnqueue: (event) => self.evaluateAndEnqueue(event),
      get evaluationActive() {
        return self.evaluationActive
      },
      get logger() {
        return self.logger
      },
      get updateLandings() {
        return self.updateLandings
      },
    }
  }

  consumeEventAndReport(event: NcIncomingEvent): Promise<NcIntakeReport> {
    return runConsumeEventAndReport(this.evaluationCycleHost(), event)
  }

  private syntheticEventHost(): SyntheticEventHost {
    const self = this
    return {
      captureLiveStill: (deviceId, deps) => self.captureLiveStill(deviceId, deps),
      consumeEventAndReport: (event) => self.consumeEventAndReport(event),
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      pruneSyntheticMedia: (now) => self.pruneSyntheticMedia(now),
      get syntheticMedia() {
        return self.syntheticMedia
      },
    }
  }

  injectTestEvent(
    input: NcTestEventInput,
    deps: NcTestInjectionDeps = {},
  ): Promise<NcTestEventResult> {
    return runInjectTestEvent(this.syntheticEventHost(), input, deps)
  }
  private liveRuleStatusHost(): LiveRuleStatusHost {
    const self = this
    return {
      get deps() {
        return self.deps
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      get grouped() {
        return self.grouped
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      get occupancyWatcher() {
        return self.occupancyWatcher
      },
      get timelapseScheduler() {
        return self.timelapseScheduler
      },
    }
  }

  ruleStatusFor(rule: NcRule): Promise<NcRuleStatus> {
    return runRuleStatusFor(this.liveRuleStatusHost(), rule)
  }

  timelapseStatusFor(
    rule: TimelapseRule,
    lookup?: NcTimelapseArtifactLookup,
  ): Promise<NcRuleStatus> {
    return runTimelapseStatusFor(this.liveRuleStatusHost(), rule, lookup)
  }

  private captureLiveStill(
    deviceId: number,
    deps: NcTestInjectionDeps,
  ): Promise<Uint8Array | null> {
    return runCaptureLiveStill(this.syntheticEventHost(), deviceId, deps)
  }

  private pruneSyntheticMedia(now: number): void {
    return runPruneSyntheticMedia(this.syntheticEventHost(), now)
  }

  // ── Persist hooks (D-2) — the PIPELINE producer's adapters ──────────
  //
  // Each is now a two-liner over `consumeEvent`: build the envelope, hand it
  // over. They are kept as named hooks because the call sites are persist sites
  // and the name is what documents WHEN they fire — but they no longer decide
  // anything, which is why a third producer can exist at all.

  onObjectEventPersisted(event: ObjectEvent, _track?: Track): void {
    return runOnObjectEventPersisted(this.liveIntakeHost(), event, _track)
  }

  recognitionOutlookFor(query: NcRecognitionOutlookQuery): NcRecognitionOutlook {
    return runRecognitionOutlookFor(this.liveIntakeHost(), query)
  }

  /**
   * D692: an ACTIVE track's label changed (accepted or retracted, C14). Called
   * synchronously from the tracker's label path, so the body ONLY appends the work to
   * the serialized chain: the promotion lands after every object event already queued
   * (the window it promotes may not exist yet), and the tracker never waits on it.
   */
  onTrackLabelChanged(input: NcTrackLabelChanged): void {
    if (!this.evaluationActive) return
    void this.onChain('label-changed', () => this.grouped.onLabelChanged(input), input.deviceId)
  }

  /**
   * D692: two tracks were fused (D683). Called synchronously from the fusion's RAM
   * steps; like {@link onTrackLabelChanged}, it only appends to the chain.
   */
  onTracksFused(input: NcTracksFused): void {
    if (!this.evaluationActive) return
    void this.onChain('tracks-fused', () => this.grouped.onTracksFused(input), input.deviceId)
  }

  /** D692: the open grouped windows — the tester, the status and the specs read it. */
  groupedOpenWindows(): readonly NcGroupedWindow[] {
    return this.grouped.openWindows()
  }

  onTrackClosed(
    track: Track,
    _ownedMedia: readonly MediaFileBytes[],
    info?: NcTrackClosedInfo,
  ): void {
    return runOnTrackClosed(this.liveIntakeHost(), track, _ownedMedia, info)
  }

  onSensorEventPersisted(event: SensorEvent, markerTrackId?: string): void {
    return runOnSensorEventPersisted(this.liveIntakeHost(), event, markerTrackId)
  }

  onUnownedSensorEvent(event: SensorEvent, linkedCameraIds: readonly number[]): void {
    return runOnUnownedSensorEvent(this.liveIntakeHost(), event, linkedCameraIds)
  }

  beginLinkedStills(request: NcLinkedStillsRequest): NcLinkedStills | undefined {
    return runBeginLinkedStills(this.liveIntakeHost(), request)
  }

  private reportLinkedCameraMuted(cameraId: number, sensorId: number): void {
    return runReportLinkedCameraMuted(this.liveIntakeHost(), cameraId, sensorId)
  }

  onSensorEvent(input: NcSensorEventInput): void {
    return runOnSensorEvent(this.liveIntakeHost(), input)
  }

  /** The linked cameras a sensor notification may show — not muted (D62), in order. */
  private unmutedCameras(cameraIds: readonly number[]): readonly number[] {
    return cameraIds.filter((id) => !this.deviceMutes.isMuted(id))
  }

  private observeOpeningEvent(event: SensorEvent): NcObserveOpeningResult {
    return runObserveOpeningEvent(this.liveIntakeHost(), event)
  }

  private announceLiftAfterEvaluation(lifted: NcObserveOpeningResult, event: SensorEvent): void {
    return runAnnounceLiftAfterEvaluation(this.liveIntakeHost(), lifted, event)
  }

  onAudioEventPersisted(event: AudioEvent): void {
    return runOnAudioEventPersisted(this.liveIntakeHost(), event)
  }

  private audioStillOwner(
    deviceId: number,
    atMs: number,
    mode: 'legacy' | 'condition',
  ): string | undefined {
    return runAudioStillOwner(this.liveIntakeHost(), deviceId, atMs, mode)
  }

  onPackageEventPersisted(event: ObjectEvent, phase: NcPackagePhase): void {
    return runOnPackageEventPersisted(this.liveIntakeHost(), event, phase)
  }

  private occupancyWatchHost(): OccupancyWatchHost {
    const self = this
    return {
      get audioEnabled() {
        return self.audioEnabled
      },
      set audioEnabled(value: boolean) {
        self.audioEnabled = value
      },
      audioStillOwner: (deviceId, atMs, mode) => self.audioStillOwner(deviceId, atMs, mode),
      get audioWatcher() {
        return self.audioWatcher
      },
      consumeEvent: (event) => self.consumeEvent(event),
      departureStillOwner: (shelf, edge) => self.departureStillOwner(shelf, edge),
      get deps() {
        return self.deps
      },
      get deviceStates() {
        return self.deviceStates
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      get lastAudioWatchReport() {
        return self.lastAudioWatchReport
      },
      set lastAudioWatchReport(value: string) {
        self.lastAudioWatchReport = value
      },
      get lastOccupancyWatchReport() {
        return self.lastOccupancyWatchReport
      },
      set lastOccupancyWatchReport(value: string) {
        self.lastOccupancyWatchReport = value
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      get occupancyEnabled() {
        return self.occupancyEnabled
      },
      set occupancyEnabled(value: boolean) {
        self.occupancyEnabled = value
      },
      get occupancyLookFailing() {
        return self.occupancyLookFailing
      },
      occupancyStillOwner: (edge) => self.occupancyStillOwner(edge),
      get occupancyStore() {
        return self.occupancyStore
      },
      get occupancyWatcher() {
        return self.occupancyWatcher
      },
      onOccupancyEdge: (edge) => self.onOccupancyEdge(edge),
      persistOccupancyEdge: (edge, now) => self.persistOccupancyEdge(edge, now),
      persistOccupancyRow: (row, now) => self.persistOccupancyRow(row, now),
      persistSeededOccupancy: (now) => self.persistSeededOccupancy(now),
      registerDepartureFallback: (shelf, edge, trackId) =>
        self.registerDepartureFallback(shelf, edge, trackId),
      reportAudioWatch: (entries) => self.reportAudioWatch(entries),
      reportOccupancyWatch: (specs) => self.reportOccupancyWatch(specs),
      requestOccupancyLook: (flip) => self.requestOccupancyLook(flip),
      ruleWantsOccupancyStill: (edge) => self.ruleWantsOccupancyStill(edge),
      get rules() {
        return self.rules
      },
      get sceneStates() {
        return self.sceneStates
      },
      get sceneWatchSignature() {
        return self.sceneWatchSignature
      },
      set sceneWatchSignature(value: string | null) {
        self.sceneWatchSignature = value
      },
      get stills() {
        return self.stills
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }

  /**
   * What the operator answered to the "was this detection right?" buttons, for
   * the retrain page: by track, the latest answer wins. A track nobody answered
   * is absent.
   */
  detectionVerdictsOf(trackIds: readonly string[]): ReadonlyMap<string, RetrainVerdict> {
    const out = new Map<string, RetrainVerdict>()
    for (const [trackId, row] of this.verdicts.forTracks(trackIds)) {
      out.set(
        trackId,
        toRetrainVerdict({
          verdict: row.verdict,
          trackId,
          at: row.at,
          suggestedClass: row.suggestedClass,
        }),
      )
    }
    return out
  }

  observeOccupancy(
    deviceId: number,
    snapshot: CameraOccupancySnapshot,
    evidence: OccupancyEvidence = 'scene',
  ): void {
    return runObserveOccupancy(this.occupancyWatchHost(), deviceId, snapshot, evidence)
  }

  private requestOccupancyLook(flip: OccupancyArmedFlip): void {
    return runRequestOccupancyLook(this.occupancyWatchHost(), flip)
  }

  onOccupancyEdge(edge: OccupancyEdge): void {
    return runOnOccupancyEdge(this.occupancyWatchHost(), edge)
  }

  private occupancyStillOwner(edge: OccupancyEdge): string | undefined {
    return runOccupancyStillOwner(this.occupancyWatchHost(), edge)
  }

  private ruleWantsOccupancyStill(edge: OccupancyEdge): boolean {
    return runRuleWantsOccupancyStill(this.occupancyWatchHost(), edge)
  }
  private departureFallbackHost(): DepartureFallbackHost {
    const self = this
    return {
      get departureFallbacks() {
        return self.departureFallbacks
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      reportNoDepartureStill: (edge, reason) => self.reportNoDepartureStill(edge, reason),
      get stills() {
        return self.stills
      },
    }
  }

  private registerDepartureFallback(
    shelf: NcStillShelf,
    edge: OccupancyEdge,
    trackId: string,
  ): void {
    return runRegisterDepartureFallback(this.departureFallbackHost(), shelf, edge, trackId)
  }

  /**
   * A departed track's id as the media store knows it now: its fusion
   * SURVIVOR when an L2 fusion absorbed it (D683), itself otherwise. A lookup
   * that FAILS reads the id as asked (D315) — the departure then degrades to
   * exactly the pre-fusion behaviour (the ring still when the id owns
   * nothing) — and is said once per id, tagged with the camera.
   */
  private async resolveDepartedTrack(trackId: string): Promise<string> {
    const resolve = this.deps.resolveTrackAlias
    if (resolve === undefined) return trackId
    return resolveMediaOwnerId(
      'track',
      trackId,
      resolve,
      this.reportDepartedAliasFailure,
      'departureFallbackMedia',
    )
  }

  /** Sampled (once per `method:id`): see {@link resolveDepartedTrack}. */
  private readonly reportDepartedAliasFailure = sampledOnce(
    NC_DEPARTED_ALIAS_FAILURE_MEMO_MAX,
    (failure: AliasResolveFailure) => {
      const deviceId = this.departureFallbacks.get(failure.id)?.deviceId
      this.logger.warn('departed track alias resolution failed — reading the id as asked (D315)', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: {
          method: failure.method,
          id: failure.id,
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        },
      })
    },
  )

  private departureFallbackMedia(trackId: string): readonly MediaFileBytes[] | undefined {
    return runDepartureFallbackMedia(this.departureFallbackHost(), trackId)
  }

  private departureStillOwner(shelf: NcStillShelf, edge: OccupancyEdge): string | undefined {
    return runDepartureStillOwner(this.departureFallbackHost(), shelf, edge)
  }

  private reportNoDepartureStill(
    edge: OccupancyEdge,
    reason: 'moment-unknown' | 'no-ring-still',
  ): undefined {
    return runReportNoDepartureStill(this.departureFallbackHost(), edge, reason)
  }

  observeAudio(deviceId: number, sample: AudioSample): void {
    return runObserveAudio(this.occupancyWatchHost(), deviceId, sample)
  }

  private systemEventsHost(): SystemEventsHost {
    const self = this
    return {
      activeOccupancyKeys: () => self.activeOccupancyKeys(),
      get addonUpdates() {
        return self.addonUpdates
      },
      admitAlertEpisode: (event, via) => self.admitAlertEpisode(event, via),
      get alertEpisodes() {
        return self.alertEpisodes
      },
      get alertEpisodesLoaded() {
        return self.alertEpisodesLoaded
      },
      announceRuleHealth: () => self.announceRuleHealth(),
      get calendarEventsProducer() {
        return self.calendarEventsProducer
      },
      get calendarEventsRules() {
        return self.calendarEventsRules
      },
      consumeEvent: (event) => self.consumeEvent(event),
      get deps() {
        return self.deps
      },
      deviceAlertSettings: () => self.deviceAlertSettings(),
      get deviceAlerts() {
        return self.deviceAlerts
      },
      get deviceDirectory() {
        return self.deviceDirectory
      },
      get deviceStates() {
        return self.deviceStates
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      get lastSystemLiveness() {
        return self.lastSystemLiveness
      },
      get liveness() {
        return self.liveness
      },
      get livenessHoldoff() {
        return self.livenessHoldoff
      },
      get logger() {
        return self.logger
      },
      get nodeLivenessHoldoff() {
        return self.nodeLivenessHoldoff
      },
      noteInertGroupedRules: () => self.noteInertGroupedRules(),
      get now() {
        return self.now
      },
      observeAlarmOpenings: () => self.observeAlarmOpenings(),
      get occupancyStore() {
        return self.occupancyStore
      },
      pruneAlarmInputBypasses: () => self.pruneAlarmInputBypasses(),
      get pruneLedger() {
        return self.pruneLedger
      },
      get pruner() {
        return self.pruner
      },
      refreshOccupancyWatch: () => self.refreshOccupancyWatch(),
      reloadTexts: () => self.reloadTexts(),
      reportLivenessDrop: (incoming, verdict) => self.reportLivenessDrop(incoming, verdict),
      get ruleAi() {
        return self.ruleAi
      },
      get ruleHealth() {
        return self.ruleHealth
      },
      get rules() {
        return self.rules
      },
      get sceneStates() {
        return self.sceneStates
      },
      get stateSummary() {
        return self.stateSummary
      },
      get summaryRules() {
        return self.summaryRules
      },
      get timelapseRules() {
        return self.timelapseRules
      },
      get plannedUpdates() {
        return self.plannedUpdates
      },
      get updateLandings() {
        return self.updateLandings
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }

  /** The device registry changed: a cached domain action target is stale (D983). */
  invalidateActionTargets(): void {
    this.actionTargets?.invalidate()
  }

  onSystemEvent(event: SystemEvent): void {
    return runOnSystemEvent(this.systemEventsHost(), event)
  }

  private deliverUnlessSuperseded(entry: NcOutboxEntry): Promise<NcDeliverResult> {
    return runDeliverUnlessSuperseded(this.evaluationCycleHost(), entry)
  }

  private rulesProviderHost(): RulesProviderHost {
    const self = this
    return {
      get actionRunner() {
        return self.actionRunner
      },
      alarmConfig: () => self.alarmConfig(),
      alarmSensors: (input) => self.alarmSensors(input),
      cancelSnooze: (snoozeId, caller) => self.cancelSnooze(snoozeId, caller),
      createSnooze: (input, caller) => self.createSnooze(input, caller),
      get deps() {
        return self.deps
      },
      get deviceCompatWarnSampler() {
        return self.deviceCompatWarnSampler
      },
      deviceIdForRuleActions: (rule) => self.deviceIdForRuleActions(rule),
      get deviceMutes() {
        return self.deviceMutes
      },
      dryRun: (rule, lookbackMinutes) => self.dryRun(rule, lookbackMinutes),
      get logger() {
        return self.logger
      },
      mutateAlarmProfile: (run) => self.mutateAlarmProfile(run),
      get now() {
        return self.now
      },
      get outbox() {
        return self.outbox
      },
      get rules() {
        return self.rules
      },
      get sequences() {
        return self.sequences
      },
      setAlarmConfig: (patch) => self.setAlarmConfig(patch),
      get snoozes() {
        return self.snoozes
      },
      get stateSummary() {
        return self.stateSummary
      },
      get texts() {
        return self.texts
      },
      validateTargetRefs: (targetIds) => self.validateTargetRefs(targetIds),
    }
  }
  buildProvider(): INotificationRulesProvider {
    return runBuildProvider(this.rulesProviderHost())
  }

  // ── Alarm panel ─────────────────────────────────────────────────────

  /**
   * Adopt the panel this node owns. Called once by the addon after
   * `declareAlarmPanel`; a node without one never calls it and the cap then
   * answers `deviceId: null`.
   */
  setAlarmPanel(panel: NcAlarmPanelPort | null): void {
    this.alarmPanel = panel
    if (panel === null || this.panelGateWords?.deviceId !== panel.deviceId) {
      this.panelGateWords = null
    }
  }

  /**
   * The `deviceState` lookup the engine gets — live path and dry-run alike, so
   * the tester predicts what the saved rule will do. Every device answers its
   * one word from `read`; the panel this node owns also answers the armed mode
   * its `pending`/`triggered` belongs to (D630).
   */
  private deviceStateLookup(read: (deviceId: number) => string | undefined): NcDeviceStateLookup {
    return panelAwareLookup(read, this.panelGateWords)
  }

  /**
   * What the panel asks before it arms — see {@link NcAlarmArmGuardHook}.
   *
   * Handed to the panel by the same wiring that hands it the publish hook: the
   * panel owns the state machine, the centre owns the rules that say which
   * devices a mode covers, and neither can reach the other on its own.
   */
  alarmArmGuard(): NcAlarmArmGuardHook {
    return {
      openings: (mode) => this.alarmOpenings(mode),
      secureOnArm: (devices) => {
        void this.secureDevicesOnArm(devices)
      },
      announceRefusal: (input) => this.announceArmRefused(input),
      announceCheckFailed: (input) => this.announceArmCheckFailed(input),
    }
  }
  private alarmRuntimeHost(): AlarmRuntimeHost {
    const self = this
    return {
      alarmAnnouncement: (panel, transition) => self.alarmAnnouncement(panel, transition),
      alarmConfig: () => self.alarmConfig(),
      alarmLive: (panel) => self.alarmLive(panel),
      get alarmLiveReadLog() {
        return self.alarmLiveReadLog
      },
      get alarmPanel() {
        return self.alarmPanel
      },
      alarmSensors: (input) => self.alarmSensors(input),
      coverageFor: (panel) => self.coverageFor(panel),
      get deps() {
        return self.deps
      },
      get deviceDirectory() {
        return self.deviceDirectory
      },
      deviceNameFromDirectory: () => self.deviceNameFromDirectory(),
      enqueueAlarmAnnouncement: (panel, incoming, announcement, reached) =>
        self.enqueueAlarmAnnouncement(panel, incoming, announcement, reached),
      get evalChain() {
        return self.evalChain
      },
      set evalChain(value: Promise<void>) {
        self.evalChain = value
      },
      evaluateAndEnqueue: (event) => self.evaluateAndEnqueue(event),
      get logger() {
        return self.logger
      },
      get outbox() {
        return self.outbox
      },
      get rules() {
        return self.rules
      },
      setAlarmConfig: (patch) => self.setAlarmConfig(patch),
      settleCombinedAlarm: (transition, incoming, report, reached, announced) =>
        self.settleCombinedAlarm(transition, incoming, report, reached, announced),
    }
  }

  private alarmOpenings(mode: AlarmArmMode): Promise<NcAlarmOpenings> {
    return runAlarmOpenings(this.alarmRuntimeHost(), mode)
  }
  private alarmArmHost(): AlarmArmHost {
    const self = this
    return {
      actuateWithAttribution: (input) => self.actuateWithAttribution(input),
      alarmConfig: () => self.alarmConfig(),
      alarmLive: (panel) => self.alarmLive(panel),
      get alarmPanel() {
        return self.alarmPanel
      },
      get alarmSensorsReadLog() {
        return self.alarmSensorsReadLog
      },
      alarmSkipReason: (deviceId) => self.alarmSkipReason(deviceId),
      coverageFor: (panel) => self.coverageFor(panel),
      get deps() {
        return self.deps
      },
      get deviceDirectory() {
        return self.deviceDirectory
      },
      get deviceMutes() {
        return self.deviceMutes
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      pressLocalPanel: (panel, origin) => self.pressLocalPanel(panel, origin),
      get rules() {
        return self.rules
      },
      scheduleAlarmTransition: (panel, transition) =>
        self.scheduleAlarmTransition(panel, transition),
    }
  }

  private secureDevicesOnArm(devices: readonly NcAlarmOpenDevice[]): Promise<void> {
    return runSecureDevicesOnArm(this.alarmArmHost(), devices)
  }

  private announceArmRefused(input: {
    readonly refusal: NcAlarmRefusal
    readonly blocking: readonly NcAlarmOpenDevice[]
    readonly state: AlarmState
    readonly at: number
  }): void {
    return runAnnounceArmRefused(this.alarmArmHost(), input)
  }

  private announceArmCheckFailed(input: {
    readonly mode: AlarmArmMode
    readonly state: AlarmState
    readonly at: number
    readonly error: string
  }): void {
    return runAnnounceArmCheckFailed(this.alarmArmHost(), input)
  }

  alarmActions(): NcAlarmActionDeps {
    return runAlarmActions(this.alarmRuntimeHost())
  }
  private setAlarmConfig(patch: NcAlarmSettingsPatch): Promise<NcAlarmConfig> {
    return runSetAlarmConfig(this.alarmArmHost(), patch)
  }

  private mutateAlarmProfile(
    run: (panel: NcAlarmPanelPort) => Promise<NcAlarmProfilesView>,
  ): Promise<NcAlarmConfig> {
    return runMutateAlarmProfile(this.alarmArmHost(), run)
  }

  private alarmLive(panel: NcAlarmPanelPort): Promise<NcAlarmLive> {
    return runAlarmLive(this.alarmRuntimeHost(), panel)
  }

  private alarmSensors(input: NcAlarmSensorsInput): Promise<NcAlarmSensors> {
    return runAlarmSensors(this.alarmArmHost(), input)
  }

  private alarmConfig(): Promise<NcAlarmConfig> {
    return runAlarmConfig(this.alarmArmHost())
  }
  private coverageFor(panel: NcAlarmPanelPort): readonly NcAlarmModeCoverage[] {
    return runCoverageFor(this.alarmArmHost(), panel)
  }

  private alarmSkipReason(deviceId: number): NcAlarmSkipReason | undefined {
    return runAlarmSkipReason(this.alarmArmHost(), deviceId)
  }
  private bootHydrationHost(): BootHydrationHost {
    const self = this
    return {
      get alarmPanel() {
        return self.alarmPanel
      },
      get alertStore() {
        return self.alertStore
      },
      buildEntries: (rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras) =>
        self.buildEntries(rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras),
      get deviceDirectory() {
        return self.deviceDirectory
      },
      get deviceStates() {
        return self.deviceStates
      },
      get evaluationActive() {
        return self.evaluationActive
      },
      kindDeps: () => self.kindDeps(),
      get liveness() {
        return self.liveness
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      get occupancyStore() {
        return self.occupancyStore
      },
      get outbox() {
        return self.outbox
      },
      get panelGateWords() {
        return self.panelGateWords
      },
      set panelGateWords(value: NcPanelGateWords | null) {
        self.panelGateWords = value
      },
      get pruner() {
        return self.pruner
      },
      resolveUserTargets: (rule, deviceId) => self.resolveUserTargets(rule, deviceId),
      get rules() {
        return self.rules
      },
      get sceneGateReported() {
        return self.sceneGateReported
      },
      get sceneStates() {
        return self.sceneStates
      },
      scheduleAlarmTransition: (panel, transition) =>
        self.scheduleAlarmTransition(panel, transition),
      get stateSummary() {
        return self.stateSummary
      },
      get textStore() {
        return self.textStore
      },
      get texts() {
        return self.texts
      },
    }
  }

  private reportSystemFilterExclusion(
    rule: { readonly id: string; readonly name: string },
    subject: NcRuleSubject,
    filter: NcSystemEventExcludingFilter,
  ): void {
    return runReportSystemFilterExclusion(this.bootHydrationHost(), rule, subject, filter)
  }

  private reportSceneSuppression(
    rule: { readonly id: string; readonly name: string; readonly conditions: NcConditions },
    subject: NcRuleSubject,
  ): void {
    return runReportSceneSuppression(this.bootHydrationHost(), rule, subject)
  }

  /**
   * A confirmed scene transition, straight from the provider in this process.
   *
   * Synchronous on purpose and for the same reason {@link onAlarmPublish} is:
   * the reload tick would otherwise be the only writer, and a rule gated on
   * "while the bin is out" would keep its old answer for up to thirty seconds
   * after the bin came back. The tick stays as reconciliation.
   *
   * A DIRECT CALL, not a bus subscription. `EnrichmentSceneStateChanged` is
   * still emitted for the badge and for anyone else, but D8 events are
   * droppable telemetry and a gate fed by droppable telemetry is a gate that is
   * sometimes wrong and never says so.
   *
   * This never OPENS a gate that the mirror had shut for lack of an entry: it
   * writes an observation the caller actually made. It is `refresh` that
   * removes entries, and it never empties on a failed read (D49).
   */
  onSceneEdge(observation: NcSceneObservation): void {
    this.sceneStates.note(observation)
  }

  /**
   * Reconcile the scene mirror now.
   *
   * The scene provider is constructed AFTER this centre starts (it needs the
   * media store and the embedding encoder), so the boot refresh reads an empty
   * provider. The addon calls this once the provider has hydrated, rather than
   * leaving every scene-gated rule shut for a whole reload tick after every
   * respawn.
   */
  refreshSceneStates(): void {
    this.sceneStates.refresh()
  }

  onAlarmPublish(report: NcAlarmPublishReport): void {
    return runOnAlarmPublish(this.bootHydrationHost(), report)
  }

  private scheduleAlarmTransition(panel: NcAlarmPanelPort, transition: NcAlarmTransition): void {
    return runScheduleAlarmTransition(this.alarmRuntimeHost(), panel, transition)
  }

  /**
   * The composed body for an alarm transition (when the words depend on the
   * rule set). Delivery targets are ALWAYS empty here: the panel no longer
   * fans out to `announceTargets` — an alarm-family rule is the only notifier
   * (operator ruling 2026-10-03). `announceTargets` remains on the settings
   * blob for schema compatibility and is ignored at send time.
   *
   *  - ARM and ARMING compose from the SAME coverage — "what does this mode
   *    actually watch" — because they are the same answer given thirty seconds
   *    apart. A COVERAGE GAP does not suppress the sentence, it changes it.
   *  - a REFUSAL names the devices that refused it, and — since its row
   *    carries the Arm anyway — where the button is.
   *
   * Every other kind is `null`: the intake picks its catalog body and params.
   */
  private alarmAnnouncement(
    panel: NcAlarmPanelPort,
    transition: NcAlarmTransition,
  ): NcAlarmAnnouncement {
    return { text: this.alarmAnnouncementText(panel, transition), targetIds: [] }
  }

  private alarmAnnouncementText(
    panel: NcAlarmPanelPort,
    transition: NcAlarmTransition,
  ): NcArmAnnouncementText | null {
    return runAlarmAnnouncementText(this.alarmRuntimeHost(), panel, transition)
  }

  private enqueueAlarmAnnouncement(
    panel: NcAlarmPanelPort,
    incoming: NcIncomingEvent,
    announcement: NcAlarmAnnouncement,
    reached: ReadonlySet<string>,
  ): Promise<readonly string[]> {
    return runEnqueueAlarmAnnouncement(
      this.alarmRuntimeHost(),
      panel,
      incoming,
      announcement,
      reached,
    )
  }

  private enqueuePickerTargets(
    event: NcIncomingEvent,
    reached: ReadonlySet<string>,
    outcomes: NcRuleOutcome[],
  ): Promise<void> {
    return runEnqueuePickerTargets(this.alarmRuntimeHost(), event, reached, outcomes)
  }

  private settleCombinedAlarm(
    transition: NcAlarmTransition,
    incoming: NcIncomingEvent,
    report: NcIntakeReport,
    reached: ReadonlySet<string>,
    /** The panel's own recipients the ANNOUNCEMENT reached (none a rule did). */
    announced: readonly string[],
  ): Promise<void> {
    return runSettleCombinedAlarm(
      this.alarmRuntimeHost(),
      transition,
      incoming,
      report,
      reached,
      announced,
    )
  }

  private actuateWithAttribution(input: {
    readonly deviceId: number
    readonly cap: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly origin?: NcRuleFireRef
  }): Promise<void> {
    return runActuateWithAttribution(this.alarmArmHost(), input)
  }

  private pressLocalPanel(panel: NcAlarmPanelPort, origin: NcRuleFireRef | undefined): boolean {
    return runPressLocalPanel(this.alarmArmHost(), panel, origin)
  }

  /**
   * Device names from the in-process directory — no I/O, so the arm sentence
   * can be composed on the publish path.
   *
   * D49 in miniature: the panel's own publish must not gate on a fallible
   * read. An id the mirror cannot place falls back to its number, which is a
   * shorter name and never a shorter LIST — understating what a mode arms is
   * the one error this sentence must not make.
   */
  private deviceNameFromDirectory(): NcDeviceNameLookup {
    return (id: number) => {
      const identity = this.deviceDirectory.get(id)
      if (identity !== undefined && identity.name.trim().length > 0) return identity.name.trim()
      // A TRANSLATED placeholder, not a hard-coded `Device 102`: this sentence
      // is delivered in Italian on this hub, and one English fragment in the
      // middle of a list is how an operator concludes the list is machine
      // output rather than an answer.
      return this.texts.text({ key: 'alarm.device.unnamed', vars: { id: String(id) } })
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * D692 §2.2 / review T8 L-2: a stored `groupingSec` on a rule the grouping cannot apply
   * to is inert — said once per rule at LOAD, because such a rule (a track-end or a sensor
   * rule) never reaches the object-event admission that would otherwise say it.
   */
  private noteInertGroupedRules(): void {
    for (const rule of this.rules.list()) {
      if (rule.groupingSec !== undefined && !ruleGroupingApplies(rule)) {
        this.grouped.noteInertRule(rule)
      }
    }
  }
  private ruleActionDispatchHost(): RuleActionDispatchHost {
    const self = this
    return {
      get actionRunner() {
        return self.actionRunner
      },
      get alarmPanel() {
        return self.alarmPanel
      },
      alarmRowsHeard: () => self.alarmRowsHeard(),
      autoTriggerAlarmPanel: (rule, subject, kind) =>
        self.autoTriggerAlarmPanel(rule, subject, kind),
      get deviceDirectory() {
        return self.deviceDirectory
      },
      deviceStateLookup: (read) => self.deviceStateLookup(read),
      get deviceStates() {
        return self.deviceStates
      },
      get groupedAlarmPhases() {
        return self.groupedAlarmPhases
      },
      isTriggerOffSubject: (subject) => self.isTriggerOffSubject(subject),
      get judgedTracks() {
        return self.judgedTracks
      },
      get logger() {
        return self.logger
      },
      get notifiedTracks() {
        return self.notifiedTracks
      },
      get now() {
        return self.now
      },
      get rules() {
        return self.rules
      },
      get sceneStates() {
        return self.sceneStates
      },
      get sequences() {
        return self.sequences
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }

  private evaluateGrouped(rule: NcRule, subject: NcRuleSubject, relax: boolean): NcEvaluation {
    return runEvaluateGrouped(this.ruleActionDispatchHost(), rule, subject, relax)
  }

  private groupedLedger(): NcGroupedTrackLedger {
    return runGroupedLedger(this.ruleActionDispatchHost())
  }

  private closeGroupedPassHost(): CloseGroupedPassHost {
    const self = this
    return {
      alarmPushVerdict: (rule, deviceId, phase) => self.alarmPushVerdict(rule, deviceId, phase),
      buildEntries: (rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras) =>
        self.buildEntries(rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras),
      closeGroupedPass: (window, reason) => self.closeGroupedPass(window, reason),
      get dispatcher() {
        return self.dispatcher
      },
      evaluateGrouped: (rule, subject, relax) => self.evaluateGrouped(rule, subject, relax),
      get groupStore() {
        return self.groupStore
      },
      get grouped() {
        return self.grouped
      },
      groupedAlarmPhaseOf: (ruleId, member) => self.groupedAlarmPhaseOf(ruleId, member),
      intrusionLocationsOf: (deviceIds) => self.intrusionLocationsOf(deviceIds),
      judgeDropped: (rule, window, dropped, at) => self.judgeDropped(rule, window, dropped, at),
      get judgedTracks() {
        return self.judgedTracks
      },
      get lastFiredAt() {
        return self.lastFiredAt
      },
      get logger() {
        return self.logger
      },
      memberFates: (fates, keptFate) => self.memberFates(fates, keptFate),
      mutedAuthority: (subject) => self.mutedAuthority(subject),
      get notifiedTracks() {
        return self.notifiedTracks
      },
      get now() {
        return self.now
      },
      get outbox() {
        return self.outbox
      },
      recordSnoozeSuppression: (verdict, input) => self.recordSnoozeSuppression(verdict, input),
      resolveUserTargets: (rule, deviceId) => self.resolveUserTargets(rule, deviceId),
      get rules() {
        return self.rules
      },
      sealGroupedWindow: (window, reason, result) => self.sealGroupedWindow(window, reason, result),
      snoozeDecision: (input) => self.snoozeDecision(input),
      snoozedAtClose: (rule, windowKey, entries, classes, at) =>
        self.snoozedAtClose(rule, windowKey, entries, classes, at),
    }
  }

  private async closeGroupedWindow(
    window: NcGroupedWindow,
    reason: NcGroupedCloseReason,
  ): Promise<number> {
    return runCloseGroupedWindow(this.closeGroupedPassHost(), window, reason)
  }

  private sealGroupedWindow(
    window: NcGroupedWindow,
    reason: NcGroupedCloseReason,
    result: NcGroupedCloseResult,
  ): void {
    return runSealGroupedWindow(this.closeGroupedPassHost(), window, reason, result)
  }

  private memberFates(
    fates: readonly NcGroupedFate[],
    keptFate: NcGroupMemberFate,
  ): readonly NcGroupMemberRecord[] {
    return runMemberFates(fates, keptFate)
  }
  private async closeGroupedPass(
    window: NcGroupedWindow,
    reason: NcGroupedCloseReason,
  ): Promise<NcGroupedCloseResult> {
    return runCloseGroupedPass(this.closeGroupedPassHost(), window, reason)
  }

  private async snoozedAtClose(
    rule: NcRule,
    windowKey: string,
    entries: readonly NcOutboxEnqueueInput[],
    classes: readonly string[],
    at: number,
  ): Promise<ReadonlyMap<string, NcGroupedSnoozeCover>> {
    return runSnoozedAtClose(this.closeGroupedPassHost(), rule, windowKey, entries, classes, at)
  }

  private judgeDropped(
    rule: NcRule,
    window: NcGroupedWindow,
    dropped: readonly NcGroupedFate[],
    at: number,
  ): void {
    return runJudgeDropped(this.closeGroupedPassHost(), rule, window, dropped, at)
  }
  private buildEntriesHost(): BuildEntriesHost {
    const self = this
    return {
      get deps() {
        return self.deps
      },
      get deviceMutes() {
        return self.deviceMutes
      },
      get deviceRouteCache() {
        return self.deviceRouteCache
      },
      get lastMutedReportAt() {
        return self.lastMutedReportAt
      },
      get lastNoMatchReportAt() {
        return self.lastNoMatchReportAt
      },
      get logger() {
        return self.logger
      },
      get mutedSuppressed() {
        return self.mutedSuppressed
      },
      get noMatchSuppressed() {
        return self.noMatchSuppressed
      },
      get now() {
        return self.now
      },
      get ownedTargetsAt() {
        return self.ownedTargetsAt
      },
      set ownedTargetsAt(value: number) {
        self.ownedTargetsAt = value
      },
      get ownedTargetsCache() {
        return self.ownedTargetsCache
      },
      set ownedTargetsCache(value: ReadonlyMap<string, readonly string[]> | null) {
        self.ownedTargetsCache = value
      },
      reportSceneSuppression: (rule, subject) => self.reportSceneSuppression(rule, subject),
      reportSystemFilterExclusion: (rule, subject, filter) =>
        self.reportSystemFilterExclusion(rule, subject, filter),
      get ruleAi() {
        return self.ruleAi
      },
      get rules() {
        return self.rules
      },
      get userFanoutUnavailableLogged() {
        return self.userFanoutUnavailableLogged
      },
      set userFanoutUnavailableLogged(value: boolean) {
        self.userFanoutUnavailableLogged = value
      },
      get userGrantsAt() {
        return self.userGrantsAt
      },
      set userGrantsAt(value: number) {
        self.userGrantsAt = value
      },
      get userGrantsCache() {
        return self.userGrantsCache
      },
      set userGrantsCache(value: readonly NcUserGrant[] | null) {
        self.userGrantsCache = value
      },
    }
  }

  private reportRuleNonMatch(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    evaluation: NcEvaluation,
    outcomes: NcRuleOutcome[],
    rejections: string[],
  ): void {
    return runReportRuleNonMatch(
      this.buildEntriesHost(),
      rule,
      subject,
      kind,
      evaluation,
      outcomes,
      rejections,
    )
  }

  private onChain(name: string, run: () => Promise<void>, deviceId: number): Promise<void> {
    return runOnChain(this.evaluationCycleHost(), name, run, deviceId)
  }

  private scheduleEvaluation(event: NcIncomingEvent): void {
    return runScheduleEvaluation(this.evaluationCycleHost(), event)
  }

  private evaluateAndEnqueueHost(): EvaluateAndEnqueueHost {
    const self = this
    return {
      alarmPushVerdict: (rule, deviceId, phase) => self.alarmPushVerdict(rule, deviceId, phase),
      buildEntries: (rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras) =>
        self.buildEntries(rule, subject, kind, matchedOn, userTargets, origin, cooldown, extras),
      deviceStateLookup: (read) => self.deviceStateLookup(read),
      get deviceStates() {
        return self.deviceStates
      },
      enqueuePickerTargets: (event, reached, outcomes) =>
        self.enqueuePickerTargets(event, reached, outcomes),
      get grouped() {
        return self.grouped
      },
      intrusionLocationsOf: (deviceIds) => self.intrusionLocationsOf(deviceIds),
      get lastFiredAt() {
        return self.lastFiredAt
      },
      get linkedStills() {
        return self.linkedStills
      },
      get logger() {
        return self.logger
      },
      mutedAuthority: (subject) => self.mutedAuthority(subject),
      get now() {
        return self.now
      },
      get outbox() {
        return self.outbox
      },
      reportMutedDrop: (subject, mutedDeviceId, kind, now) =>
        self.reportMutedDrop(subject, mutedDeviceId, kind, now),
      reportNoMatch: (subject, kind, rejections, now) =>
        self.reportNoMatch(subject, kind, rejections, now),
      reportRuleNonMatch: (rule, subject, kind, evaluation, outcomes, rejections) =>
        self.reportRuleNonMatch(rule, subject, kind, evaluation, outcomes, rejections),
      resolveUserTargets: (rule, deviceId) => self.resolveUserTargets(rule, deviceId),
      get rules() {
        return self.rules
      },
      runRuleActions: (rule, subject, kind, controls) =>
        self.runRuleActions(rule, subject, kind, controls),
      get sceneGateReported() {
        return self.sceneGateReported
      },
      get sceneStates() {
        return self.sceneStates
      },
      get sequences() {
        return self.sequences
      },
      get stills() {
        return self.stills
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }
  private async evaluateAndEnqueue(event: NcIncomingEvent): Promise<NcIntakeReport> {
    return runEvaluateAndEnqueue(this.evaluateAndEnqueueHost(), event)
  }

  /** TEST a state-summary rule (D698, `nc.testRule`) — see `NcStateSummaryService.test`. */
  testStateSummary(rule: NcRule): Promise<NcStateSummaryTest> {
    return this.stateSummary.test(rule)
  }

  private enqueueStateSummary(
    rule: NcRule,
    subject: NcRuleSubject,
    origin: NcStateSummaryOrigin,
  ): Promise<NcStateSummaryEnqueued> {
    return runEnqueueStateSummary(this.bootHydrationHost(), rule, subject, origin)
  }

  /**
   * The grouped windows, newest first — the timeline card's read.
   *
   * The STORE, not the live buffer: a card is about arrivals that happened, and
   * the buffer only knows the windows still open on this process. A window's row
   * is written at open and sealed at close (D692), so a window in progress is in
   * the answer too, with `sealed: false`.
   */
  async listTrackGroups(query: NcGroupQuery = {}): Promise<readonly NcGroupRecord[]> {
    return this.groupStore.list(query)
  }

  /**
   * True when this match is a clear / leave edge — the subject for
   * `onTriggerOff`. Raise / enter / ordinary matches use `onTrigger`.
   */
  private isTriggerOffSubject(subject: NcRuleSubject): boolean {
    if (subject.sensorRaised === false) return true
    if (subject.occupancy !== undefined && subject.occupancy.occupied === false) return true
    return false
  }

  private deviceIdForRuleActions(rule: NcRule): number {
    return runDeviceIdForRuleActions(rule)
  }

  private sequenceActionsOf = (
    sequenceId: string,
  ): readonly import('@camstack/types').NcRuleAction[] | undefined =>
    this.sequences.get(sequenceId)?.actions

  private runRuleActions(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    controls: NcIntakeControls,
  ): NcAlarmMatchPhase {
    return runRunRuleActions(this.ruleActionDispatchHost(), rule, subject, kind, controls)
  }

  private autoTriggerAlarmPanel(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
  ): NcAlarmMatchPhase {
    return runAutoTriggerAlarmPanel(this.ruleActionDispatchHost(), rule, subject, kind)
  }

  private alarmRowsHeard(): NcAlarmRowsHeard {
    return runAlarmRowsHeard(this.ruleActionDispatchHost())
  }

  private alarmPushVerdict(
    rule: NcRule,
    deviceId: number,
    phase: NcAlarmMatchPhase,
  ): NcAlarmPushVerdict {
    return runAlarmPushVerdict(this.ruleActionDispatchHost(), rule, deviceId, phase)
  }

  private alarmWindowScope(rule: NcRule): 'camera' | 'rule' {
    return runAlarmWindowScope(this.ruleActionDispatchHost(), rule)
  }

  private intrusionLocationsOf(deviceIds: readonly number[]): readonly string[] {
    return runIntrusionLocationsOf(this.ruleActionDispatchHost(), deviceIds)
  }

  private noteGroupedAlarmPhase(
    rule: NcRule,
    subject: NcRuleSubject,
    phase: NcAlarmMatchPhase,
  ): void {
    return runNoteGroupedAlarmPhase(this.ruleActionDispatchHost(), rule, subject, phase)
  }

  private groupedAlarmPhaseOf(ruleId: string, member: NcGroupedMember): NcAlarmMatchPhase {
    return runGroupedAlarmPhaseOf(this.ruleActionDispatchHost(), ruleId, member)
  }

  /**
   * The muted device that drops this subject, or `undefined` when none does.
   * A per-camera subject: its camera. A linked set: the sensor; else, when
   * the change took rows and every row camera is muted, the sensor too — the
   * line names the muted row cameras.
   */
  private mutedAuthority(subject: NcRuleSubject): number | undefined {
    const sensorId = subject.linkedSensorId
    if (sensorId === undefined) {
      return this.deviceMutes.isMuted(subject.deviceId) ? subject.deviceId : undefined
    }
    if (this.deviceMutes.isMuted(sensorId)) return sensorId
    const rowsMuted =
      (subject.rowCameraIds ?? []).length === 0 && (subject.mutedRowCameraIds ?? []).length > 0
    return rowsMuted ? sensorId : undefined
  }

  private reportMutedDrop(
    subject: NcRuleSubject,
    mutedDeviceId: number,
    kind: NcSubjectKind,
    now: number,
  ): void {
    return runReportMutedDrop(this.buildEntriesHost(), subject, mutedDeviceId, kind, now)
  }

  private reportNoMatch(
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    rejections: readonly string[],
    now: number,
  ): void {
    return runReportNoMatch(this.buildEntriesHost(), subject, kind, rejections, now)
  }
  private buildEntries(
    rule: NcRule,
    subject: NcRuleSubject,
    kind: NcSubjectKind,
    matchedOn: readonly string[] | undefined,
    userTargets: readonly NcRuleTarget[] = [],
    origin: NcEventOrigin = 'pipeline',
    /**
     * The cooldown window this fire is about to consume. Frozen on the row ONLY
     * when a confirm gate could later cancel the delivery — nothing else can
     * hand a window back, and a field nobody reads is a field that rots.
     */
    cooldown?: { readonly key: string; readonly at: number },
    /** D692: what a GROUPED close adds — see {@link NcBuildEntriesExtras}. */
    extras?: NcBuildEntriesExtras,
  ): readonly NcOutboxEnqueueInput[] {
    return runBuildEntries(
      this.buildEntriesHost(),
      rule,
      subject,
      kind,
      matchedOn,
      userTargets,
      origin,
      cooldown,
      extras,
    )
  }

  /** rule→user fan-out caches (60 s users/targets; device routes immutable). */
  private userGrantsCache: readonly NcUserGrant[] | null = null
  private userGrantsAt = 0
  private ownedTargetsCache: ReadonlyMap<string, readonly string[]> | null = null
  private ownedTargetsAt = 0
  private readonly deviceRouteCache = new Map<
    number,
    { stableId: string; addonId: string } | null
  >()
  private userFanoutUnavailableLogged = false

  private async resolveUserTargets(
    rule: NcRule,
    deviceId: number,
  ): Promise<readonly NcRuleTarget[]> {
    return runResolveUserTargets(this.buildEntriesHost(), rule, deviceId)
  }
  private drainSnoozeHost(): DrainSnoozeHost {
    const self = this
    return {
      consumeEvent: (event) => self.consumeEvent(event),
      deliverDueDigests: () => self.deliverDueDigests(),
      get deps() {
        return self.deps
      },
      get dispatcher() {
        return self.dispatcher
      },
      get drainTicks() {
        return self.drainTicks
      },
      set drainTicks(value: number) {
        self.drainTicks = value
      },
      get evalChain() {
        return self.evalChain
      },
      get grouped() {
        return self.grouped
      },
      get groupedSweepQueued() {
        return self.groupedSweepQueued
      },
      set groupedSweepQueued(value: boolean) {
        self.groupedSweepQueued = value
      },
      get intakeOpenedAt() {
        return self.intakeOpenedAt
      },
      get lastFiredAt() {
        return self.lastFiredAt
      },
      get logger() {
        return self.logger
      },
      get notifiedHydrated() {
        return self.notifiedHydrated
      },
      set notifiedHydrated(value: boolean) {
        self.notifiedHydrated = value
      },
      get notifiedTracks() {
        return self.notifiedTracks
      },
      get now() {
        return self.now
      },
      onChain: (name, run, deviceId) => self.onChain(name, run, deviceId),
      get outbox() {
        return self.outbox
      },
      recordSnoozeSuppression: (verdict, input) => self.recordSnoozeSuppression(verdict, input),
      get rules() {
        return self.rules
      },
      get sequenceActionsOf() {
        return self.sequenceActionsOf
      },
      snoozeDecision: (input) => self.snoozeDecision(input),
      get snoozes() {
        return self.snoozes
      },
      get texts() {
        return self.texts
      },
      watermarkAt: (now) => self.watermarkAt(now),
    }
  }

  private releaseCooldown(input: NcCooldownRelease): void {
    return runReleaseCooldown(this.drainSnoozeHost(), input)
  }

  private readBootRecentRows(): Promise<readonly NcOutboxEntry[] | null> {
    return runReadBootRecentRows(this.drainSnoozeHost())
  }

  private hydrateNotifiedTracks(rows: readonly NcOutboxEntry[] | null): Promise<void> {
    return runHydrateNotifiedTracks(this.drainSnoozeHost(), rows)
  }

  private seedCooldowns(rows: readonly NcOutboxEntry[] | null): void {
    return runSeedCooldowns(this.drainSnoozeHost(), rows)
  }

  /**
   * Recompute the watcher's watched key set from the enabled occupancy rules
   * (rule-driven — refreshed on boot + every reload tick). `setWatchedKeys`
   * drops confirmed state for keys no longer watched; the caller then prunes the
   * durable rows to the surviving set.
   */
  /**
   * The clip-retention asks derived from the rule set in memory.
   *
   * Recomputed per call rather than cached: the rule mirror is small (15 rules
   * on the live hub), the derivation is a filter, and a cache here would be one
   * more thing to invalidate on a reload tick — the kind of second copy this
   * change exists to remove.
   */
  private clipRetentionAsks(): readonly NcClipRetentionAsk[] {
    return deriveClipRetentionAsks(this.rules.list())
  }
  private refreshOccupancyWatch(): void {
    return runRefreshOccupancyWatch(this.occupancyWatchHost())
  }

  private pruneAlarmInputBypasses(): void {
    return runPruneAlarmInputBypasses(this.alarmArmHost())
  }
  private observeAlarmOpenings(): Promise<void> {
    return runObserveAlarmOpenings(this.alarmArmHost())
  }

  private reportOccupancyWatch(specs: readonly OccupancyKeySpec[]): void {
    return runReportOccupancyWatch(this.occupancyWatchHost(), specs)
  }

  private reportAudioWatch(entries: readonly NcAudioWatchEntry[]): void {
    return runReportAudioWatch(this.occupancyWatchHost(), entries)
  }

  /** Boot reseed of confirmed occupancy edge-state (durability, constraint 4) —
   *  hydrate the watcher from the store, then prune orphaned durable rows to the
   *  active watched set. Runs AFTER {@link refreshOccupancyWatch} so hydrate
   *  restores only currently-watched keys. */
  private async hydrateOccupancy(): Promise<void> {
    const rows = await this.occupancyStore.load()
    this.occupancyWatcher.hydrate(rows)
    await this.occupancyStore.pruneExcept(this.activeOccupancyKeys())
  }

  private admitAlertEpisode(event: SystemEvent, via: 'bus' | 'reconcile'): boolean {
    return runAdmitAlertEpisode(this.systemEventsHost(), event, via)
  }

  private async hydrateAlertEpisodes(): Promise<void> {
    try {
      const rows = await this.alertEpisodes.load()
      this.logger.info('alert episode ledger reseeded', { meta: { rows } })
    } finally {
      this.alertEpisodesLoaded = true
    }
    await this.reconcileAlertEpisodes()
  }

  async reconcileAlertEpisodes(): Promise<void> {
    return runReconcileAlertEpisodes(this.systemEventsHost())
  }

  private hydrateLiveness(): Promise<void> {
    return runHydrateLiveness(this.bootHydrationHost())
  }

  private reportLivenessDrop(incoming: NcIncomingEvent, verdict: 'seeded' | 'no-flip'): void {
    return runReportLivenessDrop(this.bootHydrationHost(), incoming, verdict)
  }

  /** Rule-reload tick: refresh the rule cache (cross-node CRUD staleness bound),
   *  recompute the occupancy watched set + prune stale durable rows. */
  /**
   * The three cluster settings, read fresh on every use.
   *
   * The fallback is the SHIPPED DEFAULTS rather than "off": an install whose
   * settings have never been opened must still alert on a flat battery, and a
   * wiring that silently disabled the feature would be indistinguishable from
   * a hub with no low batteries on it.
   */
  /**
   * Which rules exist, and at which revision — the question "did anything
   * change that could make an undelivered alert deliverable now?". Cheap: the
   * rule mirror is in RAM and holds tens of rows.
   */
  private rulesFingerprint(): string {
    return this.rules
      .list()
      .map((rule) => `${rule.id}@${String(rule.updatedAt)}`)
      .join('|')
  }

  private deviceAlertSettings(): NcDeviceAlertSettings {
    return (
      this.deps.readDeviceAlertSettings?.() ?? {
        batteryLowPercent: NC_DEVICE_ALERT_FALLBACK.batteryLowPercent,
        renotifyMinutes: NC_DEVICE_ALERT_FALLBACK.renotifyMinutes,
        notifyRecovery: NC_DEVICE_ALERT_FALLBACK.notifyRecovery,
      }
    )
  }
  private async reloadRules(): Promise<void> {
    return runReloadRules(this.systemEventsHost())
  }

  private announceRuleHealth(): void {
    return runAnnounceRuleHealth(this.systemEventsHost())
  }

  onDeviceDeleted(deviceId: number): Promise<void> {
    return runOnDeviceDeleted(this.bootHydrationHost(), deviceId)
  }

  removeDeviceData(deviceId: number): Promise<Record<string, number>> {
    return runRemoveDeviceData(this.bootHydrationHost(), deviceId)
  }

  /**
   * `nc.listPrunes` — every recorded prune, newest first.
   *
   * The evaluating node is the only writer and answers from its mirror. Any
   * other node reads the store AT THE REQUEST (an admin opening one editor)
   * rather than re-querying it on every reload tick; a read that has never
   * succeeded throws rather than answering "nothing pruned" (D315).
   */
  async listPrunes(): Promise<readonly NcPruneRecord[]> {
    if (!this.evaluationActive) await this.pruneLedger.load()
    if (!this.pruneLedger.isLoaded()) throw new Error('the prune record could not be read')
    return this.pruner.listPrunes()
  }

  private reloadTexts(): Promise<void> {
    return runReloadTexts(this.bootHydrationHost())
  }

  private activeOccupancyKeys(): ReadonlySet<string> {
    return runActiveOccupancyKeys(this.occupancyWatchHost())
  }

  private persistSeededOccupancy(now: number): void {
    return runPersistSeededOccupancy(this.occupancyWatchHost(), now)
  }

  private persistOccupancyEdge(edge: OccupancyEdge, now: number): Promise<void> {
    return runPersistOccupancyEdge(this.occupancyWatchHost(), edge, now)
  }

  private persistOccupancyRow(row: OccupancyStateRow, now: number): Promise<void> {
    return runPersistOccupancyRow(this.occupancyWatchHost(), row, now)
  }

  private reconcile(): Promise<void> {
    return runReconcile(this.drainSnoozeHost())
  }

  /**
   * The watermark to persist at `now` (D692 spec §5): never past a grouped window whose
   * message is not written yet — open, or with its close in flight — nor past its earliest
   * member event (`watermarkCeiling`, review T10 HIGH-1a / LOW-5). A crash must replay those
   * events. An event evaluated LATE (stamped before a write, evaluated after it) is the
   * other half: the replay lets an event inside the scan's overlap open a window (C5).
   */
  private watermarkAt(now: number): number {
    return Math.min(now, this.grouped.watermarkCeiling() ?? now)
  }
  private drainTick(): Promise<void> {
    return runDrainTick(this.drainSnoozeHost())
  }

  // ── Snooze ──────────────────────────────────────────────────────────

  private snoozeGate(input: NcSnoozeGateInput): Promise<string | null> {
    return runSnoozeGate(this.drainSnoozeHost(), input)
  }

  private snoozeDecision(input: NcSnoozeGateInput): NcSnoozeVerdict {
    return runSnoozeDecision(this.drainSnoozeHost(), input)
  }

  private recordSnoozeSuppression(
    verdict: NcSnoozeVerdictSuppressed,
    input: NcSnoozeGateInput,
  ): Promise<void> {
    return runRecordSnoozeSuppression(this.drainSnoozeHost(), verdict, input)
  }

  private deliverDueDigests(): Promise<void> {
    return runDeliverDueDigests(this.drainSnoozeHost())
  }

  /** The durable snooze store — the cap provider and the `nc.*` bridge serve
   *  CRUD from it, the same write-through cache the gate reads. */
  get snoozeStore(): NcSnoozeStore {
    return this.snoozes
  }

  createSnooze(input: NcSnoozeInput, caller: NcSnoozeCaller): Promise<NcSnooze> {
    return runCreateSnooze(this.drainSnoozeHost(), input, caller)
  }

  cancelSnooze(snoozeId: string, caller: NcSnoozeCaller): Promise<void> {
    return runCancelSnooze(this.drainSnoozeHost(), snoozeId, caller)
  }
  private dryRunHost(): DryRunHost {
    const self = this
    return {
      get deps() {
        return self.deps
      },
      deviceStateLookup: (read) => self.deviceStateLookup(read),
      get deviceStates() {
        return self.deviceStates
      },
      get logger() {
        return self.logger
      },
      get now() {
        return self.now
      },
      occupancyDryRun: (rule, occupancy, lookup, zoneLookup, sceneLookup) =>
        self.occupancyDryRun(rule, occupancy, lookup, zoneLookup, sceneLookup),
      get sceneStates() {
        return self.sceneStates
      },
      get zoneOwners() {
        return self.zoneOwners
      },
    }
  }

  private validateTargetRefs(targetIds: readonly string[]): Promise<void> {
    return runValidateTargetRefs(this.dryRunHost(), targetIds)
  }

  private dryRun(rule: NcRuleInput, lookbackMinutes: number): Promise<readonly NcTestResult[]> {
    return runDryRun(this.dryRunHost(), rule, lookbackMinutes)
  }

  private occupancyDryRun(
    rule: NcRuleInput,
    occupancy: NcOccupancyCondition,
    lookup: NcDeviceStateLookup,
    zoneLookup: NcZoneOwnerLookup,
    sceneLookup: NcSceneStateLookup,
  ): Promise<readonly NcTestResult[]> {
    return runOccupancyDryRun(this.dryRunHost(), rule, occupancy, lookup, zoneLookup, sceneLookup)
  }
}
