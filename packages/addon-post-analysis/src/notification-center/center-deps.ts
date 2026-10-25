/**
 * What the notification centre is wired with, and the alarm panel port it talks to.
 * Extracted from notification-center/index.ts. The class re-exports both.
 */
import type { NcAddonUpdateOutcome } from './addon-update-apply.js'
import type { NcExclusionReading } from './alarm/alarm-exclusions.js'
import type { NcAlarmInputBypassRecord } from './alarm/alarm-input-bypasses.js'
import type { NcAlarmOpening } from './alarm/alarm-openings.js'
import type {
  NcAlarmArmOutcome,
  NcAlarmExclusionPhase,
  NcAlarmInputBypassInput,
  NcAlarmInputBypassOutcome,
  NcAlarmPressOutcome,
  NcObserveOpeningOptions,
  NcObserveOpeningResult,
} from './alarm/alarm-panel-device.js'
import type { NcAlarmMatchPhase } from './alarm/alarm-push-policy.js'
import type { NcDeviceAlertSettings } from './alerts/device-alerts.js'
import type { NcUserGrant } from './build-entries.js'
import type { NcConfirmVisionRequest, NcConfirmVisionResult } from './confirm-gate.js'
import type { ListDeviceIdsByCaps } from './device-compat-guard.js'
import type { NcDeviceIdentity } from './device-directory.js'
import type { NcDeviceMuteSettings } from './device-mute-store.js'
import type { NcDispatcherDeps } from './dispatcher.js'
import type { NcRecognitionOutlook, NcRecognitionOutlookQuery } from './grouped/grouped-inputs.js'
import type { NcLinkedSnapshotState } from './linked-stills.js'
import type { PruneWindows } from './prune-windows.js'
import type { NcRuleFireRef } from './rule-engine.js'
import type { NcSceneObservation } from './scene-state-cache.js'
import type { NcRunnerStateReads } from './state-summary/runner-recovery.js'
import type { NcNodeDirectoryAnswer } from './state-summary/state-summary-service.js'
import type { NcSummaryPorts } from './summary/summary-producer.js'
import type { TimelapseRenderPorts } from './timelapse/timelapse-renderer.js'
import type {
  AlarmArmMode,
  AlarmState,
  Alert,
  CameraOccupancySnapshot,
  IScopedLogger,
  NcAlarmProfileCreateSource,
  NcAlarmProfilesView,
  NcAlarmSettings,
  NcAlarmSettingsPatch,
  ObjectEvent,
  OccupancyLookAnswer,
  OccupancyLookRequest,
  RecordsAccess,
  SystemEvent,
  Track,
} from '@camstack/types'

