// The audio chunk plane's byte format and its ONE expansion to f32le. On the
// bare entry because both `addon-pipeline` (the broker) and
// `addon-pipeline-orchestrator` (the window accumulator) bundle it into their
// own dist, so the lever ships with `camstack deploy` (D455).
export * from './audio/audio-chunk-format.js'
export type {
  EventOwnerType,
  MediaOwnerKey,
  MediaOwnerKeyInput,
  MediaOwnerType,
  MediaPresenceOwnerKind,
} from './media/media-owner-key.js'
export {
  EVENT_OWNER_TYPES,
  EventOwnerTypeSchema,
  MEDIA_OWNER_TYPES,
  MEDIA_PRESENCE_OWNER_KINDS,
  MediaPresenceOwnerKindSchema,
  formatMediaOwnerKey,
  isEventOwnerType,
  isMediaOwnerType,
  parseMediaOwnerKey,
} from './media/media-owner-key.js'
export type { CapabilitiesAccess } from './addon/base-addon.js'
export { BaseAddon, classifyStoreError, normalizeAddonInitResult } from './addon/base-addon.js'
export { normalizeNodeId } from './addon/per-node-store.js'
export type {
  AddonRouteInvokeRequest,
  AddonRouteReplyEnvelope,
} from './addon/build-addon-route-provider.js'
export { buildAddonRouteProvider } from './addon/build-addon-route-provider.js'
export type {
  BuildSessionLostAlertInput,
  IntegrationSessionBinding,
  IntegrationSessionReporterOptions,
  IntegrationSessionSink,
  SessionAlertAction,
  SessionHealthAlertsPort,
  SessionHealthTrackerOptions,
  SessionLossReason,
  SessionLostInfo,
} from './addon/session-health.js'
export {
  buildSessionLostAlert,
  DEFAULT_SESSION_LOST_DEBOUNCE_MS,
  IntegrationSessionReporter,
  SESSION_LOST_ALERT_CATEGORY,
  SessionHealthTracker,
  sessionLostAlertId,
} from './addon/session-health.js'
export type { DurableState, DurableStateDeps } from './addon/durable-state.js'
export { createDurableState } from './addon/durable-state.js'
// Re-export `IAuthProvider` from the cap definition — single source of
// truth. The legacy `interfaces/auth-provider.ts` (synchronous
// `getLoginUrl(state): string` + AuthResult with `externalId`) was
// shadowed by the cap-inferred type and produced silent type drift
// in OIDC builds. Deleted 2026-05-12.
export type { IAuthProvider } from './capabilities/auth-provider.cap.js'
export type { DisposerChainOptions, DisposerFn } from './disposer-chain.js'
export { DisposerChain } from './disposer-chain.js'
export * from './encode-profile.js'
export * from './camera/stream-pick.js'
export * from './ffmpeg/encode-defaults.js'
// The reader half of the fMP4 sink. Pure and dependency-free, so it sits in the
// bare entry beside the argv builder that produces the bytes it cuts; the plane
// and the child that own state and a process are under `@camstack/types/node`.
export * from './ffmpeg/fmp4-box-splitter.js'
export * from './ffmpeg/hwaccel.js'
// The notification gif's filter chain — shared by the broker's ring derive and
// the notification centre's recorded derive (D682), which may not import each other.
export * from './ffmpeg/gif-derive.js'
// The ONE ffmpeg primitive — argv builder, encode defaults, hwaccel
// resolution and the egress sharing key. Lives here (not in an addon) because
// `addon-pipeline`, `addon-export-hap` and `addon-export-alexa` all need it and
// addons may never import each other. The node-only spawn/lifecycle wrapper is
// under `@camstack/types/node` so browser bundles never traverse
// `node:child_process`.
export * from './ffmpeg/invocation.js'
export * from './ffmpeg/sharing-key.js'
// How a runtime site asks for the node's PINNED ffmpeg (D540) — never PATH.
export * from './ffmpeg/pinned-binary.js'
// The operator's override env var, by name — one spelling, not one per caller.
export { FFMPEG_PATH_ENV } from './deps/ffmpeg-binary-source.js'
export * from './health/wiring-health.js'
// --- Core interfaces (used by addons and server) ---
export type * from './interfaces/addon.js'
export {
  DEFAULT_ADDON_PLACEMENT,
  isAgentOnlyPlacement,
  isDeployableToAgent,
  isIsolatedBuiltin,
  resolveAddonExecution,
  resolveAddonGroup,
  resolveAddonPlacement,
  resolveRunnerId,
} from './interfaces/addon.js'
export type * from './interfaces/addon-data-plane.js'
export { DATAPLANE_SECRET_HEADER, SHARE_VIEW_KINDS } from './interfaces/addon-data-plane.js'
export type * from './interfaces/addon-peer-bytes.js'
export {
  PeerBytesTicketSchema,
  PEER_BYTES_CHUNK_BYTES,
  PEER_BYTES_MAX_OUTSTANDING,
  PEER_BYTES_STALL_MS,
  PEER_BYTES_TICKET_TTL_MS,
} from './interfaces/addon-peer-bytes.js'
export type * from './interfaces/addon-routes.js'
export * from './interfaces/adoption-job.js'
export type * from './interfaces/agent.js'
export type * from './interfaces/agent-protocol.js'
export * from './interfaces/agent-protocol.js'
export type * from './interfaces/alerts.js'
export type * from './interfaces/analysis.js'
export * from './interfaces/analysis-persistence.js'
export type * from './interfaces/api-responses.js'
export type * from './interfaces/api-shared.js'
export type {
  AudioAttachDeviceInput,
  AudioAttachDeviceResult,
  AudioClassificationResult,
  AudioDetachDeviceResult,
  IAudioAnalyzer,
} from './interfaces/audio-analyzer.js'
export type * from './interfaces/audio-inference-engine.js'
export type * from './interfaces/auth.js'
export type * from './interfaces/camera-pipeline.js'
export * from './interfaces/camera-switches.js'
export type * from './interfaces/capability.js'
export type * from './interfaces/config-port.js'
export type * from './interfaces/config-ui.js'
export type { HydratedFieldEntry } from './interfaces/config-ui.js'
export {
  collectHydratedFieldEntries,
  collectHydratedFieldValues,
  dehydrateConfigField,
  dehydrateSchema,
  hydrateSchema,
  resolveHydratedFieldValue,
  WELL_KNOWN_TAB_MAP,
  WELL_KNOWN_TABS,
} from './interfaces/config-ui.js'
export {
  collectKeychainStoredKeys,
  collectSecretConfigKeys,
  omitTransientConfig,
  isKeychainStoredField,
  isSecretConfigField,
  REDACTED_SECRET,
  schemaDeclaresAnyField,
} from './interfaces/config-ui-secrets.js'
export * from './keychain/index.js'
export * from './records/index.js'
export * from './training/index.js'
export * from './retrain-review.js'
export {
  mergeSecretStatePaths,
  parseSecretStatePath,
  type SecretNode,
  type SecretTree,
  secretTreeFromPaths,
  secretTreeFromSchema,
} from './addon/secret-paths.js'
export {
  collectSecretMarkerRefs,
  isSecretRefOwnedBy,
  KeychainWriteRefusedError,
  type ResolvedSecrets,
  resolveSecretMarkers,
  type SecretWriteInput,
  type SecretWriteResult,
  transformSecretWrite,
  type UnresolvedReason,
  type UnresolvedSecret,
} from './addon/secret-settings-view.js'
export type * from './interfaces/context.js'
export * from './interfaces/birth-decision-ledger.js'
export * from './interfaces/debug-note-archive.js'
export * from './interfaces/track-relations.js'
export type * from './interfaces/detection-addon.js'
export type { DeviceEvent, DeviceMetadata, DeviceState } from './interfaces/device.js'
export {
  autoAssignProfiles,
  classifyStream,
  classifyStreams,
  parseCameraStreamConfig,
  streamPixels,
  toStreamSourceEntry,
} from './interfaces/device-capabilities/camera.js'
export type * from './interfaces/device-capabilities/index.js'
export type { IDeviceProvider, LiveEvent, ProviderStatus } from './interfaces/device-provider.js'
export type * from './interfaces/embedding-encoder.js'
export type * from './interfaces/engine-slots.js'
export type * from './interfaces/event-bus.js'
export { createEvent, emitReadiness, isEvent } from './interfaces/event-bus.js'
export * from './interfaces/feature-flags.js'
export type * from './interfaces/ffmpeg.js'
export type * from './interfaces/frame-handle.js'
export type * from './interfaces/inference-capabilities.js'
export type * from './interfaces/inference-engine.js'
export type {
  CreateIntegrationInput,
  IIntegrationRegistry,
  Integration,
} from './interfaces/integration-registry.js'
export type * from './interfaces/kernel-abstractions.js'
export type * from './interfaces/lifecycle.js'
export type * from './interfaces/logging.js'
// The line above is `export type *`, so these VALUE exports need their own line.
export { LOG_LEVEL_RANK, logLevelAtMost } from './interfaces/logging.js'
export type * from './interfaces/metrics-provider.js'
export type * from './interfaces/network.js'
export type * from './interfaces/network-quality.js'
export type * from './interfaces/notification.js'
export * from './interfaces/ops-log.js'
export type * from './interfaces/pipeline-executor-capability.js'
export type * from './interfaces/pipeline-orchestrator-capability.js'
export type * from './interfaces/pipeline-runner.js'
export type * from './interfaces/pipeline-runner-capability.js'
// Cleanup: `addon-settings-resolver.js` deleted. The helpers it
// exported (`iterateConfigFields`, `extractSchemaDefaults`,
// `getDeviceScopedFieldKeys`, `resolveAddonSettings`,
// `filterDeviceScoped`) only existed to back the legacy merging
// `getGlobal / getDevice / updateGlobal / updateDevice` quartet on
// `SettingsResolverService`, which was itself deleted after every
// addon migrated to the raw three-level store API.
export type * from './interfaces/pipeline-slot.js'
export type * from './interfaces/platform.js'
export type * from './interfaces/process.js'
export type * from './interfaces/python-env.js'
export type * from './interfaces/queryable.js'
export type * from './interfaces/raw-tensor-engine.js'
export type * from './interfaces/readiness.js'
export * from './interfaces/recording-config.js'
export * from './interfaces/relocate.js'
export type * from './interfaces/repl.js'
export type * from './interfaces/router.js'
export type * from './interfaces/rtp-egress.js'
export type * from './interfaces/scoped-token.js'
export type * from './interfaces/server-analysis.js'
export * from './interfaces/server-analysis.js'
export type * from './interfaces/server-network.js'
export type * from './interfaces/status-overlay.js'
export type * from './interfaces/device-call-redirect.js'
// --- Server interfaces (consolidated from server/backend/src/interfaces/) ---
export type * from './interfaces/storage.js'
export type {
  LegacyStorageLocationDefault,
  StorageDrainProgress,
  StorageLocation,
  StorageLocationRef,
} from './interfaces/storage-location.js'
export {
  gbToBytes,
  isLocationEnabled,
  LegacyStorageLocationDefaultSchema,
  STORAGE_BYTES_PER_GB,
  StorageDrainProgressSchema,
  StorageLocationRefSchema,
  StorageLocationSchema,
  StorageLocationTypeSchema,
} from './interfaces/storage-location.js'
export type {
  StorageAccess,
  StorageLocationDeclaration,
} from './interfaces/storage-location-declaration.js'
export {
  STORAGE_ACCESS_FALLBACK,
  StorageAccessSchema,
  StorageLocationDeclarationSchema,
} from './interfaces/storage-location-declaration.js'
export type {
  StorageEvictionPolicy,
  StorageLocationMode,
  StorageLocationModePatch,
  StorageLocationStateSource,
} from './interfaces/storage-location-mode.js'
// The ONE interpreter of a storage location's state (D385). Everything that
// asks "may I write / read / evict here" asks these; nothing else in the repo
// may read `config.readOnly` or compare `enabled` —
// `scripts/check-storage-location-mode-single-owner.ts` enforces it.
export {
  evictionPolicyForMode,
  evictionPolicyOfLocation,
  isStorageLocationMode,
  LEGACY_READ_ONLY_CONFIG_KEY,
  legacyModeOf,
  mayReadLocation,
  mayWriteToLocation,
  modeMayRead,
  modeMayWrite,
  resolveLocationMode,
  STORAGE_LOCATION_MODES,
  StorageEvictionPolicySchema,
  StorageLocationModeSchema,
  strippedOfLegacyReadOnly,
  withLocationMode,
} from './interfaces/storage-location-mode.js'
export * from './interfaces/stream-broker.js'
export type * from './interfaces/task-handler.js'
export type { Timezone, TimezoneDstRule, Weekday } from './interfaces/timezones.js'
export { findTimezone, TIMEZONES } from './interfaces/timezones.js'
export type {
  LogChannelDescriptor,
  LogChannelWindow,
} from './logging/log-channel.js'
export {
  LogChannelDescriptorSchema,
  LogChannelGate,
  LogChannelLevelSchema,
  LogChannelRegistry,
  LogChannelWindowSchema,
} from './logging/log-channel.js'
export {
  __resetLogChannelRegistryForTests,
  declareLogChannel,
  getLogChannelRegistry,
} from './logging/log-channel.singleton.js'
export type {
  LogChannelApplyInput,
  LogChannelApplyOut,
  LogChannelsProviderHandle,
  LogChannelsProviderOptions,
} from './logging/log-channel-provider.js'
export { createLogChannelsProvider, LOG_CHANNEL_TICK_MS } from './logging/log-channel-provider.js'
export type {
  FailureCounterSample,
  FailureObservation,
  FailureReasonCount,
} from './metrics/failure-counters.js'
// The per-camera failure counter every "how often does this camera lose work,
// and why" question is answered from. Pure and shared so the addons that
// report through `failure-contribution` all count the same way — a second
// implementation is a second set of denominators (D277).
export {
  FailureCounters,
  failureRate,
  MAX_KEYS,
  MAX_REASONS_PER_KEY,
  OVERFLOW_REASON,
} from './metrics/failure-counters.js'
export type {
  LoadBucket,
  LoadBucketKind,
  LoadPoint,
  LoadProcessRow,
} from './metrics/load-series-fold.js'
// Per-function load folding + the peak-preserving reduction. Browser-safe
// (no imports), because the hub folds the retained series and the admin UI
// folds the live events, and two copies of that arithmetic is two charts
// that disagree about the same node.
export {
  foldSnapshotByFunction,
  ROOT_BUCKET_KEY,
  reducePoints,
  resolveBucketMs,
  UNATTRIBUTED_BUCKET_KEY,
} from './metrics/load-series-fold.js'
export type {
  AwaitReadyOptions,
  ReadinessHandler,
  ReadinessRegistryOptions,
  ReadinessTransition,
} from './readiness/index.js'
// Readiness protocol — cross-process capability lifecycle tracker.
// Spec: docs/superpowers/specs/2026-04-19-system-readiness-design.md
export {
  emitDownForOwnedCaps,
  ReadinessRegistry,
  ReadinessTimeoutError,
  readinessKey,
  scopeKey,
} from './readiness/index.js'
export * from './stream-selection.js'
export type {
  AgentPipelineSettings,
  CameraPipelineSettings,
  DeviceStepConfig,
} from './types/agent-pipeline-settings.js'
export {
  cameraScopedStepSettings,
  isModelScopedStepSettingKey,
  modelScopedStepSettingKeys,
} from './types/agent-pipeline-settings.js'
export {
  NODE_COLOR_IDS,
  NodeColorIdSchema,
  assignNodeColorId,
} from './node-color.js'
export type { NodeColorId } from './node-color.js'
export * from './types/analytics.js'
export * from './types/appearance.js'
export type { CameraPipelineConfig } from './types/camera-pipeline.js'
export * from './types/config.js'
export * from './types/detection.js'
export * from './types/overlay-layer.js'
export type { EngineOutput } from './types/engine-output.js'
export * from './types/entities.js'
export * from './types/events.js'
export type * from './types/frame-view.js'
export * from './types/io.js'
export * from './types/labels.js'
export * from './types/live-state.js'
export * from './types/model-variant-groups.js'
export * from './types/models.js'
export * from './types/clip-model.js'
export * from './types/pipeline.js'
export type {
  AvailableEngine,
  PipelineAddonSchema,
  PipelineDefaultStep,
  PipelineModelOption,
  PipelineSchema,
  PipelineSlotSchema,
} from './types/pipeline-schema.js'
export * from './types/pipeline-step.js'
export * from './types/tracked.js'

// Phase 11 (settings redesign): `schemas/system-settings-schemas.ts`
// deleted. Hub yml sections migrated to the `system-config` built-in
// addon's `getGlobalSettings()` method.

// The one bearer-principal / scope derivation, shared by the kernel,
// server/backend AND addons (which may not import @camstack/system).
export {
  type BearerPayloadShape,
  type BearerPrincipal,
  classifyBearerPrincipal,
  methodAccessForHttpMethod,
  type PrincipalAddonReachInput,
  type PrincipalAddonReachVerdict,
  principalMayReachAddon,
  scopesAllowAddon,
  scopesAllowDeviceCap,
} from './auth/principal-scope.js'
export {
  ADMIN_SCOPE,
  ALL_METHOD_ACCESS,
  type AddonRoutesScope,
  AddonRoutesScopeSchema,
  capabilityScopesOf,
  CREDENTIAL_TOKEN_AUDIENCE,
  CREDENTIAL_TOKEN_KIND,
  isCredentialTokenPayload,
  type CredentialScope,
  CredentialScopeSchema,
  type CredentialTokenClaims,
  CredentialTokenClaimsSchema,
  parseCredentialScopes,
  PREFERENCES_SELF_SCOPE,
  type PreferencesSelfScope,
  PreferencesSelfScopeSchema,
  SHARE_VIEW_MAX_DEVICES,
  scopesAllowAddonRoutes,
  scopesAllowOwnPreferences,
  scopesGrantAdmin,
  type ShareViewGrant,
  ShareViewGrantSchema,
  type ShareViewScope,
  ShareViewScopeSchema,
  shareViewGrantOf,
} from './auth/credential-scope.js'
export {
  DEFAULT_VIEWER_SCOPE,
  featureOfRole,
  type MethodRole,
  type MethodRoleDecl,
  type MethodRoleSource,
  methodRoleOf,
  resolveMethodRole,
  type ViewerAncestorLookup,
  viewerAdmitsDevice,
  type ViewerDeviceAllow,
  ViewerDeviceAllowSchema,
  VIEWER_FEATURE_IDS,
  VIEWER_FEATURES,
  type ViewerFeatureId,
  ViewerFeatureIdSchema,
  type ViewerFeatureSpec,
  viewerHoldsRole,
  type ViewerTokenScope,
  ViewerTokenScopeSchema,
} from './auth/viewer-access.js'
export {
  type PreferenceNamespace,
  PreferenceNamespaceSchema,
  type PreferenceRow,
  PreferenceRowSchema,
  type PreferenceValue,
  PreferenceValueSchema,
  PreferenceDeviceIdSchema,
  type PreferencesChangedSinceInput,
  PreferencesChangedSinceInputSchema,
  type PreferencesChangedSinceOutput,
  PreferencesChangedSinceOutputSchema,
  type PreferencesDeleteInput,
  PreferencesDeleteInputSchema,
  type PreferencesDeleteOutput,
  PreferencesDeleteOutputSchema,
  type PreferencesGetInput,
  PreferencesGetInputSchema,
  type PreferencesGetOutput,
  PreferencesGetOutputSchema,
  type PreferencesPutInput,
  PreferencesPutInputSchema,
  type PreferencesPutOutput,
  PreferencesPutOutputSchema,
  PREFERENCES_MAX_DEVICE_ID_LENGTH,
  PREFERENCES_MAX_NAMESPACES,
  PREFERENCES_MAX_VALUE_BYTES,
  PREFERENCES_NAMESPACE_PATTERN,
} from './schemas/user-preferences.js'
export {
  APP_AUTH_CALLBACK_MAX_LENGTH,
  APP_AUTH_CALLBACK_URLS,
  canonicalizeAppCallback,
  hasUrlScheme,
  parseAppAuthCallback,
} from './auth/app-callback.js'
export {
  APP_FLOW_DEFAULT_REDIRECT,
  APP_FLOW_REFUSAL_MESSAGES,
  APP_FLOW_STATE_PREFIX,
  APP_REFUSED_PATH,
  APP_START_REFUSAL_MESSAGES,
  type AppFlowParse,
  type AppFlowPurpose,
  AppFlowPurposeSchema,
  type AppFlowRefusal,
  type AppFlowRequest,
  type AppPageLang,
  AppPageLangSchema,
  type AppLoginPath,
  AppLoginPathSchema,
  type AppStartRefusal,
  appFlowLocation,
  isAppStartRefusal,
  parseAppFlowRequest,
  parseAppPageLang,
} from './auth/app-flow.js'
export { SSO_STATE_COOKIE, SSO_STATE_COOKIE_MAX_AGE_SEC } from './auth/sso-state.js'
export {
  buildDeviceEnrollmentLink,
  buildDeviceSignatureMessage,
  type CompleteEnrollmentInput,
  CompleteEnrollmentInputSchema,
  type CompleteEnrollmentOutput,
  CompleteEnrollmentOutputSchema,
  DEVICE_CERT_RENEW_WINDOW_DAYS,
  DEVICE_CERT_SIGNATURE,
  DEVICE_CERT_VALIDITY_DAYS,
  DEVICE_ENROLLMENT_TTL_MS,
  DEVICE_NONCE_TTL_MS,
  DEVICE_SAN_CREDENTIAL_PREFIX,
  DEVICE_SAN_USER_PREFIX,
  DEVICE_SIGNATURE_MESSAGE_VERSION,
  type DeviceCertificateLoginMethod,
  DeviceCertificateLoginMethodSchema,
  type DeviceChallenge,
  DeviceChallengeSchema,
  type DeviceCredential,
  DeviceCredentialSchema,
  type DeviceCredentialStatus,
  DeviceCredentialStatusSchema,
  type DevicePlatform,
  DevicePlatformSchema,
  type DeviceProofInput,
  DeviceProofInputSchema,
  type CompleteEnrollmentResult,
  CompleteEnrollmentResultSchema,
  DEFINITIVE_DEVICE_REFUSALS,
  DEVICE_DEFINITIVE_REFUSALS_BEFORE_DELETE,
  DEVICE_REFRESH_REFUSAL_PREFIX,
  deviceRefusalFromMessage,
  type DeviceChallengeResult,
  DeviceChallengeResultSchema,
  DeviceEnrollProofSchema,
  type DeviceRefusal,
  type DeviceRefusalReason,
  DeviceRefusalReasonSchema,
  DeviceRefusalSchema,
  type DeviceRevoker,
  type EnrollSelfInput,
  EnrollSelfInputSchema,
  formatDeviceRevoker,
  isDefinitiveDeviceRefusal,
  type RenewDeviceCertificateResult,
  RenewDeviceCertificateResultSchema,
  type RevokeOwnDeviceCertificateResult,
  RevokeOwnDeviceCertificateResultSchema,
  type DeviceSignaturePurpose,
  DeviceSignaturePurposeSchema,
  type RenewDeviceCertificateOutput,
  RenewDeviceCertificateOutputSchema,
  type StartEnrollmentOutput,
  StartEnrollmentOutputSchema,
  parseDeviceEnrollmentLink,
} from './auth/device-certificate.js'
export {
  advertisedHubOrigins,
  claimedRequestOrigins,
  normalizeOrigin,
  pickRequestOrigin,
  type RequestHeaders,
  requestMountPrefix,
} from './auth/request-origin.js'
// ── Automation recipes — the declarative shape a visual automation is
// authored as, and the generator that compiles one to a core block ──
export type {
  ActionStep,
  AutomationAction,
  AutomationCapStep,
  AutomationCondition,
  AutomationConditionAll,
  AutomationConditionAny,
  AutomationConditionExpression,
  AutomationConditionLeaf,
  AutomationConditionStationaryPresent,
  AutomationConditionNot,
  AutomationConditionOperator,
  AutomationConditionTraceNode,
  AutomationRecipe,
  AutomationRunMode,
  AutomationRunOutcome,
  AutomationRunTrace,
  AutomationRunVerdict,
  AutomationStateDoc,
  AutomationStepTrace,
  AutomationTrigger,
  AutomationTriggerTrace,
  ConditionEvaluation,
  ConditionReader,
  DetectionDecision,
  DetectionTrigger,
  DetectionVars,
  GenerateAutomationBlockInput,
  MirrorRefreshFetchers,
  MirrorRefreshReport,
  MirrorSource,
  StationaryChangedInput,
  StationaryDecision,
  StationaryTrigger,
  StationaryVars,
  TraceNodeOutcome,
  TraceValue,
  TrackLifecycleInput,
} from './automation/index.js'
export {
  ActionStepSchema,
  AutomationActionSchema,
  AutomationCapStepSchema,
  AutomationWaitStepSchema,
  EMPTY_AUTOMATION_STATE,
  mergeSkipTraces,
  AutomationConditionOperatorSchema,
  AutomationConditionSchema,
  AutomationConditionTraceNodeSchema,
  AutomationRecipeSchema,
  AutomationRunModeSchema,
  AutomationRunOutcomeSchema,
  AutomationRunTraceSchema,
  AutomationRunVerdictSchema,
  AutomationStateDocSchema,
  AutomationStepTraceSchema,
  AutomationTriggerSchema,
  AutomationTriggerTraceSchema,
  appendTrace,
  buildTriggerTrace,
  collectMirrorSources,
  ConditionMirror,
  conditionDepth,
  countConditionLeaves,
  DEFAULT_TRACE_KEEP,
  DetectionTriggerFilter,
  detectionClassMatches,
  evaluateConditionTree,
  evaluateStationaryTrigger,
  generateAutomationBlock,
  isSkippedTrace,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  MAX_TRACE_KEEP,
  RunGate,
  skipSignature,
  TraceNodeOutcomeSchema,
  TraceValueSchema,
  validateRecipeBounds,
} from './automation/index.js'
export {
  UnitWarningSchema,
  capUnitResolver,
  normalizeActionUnits,
  normalizeConditionUnits,
  normalizeRecipeUnits,
} from './automation/index.js'
export type { UnitResolver, UnitWarning, UnitsNormalized } from './automation/index.js'
export * from './automation/action.js'
export * from './automation/step-runner.js'
export * from './automation/export-entities.js'
// Per-call node pinning for ctx.api capability calls
export * from './cap-call-context.js'
// ── Capability definitions (Zod-schema-first) ──────────────────
export * from './capabilities/index.js'
export * from './running-state/defaults.js'
export * from './remote/remote-roles.js'
export * from './remote/remote-config.js'
export * from './remote/smartir-draft.js'
export * from './template/template-kinds.js'
export * from './running-state/from-operation.js'
// Our detections joined onto any clip source's listing — one overlap rule (D923).
export * from './clips/clip-event-labels.js'
export * from './device-extension/index.js'
// ── Compositions: composed devices (D659) ────────────────────────────
export * from './composition/index.js'
export {
  APPLE_SA_TO_MACRO,
  AUDIO_MACRO_LABELS,
  getAudioMacroClassIds,
  mapAudioLabelToMacro,
  YAMNET_TO_MACRO,
} from './catalogs/audio-classmap.js'
// Catalogs (coco-classmap stays in types — used by object-detection addon and other consumers)
export {
  COCO_80_LABELS,
  COCO_TO_MACRO,
  DETECTION_MACRO_CLASSES,
  isDetectionMacroClass,
  MACRO_LABELS,
} from './catalogs/coco-classmap.js'
export {
  buildPlusCatalogClassMap,
  type ClassMapMacroTarget,
  PLUS_CATALOG_CLASS_FLOORS,
  PLUS_CATALOG_TO_MACRO,
  PLUS_CATALOG_UNMAPPED_LABELS,
  PLUS_CATALOG_STOCK_CLASS_FLOORS,
  plusCatalogDefaultClassFloors,
  type PlusCatalogLabelFields,
  plusCatalogLabelFields,
} from './catalogs/plus-catalog-classmap.js'
export {
  allowedSuppliedEffect,
  containingParentIndex,
  CROP_SUPPLY_SOURCES,
  CROP_SUPPLY_STEP_IDS,
  type CropSupplySource,
  type CropSupplyStepId,
  deriveMaskSupplies,
  deriveRootSupplies,
  describeRootSupplies,
  describeRootSupply,
  isLabelSupplyStepId,
  isRootSuppliableStepId,
  LABEL_SUPPLY_MACRO,
  LABEL_SUPPLY_STEP_IDS,
  LABEL_SUPPLY_VOCABULARIES,
  type LabelSupplyStepId,
  LINKED_LABEL_STEP_PREFIX,
  linkedLabelStepId,
  MASK_EMITTING_POSTPROCESSORS,
  MASK_SUPPLY_STEP_IDS,
  type MaskSupplyStepId,
  linkedStepOf,
  readUseRootModel,
  resolveRootSupply,
  ROOT_CHILD_CONTAINMENT_MIN,
  ROOT_SUPPLIABLE_STEP_IDS,
  rootSuppliesOf,
  rootSupplyServes,
  type RootSuppliableStepId,
  type RootSupplyInactiveReason,
  type RootSupplyState,
  type RootSupplyStepDefaults,
  type SupplyBox,
  type SupplyClassMap,
  supplyFor,
  USE_ROOT_MODEL_DEFAULTS,
  USE_ROOT_MODEL_SETTING_KEY,
} from './catalogs/root-model-supply.js'
export {
  DEVICE_STATE_READERS,
  readDeviceStateFrom,
  stateVocabularyFor,
} from './catalogs/device-state-vocabulary.js'
export {
  colorForKind,
  DEFAULT_EVENT_COLOR,
  EVENT_TAXONOMY,
  type EventTaxonomyCategory,
  type EventTaxonomyEntry,
  type EventTaxonomyLevel,
  getTaxonomyEntry,
  subKindsOf,
} from './catalogs/event-taxonomy.js'
export {
  bundledCamstack,
  DISPLAY_PRESETS,
  formatPaletteViolations,
  mergeOverrides,
  paintHex,
  paletteFromInput,
  paletteFromStored,
  PaletteRejectedError,
  paletteResultSchema,
  paletteSwatchSchema,
  presetById,
  setPaletteInputSchema,
  storedFromReady,
  storedPaletteSchema,
  swatchHex,
  validatePalette,
  type DisplayPreset,
  type PaletteReady,
  type PaletteResult,
  type PaletteSwatch,
  type PaletteSwatchMap,
  type PaletteVerdict,
  type PaletteViolation,
  type SetPaletteInput,
  type StoredPalette,
} from './catalogs/display-palette.js'
export {
  AUDIO_GRADIENT_ALPHAS,
  PALETTE_BACKGROUNDS,
  PALETTE_ENTRY_IDS,
  PALETTE_MIN_CONTRAST,
  PALETTE_MIN_DELTA_E,
  PALETTE_MIN_DELTA_E_MARK,
  PALETTE_PRESET_IDS,
  type PaletteBackground,
  type PaletteEntryId,
  type PalettePresetId,
} from './catalogs/display-palette.js'
export {
  paletteEntryLabel,
  paletteLegend,
  type PaletteLegendGroup,
  type PaletteLegendItem,
} from './catalogs/palette-legend.js'
export {
  buildNcTaxonomy,
  NC_TAXONOMY,
  type NcTaxonomy,
  type NcTaxonomyEntry,
  NcTaxonomyEntrySchema,
  NcTaxonomySchema,
} from './catalogs/nc-taxonomy.js'
// THE cap→"active boolean" table and its pure edge evaluator. Shared by the
// recorder's sensor recording trigger, the post-analysis sensor markers, the
// orchestrator's camera-sensors bridge and the composed doorbell's sources —
// one table, never two (D62).
export {
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorEdge,
  evaluateSensorLevelEdge,
  isSourceCap,
  type SensorEdgeIgnoreReason,
  type SensorEdgeInput,
  type SensorEdgeVerdict,
  type SensorLevelEdgeInput,
  type SensorLevelEdgeVerdict,
  SOURCE_CAP_ACTIVE_FIELD,
  SOURCE_CAP_CHANGED_AT_FIELD,
  SOURCE_CAPS,
  SOURCE_DEVICE_TYPES,
  sliceActiveValue,
  sliceChangedAt,
} from './catalogs/sensor-active-state.js'
// Constants
export * from './constants.js'
export type { AccessoryKindValue } from './device/accessory.js'
// Accessory child helpers (kind alias + label map + stableId).
export {
  ACCESSORY_LABEL,
  AccessoryKind,
  accessoryStableId,
} from './device/accessory.js'
export type {
  AccessoryChildrenAnswer,
  AccessoryChildrenComplete,
  AccessoryChildrenRead,
  AccessoryChildrenUnknown,
  AccessoryChildSpec,
} from './device/base-device.js'
export {
  accessoryChildrenComplete,
  accessoryChildrenUnknown,
  BaseDevice,
} from './device/base-device.js'
export type {
  DeviceRestoreReport,
  DeviceSummary,
  DiscoveryCandidate,
  FieldProbeResult,
} from './device/base-device-provider.js'
export { BaseDeviceProvider, toDeviceSummary } from './device/base-device-provider.js'
// The ONE derivation of "asleep vs gone" for a battery device (D173).
export type { BatteryPresence, BatteryPresenceInput } from './device/battery-presence.js'
export {
  BATTERY_UNREACHABLE_AFTER_MS,
  deriveBatteryPresence,
  isBatteryPresenceFault,
} from './device/battery-presence.js'
// Camera device interface + stream sources
export type { ICameraDevice, StreamSourceEntry } from './device/camera-device.js'
export {
  CONTAINER_CHILD_PRIORITY,
  type ContainerChildRef,
  resolveContainerPrimaryChild,
} from './device/container-primary-child.js'
export {
  expandContainer,
  legacyAutoLinkIds,
  type LinkCandidate,
} from './device/linked-device-resolve.js'
export type {
  DeclarationPlacement,
  DeclaredDeviceOutcome,
  DeclaredDevicePorts,
  DeclaredDeviceRow,
  DeclaredDevicesResult,
  DeclaredDevicesSpec,
  DeclaredIntegrationRow,
  DeviceDeclaration,
} from './device/declared-device.js'
// Declared devices — the ownership primitive for a device an addon declares
export {
  DECLARED_DEVICE_SWEEP_LIMIT,
  DECLARED_INTEGRATION_FIXED_KEY,
  DeclaredDevices,
  declarationOwnerNodeId,
} from './device/declared-device.js'
export type {
  ExposeBlockDevicesInput,
  ReconcileBlockDevicesInput,
} from './device/block-declared-devices.js'
export { exposeBlockDevices, reconcileBlockDevices } from './device/block-declared-devices.js'
// Device interface (canonical — new architecture)
export type { IDevice } from './device/device.js'
export type { DeviceBinding, DeviceBindingEntry } from './device/device-binding.js'
// Device config + base class
export { DeviceConfig } from './device/device-config.js'
// Device context
export type {
  DeviceConstructor,
  DeviceContext,
  DeviceManagerApi,
  DevicePersistConfigOptions,
  IDeviceRegistry,
  IDeviceRegistryReader,
} from './device/device-context.js'
export { widenDeviceConstructor } from './device/device-context.js'
export type {
  AccessoryControlInput,
  AccessoryControlKind,
  AccessoryControlPick,
  DeviceControlKind,
  SensorMapping,
} from './device/device-control-resolution.js'
// Device-control RESOLUTION LOGIC — presentation-free single source for
// "device type (+ features) → which control". Consumed by admin-ui's
// ui-library web registry and (post-publish) the RN viewer accessory registry.
export {
  DEVICE_TYPE_CONTROL_KIND,
  hasMotionTrigger,
  isNode,
  MOTION_TRIGGER_FEATURE,
  pickAccessoryControl,
  resolveDeviceControlKind,
  resolveMutate,
  SENSOR_FEATURES,
  SENSOR_MAP,
} from './device/device-control-resolution.js'
export type { DeviceDoAction, DeviceDoOpenArg } from './device/device-do-actions.js'
export {
  actionsForBoundCaps,
  actionsForDevice,
  actionsForDevices,
  actionsForDeviceType,
  allDoActions,
  DEVICE_DO_ACTIONS,
  DEVICE_TYPE_DO_CAPS,
  deviceDoFamily,
  doActionSelectValue,
  isDoActionActuatable,
  isDoPickerDeviceType,
  matchDoAction,
  sameDoFamily,
} from './device/device-do-actions.js'
// The cap vocabulary (D920): every cap's actions and triggers, phrased. The
// resolver is re-exported under `vocabulary…` names — `actionsForDevice` above
// is the older Do-picker helper with a different signature.
export type {
  CapVocabularyEntry,
  CapVocabularyMap,
  L10n as VocabL10n,
  LooseCapVocabularyEntry,
  LooseVocabOffer,
  LooseVocabOpenArg,
  ResolvedBooleanTrigger,
  ResolvedEnumTrigger,
  ResolvedEnumValue,
  ResolvedEventTrigger,
  ResolvedNumericTrigger,
  ResolvedValueTrigger,
  ResolvedVocabAction,
  ResolvedVocabTrigger,
  VocabBindingsInput,
  VocabCapName,
  VocabLocale,
} from './device/cap-vocabulary/index.js'
export {
  actionsForDevice as vocabularyActionsForDevice,
  CAP_VOCABULARY,
  CAP_VOCABULARY_BY_NAME,
  renderVocabPhrase,
  triggersForDevice as vocabularyTriggersForDevice,
  VOCAB_TEMPLATES,
} from './device/cap-vocabulary/index.js'
// Device-link value transform
// Device management
export type {
  ChildLayout,
  ChildLayoutEntry,
  CreateDeviceSpec,
  DeviceCapDisplayOverride,
  DeviceDiscovery,
  DeviceDisplayOverride,
  DeviceManualCreation,
  DeviceMeta,
  DiscoveredDevice,
  InitialDeviceMeta,
  RoleDisplayDefault,
  SavedDevice,
} from './device/device-management.js'
export type {
  DeviceProfile,
  DeviceProfileDefaults,
  DeviceProfileMatch,
  PipelinePhaseMode,
} from './device/device-profile.js'
// Device profiles — declarative defaults applied to feature-matched devices.
export {
  BATTERY_DEVICE_PROFILE,
  DEVICE_PROFILES,
  deviceMatchesProfile,
  resolveDeviceProfile,
} from './device/device-profile.js'
export type {
  DeviceRestoreRetrySchedulerOptions,
  InitialRestoreFailure,
  PermanentRestoreFailure,
  PermanentRestoreFailureHandler,
  RestoreAttemptFn,
} from './device/device-restore-retry.js'
export {
  DEVICE_RESTORE_RETRY_CONCURRENCY,
  DEVICE_RESTORE_RETRY_DELAYS_MS,
  DeviceRestoreRetryScheduler,
} from './device/device-restore-retry.js'
export type {
  IDeviceRuntimeState,
  RuntimeStateWriteFailed,
  RuntimeStateWriter,
} from './device/device-runtime-state.js'
export { DeviceRuntimeState } from './device/device-runtime-state.js'
export type {
  SliceEventBus,
  SliceHandle,
  SliceHandleApi,
  SliceHandleSource,
} from './device/device-state-handle.js'
export {
  createEventBusSliceSource,
  createLazyTrpcSource,
  createMirrorSource,
  createSliceHandle,
} from './device/device-state-handle.js'
// ── Device architecture ──────────────────────────────────────────────
// DeviceType (enum), DeviceFeature, ChargingStatus, DeviceRole
export { ChargingStatus, DeviceFeature, DeviceRole, DeviceType } from './device/device-type.js'
export {
  APPLIANCE_EXPORT,
  type ApplianceExportDecision,
  type ApplianceExportEcosystem,
  type ApplianceExported,
  type ApplianceNotExported,
  type PlugApplianceType,
  PLUG_APPLIANCE_TYPES,
  applianceExport,
  isPlugApplianceType,
} from './device/appliance-export.js'
// Device feature interfaces
export type {
  IBatteryOperated,
  IDoorbellButton,
  INativeSnapshot,
  IPanTiltZoom,
  IRebootable,
  ITwoWayAudio,
} from './device/features.js'
// Immutable dot-path get/set utilities
// The ONE icon catalog (D854): every lucide icon both surfaces can draw. Icons
// are picked and stored by catalog key everywhere — a device's display override,
// a location, a site zone, a viewer accessory, an `icon` settings field.
export type {
  IconCategoryId,
  IconEntry,
  IconHit,
  IconKey,
} from './device/icon-catalog.js'
export {
  ICON_CATALOG_SOURCE,
  ICON_CATEGORIES,
  ICON_ENTRIES,
  ICON_KEYS,
  ICON_VIEWER_MODULES,
  IconKeySchema,
  canonicalIconKey,
  iconCategoryLabel,
  iconEntry,
  iconsInCategory,
  isIconKey,
  resolveIconKey,
  searchIcons,
} from './device/icon-catalog.js'
// The join key (`locationIconKey`) every surface must derive a location icon through.
export type {
  LocationDescriptionAssignment,
  LocationIconAssignment,
} from './device/location-icon.js'
export {
  LOCATION_ICON_FALLBACK,
  LOCATION_DESCRIPTION_MAX,
  LocationDescriptionAssignmentSchema,
  LocationIconAssignmentSchema,
  locationIconKey,
} from './device/location-icon.js'
export { getByPath, setByPath } from './device/path-util.js'
export type {
  ReachabilityPollHandle,
  ReachabilityPollLogger,
  ReachabilityPollOptions,
} from './device/reachability-poll.js'
export {
  REACHABILITY_FAILURES_TO_OFFLINE,
  REACHABILITY_POLL_INTERVAL_MS,
  REACHABILITY_PROBE_TIMEOUT_MS,
  startReachabilityPoll,
} from './device/reachability-poll.js'
export type {
  RuntimeStateBridge,
  RuntimeStateStaleReadPolicy,
} from './device/runtime-state-helpers.js'
export {
  createRuntimeStateBridge,
  OPERATOR_WRITTEN_STALE_MS,
  RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS,
} from './device/runtime-state-helpers.js'
export type { WireableField } from './device/schema-fields.js'
// Cap status schema → wireable leaf field enumerator (wiring UI field pickers)
export {
  enumerateItemArrayFields,
  enumerateSchemaFields,
  unwrapSchema,
} from './device/schema-fields.js'
export type { SourceInfo } from './device/source-info.js'
// SourceInfo (upstream-system identity + rendering hints)
export {
  extractSourceInfoFromMetadata,
  mergeSourceInfo,
  normalizeUnit,
  SOURCE_INFO_METADATA_KEY,
  SourceInfoSchema,
  synthesizeSourceInfo,
} from './device/source-info.js'
export type {
  DeviceCapListener,
  DeviceLifecycleListener,
  DeviceQueryFilters,
  StringMatch,
  SystemMirrorApi,
  SystemMirrorListener,
} from './device/system-mirror.js'
export { SystemMirror } from './device/system-mirror.js'
export type { DeviceConfigEntry } from './device/zod-to-config-ui.js'
// Zod → ConfigUISchema converter
export { zodEntriesToConfigUI } from './device/zod-to-config-ui.js'
export { collectZodSecretPaths, isZodSecret, SECRET_META } from './device/zod-secret.js'
// Enums
export {
  EventCategory,
  isOwnerOnlyEventCategory,
  OWNER_ONLY_EVENT_CATEGORIES,
  publicEventCategories,
} from './enums/event-category.js'
// Enums
export * from './enums/index.js'
export type {
  CompileResult,
  EvaluateExpressionSourceResult,
  ExpressionBinaryOperator,
  ExpressionBindingSource,
  ExpressionBuiltin,
  ExpressionEvalHooks,
  ExpressionEvalOptions,
  ExpressionFieldBinding,
  ExpressionGlobalBinding,
  ExpressionLiteralBinding,
  ExpressionLogicalOperator,
  ExpressionNode,
  ExpressionNodePath,
  ExpressionSource,
  ExpressionSourceInput,
  ExpressionUnaryOperator,
  ExpressionValue,
  CountCallState,
  RoseCallState,
  StatefulCallState,
  StatefulCallInvocation,
  StatefulExpressionEnvironment,
  StatefulExpressionMemory,
  StatefulExpressionBuiltin,
  Keyword,
  ParsedExpression,
  Punctuator,
  Token,
} from './expression/index.js'
// ── Safe expression engine — the derivation language of a composed device
// and the escape-hatch leaf of an automation's condition tree ───────
export {
  compileExpression,
  compileExpressionSafe,
  cloneStatefulExpressionMemory,
  createExpressionScope,
  createStatefulExpressionMemory,
  EXPRESSION_BUILTIN_NAMES,
  EXPRESSION_BUILTINS,
  EXPRESSION_COMPILE_CACHE_CAPACITY,
  EXPRESSION_IDENTIFIER_RE,
  EXPRESSION_INJECTED_NOW,
  ExpressionBindingSourceSchema,
  ExpressionEvalError,
  ExpressionFieldBindingSchema,
  ExpressionGlobalBindingSchema,
  ExpressionLiteralBindingSchema,
  ExpressionParseError,
  ExpressionSourceSchema,
  evaluateAst,
  evaluateCount,
  disarmRoseMemory,
  evaluateExpressionSource,
  evaluateRose,
  evaluateStatefulExpressionCall,
  isStatefulBuiltin,
  MAX_EXPRESSION_AST_NODES,
  MAX_EXPRESSION_BINDINGS,
  MAX_EXPRESSION_CALL_ARGS,
  MAX_EXPRESSION_EVAL_STEPS,
  MAX_EXPRESSION_SOURCE_LENGTH,
  parseExpression,
  RESERVED_BINDING_NAMES,
  toExpressionValue,
  tokenize,
  validateExpressionSource,
} from './expression/index.js'
export type { AddonApi, AppRouter } from './generated/addon-api.js'
export type { CapNameWithStatus, CapStatusTypeMap } from './generated/cap-status-types.js'
// ── Generated capability status map (codegen) ────────────────────────
export { CAP_NAMES_WITH_STATUS } from './generated/cap-status-types.js'
export type { CapabilityName, CapabilityRouterMap } from './generated/capability-router-map.js'
// ── Generated capability router map (codegen) ────────────────────────
export {
  ALL_CAPABILITY_DEFINITIONS,
  CAPABILITY_NAMES,
  CAPABILITY_ROUTER_KEYS,
} from './generated/capability-router-map.js'
export type { DeviceProxy } from './generated/device-proxy.js'
export { createDeviceProxy } from './generated/device-proxy.js'
export { DEVICE_SCOPED_CAPS, isDeviceScopedCap } from './generated/device-scoped-caps.js'
export type { MethodAccessRecord } from './generated/method-access-map.js'
// ── Generated method access map (codegen) ────────────────────────────
export {
  DEVICE_CAP_NAMES,
  KNOWN_CAP_NAMES,
  METHOD_ACCESS_MAP,
  SYSTEM_CAP_NAMES,
} from './generated/method-access-map.js'
// ── Generated method device selectors (codegen) ──────────────────────
export type { DeviceRefField, DeviceRefForm } from './generated/method-device-selectors.js'
export {
  METHOD_DEVICE_SELECTORS,
  SYSTEM_SCOPE_DEVICE_METHODS,
} from './generated/method-device-selectors.js'
// ── Generated provider-kind map (codegen) ────────────────────────────
export {
  CAP_PROVIDER_KIND_MAP,
  getCapsByProviderKind,
  PROVIDER_KIND_CAP_NAMES,
} from './generated/provider-kind-map.js'
// ── Generated runtime-state durability policy (codegen) ──────────────
export type { RuntimeStatePolicy } from './generated/runtime-state-durability.js'
export {
  isRestoredCap,
  RESTORED_CAP_NAMES,
  RUNTIME_STATE_POLICY,
  runtimeStatePolicyFor,
} from './generated/runtime-state-durability.js'
// ── Producer-side bucket accumulator for device-history (D850) ───────
export {
  BucketAccumulator,
  bucketStartOf,
  type ClosedHistoryBucket,
  HISTORY_BUCKET_MS,
  MAX_REQUEUED_BUCKETS_PER_SERIES,
} from './history/bucket-accumulator.js'
// ── Generated history catalog (codegen, D850) ────────────────────────
export {
  HISTORY_CATALOG,
  HISTORY_ITEM_CATALOG,
  HISTORY_NONE_CAPS,
  historyFieldsFor,
} from './generated/history-catalog.js'
export { CAP_CUSTOMIZE_CATALOG } from './generated/customize-catalog.js'
export type {
  CustomizeCatalog,
  CustomizeCatalogField,
  CustomizeCatalogSource,
  CustomizeCatalogTarget,
  CustomizeCatalogTransform,
} from './capabilities/customize-catalog.js'
export { CAP_RUNTIME_FIELD_UNITS } from './generated/customize-catalog.js'
export { runtimeFieldUnit } from './capabilities/runtime-field-unit.js'
export {
  compositionFillStatus,
  decodeCompositionToCards,
  formulaProblem,
  primaryCapForRole,
  problemsBlockSave,
} from './composition/cards/index.js'
export type { CompositionFillStatus } from './composition/cards/index.js'
export type {
  CapabilityCustomizeSpec,
  CapabilityCustomizeTarget,
  CustomizeCardinality,
  CustomizeEventEdge,
  EventCustomizeTarget,
  PulseEventCustomizeTarget,
  SpanEventCustomizeTarget,
} from './capabilities/customize-spec.js'
export {
  CustomizeAssignmentStatusSchema,
  OverrideDraftSchema,
  type CustomizeAssignmentStatus,
  type OverrideDraft,
} from './composition/customize/override-draft.js'
export {
  compileScalarOverride,
  type ScalarCompileInput,
  type ScalarValueKind,
} from './composition/customize/scalar-compile.js'
export {
  decodeScalarOverride,
  type ScalarDecoded,
  type ScalarDecodeInput,
} from './composition/customize/scalar-decode.js'
export {
  mergeScalarTarget,
  targetFeature,
  ownedSlice,
  removeScalarTarget,
  scalarTargetCount,
} from './composition/customize/scalar-merge.js'
export {
  projectScalarAssignment,
  type ScalarAssignmentProjection,
  type ScalarRead,
  type ScalarSourcePresence,
  type ScalarStatusInput,
} from './composition/customize/scalar-status.js'
export {
  compilePulseOverride,
  compileSpanOverride,
  type PulseCompileInput,
  type SpanCompileInput,
  type SpanCompiled,
} from './composition/customize/event-compile.js'
export {
  decodePulseOverride,
  type PulseDecodeInput,
  type PulseDecoded,
} from './composition/customize/event-decode.js'
export {
  INITIAL_PULSE,
  INITIAL_SPAN,
  stepPulse,
  stepSpan,
  type LevelSample,
  type PulseState,
  type SpanState,
  type SpanTiming,
} from './composition/customize/event-eval.js'
export {
  projectPulseAssignment,
  projectSpanAssignment,
  type PulseAssignmentProjection,
  type PulseStatusInput,
  type SpanAssignmentProjection,
  type SpanRead,
  type SpanSensorRow,
} from './composition/customize/event-status.js'
export {
  compileKeyedArrayOverride,
  mergeKeyedArrayItem,
  withoutKeyedArrayItem,
  type KeyedArrayCompileInput,
  type KeyedArrayItemCompile,
  type KeyedArrayLiteral,
  type KeyedSourceValueKind,
} from './composition/customize/keyed-array-compile.js'
export {
  decodeKeyedArrayOverride,
  readKeyedArrayItems,
  type KeyedArrayItemView,
  type KeyedArrayRead,
} from './composition/customize/keyed-array-decode.js'
export {
  projectKeyedArrayAssignment,
  type KeyedArrayAssignmentProjection,
  type KeyedArrayStatusInput,
} from './composition/customize/keyed-array-status.js'
export type { ScopePresetId, ScopePresetSpec } from './generated/scope-presets.js'
export { SCOPE_PRESETS } from './generated/scope-presets.js'
export type { SystemProxy } from './generated/system-proxy.js'
export { createSystemProxy } from './generated/system-proxy.js'
// Audio codec session types
export type {
  AudioCodecInfo,
  AudioDecodeSessionConfig,
  AudioEncodedChunk,
  AudioEncodeSessionConfig,
  AudioPcmChunk,
  PcmSampleFormat,
} from './interfaces/audio-codec.js'
export type { StreamQuality } from './interfaces/device-capabilities/camera.js'
export {
  STREAM_QUALITY_LABELS,
  streamQualityLabel,
} from './interfaces/device-capabilities/camera.js'
// Lifecycle management (job engine data model)
export * from './lifecycle/index.js'
// ── The audio amplitude scale, and the instant it changed (D459) ────────────
export {
  AUDIO_SCALE_EPOCH_ISO,
  AUDIO_SCALE_EPOCH_MS,
  type AudioScaleEra,
  audioScaleEraOf,
  G711_SCALE_CORRECTION_DB,
  type G711Law,
  ituDbfsFromPreEpoch,
} from './audio/audio-scale-epoch.js'
// ── Sustained-sound condition authoring (pure; shared by every editor) ──────
export {
  audioIsFailClosed,
  audioKindId,
  audioLabelChoices,
  audioModeOf,
  audioOrDefaults,
  isAudioLabelSelected,
  NC_AUDIO_CONFIRM_HITS_DEFAULT,
  NC_AUDIO_CONFIRM_HITS_MAX,
  NC_AUDIO_CONFIRM_HITS_MIN,
  NC_AUDIO_CONFIRM_WINDOW_MAX_SEC,
  NC_AUDIO_CONFIRM_WINDOW_MIN_SEC,
  NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT,
  NC_AUDIO_DB_MAX,
  NC_AUDIO_DB_MIN,
  NC_AUDIO_DB_OFFERED,
  NC_AUDIO_DB_STEP,
  NC_AUDIO_DEFAULTS,
  NC_AUDIO_HIT_PERCENT_MAX,
  NC_AUDIO_HIT_PERCENT_MIN,
  NC_AUDIO_SAMPLING_MAX_SEC,
  NC_AUDIO_SAMPLING_MIN_SEC,
  type NcAudioLabelChoice,
  type NcAudioMode,
  type NcAudioPatch,
  normalizeAudioLabel,
  patchAudio,
  toggleAudioLabel,
} from './notification/audio-condition.js'
// ── Notification-rule condition pickers (pure; shared by admin UI + viewer) ──
export {
  isAudioClassName,
  isBaseConditionKey,
  knownValues,
  NC_BASE_CONDITION_KEYS,
  type NcBaseConditionKey,
  pickerForCondition,
  pickerForRuleClasses,
  type TaxonomyGroup,
  type TaxonomyOption,
  type TaxonomyPicker,
} from './notification/condition-taxonomy.js'
// ── Notification degrade engine (pure, capability-gated) ────────────
export {
  type PreparedAction,
  type PreparedAttachment,
  type PreparedNotification,
  prepareNotification,
  type ResolvedLevel,
} from './notification/degrade-engine.js'
export { deliveryParamsDeclaredBy, resolveDeliveryParams } from './notification/delivery-params.js'
export {
  htmlToText,
  markdownToHtmlLite,
  markdownToText,
  type NotificationFormat as NotificationBodyFormat,
  resolveFormat,
  textToHtml,
  transcodeBody,
} from './notification/format-transcode.js'
// ── Schedule windows (shared by notification rules and OSD bindings) ──
// ── Rule KIND + SECTION model (pure; shared by admin UI + viewer) ────
// Which kind of rule this is, which fields that kind actually has (each
// exclusion carrying the engine reason shown to the operator), which list
// section it lives in, and what a seeded "New <kind> rule" opens on. The admin
// UI still holds a pinned local copy — MF-singleton lag, see the module
// docblock and `docs/design/2026-08-19-viewer-notification-rule-parity.md`.
export {
  conditionExclusionReason,
  conditionVisibleForKind,
  defaultDeliveryForSection,
  droppedConditionsForKind,
  isAudioRule,
  isOccupancyRule,
  isSystemDelivery,
  isSystemRuleKind,
  kindsForDiscriminator,
  NC_AUDIO_SEED,
  NC_CAMERA_SCOPE_CAP_NAME,
  NC_OCCUPANCY_DEFAULTS,
  NC_RULE_EDITOR_SECTION_ORDER,
  NC_RULE_KIND_SPECS,
  NC_RULE_SECTIONS,
  NC_SYSTEM_DELIVERY,
  NC_SYSTEM_RULE_KINDS,
  type NcDroppedCondition,
  type NcKindVisibilitySubject,
  type NcRuleEditorSection,
  type NcRuleEditorSectionKey,
  type NcRuleKind,
  type NcRuleKindSpec,
  type NcRuleOwningSectionKey,
  type NcRuleSection,
  type NcRuleSectionKey,
  type NcRuleConditionsSubject,
  type NcRuleSectionSubject,
  type NcRuleSeed,
  parseRuleSection,
  ruleDeviceCompatCapNames,
  ruleDeviceCompatCapQueries,
  ruleEditorSectionsForKind,
  ruleGroupingApplies,
  ruleKindOf,
  ruleKindSpec,
  ruleMatchesSection,
  ruleSection,
  ruleSectionOf,
  ruleSeedForSection,
  systemFamilyOfKind,
  systemRuleKindOf,
} from './notification/rule-kinds.js'
export {
  imageModesForKind,
  legacyImageMode,
  NC_MEDIA_IMAGE_MODES,
  type NcMediaRuleSubject,
  ncMediaPolicyError,
  normalizeNcMediaPolicy,
  resolveNcMediaImage,
  ruleTriggerZoneIds,
  subjectHasPath,
} from './notification/media-image.js'
export { isScheduleActive } from './notification/schedule.js'
// ── Subject path: the one geometry of a track's path over a frame ────
export {
  buildSubjectPath,
  isDrawableSubjectPath,
  projectSubjectPath,
  SUBJECT_PATH_DWELL_EPS,
  SUBJECT_PATH_FULL_FRAME_COVERAGE,
  SUBJECT_PATH_MAX_POINTS,
  type SubjectPath,
  type SubjectPathNode,
  type SubjectPathOptions,
  type SubjectPathPoint,
  type SubjectPathRect,
  type SubjectPathSample,
  subjectPathSampleFromBox,
  subjectPathSvgPoints,
} from './geometry/subject-path.js'
// ── Sensor edge of a device-event rule (D640) ────────────────────────
export {
  isAlarmControllableCap,
  NC_ALARM_CONTROLLABLE_CAPS,
  NC_ALARM_OPENING_EVENT_KINDS,
  NC_SENSOR_TRANSITION_NEVER_FIRES_WARNING,
  type NcAlarmControllableCap,
  type NcAlarmMembershipSubject,
  type NcAlarmOpeningEventKind,
  ruleAutoTriggersAlarm,
  ruleBelongsToAlarm,
  ruleGatedOnArmedState,
  sensorTransitionNeverFires,
} from './notification/alarm-membership.js'
export {
  alarmDeviceBlocksArming,
  alarmDeviceSecureOnArm,
  type AlarmDeviceBlocksInput,
  type AlarmDeviceSecureOnArmInput,
  type NcAlarmSecureActuation,
  secureActuationFor,
} from './notification/alarm-controllable.js'
// ── Alarm settings: inheritance, patch application, landed check (D697) ──
export {
  alarmPatchLanded,
  applyBlockingEdit,
  applyModeDelaysEdits,
  applyModeDeviceListEdit,
  applyNonBlockingEdit,
  applySecureOnArmEdit,
  derivePostTriggeredAction,
  NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
  NC_ALARM_DELAY_FIELDS,
  NC_ALARM_NOTIFY_FIELDS,
  type NcAlarmDelayField,
  type NcAlarmDelaySettings,
  type NcAlarmDelaySource,
  type NcAlarmModeDeviceListEditResult,
  type NcAlarmModeNotifyPolicy,
  type NcAlarmNonBlockingEditResult,
  type NcAlarmNotifyField,
  type NcAlarmResolvedDelays,
  resolveModeDelays,
  resolveModeNotifyPolicy,
} from './notification/alarm-settings.js'
// ── Alarm configuration profiles (named NcAlarmSettings blobs) ──────────
export {
  activateAlarmProfile,
  alarmProfileById,
  cloneAlarmSettings,
  createAlarmProfile,
  deleteAlarmProfile,
  ensureAlarmProfiles,
  isDefaultAlarmProfileId,
  NC_ALARM_DEFAULT_PROFILE_ID,
  NC_ALARM_DEFAULT_PROFILE_NAME,
  NC_ALARM_SYSTEM_DEFAULT_DELAYS,
  ncAlarmSystemDefaultSettings,
  type NcAlarmProfileCreateSource,
  type NcAlarmProfileRecord,
  type NcAlarmProfilesMutationResult,
  type NcAlarmProfilesRefuseReason,
  type NcAlarmProfilesState,
  renameAlarmProfile,
  syncActiveAlarmProfileSettings,
} from './notification/alarm-profiles.js'
export {
  NC_SENSOR_RAISED_FIELD_BY_KIND,
  NC_SENSOR_TRANSITION_KINDS,
  NC_SENSOR_TRANSITION_UNSUPPORTED_REASON,
  sensorRaisedOf,
  sensorTransitionOffered,
} from './notification/sensor-raised.js'
export {
  alertEpisodeId,
  alertEpisodeKind,
  alertEpisodePayload,
  alertNodeId,
  deviceAttentionKind,
  isAlertEpisodeOpen,
  isAlertEpisodeSeverity,
  parseAlertEpisodePayload,
  AlertEpisodePayloadSchema,
  type AlertEpisodePayload,
  type AlertEpisodePhase,
} from './notification/alert-episode.js'
// ── Notification template-variable catalog ───────────────────────────
// `NcRuleKindSchema` / `NcTemplateFamilySchema` / `NcTemplateFieldSchema` /
// `NcTemplateVarGroupSchema` / `NcTemplateVarDescriptorSchema` /
// `NcTemplateVarContextSchema` (and their inferred types) are cap-native —
// already reached through `export * from './capabilities/index.js'` above.
// Re-exporting them here too would be a duplicate export tsc refuses.
export {
  NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS,
  NC_TEMPLATE_VARS,
  isHeldBackTemplateVar,
  isKnownTemplateVar,
  servedTemplateVars,
  templateVarDeliveryApplies,
  templateVarKindApplies,
  templateVarSystemEventApplies,
  templateVarsFor,
} from './notification/template-vars.js'
// ── System-event filter scoping (ONE rule; engine + every rule editor) ──
export {
  NC_SYSTEM_EVENT_FILTER_KEYS,
  type NcSystemEventFilterKey,
  systemEventFilterApplies,
  systemEventFilterAppliesToAnyKind,
} from './notification/system-event-filters.js'
// ── System-event families (ONE table; hub validator + both editors, D637) ──
export {
  describeSystemEventFamilyProblem,
  isSystemEventFamily,
  NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS,
  NC_SYSTEM_EVENT_FAMILIES,
  NC_SYSTEM_EVENT_FAMILY,
  NC_SYSTEM_EVENT_FAMILY_FILTERS,
  NC_SYSTEM_EVENT_KIND_GROUP_SPECS,
  type NcSystemEventConditionFilterKey,
  type NcSystemEventFamily,
  type NcSystemEventFamilyProblem,
  type NcSystemEventFamilyVerdict,
  type NcSystemEventKindGroupSpec,
  systemEventFamilyOf,
  systemEventFamilyProblems,
  systemEventKindNamesOf,
  systemEventKindsOfFamily,
} from './notification/system-event-families.js'
// ── Paired system events as ONE class (D906) ──
export {
  expandSystemEventClasses,
  isSystemEventRecoveryKind,
  NC_SYSTEM_EVENT_CLASS_SPECS,
  type NcSystemEventClassSpec,
  type NcSystemEventClassSubject,
  systemEventClassesFor,
  systemEventClassKinds,
  systemEventClassOf,
  withSystemEventClasses,
} from './notification/system-event-classes.js'
// ── The scheduled STATE SUMMARY of a system rule (D647) ──
export {
  describeSystemEventDeliveryProblem,
  isSystemEventSummaryRule,
  NC_SYSTEM_EVENT_SUMMARY_FAMILIES,
  type NcSummarySendTime,
  type NcSystemEventDeliveryProblem,
  type NcSystemEventDeliverySubject,
  scheduleForSendTimes,
  sendTimesForEditor,
  sendTimesOfSchedule,
  systemEventDeliveryProblems,
  systemEventSummaryScheduleOf,
  systemEventSummarySplitOf,
  templateCarriesSummary,
} from './notification/system-event-summary.js'
export {
  NC_SERVER_PACKAGE_NAME,
  NC_UPDATE_EVENT_PACKAGE_NAMES,
  type NcInstalledPackageLike,
  type NcScopePickerItem,
  nodePickerItems,
  packagePickerItems,
} from './notification/scope-picker-items.js'
export type {
  TimelapseCadencePair,
  TimelapsePreviewMode,
  TimelapseRule,
  TimelapseRuleInput,
  TimelapseRulePatch,
  TimelapseTemplate,
} from './notification/timelapse-rule.js'
// The ONE dictionary of state-word labels both rule editors render (R7, D690).
export type { StateLabel, StateLabelKey, StateLabelLocale } from './i18n/state-labels.js'
export {
  isStateLabelKey,
  STATE_LABEL_KEYS,
  STATE_LABELS,
  stateLabel,
} from './i18n/state-labels.js'
// Event-kind labels (detection / sensor / audio) — viewer filters + NC (R7).
export type {
  EventKindLabel,
  EventKindLabelKey,
  EventKindLabelLocale,
} from './i18n/event-kind-labels.js'
export {
  EVENT_KIND_LABEL_KEYS,
  EVENT_KIND_LABELS,
  eventKindLabel,
  isEventKindLabelKey,
} from './i18n/event-kind-labels.js'
// Server-side translation (D863): catalog primitives + the coded user error.
export type {
  CatalogFile,
  CatalogLang,
  CatalogLookup,
  TranslationParams,
} from './i18n/translation.js'
export {
  CATALOG_LANGS,
  CatalogFileSchema,
  CatalogLangSchema,
  DEFAULT_CATALOG_LANG,
  interpolate,
  localizeConfigTree,
  splitTranslationRef,
} from './i18n/translation.js'
export type { ErrorI18nPayload } from './i18n/camstack-error.js'
export {
  CamstackError,
  ErrorCodeSchema,
  ErrorI18nPayloadSchema,
  readErrorI18n,
  userError,
} from './i18n/camstack-error.js'
// ── Timelapse rules (standalone scheduled producer — NOT a cap) ──────
export {
  assertTimelapseCadences,
  DEFAULT_TIMELAPSE_PREVIEW_TEXT,
  readTimelapseGeneratedAt,
  TIMELAPSE_DENSE_FLOOR_SEC,
  TimelapseRuleInputSchema,
  TimelapseRulePatchSchema,
  TimelapseRuleSchema,
  TimelapseTemplateSchema,
} from './notification/timelapse-rule.js'
// A model choice has a SCOPE — see `pipeline/cluster-model-scope.ts`, and
// `scripts/check-cluster-model-scope.ts` for the guard that keeps this registry
// equal to the catalog's `modelScope: 'cluster'` declarations.
export {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_MODEL_SECTION_ID,
  CLUSTER_STEP_SETTING_FIELDS,
  type ClusterModelScopedStep,
  type ClusterStepModels,
  type ClusterStepSettingField,
  type ClusterStepSettings,
  clusterModelSettingKey,
  clusterStepSettingFieldsFor,
  clusterStepSettingKey,
  DEFAULT_CLUSTER_STEP_MODELS,
  DEFAULT_CLUSTER_STEP_SETTINGS,
  DEFAULT_MIN_LANDMARK_FACE_SIZE_PX,
  type HydratedClusterSection,
  type HydratedClusterView,
  interpretStoredClusterModel,
  type InvalidClusterStepModelEntry,
  invalidClusterStepModelEntries,
  isClusterScopedStep,
  overlayClusterStepSettings,
  pickClusterStepModels,
  pickClusterStepSettings,
  pickInvalidClusterStepModels,
  readClusterStepModels,
  readClusterStepSettings,
  resolveClusterStepModelId,
  type StepModelScope,
  type StoredClusterModelInterpretation,
} from './pipeline/cluster-model-scope.js'
// Camera sensors (D672) — see `pipeline/camera-sensors.ts`.
export {
  CAMERA_SENSORS_NOT_LOADED,
  CAMERA_SENSORS_SETTINGS_KEY,
  CAMERA_TRIGGER,
  type CameraSensorAttachment,
  CameraSensorAttachmentSchema,
  type CameraSensorRef,
  CameraSensorRefSchema,
  cameraSensorRefKey,
  type CameraSensorsConfig,
  CameraSensorsConfigSchema,
  type CameraOwnMotion,
  CameraOwnMotionSchema,
  type CameraRawLevel,
  CameraRawLevelSchema,
  type CameraSensorEntry,
  CameraSensorEntrySchema,
  type CameraSensorMode,
  CameraSensorModeSchema,
  type CameraSensorsNotEnforced,
  CameraSensorsNotEnforcedSchema,
  type CameraSensorsNotForwarded,
  CameraSensorsNotForwardedSchema,
  type CameraSensorsStatus,
  CameraSensorsStatusSchema,
  DEFAULT_CAMERA_SENSOR_MODE,
  MAX_CAMERA_SENSORS,
  type MotionTriggeredBy,
  type MotionTriggeredByReading,
  MotionTriggeredBySchema,
  readMotionTriggeredBy,
} from './pipeline/camera-sensors.js'
// D475's sensor-owned-motion rule, one copy for the runner and the orchestrator (D696).
export { cameraOwnsMotionViaSensor } from './pipeline/motion-ownership.js'
// A camera's `motion` slice read from the HUB, for a provider's `isDetected` and `getStatus` (D696).
export {
  hubMotionNativeProvider,
  readHubMotionDetected,
  readHubMotionStatus,
} from './device/hub-motion-read.js'
// A camera's RAW onboard motion push (D673) — see `pipeline/provider-motion.ts`.
export {
  type ProviderMotionData,
  ProviderMotionDataSchema,
  providerMotionEvent,
} from './pipeline/provider-motion.js'
// The ONE "can this format run this step" rule (D657) — see
// `pipeline/step-format-runnable.ts`.
export {
  type FormatRunnableModel,
  stepModelRunsOnFormat,
} from './pipeline/step-format-runnable.js'
// Model ids deleted from a step's catalog, and the stored-pin reset's one
// question about them (D725) — see `pipeline/removed-model-ids.ts`.
export { isRemovedModelId, REMOVED_MODEL_IDS } from './pipeline/removed-model-ids.js'
// A setting stored with the model it was made for, applied only while that
// model runs (D738) — see `pipeline/model-bound-settings.ts`.
export {
  applyModelBoundSettings,
  clearModelBoundOverrides,
  clearModelBoundSetting,
  collectModelBoundKeys,
  hasModelBoundOverrides,
  type InapplicableModelBoundOverride,
  modelBindingKey,
  type ModelBoundSettingsBag,
  type ModelBoundSettingSource,
  type ModelBoundSettingState,
  resolveModelBoundSetting,
  writeModelBoundSetting,
} from './pipeline/model-bound-settings.js'
// A step's settings layers (node ⊕ camera ⊕ accelerator) and the field-level
// edits on them (D754) — see `pipeline/step-settings-layers.ts`.
export {
  diffStepSettings,
  effectiveStepSettings,
  fieldsPinnedAtValueBelow,
  fieldUnitKeys,
  mergeSettingsBags,
  settingsBelow,
  settingValuesEqual,
  type StepSettingSource,
  type StepSettingsBag,
  type StepSettingsLayers,
  stepSettingSource,
  withFieldFrom,
  withoutField,
} from './pipeline/step-settings-layers.js'
// Auto tune (D745): one detector family for the cluster, picked from static
// hardware facts x the measured latency table x demand — see
// `pipeline/auto-tune/recommend.ts`.
export * from './pipeline/auto-tune/index.js'
// Load balancing (D748): share placement of detection sessions.
export * from './pipeline/load-balancing/index.js'
// Node benchmark (D791): one node at a time, owned by the orchestrator.
export * from './pipeline/node-benchmark/index.js'
export * from './pipeline/second-pass/index.js'
// The ONE face-scoped crop of a root-supplied face (D731).
export {
  deriveRootFaceRefineRect,
  ROOT_FACE_REFINE_INPUT_PX,
  ROOT_FACE_REFINE_SCALE,
} from './pipeline/root-face-crop.js'
// The ONE detail/CLIP crop-rectangle derivation — see `pipeline/detail-crop.ts`
// for why a second one is a defect, and `scripts/check-clip-crop-single-owner.ts`
// for the guard that keeps it single.
export {
  DEFAULT_DETAIL_CROP_CONVENTION,
  DETAIL_CROP_PADDING_FIELD,
  DETAIL_CROP_PADDING_KEY,
  DETAIL_CROP_SECTION_ID,
  DETAIL_CROP_SQUARE_KEY,
  type DetailCropConvention,
  DetailCropConventionSchema,
  type DetailCropRect,
  deriveDetailCropRect,
  FULL_IMAGE_BBOX,
  type HydratedSettingsSection,
  type HydratedSettingsView,
  pickDetailCropConvention,
  readDetailCropConvention,
} from './pipeline/detail-crop.js'
// The cadence of the automatic whole-archive face rescore (D866): written by
// `pipeline-orchestrator`, read by `pipeline-analytics` — `pipeline/face-rescore-schedule.ts`.
export {
  FACE_RESCORE_INTERVAL_FIELD,
  FACE_RESCORE_INTERVAL_KEY,
  FACE_RESCORE_INTERVAL_MIN_RUNNING,
  FACE_RESCORE_SECTION_ID,
  type FaceRescoreSettingsView,
  pickFaceRescoreIntervalMinutes,
  readFaceRescoreIntervalMinutes,
} from './pipeline/face-rescore-schedule.js'
// The cluster-wide native-frame LEASE knobs (TTL / RAM budget / demand window).
// Written by `pipeline-orchestrator`, read by the pipeline-runner's decode
// worker — see `pipeline/native-lease.ts` for why they are defined here.
export {
  DEFAULT_NATIVE_LEASE_SETTINGS,
  NATIVE_LEASE_ACTIVITY_FIELD,
  NATIVE_LEASE_ACTIVITY_KEY,
  NATIVE_LEASE_ADMISSION_FIELD,
  NATIVE_LEASE_ADMISSION_KEY,
  NATIVE_LEASE_BUDGET_FIELD,
  NATIVE_LEASE_BUDGET_KEY,
  NATIVE_LEASE_HOLD_FIELD,
  NATIVE_LEASE_HOLD_KEY,
  NATIVE_LEASE_SCENE_BUDGET_FIELD,
  NATIVE_LEASE_SCENE_BUDGET_KEY,
  NATIVE_LEASE_SECTION_ID,
  NATIVE_LEASE_TILE_BUDGET_FIELD,
  NATIVE_LEASE_TILE_BUDGET_KEY,
  type NativeLeaseAdmission,
  NativeLeaseAdmissionSchema,
  type NativeLeaseKnob,
  type NativeLeaseNumberKnob,
  type NativeLeaseSettings,
  type NativeLeaseSettingsOverride,
  NativeLeaseSettingsSchema,
  pickNativeLeaseOverride,
  readNativeLeaseOverride,
} from './pipeline/native-lease.js'
export {
  ACCESS_ROLES,
  type AccessRoleAssignment,
  type AccessRoleId,
  type AccessRoleSpec,
  buildRoleScopes,
  detectAccessRole,
  roleSpec,
} from './schemas/access-roles.js'
// Persisted record schemas (Zod-first — source of truth for persisted types)
export {
  type CapScope,
  CapScopeSchema,
  type DeviceSelector,
  DeviceSelectorSchema,
  type DeviceTokenScope,
  type MethodAccess,
  MethodAccessSchema,
  type ScopedToken,
  ScopedTokenSchema,
  type TokenScope,
  TokenScopeSchema,
  type UserRecord,
  UserRecordSchema,
  type UserScope,
  UserScopeSchema,
} from './schemas/auth-records.js'
export {
  type DeviceMetaLike,
  type DeviceReachSummary,
  deviceSelectorMatches,
  type EffectiveScope,
  grantRowsOf,
  normalizeTokenScopes,
  resolveViewableDeviceIds,
  type ScopeGrantSummary,
  scopeInherits,
  summarizeEffectiveScope,
  viewerScopeOf,
} from './schemas/device-selector.js'
export type {
  CameraDetectionCapabilities,
  CameraMotionConfig,
  CameraNativeDetectionConfig,
} from './types/camera-detection.js'
export { DEVICE_TYPE_INFO, type DeviceTypeInfo } from './types/device-type.js'
// Unit conversion table (pure) — shared by the render path + expression engine.
export * from './units/index.js'
export { BOOT_RECOVERY_BACKOFF_MS } from './util/boot-recovery-backoff.js'
export { bestLocationMatch, locationSimilarity } from './util/location-match.js'
export { bareAddonId, isSameAddonId } from './utils/addon-id.js'
export {
  BackgroundRunRegistry,
  type BackgroundRunContext,
  type BackgroundRunRegistryOptions,
  type BackgroundRunState,
  type BackgroundRunStatus,
} from './utils/background-run-registry.js'
export { cosineSimilarity } from './utils/cosine-similarity.js'
export { ElementConfigStore } from './utils/element-config-store.js'
export { errMsg } from './utils/err-msg.js'
export { hfModelUrl } from './utils/hf-url.js'
// Utils
export {
  asBoolean,
  asJsonArray,
  asJsonObject,
  asNumber,
  asString,
  parseJsonArray,
  parseJsonObject,
  parseJsonUnknown,
} from './utils/json-safe.js'
export { maskUrlCredentials } from './utils/mask-url.js'
export {
  VendorLoginProxy,
  rewriteBody as rewriteLoginProxyBody,
  rewriteLocation as rewriteLoginProxyLocation,
  rewriteReferer as rewriteLoginProxyReferer,
  rewriteSetCookie as rewriteLoginProxySetCookie,
  type LoginProxyAttemptSpec,
  type LoginProxyResponseView,
  type LoginProxyRoute,
  type LoginProxyScheme,
  type LoginProxyUpstream,
  type LoginProxyVerdict,
  type VendorLoginProxyOptions,
  VENDOR_LOGIN_PROXY_PREFIX,
} from './vendor-login-proxy/index.js'
export {
  OAUTH_LANDING_PATH,
  OAUTH_LANDING_REASONS,
  isOauthLandingReason,
  oauthLandingUrl,
  parseOauthLandingFragment,
  type OauthLandingOutcome,
  type OauthLandingReason,
} from './utils/oauth-landing.js'
export {
  commitWatchdogRestart,
  DEFAULT_POOL_MEMORY_POLICY,
  evaluatePoolMemory,
  initialPoolMemoryState,
  type PoolMemoryAction,
  type PoolMemoryPolicy,
  type PoolMemoryState,
  type PoolMemoryTelemetry,
  type PoolMemoryVerdict,
  PoolMemoryWatchdog,
  type PoolMemoryWatchdogOptions,
  type ProcMemory,
  parseProcStatus,
  pickRestartCandidate,
  poolMemoryThreshold,
  type RestartCandidate,
  resetPoolBaseline,
  resolvePoolMemoryPolicy,
} from './utils/pool-memory-watchdog.js'
export { cellsToRects, type NormRect, rectsToCells } from './utils/privacy-grid-raster.js'
export { RingBuffer } from './utils/ring-buffer.js'
export type { InferenceStepResult } from './utils/run-inference-step.js'
export { runInferenceStep } from './utils/run-inference-step.js'
export type { PipelineRuntime } from './utils/runtime-mapping.js'
export {
  DEVICE_BACKEND_TO_FORMAT,
  deviceBackendToFormat,
  formatForRuntime,
  PYTHON_SCRIPT,
  pythonScriptForBackend,
  RUNTIME_TO_FORMAT,
  requiresPython,
} from './utils/runtime-mapping.js'
export { sleep, sleepCancellable } from './utils/sleep.js'
export {
  decodeVectorBase64,
  encodeVectorBase64,
  vectorDimFromBase64,
} from './utils/vector-codec.js'
export { evaluateZoneRules, type ZoneRuleEvalResult } from './utils/zone-rule-eval.js'
// `canonicalHash` is intentionally NOT exported here — it imports
// `node:crypto`, which Vite externalises in browser bundles and crashes
// at runtime when an admin-UI module transitively pulls it in. Server-
// side consumers (Alexa/HAP export adapters) import it from
// `@camstack/types/node` instead.