export interface NotificationCenterDeps {
  /**
   * `ctx.records` — every NC config and ledger kind lives on it, on every node.
   */
  readonly records: RecordsAccess
  /**
   * The addon's per-device settings (`ctx.settings`, D870): where the permanent
   * per-camera mute lives, so the central device delete takes it with the device.
   */
  readonly deviceSettings: NcDeviceMuteSettings
  readonly logger: IScopedLogger
  /**
   * The operator's prune windows. A port, read at sweep time, so a Save takes
   * effect on the next boot prune rather than on the next release.
   */
  readonly pruneWindows: () => Promise<PruneWindows>
  /** Dispatcher transport closures (bound to `ctx.api` + media store). */
  readonly dispatcher: Omit<NcDispatcherDeps, 'logger'>
  /** Cross-device object events since a timestamp (boot reconcile + dry-run). */
  readonly listObjectEventsSince: (
    sinceMs: number,
    limit: number,
  ) => Promise<readonly ObjectEvent[]>
  /** Recently persisted (closed) tracks — track-end dry-runs. */
  readonly listRecentTracks: (sinceMs: number, limit: number) => Promise<readonly Track[]>
  /**
   * Users (id, admin flag, device grants) — rule→user fan-out (Phase 4).
   * Absent on an older wiring: user-addressed rules then fan out to nothing,
   * logged once.
   */
  readonly listUsers?: () => Promise<readonly NcUserGrant[]>
  /** Routing identity of a device for the allowedDevices check. */
  readonly getDeviceRoute?: (
    deviceId: number,
  ) => Promise<{ stableId: string; addonId: string } | null>
  /**
   * Which device ids carry ANY of the given capability names
   * (`deviceManager.listDeviceIdsByCaps`) — the save-time device-compatibility
   * guard (`device-compat-guard.ts`, operator ruling 2026-10-01). Absent on an
   * older wiring: the guard then FAILS OPEN and refuses nothing, because a
   * save must never become un-makeable over one unreachable capability read.
   */
  readonly listDeviceIdsByCaps?: ListDeviceIdsByCaps
  /**
   * ONE photograph of a camera, for the STILL SHELF (`still-shelf.ts`).
   *
   * A sound owns no frame and an emptied occupancy scope owns no member, so the
   * only picture those notifications can carry is a snapshot taken at the
   * trigger. Absent leaves them text-only — reported per camera at the enqueue,
   * never silent.
   *
   * NOT the same dep as {@link NcTestInjectionDeps.getSnapshot}: that one is
   * passed per call because the tester is one code path, this one is held
   * because the audio confirmation and the occupancy commit are live producers.
   */
  readonly getSnapshot?: (
    deviceId: number,
  ) => Promise<{ readonly base64: string; readonly contentType: string } | null>
  /**
   * D691 — ask the orchestrator for ONE occupancy burst at the end of a
   * pending flip's sustain (`pipelineOrchestrator.requestOccupancyLook`).
   * Absent = the edge commits on whatever sample comes next, as before.
   */
  readonly requestOccupancyLook?: (ask: OccupancyLookRequest) => Promise<OccupancyLookAnswer>
  /**
   * A frame of a camera at a PAST instant, cut from its clip ring (D691) — a
   * departure's picture when nobody who left owns track media. Absent = a
   * departure without a departed track ships no picture, by named reason
   * (`occupancy departure still: none`), never a live frame of the empty space.
   */
  readonly getPastStill?: (
    deviceId: number,
    atMs: number,
  ) => Promise<{ readonly base64: string; readonly contentType: string } | null>
  /**
   * D683 × D691: the track alias store's lookup — an id an L2 fusion absorbed
   * answers its SURVIVOR, anything else `null`. A departed track is resolved
   * through it BEFORE its departure falls back to the ring still: a subject
   * the fusion merely renamed still owns its picture under the survivor.
   * Absent = the departed id is read as asked (no fusion on this wiring).
   */
  readonly resolveTrackAlias?: (trackId: string) => Promise<string | null>
  /**
   * D692 (fresh review L-1): the alias store's RAM read (`TrackAliasStore.resolveSync`) —
   * a grouped admission asks it before the durable {@link resolveTrackAlias}, so a late
   * event under an absorbed id usually resolves without an await. `undefined` = not an
   * alias it knows.
   */
  readonly resolveTrackAliasSync?: (trackId: string) => string | undefined
  /**
   * D692 §4: has a grouped-window member anything left to wait for? Synchronous and
   * in-process (the recognisers share this node). Absent ⇒ every outlook is `unknown`,
   * which is PENDING (D49): windows then wait for their deadline.
   */
  readonly recognitionOutlook?: (query: NcRecognitionOutlookQuery) => NcRecognitionOutlook
  /**
   * The snapshot wrapper's CAPTURE-FREE state for one camera, for the
   * linked-camera shelf (`linked-stills.ts`, ADR 0632): a reason here
   * (`sleeping`, `disabled`, …) keeps a camera's state card out of a sensor
   * notification. Throws / `undefined` when unknown — the tile is then kept
   * (D49). Absent = no camera is ever excluded on its wrapper state.
   */
  readonly getSnapshotState?: (deviceId: number) => Promise<NcLinkedSnapshotState | undefined>
  /**
   * CACHE-ONLY: when each camera's cached frame was captured (null = none),
   * for the linked-camera shelf's freshness check. Absent = every landed
   * frame is kept.
   */
  readonly getFrameCapturedAt?: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, number | null>>
  /**
   * Lower-cased display name → gallery id, across the face and plate galleries.
   * Handed straight to {@link NcRuleStore} for the lazy identity migration;
   * absent leaves every rule matching by name, exactly as it did before ids.
   */
  readonly identityIdsByName?: () => Promise<ReadonlyMap<string, string>>
  /**
   * Current state of the given devices, for the `deviceState` rule gate. A
   * device that cannot be read is ABSENT from the map — never present with a
   * stale value. Absent dep = no rule can ever be gated (fails closed).
   */
  readonly readDeviceStates?: (ids: readonly number[]) => Promise<ReadonlyMap<number, string>>
  /**
   * Whether each of the given devices is an OPENING, and if so whether it is
   * open — D630's table (`alarm-openings.ts`), read from the raw runtime
   * slices. Four outcomes per id, and none of them is a guess (D49):
   *  - ABSENT from the map — the read FAILED;
   *  - `not-opening` — read, and no opening slice (a camera, a switch);
   *  - `unknown` — read, an opening slice is there but its word is missing or
   *    not one its cap defines (carries the cap and the raw value);
   *  - `reading` — open or secure, with the state word.
   * `unknown` and absent never block and are never treated as secure.
   */
  readonly readDeviceOpenings?: (
    ids: readonly number[],
  ) => Promise<ReadonlyMap<number, NcAlarmOpening>>
  /**
   * WHO every device id is (name + type), for the system-event intake: the
   * kind a `device.offline` becomes is decided by whether the device is a
   * CAMERA, and the sentence names it. Mirrored and refreshed off the event
   * path — see `device-directory.ts`.
   *
   * Absent dep = an empty directory = no `device.*` event is ever worded as a
   * camera. Fails closed on purpose: the alternative shipped sixteen "La
   * camera 2018 è offline" [Camera 2018 is offline] notifications about a smart plug.
   */
  readonly listDeviceIdentities?: () => Promise<readonly NcDeviceIdentity[]>
  /**
   * The deleted-device prune's SECOND read: true only when
   * `deviceManager.getDevice` answers `null` — the persisted row is gone, which
   * is the one durable fact that means "deleted" (a respawn keeps the row).
   * Absent ⇒ no device is ever pruned from the rules; an unwired read must
   * never read as agreement (D49). See `device-prune-runner.ts`.
   */
  readonly isDeviceDeleted?: (deviceId: number) => Promise<boolean>
  /**
   * The zone ids each given camera OWNS — how a multi-camera rule scopes its
   * `zones` condition per camera (`zone-ownership.ts`). Mirrored and refreshed
   * on the reload tick, never on the event path (D49).
   *
   * A camera that cannot be read is ABSENT from the map, never present with an
   * empty list: `[]` means "this camera has no zones" and makes the condition
   * inert for it, so a failed read that looked like `[]` would fire exactly the
   * notification the operator scoped away. Absent dep = no ownership at all =
   * today's flat behaviour, unchanged.
   */
  readonly readDeviceZoneIds?: (
    ids: readonly number[],
  ) => Promise<ReadonlyMap<number, readonly string[]>>
  /**
   * Every scene this process can answer for, for the `scene` rule gate.
   *
   * SYNCHRONOUS and in-process by construction: `pipeline-analytics` hosts both
   * the scene provider and this centre, so the mirror is refreshed by a plain
   * call and never by an RPC or an event (D8 telemetry is droppable; a gate fed
   * by droppable telemetry is sometimes wrong and never says so).
   *
   * Absent dep = the mirror is permanently cold = no scene-gated rule can ever
   * fire. Fails closed, deliberately: the alternative is a rule the operator
   * believes is gated that is in fact notifying.
   */
  readonly readSceneStates?: () => readonly NcSceneObservation[]
  /**
   * The three cluster settings behind the sustained-state alerts (battery
   * threshold, reminder interval, recovery switch).
   *
   * A FUNCTION, not a value: the operator edits them at runtime, and a value
   * captured at construction would be the settings as they were when the addon
   * last booted. Absent = the shipped defaults, which is what an install that
   * has never opened the page runs on.
   */
  readonly readDeviceAlertSettings?: () => NcDeviceAlertSettings
  /**
   * The CURRENT ZoneAnalytics occupancy snapshot of each given camera — the
   * rule tester's occupancy probe ("as of now, would this rule fire?").
   *
   * `undefined` ids = every camera that has a snapshot, which is what an
   * un-scoped occupancy rule has to be answered against. A camera with none is
   * simply ABSENT from the map (never present with an empty snapshot): absent
   * is the fail-closed state the live condition has, and the tester reports it
   * as such.
   *
   * Absent dep (a node with no analytics provider, an older wiring) ⇒ the
   * occupancy dry-run answers nothing rather than guessing.
   */
  readonly readOccupancySnapshots?: (
    deviceIds: readonly number[] | undefined,
  ) => Promise<ReadonlyMap<number, CameraOccupancySnapshot>>
  /**
   * Invoke one device-capability method — the transport behind a rule's
   * actions. Absent = a rule that declares actions still notifies.
   */
  readonly actuate?: import('./rule-actions.js').NcActuator
  /** Whether a capability is device-scoped. The only boundary on what a rule
   *  may actuate; see the cap file for why it is structural, not a list. */
  readonly isCapDeviceScoped?: import('./rule-actions.js').NcCapScopeCheck
  /**
   * Build the externally-reachable callback URL for one button, or null when
   * no such URL exists (loopback-only install). Null means NO buttons rather
   * than a broken one: a `127.0.0.1` callback is a button that cannot work
   * from the phone it was sent to.
   *
   * Injected because only the wiring knows the served route prefix, the
   * per-install secret and which base URL the RECIPIENT can reach.
   */
  readonly mintActionUrl?: (input: {
    readonly id: string
    readonly expMs: number
  }) => Promise<string | null>
  /**
   * Which packages have an update available on `nodeId` RIGHT NOW
   * (`addons.listUpdates`), by name.
   *
   * The "apply these updates" button asks this BEFORE it applies anything. The
   * row froze what was out of date when the 6-hourly check ran; by the tap the
   * operator may have updated some from the Addons page, auto-update may have
   * taken others, and a second delivery of the same notification may have been
   * tapped already. Applying the frozen list blind would re-install packages
   * that are current and then report work it did not do.
   *
   * A throw is NOT "nothing to do": the runner changes nothing and says so.
   * Refusing costs one spent token the operator can replace from the Addons
   * page; guessing costs a node's worth of unnecessary addon restarts.
   *
   * Optional: a wiring without it mints no update button.
   */
  readonly listAddonUpdates?: (nodeId: string) => Promise<readonly string[]>
  /**
   * Apply ONE package on ONE node (`addons.updatePackage`).
   *
   * Version-free in both directions, deliberately. Inbound, because the
   * notification must not restate a version it observed (D313) — the dist-tag
   * is resolved once, at apply time, by `LifecycleJobEngine.fetchAddonTask`.
   * Outbound, because the cap's hub branch answers with the version it was
   * ASKED for (`input.version ?? 'latest'`), and a seam that could hand that
   * string back is a seam through which `latest` reaches an operator's phone
   * for the second time. What actually landed is read back and announced by
   * the `addon.updated` notification.
   *
   * Optional: a wiring without it mints no update button.
   */
  readonly applyAddonUpdate?: (input: {
    readonly packageName: string
    readonly nodeId: string
  }) => Promise<NcAddonUpdateOutcome>
  /**
   * Whether a server update is still available on `nodeId` RIGHT NOW
   * (`serverManagement.checkServerUpdate`). Returns only the boolean — a
   * version this seam could hand back is a version a notification would
   * restate (D313). A throw is NOT "nothing to do": the runner changes
   * nothing and says so.
   *
   * Optional: a wiring without it mints no server-update button.
   */
  readonly checkServerUpdate?: (nodeId: string) => Promise<boolean>
  /**
   * Stage a server update on ONE node (`serverManagement.applyServerUpdate`).
   *
   * Version-free, deliberately: omit `version` so the provider resolves latest
   * at apply time. Optional: a wiring without it mints no server-update button.
   */
  readonly applyServerUpdate?: (input: { readonly nodeId: string }) => Promise<NcAddonUpdateOutcome>
  /**
   * The scheduled-timelapse producer's outside world (export engine, footage
   * availability, track history, artifact publishing).
   *
   * OPTIONAL: absent on every node that is not the hub, and absent on a hub
   * whose wiring predates the feature. The centre then holds the rule store
   * (so CRUD still works) and runs NO scheduler — never a half-wired producer
   * that renders and cannot deliver.
   */
  readonly timelapse?: NcTimelapseRenderPorts
  /**
   * The multi-camera DIGEST producer's outside world (track history, stored
   * media, artifact publishing).
   *
   * OPTIONAL on exactly the same terms as {@link timelapse}: absent on every
   * node that is not the hub. The centre then holds the rule store (so CRUD
   * still works from anywhere) and runs NO producer — never a half-wired one
   * that renders and cannot deliver.
   */
  readonly summary?: NcSummaryPorts
  /**
   * The calendars singleton — listCalendars / listEvents for the
   * calendar-events producer. Absent ⇒ CRUD still works, no producer ticks.
   */
  readonly calendars?: {
    readonly listCalendars: () => Promise<readonly { readonly id: string }[]>
    readonly listEvents: (input: {
      readonly calendarIds: readonly string[]
      readonly startMs: number
      readonly endMs: number
    }) => Promise<
      readonly {
        readonly id: string
        readonly calendarId: string
        readonly title: string
        readonly startMs: number
        readonly endMs: number
        readonly allDay?: boolean
        readonly description?: string
        readonly location?: string
      }[]
    >
  }
  /**
   * `llm.generateVision`, for the AI CONFIRM gate — hub-only, in-process.
   *
   * ABSENT is the whole feature switched off, cleanly: no gate is constructed,
   * `confirmGate` never reaches the dispatcher, and a rule that asks for a
   * confirm delivers exactly as it did before. That is deliberate rather than
   * accidental: on a node with no `llm` provider the alternative is a gate that
   * fails open on every single notification, which is a lot of noise for a
   * feature that is simply not installed there.
   */
  readonly generateVision?: (request: NcConfirmVisionRequest) => Promise<NcConfirmVisionResult>
  /** `llm.cancel` — frees the GENERATION when the gate's 8 s bound wins. */
  readonly cancelVision?: (requestId: string) => Promise<void>
  /**
   * Mint a fresh, externally-reachable URL for an artefact ALREADY stored —
   * the cap's `resolveArtifactUrl`. Delegates to the SAME `NcArtifactPlane`
   * the dispatcher publishes through (see `NcDispatcherDeps.indexArtifact`);
   * this never re-derives the signing or the endpoint ranking.
   *
   * `null` for an unknown/expired id or an install with no reachable base
   * URL — the three causes a caller must render identically ("no image right
   * now"). Absent dep (a node with no artefact plane) answers `null` for
   * every id, the same degrade as an install with nothing reachable.
   */
  readonly resolveArtifactUrl?: (artifactId: string) => Promise<string | null>
  readonly now?: () => number
  /**
   * Trailing hold-off for device online/offline notifications. Default 5 min
   * in production; 0 under Vitest (so existing suites keep asserting immediate
   * flips) unless this is set explicitly.
   */
  readonly livenessHoldoffMs?: number
  /**
   * Grace before a node offline / back-online is announced (60 s in
   * production, 0 under Vitest unless set) — a reconnect storm flips a node
   * every few seconds and must not page the operator for each flip.
   */
  readonly nodeLivenessHoldoffMs?: number
  /**
   * `nodes.directory` — the state summary's D8 reconcile read for its node
   * sections (D647 review I2). Absent ⇒ those sections say "unavailable".
   */
  readonly readNodeDirectory?: () => Promise<NcNodeDirectoryAnswer>
  /**
   * The runner state (`core-blocks.list`, `nodes.getNodeAddons`) — the state
   * summary's recovery read for crash-looped runners (D708). Absent ⇒ a
   * crash-loop state closes only on its events.
   */
  readonly readRunnerStates?: NcRunnerStateReads
  /**
   * The alerts store (`alerts.list`) — the reconcile that makes the alert
   * centre's bus announcements (`alert.episode`) safe to lose (D8, D11): at
   * boot and every {@link NC_ALERT_RECONCILE_INTERVAL_MS}, an open critical or
   * error alert not yet notified is notified once. Absent ⇒ the bus is the
   * only path.
   */
  readonly readAlerts?: () => Promise<readonly Alert[]>
  /**
   * `ctx.eventBus.emit` — the centre's own announcements on the bus: a rule that
   * cannot work (`notification.rule-broken` / `-repaired`, D905). The alert centre
   * turns them into an in-app alert, and this centre's intake into the
   * `rule-broken` / `rule-repaired` system kinds. Absent ⇒ logged only.
   */
  readonly emitBusEvent?: (event: SystemEvent) => void
  readonly alertReconcileIntervalMs?: number
  readonly drainIntervalMs?: number
  readonly ruleReloadIntervalMs?: number
  /** Bound of the boot crash-gap scan. */
  readonly reconcileWindowMs?: number
}