// Client-side helpers
export { bindAddonActions } from './helpers/bind-addon-actions.js'
export type {
  DeviceOption,
  InferenceDeviceDescriptor,
  RuntimeId,
} from './inference/runtime-capabilities.js'
export type { CoralUnitAddress } from './inference/coral-units.js'
export { coralUsableUnits, edgetpuDelegateDevice } from './inference/coral-units.js'
// Inference — hardware-driven runtime capability rules (SSOT)
export {
  defaultDeviceFor,
  enumerateInferenceDevices,
  modelFormatForRuntime,
  runtimeDevices,
  scoreRuntimes,
  supportedRuntimes,
} from './inference/runtime-capabilities.js'

// Node-only infrastructure utilities are exposed on the
// `@camstack/types/node` sub-entry, NOT here. Keeping `node:fs` / `node:path`
// imports out of the root entry is what lets the browser-side widget
// bundlers (Vite + rollup) consume `@camstack/types` without choking on
// `__vite-browser-external` placeholders.

export type { SiteZone } from './device/site-zone.js'
export { SiteZoneSchema, siteZoneKey } from './device/site-zone.js'

// The hub's human name (D861): the `server.name` setting, its validation and the
// hostname fallback every reader applies.
export type { ServerNameInfo } from './system/server-name.js'
export {
  resolveServerName,
  SERVER_NAME_MAX_LENGTH,
  SERVER_NAME_SETTING_KEY,
  ServerNameInfoSchema,
  ServerNameSchema,
  shortHostname,
} from './system/server-name.js'
export {
  armRemovalReconcile,
  reconcileRemovedDevices,
  REMOVAL_RECONCILE_INTERVAL_MS,
  type RemovalReconcileOptions,
  type RemovalReconcileOutcome,
  type TombstoneSource,
} from './device/device-removal-reconcile.js'
// IR / RF codecs: pulse-train schemas, Pronto, SmartIR import
export * from './ir/index.js'