/**
 * The slice of {@link TimelapseRenderPorts} the WIRING supplies.
 *
 * The centre owns the clock, the logger and the sleep — one clock, one child
 * logger, and a `sleep` the tests can neutralise — so the wiring provides only
 * what reaches outside the process.
 */
export type NcTimelapseRenderPorts = Omit<TimelapseRenderPorts, 'logger' | 'now' | 'sleep'>

/**
 * The alarm panel, as the Notification Center needs it.
 *
 * An interface rather than the device class so this module keeps knowing
 * nothing about `BaseDevice` — and so the settings tab can be tested without
 * a kernel. Null on every node but the hub, and on a hub whose panel could not
 * be created: the cap then answers honestly with `deviceId: null` instead of
 * offering an editor whose Save goes nowhere.
 */
export interface NcAlarmPanelPort {
  readonly deviceId: number
  settings(): NcAlarmSettings
  applySettings(patch: NcAlarmSettingsPatch): Promise<NcAlarmSettings>
  /** Named configuration profiles (Default always present after ensure). */
  profilesView(): NcAlarmProfilesView
  createProfile(input: {
    readonly name: string
    readonly newId: string
    readonly source: NcAlarmProfileCreateSource
  }): Promise<NcAlarmProfilesView>
  renameProfile(id: string, name: string): Promise<NcAlarmProfilesView>
  deleteProfile(id: string): Promise<NcAlarmProfilesView>
  activateProfile(id: string): Promise<NcAlarmProfilesView>
  /** Modes the panel offers — the coverage list has one row per entry. */
  availableModes(): readonly AlarmArmMode[]
  /**
   * A RULE presses the panel, with the match that pressed it — synchronously, in the call.
   *
   * The whole of the COMBINED notification, and the only reason this port is not
   * read-only. `alarm-panel.trigger` takes a device id and nothing else — deliberately,
   * since Home Assistant provides the same cap — so a rule press on THIS panel never goes
   * through the cap: the source rides this call and is never parked for a later one
   * (D735). See {@link NcRuleFireRef}.
   */
  triggerFromRule(source: NcRuleFireRef): NcAlarmPressOutcome
  /**
   * Where the alarm stands for ONE rule match, read before the match presses the panel
   * (D706) — what the rule's own push does follows from it (`alarm-push-policy.ts`).
   */
  classifyRuleMatch(source: NcRuleFireRef): NcAlarmMatchPhase
  /**
   * "Watched again" for a sensor the arm had bypassed, after the event that lifted it was
   * evaluated (D706) — the panel applies the mode's switch and the duplicate check.
   */
  announceLifted(deviceId: number, now?: number): void
  /**
   * Devices the CURRENT arm is ignoring because they were open when it armed
   * (non-blocking for the mode, or confirmed with Arm anyway).
   *
   * Read by the arm/arming announcement, so the sentence that says "armed"
   * also says what it is not watching. The panel owns the list — this is a
   * read, never a second copy.
   */
  excludedDevices(): readonly number[]
  /** One opening's reading (`open` / `secure`), from the event path or the reconcile tick. */
  observeOpening(
    deviceId: number,
    reading: NcExclusionReading,
    now?: number,
    options?: NcObserveOpeningOptions,
  ): NcObserveOpeningResult
  /** The same exclusions with their two-phase lift position — the live view's list. */
  exclusionPhases(): readonly NcAlarmExclusionPhase[]
  /** Drop a DELETED device from the current arm's exclusions (`device-prune-runner.ts`). */
  forgetExcluded(deviceId: number): void
  /** "Bypass this input until disarm" — one (rule, input) pair, for this arm session only. */
  bypassInput(input: NcAlarmInputBypassInput): NcAlarmInputBypassOutcome
  /** The (rule, input) pairs this arm session ignores — the live view's list. */
  inputBypasses(): readonly NcAlarmInputBypassRecord[]
  /** Drop the bypasses whose input is no longer one (rule deleted, disabled, re-scoped). */
  pruneInputBypasses(keep: (entry: NcAlarmInputBypassRecord) => boolean): void
  /** The lifecycle word now (`arming`, `pending`, …). */
  currentState(): AlarmState
  /** The machine's target — `disarmed` or the `armed_<mode>` it is in or heading to. */
  currentTarget(): AlarmState
  /** A plain arm — refused on an open covered device the mode does not tolerate. */
  armWith(mode: AlarmArmMode): Promise<NcAlarmArmOutcome>
  /** The Arm anyway bound to ONE refusal — the only path that excludes a blocker (D630). */
  armAnyway(refusalId: string): Promise<NcAlarmArmOutcome>
  /** Disarm — the cap's own path, clearing the exclusions with the arm. */
  disarm(): Promise<void>
}
