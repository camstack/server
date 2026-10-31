import { z } from 'zod'
import { ActionTargetSchema } from '../automation/action-target.js'
import { NcTaxonomySchema } from '../catalogs/nc-taxonomy.js'
import { type AlarmArmMode, AlarmArmModeSchema, AlarmStateSchema } from './alarm-panel.cap.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { MaskPolygonShapeSchema } from './mask-shape.js'
import { NotificationActionIconSchema } from './notification-output.cap.js'
import { CamProfileSchema } from './schemas/streaming-shared.js'

/**
 * notification-rules — the Notification Center rule surface (P1 core).
 *
 * Spec: `docs/superpowers/specs/2026-07-22-notification-center-requirements.md`
 * (operator decisions D-1/D-2/D-3 are binding):
 *
 *  - D-2: rule EVALUATION lives in `addon-post-analysis` (the
 *    `notification-center` module), hooked on the durable persistence
 *    moments (object-event insert, TrackCloser.closeExpired) with a
 *    persisted outbox + retry — never the lossy telemetry bus (D8).
 *  - D-3: urgency belongs to the RULE. `delivery: 'immediate'` fires on the
 *    FIRST persisted detection matching the conditions (per-track dedup,
 *    `maxPerTrack` fixed at 1 — see {@link NC_MAX_PER_TRACK_IMMEDIATE});
 *    `delivery: 'track-end'` evaluates the finalized track record at close.
 *  - DISPATCH stays behind `notification-output` (rules reference targets
 *    by id; per-backend params are a passthrough blob capped by the
 *    target kind's own caps/degrade engine).
 *
 * P1 scope: admin-authored rules only (`createdBy` stamped from the
 * server-injected caller identity — the first `caller: 'required'`
 * adopter). The P1 condition subset is: devices, classes(+exclude),
 * minConfidence, admin zones (any/all + exclude), weekly schedule
 * windows, and the optional label/identity/plate matchers. User rules,
 * private zones, per-recipient fan-out and the wider condition table are
 * P2+ (see spec §7).
 *
 * All schemas here are the single source of truth — `NcRule` etc. are
 * `z.infer` exports; no duplicate interfaces (the advanced-notifier
 * schema/interface drift is explicitly not repeated).
 */

// ── Rule domain model ───────────────────────────────────────────────

/**
 * D-3: the trigger/urgency of a rule — which persistence moment evaluates it.
 * The value maps 1:1 onto the evaluated record kind:
 *  - `immediate`     ↔ object-event persist (lowest-latency detection burst)
 *  - `track-end`     ↔ TrackCloser.closeExpired (finalized track record)
 *  - `device-event`  ↔ SensorEventStore insert (doorbell press / sensor state
 *                       change of a LINKED device, one row per linked camera)
 *  - `package-event` ↔ PackageDropDetector object-event insert (a `package`
 *                       delivery / pick-up)
 *
 * `immediate`/`track-end` carry the D-3 urgency semantics; `device-event`/
 * `package-event` are pure trigger kinds (no urgency dimension). Extending
 * this one field keeps the schema additive — a rule still declares exactly
 * one trigger.
 *
 * AUDIO rules add no member here, for the reason occupancy added none: the
 * enum is mirrored by hand in the viewer (`scripts/check-viewer-condition-
 * mirror.ts` fails the build on a member the app cannot render) and every
 * member costs a release train. A sustained-sound rule is therefore an
 * `immediate` rule carrying {@link NcConditions.audio} — the condition is the
 * trigger discriminator, exactly as `occupancy` is on `device-event`.
 */
export const NcDeliverySchema = z.enum([
  'immediate',
  'track-end',
  'device-event',
  'package-event',
  'system-event',
])
export type NcDelivery = z.infer<typeof NcDeliverySchema>

/**
 * Stable Notification Center vocabulary over infrastructure/liveness events.
 * Bus categories are normalized into these intent-level kinds so rules do not
 * depend on a provider's raw event name or payload shape.
 */
export const NcSystemEventKindSchema = z.enum([
  // LIVENESS IS A DEVICE FACT, NOT A CAMERA FACT. These are emitted for every
  // device type the hub knows — a camera, a smart plug, a sensor, a container.
  // Which of them an operator wants to hear about is a property of the RULE
  // ({@link NcSystemEventConditionSchema.shape.deviceTypes}), never of the
  // intake: a filter baked into the producer is a filter nobody can change.
  //
  // They replaced `camera-online` / `camera-offline`, which were produced for
  // EVERY device and read as a camera in both languages. On 2026-08-12 one
  // zigbee plug going offline delivered sixteen "La camera 2018 è offline"
  // notifications, one per sub-entity.
  'device-online',
  'device-offline',
  // The operator's SWITCH, which is not liveness and must never be worded as
  // if it were (D62): a device someone turned off is reported off, never
  // offline and never broken. Fed by `device.disabled` / `device.enabled`,
  // which `deviceManager.setDisabled` emits on a transition of the flag.
  'device-disabled',
  'device-enabled',
  // ── A SUSTAINED STATE, NOT AN EDGE ────────────────────────────────────
  //
  // Every kind above this line is a MOMENT: it happened, it was announced,
  // it is over. A flat battery is not — it is still flat tomorrow, and the
  // operator asked to be told again. These two are therefore the first kinds
  // driven by a durable EPISODE (`alerts/alert-episode.ts`) rather than by a
  // bus event, and the re-notify interval is a cluster setting.
  //
  // `device-battery-low` fires on the BAND crossing the operator's threshold,
  // never on a raw reading: the `battery` slice was measured writing 526 times
  // in 25 minutes with zero value changes, and a reading that oscillates around
  // the edge must not produce pairs of notifications. A BINARY indicator (an HA
  // `binary_sensor` with `device_class=battery`, which has no real level)
  // ignores the threshold entirely — the provider already decided, and its
  // 15 %/100 % stand-ins are not measurements to compare.
  //
  // A device that has NEVER reported a level produces neither kind. Three
  // devices on this installation carried the cap's OLD cold seed
  // (`{percentage: 0, lastUpdated: 0}`, since replaced with `{percentage:
  // null, ...}`, D663); announcing those as flat is the one failure this
  // whole family had to be built around.
  'device-battery-low',
  // The recovery, and the reason it is a KIND rather than a polarity on the
  // one above: an operator who filters on "tell me about flat batteries" must
  // not be shown the ones that got better. It is gated by a cluster flag that
  // defaults ON, and it fires on the LEDGERED band transition — see D141 for
  // the same split between `device-offline` and `device-online`.
  'device-battery-normal',
  // The same pair for a CONSUMABLE — a filter, a brush, a mop pad — and the
  // same machinery: a durable episode, a band transition, a re-notify
  // interval. The subject carries the ITEM (`consumable:<id>:<key>`), because
  // a device has several and one subject for all of them would let the
  // brush's alert cancel the filter's.
  'device-consumable-low',
  'device-consumable-normal',
  'stream-online',
  'stream-offline',
  'node-online',
  'node-offline',
  // A node announcing its OWN restart before it exits (D723), split by the
  // one fact the operator acts on: `node-restarting` is a plain restart (no
  // target version — the node comes back as it was), `node-updating` is the
  // restart an update drives (it names the node and both versions). The same
  // `system.restarting` event carries both; the intake tells them apart with
  // the rule `server-updated` already uses — an update needs a VERSION.
  'node-restarting',
  'node-updating',
  // ── THE TWO SILENT FAILURES ───────────────────────────────────────────
  //
  // Both report a component that is UP and PRODUCING NOTHING, which is the
  // one shape ordinary liveness cannot express: the node is online, the
  // camera is decoding, the session is open — and no work comes out.
  //
  // `node-inference-unavailable`: every accelerator the operator enabled on
  // a node reads unavailable to the live probe. The node keeps answering,
  // keeps looking healthy, and fails every inference it is handed —
  // agent-a absorbed 283k errors in one day exactly like that. The
  // orchestrator ALSO drops such a node from placement, so this event is the
  // only notice an operator gets that their cluster just got smaller.
  //
  // `detection-blind`: a camera with an OPEN detection session that has
  // produced no detection for the blind threshold. A 1h43 blackout on the
  // entrance camera went unnoticed because a blind camera and a quiet camera
  // are byte-identical in every existing signal.
  //
  // Neither has a paired "recovered" kind: recovery is logged, and a
  // notification that the thing which was broken is no longer broken is a
  // second rule nobody asked for. Add one when an operator does.
  //
  // D907: `detection-blind` now means the camera MOVED (>= 10 min of session
  // time over >= 3 sessions) and the detector produced NOTHING, not even a
  // below-floor candidate. Constant motion with no subject is its own paired
  // class: `motion-noisy` (over a rolling hour with zero detections, motion
  // duty >= 25% or >= 40 sessions) and `motion-calm` (it fell back, or a
  // detection arrived). The body tells the operator to tune the motion zones
  // or sensitivity — the detector is fine.
  'node-inference-unavailable',
  'detection-blind',
  'motion-noisy',
  'motion-calm',
  // D931 (2026-10-26): a packages rule's LLM confirm failed closed three
  // times in a row (`package-llm-silent`) and then answered again
  // (`package-llm-answered`). One open notice per camera. Scene-difference
  // parcels are not emitted until the confirm says yes.
  'package-llm-silent',
  'package-llm-answered',
  // ── RECORDING THAT SHOULD BE WRITING AND IS NOT ───────────────────────
  //
  // `recording-stalled`: the camera's recording is ON (enabled, not switched
  // off) and no segment has finalized for the stall window. The idle writer
  // watchdog already re-pins in silence; this is the operator-facing edge.
  // `recording-healthy` is the recovery, split so a "stall only" rule does
  // not announce the cameras that came back.
  // `recording-degraded`: a writer's bounded inner restart budget is spent
  // (restart storm) — different from a quiet gap, and terminal until the
  // next successful segment.
  'recording-stalled',
  'recording-healthy',
  'recording-degraded',
  // ── A DEVICE THAT NEEDS THE OPERATOR (D911) ───────────────────────────
  //
  // The device's own addon raised a critical alert about it (a missing PIN,
  // a rejected credential). It is announced in the devices family, not as
  // `alert-critical`: the same alert episode notifies ONCE, through ONE family.
  // `device-attention-resolved` is the recovery.
  'device-attention-required',
  'device-attention-resolved',
  // ── STORAGE LOCATIONS RUNNING OUT (OR UNREADABLE) ─────────────────────
  //
  // Per location, not per camera: free space on the class subtree (D327).
  // `critical` also covers a failed capacity probe (`null`, never folded to
  // 0 — D393). `ok` is the recovery from either band.
  'storage-location-low',
  'storage-location-critical',
  'storage-location-ok',
  // ── THE THIRD SILENT FAILURE: A RUNNER NOBODY WILL RESTART ────────────
  //
  // `addon-crash-loop` is the D6 crash circuit-breaker having given up. The
  // breaker is right to stop respawning a runner that crashed
  // `MAX_CRASHES_IN_WINDOW` times inside `CRASH_WINDOW_MS` — an infinite
  // respawn loop is worse — but until 2026-08-18 it did so in SILENCE. Three
  // cameras were unplugged, three unhandled ffmpeg spawn errors (EAGAIN)
  // killed the `recorder` runner, the breaker tripped, and every recording
  // capability answered "provider not available" for three hours and fifteen
  // minutes while `/health` returned 200 and no event was emitted at all.
  //
  // It is NODE-scoped and carries no device: a runner is not a camera, and
  // the addons it hosted are named in the sentence rather than filtered on.
  // Terminal by construction — nothing will clear it but an operator — so it
  // has no paired "recovered" kind for the same reason the two above do not.
  'addon-crash-loop',
  'addon-update-available',
  'server-update-available',
  // The SHELL the node runs inside is behind the release contract — a Docker
  // image from a repository nothing rebuilds (2026-08-02), an Electron bundle
  // older than the closure it launches. It is its own kind rather than a
  // variant of `server-update-available` because it is the opposite fact:
  // `runningVersion` can be perfectly current, which is exactly why every
  // existing surface said "up to date" on a hub whose image was 13 days old.
  // Purely informative — no node can replace its own shell (D437).
  'wrapper-update-available',
  // ── THE ALARM PANEL'S OWN LIFECYCLE ───────────────────────────────────
  //
  // The panel is a DEVICE and its transitions are facts about the
  // installation, so they are ordinary system events: "tell me when the alarm
  // goes off" is authored exactly like "tell me when a node goes away", and the
  // engine keeps no alarm branch. Emitted once per TRANSITION by
  // `NcAlarmPanelDevice.publish()` — never on the first publish after a
  // restart, or every deploy would announce an arm nobody performed.
  //
  // `alarm-triggered` is the one that can carry the pictures: when the trigger
  // came from a rule's `onTrigger` sequence, the event is stamped with that
  // rule and its subject, and the notification is COMBINED — alarm words,
  // rule media, one row. See `alarm-trigger-source.ts` in the addon.
  //
  // `alarm-arming` is the EXIT DELAY, and it is a separate kind rather than a
  // variant of `alarm-armed` for one reason: it is the only alarm notification
  // that arrives while the operator can still act on it. "Away armed" lands
  // after the countdown, when a mode that protects nothing is already the
  // state; "arming, 30s" lands at the start of it, with a Disarm button and
  // thirty seconds to use it. It is emitted only when an exit delay actually
  // runs — `exitDelaySec: 0` arms straight from `disarmed` and produces
  // exactly one notification, not two.
  //
  // `alarm-arm-refused` is the one that reports something NOT happening: an
  // arm the panel turned down because a contact the mode covers reads open.
  // It is a kind rather than a variant of `alarm-armed` because it is the
  // opposite fact — the panel is still disarmed — and an operator who
  // filters on "armed" must not be shown the arms that never took effect.
  'alarm-triggered',
  'alarm-armed',
  'alarm-disarmed',
  'alarm-arming',
  'alarm-arm-refused',
  // The entry delay started: a covered sensor tripped and the siren follows
  // unless someone disarms first.
  'alarm-pending',
  // The panel re-armed itself after a bounded siren (`triggeredDurationSec`).
  'alarm-rearmed',
  // A covered sensor was bypassed or restored; `textParams.event` is
  // `ignored` or `lifted`.
  'alarm-sensor-bypass',
  // The arm went ahead because the openings could not be read (D49: an
  // unreadable state never blocks, and never goes unreported).
  'alarm-check-failed',
  // Completed (not merely available) package/server updates, plus a footage
  // export that finished rendering. `addon-updated` is coalesced across a
  // 30 s window so a bulk job is one notification of N addons, not N pushes.
  'addon-updated',
  'server-updated',
  'export-completed',
  // A whole backup RUN, not one destination — see
  // `EventCategory.BackupRunCompleted`. The message carries how many
  // destinations won and how many did not, because a run where two of three
  // succeeded is not a clean success and must not read as one.
  'backup-completed',
  // ── THE ALERT CENTRE'S EPISODES ───────────────────────────────────────
  //
  // The alert centre sends nothing of its own: a critical or error alert
  // reaches the operator ONLY through a rule on these kinds. One notification
  // per alert EPISODE (a re-emit of an open alert never repeats it; a new
  // episode after completion does). `alert-critical-resolved` closes a critical
  // episode; an `error` episode announces its opening only.
  'alert-critical',
  'alert-error',
  'alert-critical-resolved',
  // ── A NOTIFICATION RULE THAT CANNOT WORK ──────────────────────────────
  //
  // `rule-broken`: a stored rule the centre cannot load (its row fails the
  // schema), or one that still names a device or a delivery target the prune
  // CONFIRMED deleted (two answered directory reads + `getDevice === null`,
  // D49) and therefore kept and switched off. One edge per rule per distinct
  // set of reasons; an unanswered read raises nothing. `rule-repaired` is the
  // clear. Camera 108's stream-offline rule had been skipped silently for
  // four days before this existed (2026-10-22).
  'rule-broken',
  'rule-repaired',
  // ── LEGACY TAIL — parsed, never produced, never offered ───────────────
  //
  // These are the pre-generic names. They stay in the enum for two durable
  // readers, and for nothing else:
  //
  //   - OUTBOX + HISTORY ROWS enqueued before the rename froze their kind, and
  //     the history VIEW parses it back out through this enum. Dropping the
  //     member would make one old row poison the whole history call.
  //   - The operator's LIVE RULE still carries them until it is migrated
  //     (kinds → `device-*` plus `deviceTypes: ['camera']`). A rule that fails
  //     to parse is a rule that vanishes from the editor.
  //
  // They match nothing: the intake produces only the generic kinds, so a rule
  // still carrying one is a rule that cannot fire — which is why the migration
  // is a note in the release, not an optional cleanup.
  //
  // DELETE THEM when no outbox row older than `OUTBOX_RETENTION_MS` can carry
  // one and every rule has been migrated.
  'camera-online',
  'camera-offline',
  'camera-disabled',
  'camera-enabled',
])
export type NcSystemEventKind = z.infer<typeof NcSystemEventKindSchema>

/** The legacy tail of {@link NcSystemEventKindSchema} — see its docblock. */
export const NC_LEGACY_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] = [
  'camera-online',
  'camera-offline',
  'camera-disabled',
  'camera-enabled',
]

const NC_LEGACY_SYSTEM_EVENT_KIND_SET = new Set<string>(NC_LEGACY_SYSTEM_EVENT_KINDS)

/**
 * The kinds a rule may be AUTHORED with — every schema member except the
 * legacy tail. Editors render THIS list; the schema still parses the tail so a
 * durable row (and an unmigrated rule) survives being read.
 */
export const NC_AUTHORABLE_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] =
  NcSystemEventKindSchema.options.filter((kind) => !NC_LEGACY_SYSTEM_EVENT_KIND_SET.has(kind))

/**
 * The panel's transitions, as ONE list.
 *
 * Named here rather than spelled out at each of the four sites that need them
 * (the emitter, the intake, the editor group, the combined-notification gate),
 * because a transition added to the enum and forgotten at one of them is an
 * alarm state nobody can be notified about. That is exactly what this list
 * failed to prevent while it held three: `alarm-arming` was the fourth.
 *
 * In LIFECYCLE order, which is the order an editor lists them in and the order
 * a person experiences them — not the order they were added.
 */
export const NC_ALARM_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] = [
  'alarm-arm-refused',
  'alarm-check-failed',
  'alarm-arming',
  'alarm-armed',
  'alarm-pending',
  'alarm-triggered',
  'alarm-rearmed',
  'alarm-sensor-bypass',
  'alarm-disarmed',
]

/**
 * The SUSTAINED device-health family — a battery or a consumable below the
 * operator's threshold, and its recovery. Named once because three readers
 * need the same four: the viewer's dedicated "battery and consumables" rule
 * section (a stored system rule whose kinds are ALL in this family is shown
 * there), both editors' warning when these kinds meet a `deviceTypes` filter
 * (the filter that silenced the live rule for two weeks — D636), and the
 * catalog parity spec.
 */
export const NC_BATTERY_CONSUMABLE_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] = [
  'device-battery-low',
  'device-battery-normal',
  'device-consumable-low',
  'device-consumable-normal',
]

/**
 * The two kinds a RULE's consumable threshold speaks about (D642). Named once:
 * the filter scoping (`systemEventFilterApplies`), the hub's threshold census
 * and both editors read it.
 */
export const NC_CONSUMABLE_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] = [
  'device-consumable-low',
  'device-consumable-normal',
]

/**
 * The consumable threshold a rule that does not state one judges at (D642).
 * The operator's number ("default 15 %, configurable on the rule"), and the
 * value the cluster-wide setting it replaces shipped with.
 */
export const NC_CONSUMABLE_LOW_PERCENT_DEFAULT = 15

/**
 * The highest consumable threshold a rule may state (D642 review M1): 100 minus
 * the band's 5-point recovery hysteresis (`consumable-band.ts`). Above it the
 * recovery point passes 100 % and an episode could never clear, even for a
 * part just replaced. A spec in the notification centre pins the sum.
 */
export const NC_CONSUMABLE_LOW_PERCENT_MAX = 95

/**
 * One coherent system-event condition. `kinds` is the required opt-in safety
 * gate; the remaining lists are optional narrowing filters relevant to the
 * selected kinds.
 */
export const NcSystemEventConditionSchema = z.object({
  kinds: z.array(NcSystemEventKindSchema).min(1),
  deviceIds: z.array(z.number().int()).min(1).optional(),
  /**
   * Narrow a `device-*` kind to these device TYPES (`DeviceType` values —
   * `camera`, `switch`, `sensor`, `container`, …). Absent = every type, which
   * is what a liveness rule means when nobody said otherwise.
   *
   * This is where "only my cameras" is expressed, and it lives on the rule for
   * one reason: the intake cannot know which devices this household cares
   * about, and a producer-side filter is one no operator can change. Fails
   * CLOSED — a subject whose device type is unknown (an id the device mirror
   * does not carry) matches no `deviceTypes` list.
   */
  deviceTypes: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Devices this rule NEVER speaks about, whatever else matched. Scoped to the
   * same kind family as `deviceIds` (`systemEventFilterApplies(kind,
   * 'deviceIds')`) and applied AFTER it: include first, then exclude. A
   * consumable subject (`consumable:<id>:<key>`) is excluded by its device id.
   *
   * It never fails closed: a subject that carries no device id is not in the
   * list, so it is not excluded. "Every battery except the one thermometer that
   * reads 0 % forever" is the question this answers — expressed as an include
   * list it would have to name every other battery device, and every device
   * adopted later would be silently left out (D636).
   */
  excludeDeviceIds: z.array(z.number().int()).min(1).optional(),
  nodeIds: z.array(z.string().min(1)).min(1).optional(),
  packageNames: z.array(z.string().min(1)).min(1).optional(),
  /**
   * At or below this remaining-life %, a consumable is LOW for THIS rule
   * (D642). Absent = {@link NC_CONSUMABLE_LOW_PERCENT_DEFAULT}; at most
   * {@link NC_CONSUMABLE_LOW_PERCENT_MAX}, so every episode can recover. Scoped to the
   * consumable kinds (`systemEventFilterApplies`) and to the device-events
   * family; ignored on every other kind.
   *
   * It is a property of the RULE because the operator decided so: a rule at
   * 25 must be told about a filter at 20 %, a rule at 10 must not. The hub
   * keeps one episode per (threshold, device, item) — its own hysteresis, its
   * own reminder — and a rule hears only the episode judged at ITS threshold,
   * exactly as an occupancy rule hears only the edge of its own count. A
   * provider's own `replace` verdict is low at every threshold.
   */
  consumableLowPercent: z.number().int().min(1).max(NC_CONSUMABLE_LOW_PERCENT_MAX).optional(),
})
export type NcSystemEventCondition = z.infer<typeof NcSystemEventConditionSchema>

/** The consumable threshold a system-event condition judges at (D642). */
export function consumableLowPercentOf(condition: NcSystemEventCondition): number {
  return condition.consumableLowPercent ?? NC_CONSUMABLE_LOW_PERCENT_DEFAULT
}

/**
 * `maxPerTrack` for `immediate` rules is FIXED at 1 (D-3): a single track
 * fires an immediate rule at most once, enforced durably by the outbox
 * unique key `(ruleId, trackId, targetId)`. Not a rule field in P1.
 */
export const NC_MAX_PER_TRACK_IMMEDIATE = 1

// ── Snooze bounds ───────────────────────────────────────────────────
//
// Declared HERE, far from the snooze section they belong to, because
// `NcRuleInputSchema.snoozeOptions` bounds itself on the ceiling and a `const`
// read at module-eval time cannot be declared below its reader.

/** Hard ceiling on a window (24h). A snooze that could not expire would be an
 *  outage the operator asked for once and forgot. */
export const NC_SNOOZE_MAX_MINUTES = 1440

/**
 * The durations a notification offers when its rule does not say otherwise.
 *
 * MINUTES, and short ones: a snooze button is answered on a lock screen, and
 * the three choices that fit there are "the next few minutes", "the next half
 * hour" and "the next hour". Anything longer is a decision somebody sits down
 * to make, which is what the app's own snooze surface is for.
 *
 * Resolved in CODE (`snoozeChoices`), never as a Zod default — see
 * {@link NcRuleInputSchema.shape.snoozeOptions} for why the distinction is
 * load-bearing.
 */
export const NC_DEFAULT_SNOOZE_MINUTES: readonly number[] = [10, 30, 60]

/** One weekly activation window. `startMinute > endMinute` crosses midnight. */
export const NcScheduleWindowSchema = z.object({
  /** Days of week the window STARTS on (0 = Sunday … 6 = Saturday). */
  days: z.array(z.number().int().min(0).max(6)).min(1),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
})
export type NcScheduleWindow = z.infer<typeof NcScheduleWindowSchema>

/** Weekly schedule — OR of windows; absence on the rule = always active. */
export const NcScheduleSchema = z.object({
  windows: z.array(NcScheduleWindowSchema).min(1),
  /** IANA timezone; default = hub host timezone. */
  timezone: z.string().optional(),
  /** Active OUTSIDE the windows (e.g. "only outside business hours"). */
  invert: z.boolean().optional(),
})
export type NcSchedule = z.infer<typeof NcScheduleSchema>

/**
 * How a system-event rule of the `device-events` or `system` family speaks
 * (D647): at once, per event (`instant`, the only behaviour before D647), or
 * as a STATE SUMMARY at the end of each window of `schedule`.
 */
export const NcSystemEventDeliveryModeSchema = z.enum(['instant', 'summary'])
export type NcSystemEventDeliveryMode = z.infer<typeof NcSystemEventDeliveryModeSchema>

/**
 * How a summary window is SENT (D698): `rule` (absent) = ONE notification with
 * every section; `section` = one notification per section with something to
 * say (an unavailable section included), each titled by its section.
 */
export const NcStateSummarySplitSchema = z.enum(['rule', 'section'])
export type NcStateSummarySplit = z.infer<typeof NcStateSummarySplitSchema>

/**
 * `summary`: the rule sends NOTHING per event. When a window of `schedule`
 * CLOSES, it sends one notification with the current state of its kinds
 * (low batteries, consumables to replace, devices offline, updates
 * available, ...), after its own filters — or, with `split: 'section'`
 * (D698), one notification per section. Nothing to report sends nothing.
 * The schedule is the ordinary `NcSchedule` (weekly windows, IANA timezone,
 * midnight crossing); the send time is each window's END. Refused on the
 * `alarm` family, which stays instant (`systemEventDeliveryProblems`).
 */
export const NcSystemEventDeliverySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('instant') }),
  z.object({
    mode: z.literal('summary'),
    schedule: NcScheduleSchema,
    split: NcStateSummarySplitSchema.optional(),
  }),
])
export type NcSystemEventDelivery = z.infer<typeof NcSystemEventDeliverySchema>

/** Fuzzy plate matcher — OCR noise makes exact match useless (spec row 12/13). */
export const NcPlateMatcherSchema = z.object({
  /**
   * Plate texts (or gallery vehicle names) to match. EMPTY = **any plate the
   * pipeline could read** — the plate half of "no selection = no narrowing",
   * and the switch that says this rule is about vehicles that were IDENTIFIED
   * rather than merely seen. A subject carrying no plate still fails.
   *
   * The `.min(1)` this used to carry made that state unauthorable; nothing has
   * ever persisted an empty list, so widening it cannot change an existing rule.
   */
  values: z.array(z.string().min(1)),
  /** Max Levenshtein distance after normalization (uppercase alphanumeric). */
  maxDistance: z.number().int().min(0).max(3).default(1),
})
export type NcPlateMatcher = z.infer<typeof NcPlateMatcherSchema>

/**
 * Occupancy condition (DEVICE-EVENT trigger). Fires on a ZoneAnalytics
 * occupancy edge for a device — optionally narrowed to a single admin
 * `zoneId` and/or object `className`. `op` selects the edge/threshold:
 *  - `became-occupied` (default) — count crossed 0 → ≥ `count`
 *  - `became-free`               — count crossed ≥ `count` → below it
 *  - `>=` / `<=`                 — count is at/over or at/under `count`
 * `sustainSeconds` requires the condition hold continuously that long
 * before firing (debounces flicker; 0 = fire on the first matching edge).
 * Fail-closed: no ZoneAnalytics snapshot / missing zone / null snapshot ⇒
 * the condition never matches. Confirmed edge-state survives addon restarts
 * (declared SQLite collection, reseeded on boot).
 */
export const NcOccupancyConditionSchema = z.object({
  /** Admin zone id to scope the count to; absent = whole-frame occupancy. */
  zoneId: z.string().optional(),
  /** Object class to count; absent = any class. */
  className: z.string().optional(),
  op: z.enum(['became-occupied', 'became-free', '>=', '<=']).default('became-occupied'),
  count: z.number().int().min(0).default(1),
  sustainSeconds: z.number().int().min(0).max(3600).default(15),
})
export type NcOccupancyCondition = z.infer<typeof NcOccupancyConditionSchema>

/**
 * The dBFS floor the analyzer reports on digital silence
 * (`AudioAnalyzerProvider.analyseChunk`: `dbfs = rms > 0 ? 20*log10(rms) : -96`).
 *
 * It is the lower bound of {@link NcAudioConditionSchema.shape.dbThreshold} for
 * one reason worth stating out loud: **the scale is dBFS and it is
 * NEGATIVE-GOING** — `0` is full scale and silence reads as a large negative
 * number. An operator (or a UI) that writes `60` meaning "60 decibels, quite
 * loud" would author a threshold NO sample can ever reach, and the rule would
 * look broken rather than mis-configured. The schema range rejects it instead.
 *
 * Untouched by the D459 scale correction, and structurally so: -96 dBFS is
 * where 16-bit digital silence sits on ANY decoder, right or wrong. It
 * describes the container, not a calibration made through one.
 *
 * @dbfs-era scale-bound
 */
export const NC_AUDIO_DBFS_FLOOR = -96

/**
 * Audio condition (IMMEDIATE trigger) — a rule on SOUND, not on a picture.
 *
 * **TWO EXCLUSIVE MODES** (operator decision 2026-08-14, D157). Which one a
 * rule is in is not a stored field — it is WHICH FILTER the rule carries, so
 * there is no second switch that can disagree with the first and every rule
 * authored before the decision migrates for free (`audioModeOf`):
 *
 *  - **LABEL mode — `labels` present.** The rule fires when `confirmHits`
 *    labelled frames land inside `confirmWindowSec` (default 2 in 5 s).
 *    `hitPercent` and `samplingSeconds` are still ignored — a percentage of
 *    frames is the wrong question for a classifier that labels 1–3 frames
 *    per episode. The count window is the brake that drops a single-frame
 *    false positive; the rule's own `throttle` cooldown is the other. The
 *    per-label confidence floor is the analyzer's (`classificationMinScore`,
 *    per device) — a label only reaches this condition if the classifier was
 *    already confident enough. `confirmHits: 1` restores first-frame fire.
 *  - **LEVEL mode — `dbThreshold` present, no labels.** The sampling window IS
 *    the condition: at least `hitPercent`% of the samples over
 *    `samplingSeconds` must be at or above `dbThreshold` dBFS (see
 *    {@link NC_AUDIO_DBFS_FLOOR}: negative-going, `0` = full scale). The window
 *    must be FULL before it can match — a window open for two of its ten
 *    seconds is 100% of nothing.
 *
 * **Why label mode has no window.** It had one, and it never fired: the
 * analyzer emits ~1 audio frame per second but YAMNet only LABELS one to three
 * of them per episode, even through continuous crying. The measured maximum
 * `hitPercent` over the whole live history was 40 — under the shipped default
 * of 60, so a label rule could not fire at all, ever. A percentage of frames is
 * the wrong question to ask of a sparse classifier.
 *
 * **Fail-closed when NEITHER is given** — every sample would be a trivial hit
 * and the rule would fire on silence. The schema cannot express "exactly one
 * of" without becoming a ZodEffects the cap path would have to special-case, so
 * the exclusivity is enforced where every editor writes (`patchAudio`) and a
 * legacy rule carrying both resolves to LABEL (the mode that fires).
 *
 * Labels are the audio macro classes (`AUDIO_MACRO_LABELS` / the NC taxonomy's
 * `audio-*` ids). Both spellings are accepted — the matcher normalizes the
 * `audio-` prefix away on both sides, so a picker that offers taxonomy ids and
 * an operator who typed `dog` mean the same thing.
 */
export const NcAudioConditionSchema = z.object({
  /** LABEL MODE: audio macro labels. Present ⇒ count-in-window confirm. */
  labels: z.array(z.string().min(1)).min(1).optional(),
  /** LEVEL MODE: floor in dBFS (negative-going, `0` = full scale). */
  dbThreshold: z.number().min(NC_AUDIO_DBFS_FLOOR).max(0).optional(),
  /** LEVEL MODE ONLY: percentage of the window's samples that must be hits (1–100). */
  hitPercent: z.number().int().min(1).max(100).default(60),
  /** LEVEL MODE ONLY: length of the sampling window in seconds. */
  samplingSeconds: z.number().int().min(1).max(300).default(10),
  /**
   * LABEL MODE: how many labelled frames must land inside
   * {@link NcAudioConditionSchema.shape.confirmWindowSec} before dispatch.
   * Absent ⇒ 2 (the matcher default). `1` is first-frame fire.
   */
  confirmHits: z.number().int().min(1).max(20).optional(),
  /** LABEL MODE: the window those frames must share, in seconds. Absent ⇒ 5. */
  confirmWindowSec: z.number().int().min(1).max(60).optional(),
})
export type NcAudioCondition = z.infer<typeof NcAudioConditionSchema>

/**
 * Which zone-crossing DIRECTION a rule accepts (`ObjectEvent.zoneCrossing`).
 *
 * The values are not symmetric, and deliberately so — the absent value has to
 * mean exactly what every rule authored before this condition existed already
 * does:
 *  - `enter` — entries and every NON-crossing record (movement state,
 *    package, sensor). Exits are rejected. **This is the absent behaviour**:
 *    an operator who never asked for exits must not start receiving them.
 *  - `exit`  — ONLY an exit crossing. A record that is not a crossing at all
 *    fails closed, because "the car left the drive" is a question about a
 *    boundary, not about a detection.
 *  - `any`   — no direction filter; entries, exits and non-crossings alike.
 *
 * A rule asking for a direction should normally also scope `zones`, which the
 * engine evaluates against the crossed zone as well as the current membership
 * (an exit's membership no longer contains the zone it just left).
 */
export const NcCrossingSchema = z.enum(['enter', 'exit', 'any'])
export type NcCrossing = z.infer<typeof NcCrossingSchema>

/**
 * Which edge of a BOOLEAN sensor fires a device-event rule (D640).
 *  - `raised`  — the sensor went high: water detected, smoke, open, tampered.
 *  - `cleared` — it went back: dry, clear, closed.
 *  - absent    — both edges, which is what every rule authored before this did.
 *
 * There is no third member for "both": absence already says it, and a value
 * that means the same as absence is a second way to write one rule.
 */
export const NcSensorTransitionSchema = z.enum(['raised', 'cleared'])
export type NcSensorTransition = z.infer<typeof NcSensorTransitionSchema>

/** Admin-zone membership condition (zone IDs as stamped by the ZoneEngine). */
export const NcZoneConditionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /**
   * LEGACY quantifier over `ids`. Absent = `any` (at least one visited), which
   * is what both editors mean and all they write since D690: "all of" was
   * removed from the editors because on an immediate rule it asked one
   * detection to stand in every zone at once. Still ACCEPTED, and `all` still
   * evaluated, so a stored rule keeps parsing and meaning what it meant.
   */
  match: z.enum(['any', 'all']).optional(),
})
export type NcZoneCondition = z.infer<typeof NcZoneConditionSchema>

/**
 * The P1 condition set — a flat AND of groups; absent group = pass;
 * membership lists are OR within the list (spec §2.3).
 */
// ── Rule actions — actuating devices when a rule fires ──────────────

/**
 * What a rule may actuate.
 *
 * **No hand-maintained allowlist** (operator decision, and the right one — a
 * written list of methods is a third parallel map to keep aligned, and this
 * repo has paid for those). The boundary instead comes from a property the
 * capabilities already carry: an action may target only a **device-scoped**
 * capability method.
 *
 * That is not decoration. A rule can be authored by a NON-ADMIN — personal
 * rules are a supported flow — and the executor runs with the addon's
 * privileges, so an unbounded action is an arbitrary RPC channel with a
 * privilege escalation attached. Restricting to device scope excludes the
 * system caps (`device-manager.removeDevice` and friends) by construction,
 * costs nothing to maintain, and cannot rot: a cap that stops being
 * device-scoped stops being actuatable in the same change.
 *
 * The executor enforces it; {@link NcRuleActionSchema} carries the intent.
 */

/**
 * One step of a sequence.
 *
 * `wait` is a first-class step rather than a property of the next action: it is
 * what makes a sequence a SEQUENCE and not a list — "unlock, wait 5s, open"
 * cannot be expressed otherwise.
 */
export const NcRuleActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), seconds: z.number().min(0).max(300) }),
  z
    .object({
      kind: z.literal('cap'),
      /**
       * WHO the step acts on (D983) — the only shape that is written. A sequence
       * stored before D983 carries `deviceId`; the sequence store reads it as a
       * `devices` target.
       */
      target: ActionTargetSchema.optional(),
      /** The vocabulary action the step performs; required for a `domain` target. */
      actionId: z.string().min(1).optional(),
      /** @deprecated The pre-D983 single device. Read, never written. */
      deviceId: z.number().int().optional(),
      /** Capability name, e.g. `alarm-panel`. */
      cap: z.string().min(1),
      /** Method on it. The executor refuses a non-device-scoped cap. */
      method: z.string().min(1),
      /** Method arguments, minus `deviceId` (the executor injects it). */
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((step) => step.target !== undefined || step.deviceId !== undefined, {
      message: 'a cap step needs a target',
      path: ['target'],
    })
    .refine((step) => step.target?.kind !== 'domain' || step.actionId !== undefined, {
      message: 'a domain target needs the vocabulary action it applies to (actionId)',
      path: ['actionId'],
    }),
])
export type NcRuleAction = z.infer<typeof NcRuleActionSchema>

/**
 * A named, ordered run of steps shared across rules, with its own throttle.
 *
 * Sequences live in the notification centre's sequence store — never inline on
 * a rule. A rule binds to one by id ({@link NcActionBindingSchema}), and a
 * button names one the same way. `minDelaySec` exists because a noisy rule
 * otherwise hammers a physical actuator — the rule's own cooldown governs
 * NOTIFICATIONS, which is a different budget from "how often may this gate
 * actually open". The throttle key is the sequence id, so two rules sharing
 * one sequence share its budget.
 */
export const NcSharedSequenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  minDelaySec: z.number().int().min(0).max(86_400).optional(),
  actions: z.array(NcRuleActionSchema).min(1),
})
export type NcSharedSequence = z.infer<typeof NcSharedSequenceSchema>

/** Create / update body — the id is minted by the provider. */
export const NcSharedSequenceInputSchema = z.object({
  name: z.string().min(1).max(120),
  minDelaySec: z.number().int().min(0).max(86_400).optional(),
  actions: z.array(NcRuleActionSchema).min(1),
})
export type NcSharedSequenceInput = z.infer<typeof NcSharedSequenceInputSchema>

/**
 * What one hook slot may run: a shared sequence, or a single step authored
 * inline ("Do").
 *
 * A button may ONLY name a sequence — a one-shot Do on a public callback would
 * be a parallel actuation vocabulary with no throttle and no shared authoring
 * surface.
 */
export const NcActionBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sequence'), sequenceId: z.string().min(1) }),
  z.object({ kind: z.literal('do'), action: NcRuleActionSchema }),
])
export type NcActionBinding = z.infer<typeof NcActionBindingSchema>

/** Bindings on one hook edge. Cap keeps a slot from becoming a second sequence editor. */
export const NcHookBindingsSchema = z.array(NcActionBindingSchema).max(4)
export type NcHookBindings = z.infer<typeof NcHookBindingsSchema>

/**
 * One button carried by the notification, running a shared sequence on tap.
 *
 * **Read this before adding a button that does something physical.** The tap
 * arrives over a link that travelled through third-party infrastructure — ntfy,
 * a push relay, whatever forwarded the message — and the callback's ONLY
 * authority is the token in that link: single-use, short-lived, bound to this
 * one action of this one notification. It does not identify who tapped.
 * Whoever holds the notification can run the button, once, inside the window.
 * That is the operator's explicit choice (2026-08-05), and `destructive` is a
 * rendering hint, not a second gate. [D47](decisions/adr-0047.md).
 */
export const NcRuleNotificationButtonSchema = z.object({
  /** Stable id — travels in the callback and identifies the button in logs. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
  /** Id of a shared sequence. The dispatcher drops a button whose sequence
   *  does not exist rather than minting a token for nothing. */
  sequenceId: z.string().min(1),
  icon: NotificationActionIconSchema.optional(),
  destructive: z.boolean().optional(),
})
export type NcRuleNotificationButton = z.infer<typeof NcRuleNotificationButtonSchema>

/**
 * What a rule runs, by hook edge.
 *
 * Each hook appears here only with an edge that produces it:
 *
 *  - `onActivation` / `onDeactivation` — `setRuleEnabled`
 *  - `onTrigger` — a positive/raised match
 *  - `onTriggerOff` — a clear/leave match (`sensorRaised === false`, occupancy
 *    leave). A delivery with no clear edge never produces this hook.
 */
export const NcRuleActionsSchema = z.object({
  onActivation: NcHookBindingsSchema.optional(),
  onDeactivation: NcHookBindingsSchema.optional(),
  /** Runs on a positive / raised match. */
  onTrigger: NcHookBindingsSchema.optional(),
  /** Runs on a clear / leave match, when the subject carries one. */
  onTriggerOff: NcHookBindingsSchema.optional(),
  /**
   * Buttons the NOTIFICATION carries, each running one shared sequence when
   * tapped. Deliberately a REFERENCE — a button that could define its own
   * actions would be a parallel actuation vocabulary.
   */
  buttons: z.array(NcRuleNotificationButtonSchema).max(8).optional(),
})
export type NcRuleActions = z.infer<typeof NcRuleActionsSchema>

/**
 * @deprecated Legacy inline sequence shape (pre shared-sequence store). Kept
 * only so boot migration / tests can recognise and rewrite persisted rows.
 * New code must use {@link NcSharedSequence} + {@link NcActionBinding}.
 */
export const NcLegacyRuleActionSequenceSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  minDelaySec: z.number().int().min(0).max(86_400).optional(),
  actions: z.array(NcRuleActionSchema).min(1),
})
export type NcLegacyRuleActionSequence = z.infer<typeof NcLegacyRuleActionSequenceSchema>

/** @deprecated Alias kept for call sites mid-migration; prefer {@link NcSharedSequence}. */
export const NcRuleActionSequenceSchema = NcLegacyRuleActionSequenceSchema
/** @deprecated */
export type NcRuleActionSequence = z.infer<typeof NcRuleActionSequenceSchema>

/**
 * "This rule applies only while `deviceId` is in one of `states`."
 *
 * The states are the DEVICE's own vocabulary — `AlarmState` for a panel,
 * `on`/`off` for a switch — not a normalised set, because normalising would
 * make the condition lie about devices whose states have no equivalent.
 *
 * An unreadable state does NOT match: see the engine's fail-closed gate. A
 * condition that fired on "I could not read it" would be worse than no gate.
 */
export const NcDeviceStateConditionSchema = z.object({
  deviceId: z.number().int(),
  /** Any of these matches. */
  states: z.array(z.string().min(1)).min(1),
})
export type NcDeviceStateCondition = z.infer<typeof NcDeviceStateConditionSchema>

/**
 * "This rule applies only while scene `sceneId` is `matched` / `diverged`."
 *
 * A GATE, not a trigger. `occupancy` and `audio` each DISCRIMINATE their rule —
 * carrying one makes the rule fire on that subject and nothing else. Scene is
 * the other shape entirely, the `deviceState` shape: it narrows a rule that
 * already has a trigger ("tell me about a person at the front door, but only
 * while the bin is still out"). That is why it composes with every delivery
 * instead of owning one, and why no new `NcDelivery` member and no new subject
 * kind exist for it — see D159.
 *
 * ── Identity ───────────────────────────────────────────────────────────────
 * `sceneId` is `SceneMonitor.id`, a `randomUUID()` minted by `createScene` —
 * globally unique, so it needs no device to disambiguate it. `deviceId` is
 * carried as a HINT for the editor and for the log line, never as part of the
 * lookup key: a rule whose hint drifted must still gate correctly.
 *
 * ── Which boolean ──────────────────────────────────────────────────────────
 * `latched` ABSENT means "whatever the scene itself says" — `SceneMonitor.emit`
 * already declares which boolean drives notification rules, and a second knob
 * that could disagree with it is exactly the D62 failure. Set it only to
 * override one rule against the scene's own default.
 *
 *  - LIVE reading (`emit`/`latched` resolve to live): passes iff
 *    `verdict === requiredState`. `unknown` — no reference for this light, view
 *    shifted, no snapshot — passes NEITHER. A scene that cannot judge is not
 *    evidence, in either direction.
 *  - LATCHED reading: passes iff `latched === (requiredState === 'diverged')`.
 *    The latch is a durable fact about the past ("it has diverged since I armed
 *    it"), so a camera that has gone dark does not clear it — that is the whole
 *    reason the operator asked for a latch.
 *
 * The gate reads an in-memory mirror (`NcSceneStateCache`) refreshed OFF the
 * event path, never the cap: D49. A mirror that has never loaded, or a scene it
 * does not carry, reads absent and the rule does NOT fire — fail closed, and
 * said out loud in the log rather than dropped in silence.
 */
export const NcSceneConditionSchema = z.object({
  /** `SceneMonitor.id` — the uuid the cap mints. The whole lookup key. */
  sceneId: z.string().min(1),
  /** The camera the scene lives on. A hint for the editor and the log line. */
  deviceId: z.number().int().optional(),
  /** The state the scene must be in for the rule to fire. */
  requiredState: z.enum(['matched', 'diverged']),
  /**
   * Read the LATCH (`true`) or the LIVE verdict (`false`). Absent = follow the
   * scene's own `emit` field, which is the only place that decision belongs.
   */
  latched: z.boolean().optional(),
})
export type NcSceneCondition = z.infer<typeof NcSceneConditionSchema>

export const NcConditionsSchema = z.object({
  /** Gate on ANOTHER device's current state (the alarm armed, a switch on). */
  deviceState: NcDeviceStateConditionSchema.optional(),
  /**
   * Gate on a SCENE's state — "only while the bin is still out". Composes with
   * every trigger (detection, occupancy, audio, sensor, package, track-end);
   * unlike `occupancy`/`audio` it discriminates nothing. See
   * {@link NcSceneCondition} and D159.
   */
  scene: NcSceneConditionSchema.optional(),
  /** Device scope — absent = all devices. */
  devices: z.array(z.number()).optional(),
  /**
   * Device EXCLUSION (D641) — "every device except these". Judged on the SAME
   * subject ids {@link devices} is judged on (the camera, the sensor that
   * fired, a linked set's sensor and row cameras), so a sensor fanned out per
   * linked camera is excluded exactly where an include would have tested it.
   * `min(1)`: an empty exclusion excludes nothing and is written as absent.
   *
   * Not for `system-event` rules — those carry their own
   * `systemEvent.excludeDeviceIds` (D636), and the hub refuses this key there.
   * Editors present the two lists as ONE field (All | Only these | All except
   * these); the engine evaluates each independently, so a legacy rule
   * carrying both still means "these, minus those".
   */
  devicesExclude: z.array(z.number()).min(1).optional(),
  /** Detector class names (any overlap with the record's class set). */
  classes: z.array(z.string().min(1)).optional(),
  /** Veto classes — any overlap fails the rule. */
  classesExclude: z.array(z.string().min(1)).optional(),
  /** Minimum detection confidence 0–1 (fails when the record has none). */
  minConfidence: z.number().min(0).max(1).optional(),
  /** Admin zone membership over event `zones` / track `zonesVisited`. */
  zones: NcZoneConditionSchema.optional(),
  /** Veto zones — any hit fails the rule. */
  zonesExclude: z.array(z.string().min(1)).optional(),
  /**
   * Zone-crossing direction. IMMEDIATE only — a crossing is a per-event fact
   * and a closed track carries none, so a `track-end` rule asking for one
   * fails closed (use `zones`, which tests `zonesVisited`). ABSENT = `enter`,
   * which is exactly today's behaviour. See {@link NcCrossingSchema}.
   */
  crossing: NcCrossingSchema.optional(),
  /**
   * Exact (case-insensitive) match on the record's collapsed `label`
   * (identity name / plate text / subclass).
   */
  labelEquals: z.array(z.string().min(1)).optional(),
  /**
   * KNOWN FACES — the rule's identity scope, and the switch that says the rule
   * is about recognised people at all.
   *
   * Three states, and the empty one is the point:
   *
   * | value | meaning |
   * | --- | --- |
   * | absent | the rule does not care who it is; an unrecognised person matches |
   * | `[]` | **only known faces** — any identity in the gallery, nobody in particular |
   * | a list | only these identities |
   *
   * `[]` is the repo-wide "no selection = no narrowing" reading (an absent
   * `devices` list is every device), applied one level down: the operator has
   * turned the face scope ON and narrowed it to nothing, which is every known
   * face. No second field states the same thing — a switch that can disagree
   * with the list under it is worse than no switch (D62).
   *
   * MEMBERS ARE FACE-GALLERY `Identity.id`s (uuid), not display names. A name is
   * renameable, and a rule authored on "Alice" went silently dark the moment
   * the operator fixed the spelling. The id reaches the record on
   * `LabelAttribution.identityId`; the name is what the editor shows and what
   * `{{label}}` renders.
   *
   * Rules written before this carry NAMES, and are resolved to ids lazily at
   * load (`NcRuleStore.load`) against the live gallery — a name nothing answers
   * for is left as it stands and reported, never dropped. The engine also
   * accepts a display-name hit as a compatibility leg, so a rule whose
   * migration could not resolve keeps matching exactly what it matched before.
   */
  identities: z.array(z.string().min(1)).optional(),
  /**
   * KNOWN PLATES / VEHICLES — the plate mirror of {@link identities}, including
   * the empty-list reading: `values: []` is "any plate the OCR could read",
   * a non-empty list is those plates (fuzzily). See {@link NcPlateMatcherSchema}.
   */
  plates: NcPlateMatcherSchema.optional(),
  /**
   * Identity EXCLUDE — mirror of {@link identities} with `notIn` semantics, and
   * the same id members and the same lazy name→id migration. A record with NO
   * identity passes (nothing to exclude), unlike the include variant which
   * fails on an unrecognised subject. An EMPTY list excludes nobody.
   */
  identitiesExclude: z.array(z.string().min(1)).optional(),
  /**
   * Minimum server-computed key-event importance in [0,1] (`Track.importance`).
   * TRACK-END only: importance is scored at track close, so it does not exist
   * at immediate / object-event evaluation time (see catalog `appliesTo`). At
   * close the value is threaded via the close-time info (the `Track` clone is
   * captured before the DB row is updated, so it would otherwise read stale).
   * Fails when the record carries no importance (never guess quality — the
   * `minConfidence` precedent). MVP cut: a single scalar threshold.
   */
  minImportance: z.number().min(0).max(1).optional(),
  /**
   * Minimum track dwell in SECONDS — `(lastSeen − firstSeen) / 1000`.
   * TRACK-END only: an `immediate` / object-event subject has no closed
   * lifespan, so a dwell condition never matches immediate delivery
   * (documented choice — the object-event record carries no `firstSeen`,
   * so dwell cannot be computed from what the subject actually carries).
   */
  minDwellSeconds: z.number().min(0).optional(),
  /**
   * Detection provenance filter. `any` (default / absent) matches every
   * source; otherwise the subject's source must equal it. Legacy records
   * with no stamped source are treated as `pipeline`. The union spans both
   * record kinds — object events carry `pipeline` | `onboard`, synthetic
   * tracks carry `sensor` (a linked device) or `audio` (a D62 audio marker).
   */
  source: z.enum(['pipeline', 'onboard', 'sensor', 'audio', 'any']).optional(),
  /**
   * Minimum identity / plate MATCH confidence in [0,1] — DISTINCT from the
   * detector `minConfidence` (that gates the object-detection score; this
   * gates the recognition/OCR match score). Fails when the subject carries
   * no label-match confidence (never guess). TRACK-END only: the confidence
   * lives on the recognition result and reaches the subject at track close.
   *
   * What it measures precisely (plumbed at track close — the closer threads
   * the value into `NcTrackClosedInfo.labelConfidence`, the same seam as
   * `importance`): the BEST recognition match confidence observed for the
   * label the track carries at close — for a face, the peak cosine similarity
   * of the ASSIGNED identity (`FaceMatch.score`, reset on an identity switch);
   * for a plate, the peak OCR read score of the best-held plate
   * (`plateText.confidence`). When BOTH a face and a plate were recognized on
   * one track the higher of the two is used. A track that ended with no
   * confident identity/plate match carries no value, so the condition fails
   * closed for it (an un-recognized subject).
   */
  minLabelConfidence: z.number().min(0).max(1).optional(),
  /**
   * DEVICE-EVENT only. Raw device event-type tokens (`EventFire.eventType`,
   * e.g. a doorbell `press` / `press_long`) — matched case-insensitively
   * against the token carried on the device-event subject (extracted from the
   * event-emitter runtime slice's `lastEvent.eventType`). Fails when the
   * subject carries no token. Doorbell-pulse / passive-sensor kinds emit no
   * eventType, so gate those with {@link sensorKinds} instead.
   */
  eventTypeTokens: z.array(z.string().min(1)).optional(),
  /**
   * DEVICE-EVENT only. Sensor/control taxonomy kinds (e.g. `doorbell`,
   * `contact`, `button`, `device-event`) — matched against the persisted
   * `SensorEvent.kind` (see `sensor-event-kinds.ts`). Membership is OR.
   */
  sensorKinds: z.array(z.string().min(1)).optional(),
  /**
   * DEVICE-EVENT only (D640). Fire on one edge of a boolean sensor —
   * {@link NcSensorTransitionSchema}. Which field of the slice means "raised"
   * is `@camstack/types` → `notification/sensor-raised.ts`. A reading the
   * engine cannot place (a kind with no raise, an unreadable slice) PASSES:
   * the condition fails open towards notifying, never towards silence. Editors
   * offer it only when every chosen {@link sensorKinds} member has a raise
   * (`sensorTransitionOffered`), and the hub refuses it on any other delivery.
   */
  sensorTransition: NcSensorTransitionSchema.optional(),
  /**
   * PACKAGE-EVENT only. Which package phase fires the rule — `delivered`
   * (a parked parcel appeared), `picked-up` (it departed), or `both`. Fails
   * when the subject's phase does not match (a subject always carries a phase
   * on the package-event trigger).
   */
  packagePhase: z.enum(['delivered', 'picked-up', 'both']).optional(),
  /** Infrastructure/liveness/update event matcher (`system-event` delivery). */
  systemEvent: NcSystemEventConditionSchema.optional(),
  /**
   * PERSONAL-RULE custom zones (viewer-drawn). Inline normalized polygons
   * (MaskShape vocabulary). A record passes when its bbox overlaps ANY
   * listed polygon (ZoneEngine membership semantics). Evaluated only when
   * the subject carries a bbox; absent bbox ⇒ the condition FAILS.
   */
  customZones: z.array(MaskPolygonShapeSchema).optional(),
  /**
   * DEVICE-EVENT only. ZoneAnalytics occupancy edge — fires when a device's
   * (optionally zone/class-scoped) occupancy count crosses the configured
   * threshold and holds for `sustainSeconds`. Fail-closed on missing
   * substrate (no snapshot / missing zone). See {@link NcOccupancyCondition}.
   */
  occupancy: NcOccupancyConditionSchema.optional(),
  /**
   * IMMEDIATE only. Sustained-sound matcher — `hitPercent` of the samples in a
   * `samplingSeconds` window clear the optional `dbThreshold` and carry one of
   * the optional `labels`. Fail-closed on missing substrate (no audio samples,
   * a window that is not full yet, neither filter given). See
   * {@link NcAudioCondition}.
   *
   * Presence of this key is what makes a rule an AUDIO rule: the engine fires
   * it ONLY on a confirmed audio window, and a rule carrying it never fires on
   * a detection, a track or a device event (the same fail-closed pairing
   * `occupancy` has with the `device-event` trigger). That is how audio labels
   * leave `classes`: an audio rule names its sounds HERE, and the legacy path
   * (an `immediate` rule naming an `audio-*` class, one notification per
   * classified sample) stays exactly as it was for rules that already use it.
   *
   * In {@link NC_CONDITION_CATALOG} since P2, and the ORDER it got there is the
   * rule rather than an accident: the viewer mirrors the descriptor enums BY
   * HAND (`camstack/src/data/notification-center.ts`, guarded by
   * `scripts/check-viewer-condition-mirror.ts`) and its rule editor strips the
   * condition fields it does not know when a rule is saved from the phone.
   * Publishing an editor for a condition the app cannot round-trip is how an
   * operator loses a rule's conditions by opening it — so the viewer mirror
   * (P3, shipped) went FIRST, and the descriptor an editor renders from
   * follows here.
   */
  audio: NcAudioConditionSchema.optional(),
})
export type NcConditions = z.infer<typeof NcConditionsSchema>

/** One delivery target: a `notification-output` Target ref + passthrough params. */
export const NcRuleTargetSchema = z.object({
  /** `notification-output` Target id. */
  targetId: z.string().min(1),
  /**
   * Per-backend passthrough. Recognized keys are mapped onto the canonical
   * Notification (`priority`, `level`, `sound`, `clickUrl`, `ttl`); the
   * degrade engine drops what the backend can't render.
   */
  params: z.record(z.string(), z.unknown()).optional(),
})
export type NcRuleTarget = z.infer<typeof NcRuleTargetSchema>

/**
 * WHAT THE NOTIFICATION'S PICTURE IS (D897) — the ONE media choice of a rule.
 *
 * Every mode starts from the same CLEAN source frame of the trigger moment
 * (keyFrame → sceneFrame → lastSceneFrame, narrowed to the trigger instant and
 * to the zone that fired the rule) and renders it once at send time:
 *  - `scene-boxes` — the whole scene, the subject outlined thick in the accent
 *    colour and every OTHER track visible at that instant outlined thin, each
 *    labelled with class and confidence ("dog 87%").
 *  - `crop`  — the subject cut out of that frame around its box at that instant.
 *  - `clean` — the whole scene with nothing drawn on it.
 *  - `none`  — no picture.
 *
 * A mode that cannot be honoured (no box at that instant, a photograph with no
 * tracked subject) ships `clean` and names the reason in the log, per camera.
 * It replaces the `attach` × `frame` × `zoneCrop` triple, which let one rule
 * ship a crop on one event and a boxed scene on the next depending on which
 * stored kind had landed.
 */
export const NcMediaImageSchema = z.enum(['scene-boxes', 'crop', 'clean', 'none'])
export type NcMediaImage = z.infer<typeof NcMediaImageSchema>

/**
 * @deprecated Read only by `normalizeNcMediaPolicy` (D897) — see {@link NcMediaImageSchema}.
 *
 * Media attachment policy (P1 still-image subset).
 *  - `best` — the best AVAILABLE subject image at dispatch time (D-3).
 *  - `best-matching` — the media that explains WHY the rule fired: a rule
 *    matched on identities attaches the subject's `faceCrop`, one matched on
 *    plates attaches the `plateCrop`; a rule with no identity/plate condition
 *    (or when the specific crop is missing) degrades to `best`, then
 *    `keyFrame`, then no attachment — never delaying the send. The matched
 *    condition summary is frozen on the outbox row at enqueue (like the rule
 *    name), so the choice never drifts from the record that fired it.
 *  - `keyFrame` — the clean scene frame (no subject box).
 *  - `none` — no attachment.
 */
/**
 * @deprecated Read only by `normalizeNcMediaPolicy` (D897) — see {@link NcMediaImageSchema}.
 *
 * WHAT THE PICTURE SHOWS — chosen explicitly, because the implicit ladders
 * conflate it with the selection strategy and betray the request: asking for
 * the clean scene frame on an object-event owner used to start at
 * `fullFrameBoxed`, i.e. the annotated frame (2026-07-30).
 *  - `cropped` — the subject, tight. What "who is at the door" wants.
 *  - `full`    — the clean scene, no annotation. What "what is going on" wants.
 *  - `boxed`   — the scene WITH the detection boxes drawn, for verifying what
 *                the pipeline actually saw.
 */
export const NcMediaFrameSchema = z.enum(['cropped', 'full', 'boxed'])
export type NcMediaFrame = z.infer<typeof NcMediaFrameSchema>

/**
 * How a SENSOR notification shows the cameras that link the sensor.
 *
 * `mosaic` — one image composed of every linked camera's photograph, taken at
 * the trigger. `each` — one image per camera where the target takes several
 * attachments; a target that takes one keeps the first camera's (the degrade
 * engine drops the rest by order). Either way ONE notification per event.
 * Absent = `mosaic`, applied by the Notification Center and deliberately NOT
 * a Zod default (see NcRulePatchSchema: a default materialises on every
 * partial patch). Meaningless for a rule whose subject is not a sensor, and a
 * sensor linked to one camera ships that camera's plain snapshot either way.
 */
export const NcLinkedCameraModeSchema = z.enum(['mosaic', 'each'])
export type NcLinkedCameraMode = z.infer<typeof NcLinkedCameraModeSchema>

/**
 * The clip window a rule gets when it stores no `clipPreRollSec` /
 * `clipPostRollSec` (D654): 4 s before the moment, 6 s after.
 *
 * THE one owner. The Notification Center resolves an absent roll to these at
 * dispatch and sizes the broker's clip ring from them (`clip-retention-ask`).
 * The admin editor does not author the roll; the viewer editor still keeps its
 * own 3 / 7 until it imports these (viewer follow-up). A second copy is how the
 * viewer came to display 3 / 7 — copied from a stale comment on the schema
 * below — while the hub cut 4 / 6, and to prune a typed 3 back to "absent",
 * which the hub then read as 4.
 *
 * A product decision of the notification, not the broker's history window
 * (D381/D382): the clip is cut from the broker's per-camera clip ring, which
 * the rules size, not from a pre-roll dial.
 */
export const NC_CLIP_PRE_ROLL_DEFAULT_SEC = 4
export const NC_CLIP_POST_ROLL_DEFAULT_SEC = 6

export const NcMediaPolicySchema = z.object({
  /**
   * The picture — see {@link NcMediaImageSchema}. Absent on a rule nobody has
   * saved since D897: `normalizeNcMediaPolicy` derives it from the legacy
   * triple below, at load and at every write, and the store keeps only this.
   */
  image: NcMediaImageSchema.optional(),
  /**
   * Draw the zone that FIRED the rule on the picture (`scene-boxes` / `clean`;
   * a `crop` never shows it). Valid only on a rule whose trigger is a zone —
   * `conditions.zones` or an occupancy zone — and refused on save otherwise.
   * Replaces `zoneCrop`.
   */
  showTriggerZone: z.boolean().optional(),
  /**
   * Draw the SUBJECT'S PATH on the picture — a line in the subject's colour
   * through the track's positions up to the frame shown, the same path the
   * debug views draw (`buildSubjectPath`, D903). Every picture mode a subject
   * is drawn on: a `crop` maps the path into the crop and clips it. Valid only
   * on a rule whose subject is a tracked object (refused on a sound rule);
   * dropped on `image: 'none'`. Absent = off.
   */
  showSubjectPath: z.boolean().optional(),
  /** @deprecated D897 — accepted from an editor that predates `image`, folded into it on save. */
  attach: z.enum(['best', 'best-matching', 'keyFrame', 'none']).optional(),
  /** @deprecated D897 — accepted from an editor that predates `image`, folded into it on save. */
  frame: NcMediaFrameSchema.optional(),
  /** @deprecated D897 — folded into `image: 'clean'` + `showTriggerZone` on save. */
  zoneCrop: z.boolean().optional(),
  /**
   * Also attach a short GIF cut from the stream broker's clip ring around the
   * event — NOT from the recording, so the camera does not have to be
   * recording, and the window sits AROUND the moment instead of a segment
   * behind it. Fail-closed: a window the ring does not cover contributes no
   * gif, never a failed notification.
   */
  gif: z.boolean().optional(),
  /**
   * Also attach a short MP4 CLIP of the same cut. Same source and the same
   * fail-closed rule as `gif`. Prefer it where the backend takes video
   * (telegram, discord, zentik, webhook); backends that do not are handled by
   * the degrade engine, which drops the video and keeps the still.
   */
  clip: z.boolean().optional(),
  /**
   * Seconds of footage BEFORE / AFTER the event instant. Absent =
   * {@link NC_CLIP_PRE_ROLL_DEFAULT_SEC} / {@link NC_CLIP_POST_ROLL_DEFAULT_SEC}
   * (4 / 6), resolved by the Notification Center at dispatch — deliberately not
   * a Zod default, so a rule that never chose keeps following the hub's.
   */
  clipPreRollSec: z.number().int().min(0).max(30).optional(),
  clipPostRollSec: z.number().int().min(0).max(30).optional(),
  /**
   * Playback rate of the attached gif / clip. Absent = 2x.
   *
   * A notification clip is GLANCED at on a lock screen, not watched: at real
   * time an eight-second passage is eight seconds of the recipient's attention
   * and twice the bytes. 1 is real time for the operator who wants it.
   */
  clipSpeed: z.number().min(1).max(8).optional(),
  /**
   * Which stream profile the footage is cut from. Absent = the CHEAPEST
   * assigned profile: a notification is watched on a phone, so the 4K
   * rendition would burn CPU to produce a file the client downscales anyway.
   * A profile that is not assigned falls back to the cheapest, and the render
   * reports which one actually ran.
   */
  profile: CamProfileSchema.optional(),
  /** See {@link NcLinkedCameraModeSchema}. */
  linkedCameras: NcLinkedCameraModeSchema.optional(),
})
export type NcMediaPolicy = z.infer<typeof NcMediaPolicySchema>

/**
 * Cooldown GRANULARITY over the subject's class — how much a fired
 * notification suppresses.
 *  - `per-class` (default, and the absent value since 2026-10-01 — D36) — an
 *    independent window per detected class: cat→dog fires at once, cat→cat
 *    still waits.
 *  - `shared` — one window for the whole rule/scope: a cat silences the next
 *    dog for `cooldownSec`. Only written when an operator picks it; it is no
 *    longer what an unset rule means.
 *
 * AUDIO subjects are ALWAYS per-class regardless of this setting: a scream
 * must not be swallowed by a bark's window (the precedent this generalizes —
 * see `cooldownKey` in the rule engine).
 */
export const NcThrottleGranularitySchema = z.enum(['shared', 'per-class'])
export type NcThrottleGranularity = z.infer<typeof NcThrottleGranularitySchema>

/** Throttle — cooldown survives restarts (rebuilt from the outbox on boot). */
export const NcThrottleSchema = z.object({
  cooldownSec: z.number().int().min(0).max(86_400).default(60),
  /** `rule` = one shared cooldown; `rule-device` = per-camera cooldown. */
  scope: z.enum(['rule', 'rule-device']).default('rule-device'),
  /**
   * Class granularity of the cooldown key. Optional rather than defaulted:
   * a Zod default does NOT run on the addon→addon cap path, so a persisted
   * rule authored before this field simply carries none. The engine used to
   * read absent as `shared` (D36); since 2026-10-01 it reads absent as
   * `per-class` — the operator's default — and only an explicit `shared`
   * still means `shared`. See `cooldownKey` / `keysPerClass` in the rule
   * engine, and D36's dated note.
   */
  granularity: NcThrottleGranularitySchema.optional(),
})
export type NcThrottle = z.infer<typeof NcThrottleSchema>

/**
 * How long the confirm gate may hold ONE notification, and how big the picture
 * it judges may be.
 *
 * The clamp is the product decision, not a coincidence of the model: p50 was
 * 4.9 s warm and 15.3 s cold against qwen3-vl-8b, and a notification that
 * arrives after the visitor has gone is not a notification. 448 px was enough
 * to score 16/16 on the operator's parking scenario — bigger costs latency and
 * tokens for pixels the model pools away.
 */
export const NC_CONFIRM_MIN_TIMEOUT_MS = 1_000
export const NC_CONFIRM_MAX_TIMEOUT_MS = 20_000
export const NC_CONFIRM_DEFAULT_TIMEOUT_MS = 8_000
export const NC_CONFIRM_DEFAULT_MAX_IMAGE_PX = 448

/** Comparison the model's COUNT must satisfy for the notification to fire. */
export const NcConfirmExpectSchema = z.object({
  op: z.enum(['>=', '>', '<=', '<', '==']),
  count: z.number().int().min(0).max(1_000),
})
export type NcConfirmExpect = z.infer<typeof NcConfirmExpectSchema>

/**
 * AI CONFIRM — a vision model looks at the picture this notification is about
 * to ship and says whether it agrees with the rule.
 *
 * It runs AFTER the attachments resolve, deliberately: the crop JUDGED is the
 * crop SHIPPED (D52). A verdict about a different pixel rectangle than the one
 * on the operator's phone is not a verdict about this notification.
 *
 * FAIL-OPEN is the only safe default. A gate that cannot reach its model, or
 * whose model is cold, must not silence a camera — so `onTimeout: 'fire'` is
 * the default and every fail-open is COUNTED, because a gate that always fails
 * open looks in the log exactly like a gate that works.
 *
 * Every field is `.optional()` rather than relied on as a Zod default at the
 * runtime seam: a Zod default does NOT run on the addon→addon cap path (three
 * production failures in one day), so the gate reads absent as the constant
 * above rather than trusting a parse it may never have seen.
 */
export const NcConfirmSchema = z.object({
  /** Off unless asked for. An absent `confirm` and `enabled:false` are the
   *  same thing, and both mean "deliver exactly as before". */
  enabled: z.boolean().default(false),
  /** Explicit vision profile; absent = the `purpose:'vision'` cluster default. */
  profileId: z.string().optional(),
  /**
   * The operator's question, in his own words. Absent = a question derived
   * from the rule (its class and its expectation).
   *
   * NEVER composed with text READ OUT OF THE FRAME. The model reads OSD
   * banners, signage and plates as instructions if you let them reach the
   * prompt — proven live — so the authoritative contract stays in the system
   * turn and only rule-authored words land here.
   */
  prompt: z.string().max(1_000).optional(),
  /** Fire only when the model's count satisfies this. Absent = the model's
   *  own boolean verdict decides. */
  expect: NcConfirmExpectSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(NC_CONFIRM_MIN_TIMEOUT_MS)
    .max(NC_CONFIRM_MAX_TIMEOUT_MS)
    .default(NC_CONFIRM_DEFAULT_TIMEOUT_MS),
  /** What a timeout / unreachable model MEANS. `fire` (default) = fail-open. */
  onTimeout: z.enum(['fire', 'suppress']).default('fire'),
  /** Longest edge the judged image is downscaled to before it is sent. */
  maxImagePx: z.number().int().min(64).max(2_048).default(NC_CONFIRM_DEFAULT_MAX_IMAGE_PX),
})
export type NcConfirm = z.infer<typeof NcConfirmSchema>

/**
 * IMMEDIATE GROUPED (D692) — the window bounds. ONE owner; both editors import them.
 * MIN: below it nothing has time to be promoted, and operator decision 1 (2026-10-01) makes
 *      it the window's floor too — a window never closes earlier, so companions arriving
 *      together share one message.
 * DEFAULT: equals the tracker's face-settle cap (`FACE_SETTLE_HOLD_MS`, D683 (f)); what an
 *      editor PRE-FILLS, never what absence means (absent = plain immediate).
 * MAX: equals {@link NC_CLIP_RETENTION_MAX_SEC} — past it a gif/clip is always a recordings cut,
 *      and a lock-screen alert a minute late has lost its purpose.
 */
export const NC_GROUPING_MIN_SEC = 5
export const NC_GROUPING_DEFAULT_SEC = 20
export const NC_GROUPING_MAX_SEC = 60

/** Client-supplied rule fields (server stamps id/createdBy/createdAt/updatedAt). */
export const NcRuleInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  delivery: NcDeliverySchema,
  conditions: NcConditionsSchema.default({}),
  schedule: NcScheduleSchema.optional(),
  /**
   * A `device-events` / `system` rule's delivery (D647): absent or `instant`
   * is a notification per event; `summary` is one state summary per closed
   * window of its schedule. `.optional()` and never defaulted: absent must
   * keep meaning what every rule authored before D647 meant, with no
   * migration. Top-level rather than inside `conditions.systemEvent`, so a
   * client that does not know it (an older viewer re-sending `conditions`
   * whole) leaves it standing through the store's patch merge.
   */
  systemEventDelivery: NcSystemEventDeliverySchema.optional(),
  /** May be empty when `targetUsers` addresses at least one user — the
   *  "at least one addressee" invariant is enforced by the provider, because
   *  a cross-field refine here would break `NcRulePatchSchema.partial()`. */
  targets: z.array(NcRuleTargetSchema),
  /**
   * USERS this rule addresses in addition to `targets` (Phase 4). At fire
   * time each user fans out to the personal targets they own
   * (`config.ownerUserId`), filtered by that user's `allowedDevices` for the
   * firing camera — a user is never notified about a device they cannot open.
   * Per-user opt-outs (`disabledTargetIds`) still apply to the fanned-out
   * targets.
   */
  targetUsers: z.array(z.string()).optional(),
  /** Absent = the kind's default picture (`resolveNcMediaImage`): the subject crop for a
   *  detection, the clean scene for a sensor or a sound. Set explicitly on save (D897). */
  media: NcMediaPolicySchema.default({}),
  throttle: NcThrottleSchema.default({ cooldownSec: 60, scope: 'rule-device' }),
  /** `{{var}}` title/body. The variables are declared in `NC_TEMPLATE_VARS` (@camstack/types) and depend on the rule kind — see `templateVarsFor`. */
  template: z
    .object({ title: z.string().max(500).optional(), body: z.string().max(2000).optional() })
    .optional(),
  /** Canonical notification priority ordinal (1..5); per-target overridable. */
  priority: z.number().int().min(1).max(5).default(3),
  /**
   * Ownership/visibility key. Absent = admin/global rule (unchanged legacy
   * behaviour, visible to all, read-only in the viewer). Present = personal
   * rule owned by this userId. Server-stamped; never trusted from a client.
   */
  ownerUserId: z.string().optional(),
  /**
   * May a non-admin snooze this rule for EVERYONE, not just themselves?
   *
   * A snooze is personal by default — it silences the person who set it. This
   * opts THIS rule into the "the gardener is here all afternoon" case, where
   * silencing the camera for the whole household is legitimate. It silences
   * other people, so it is off unless a rule deliberately allows it.
   *
   * `.optional()`, deliberately NOT `.default()`: a Zod default does not run on
   * the addon cap path (three production failures in one day), so absent is
   * read as `false` by {@link canSetGlobal} in the engine. Admins are not bound
   * by this flag — see the scope rules on that function.
   */
  snoozeAllowGlobal: z.boolean().optional(),
  /**
   * The snooze durations THIS rule's notification offers as buttons, in
   * minutes.
   *
   * Three states, and all three are distinct — which is exactly why this is
   * `.optional()` and never `.default()`. A Zod default does not run on the
   * addon cap path (three production failures in one day), so a schema default
   * would collapse the first two:
   *
   * | value | meaning |
   * | --- | --- |
   * | absent | the operator never said ⇒ {@link NC_DEFAULT_SNOOZE_MINUTES} |
   * | `[]` | **no snooze buttons on this rule** — the explicit override |
   * | a list | these choices, de-duplicated and sorted, at most four |
   *
   * `.max(4)` because the notifier's own action budget is small (ntfy allows
   * three buttons in total) and a rule that spent it all on snooze choices
   * would push its own tap-through actions off the notification.
   *
   * An empty list is NOT an alarm exemption: a rule the alarm is about, or
   * that arms the panel, is exempt automatically and cannot be silenced by a
   * window from anywhere (D133).
   */
  snoozeOptions: z.array(z.number().int().min(1).max(NC_SNOOZE_MAX_MINUTES)).max(4).optional(),
  /**
   * Devices this rule ACTUATES — arm the alarm, open a gate, turn on a light.
   *
   * This is what makes the rule set the alarm's trigger set without the alarm
   * being a special case: arming is
   * `{ cap: 'alarm-panel', method: 'arm', args: { mode: 'away' } }`, the same
   * shape as every other actuation.
   */
  actions: NcRuleActionsSchema.optional(),
  /**
   * AI CONFIRM — see {@link NcConfirmSchema}. `.optional()`, never defaulted:
   * a rule that predates the gate must keep delivering byte-for-byte as it
   * did, and absent is the only way to say that without a migration.
   */
  confirm: NcConfirmSchema.optional(),
  /**
   * IMMEDIATE GROUPED (D692): the first matching subject opens a window of this many
   * seconds; the rule sends ONE message when the window closes — early, once every
   * subject in it is final, never before {@link NC_GROUPING_MIN_SEC} — naming everybody
   * the rule matched, with one mosaic tile per subject.
   * Absent = plain immediate (one message per track, at the first match).
   * Only an `immediate` DETECTION rule may carry it (`ruleGroupingApplies`, enforced on
   * save by the hub's grouping guard). `.optional()`, never `.default()`: the addon cap
   * path does not run Zod defaults.
   */
  groupingSec: z.number().int().min(NC_GROUPING_MIN_SEC).max(NC_GROUPING_MAX_SEC).optional(),
  /**
   * ASK ME TO CONFIRM DETECTIONS (#243): a DETECTION notification of this rule
   * carries "Correct" / "Wrong" buttons (and, where the channel has room, a
   * "Wrong, it is a <class>" choice). A tap marks the track for retraining, the
   * same mark the Library writes, and records whose notification it was and
   * when. A channel with no buttons gets the same two choices as links.
   *
   * `.optional()`, never `.default()` (a Zod default does not run on the addon
   * cap path): absent and `false` both mean off, which is what every rule
   * authored before this field meant. An editor turns it off by writing
   * `false`, so it needs no `clear` key.
   */
  askVerdict: z.boolean().optional(),
})
export type NcRuleInput = z.infer<typeof NcRuleInputSchema>

/**
 * Partial patch for `updateRule` — any subset of the input fields, plus the
 * persisted-only {@link NcRuleSchema} `disabledTargetIds` set. The latter is
 * NOT a client-authored input field (it lives on the persisted rule, not the
 * input), so it is added here explicitly to let the store's per-target opt-out
 * toggle round-trip through the shared `update` path. Viewer opt-out mutations
 * still flow through `nc.setRuleTargetEnabled` (owner-checked), never a raw
 * `updateRule` patch.
 */
export const NcRulePatchSchema = NcRuleInputSchema.partial().extend({
  disabledTargetIds: z.array(z.string()).optional(),
  /**
   * `.partial()` DOES NOT REMOVE A FIELD'S `.default()`.
   *
   * It makes the key optional to SUPPLY; the parse still materialises the
   * default when the key is absent. And `NcRuleStore.update` merges with
   * `{ ...existing, ...patch }`, so a materialised key OVERWRITES the stored
   * one — which made every partial edit destructive:
   *
   *   nc.updateRule({ throttle })         → conditions reset to `{}`
   *   nc.setRuleTargetEnabled(...)        → conditions reset to `{}`
   *   setEnabled(ruleId, false)           → conditions reset to `{}`
   *
   * A rule scoped to one camera and one zone silently became a rule that
   * matches EVERY event on EVERY camera, and lost its `media` policy
   * (zoneCrop / gif / clip / frame) and its `priority` at the same time. Seen
   * live on 2026-08-12: a rule scoped to device 102 fired on 104 and 101
   * within a minute of a two-field patch.
   *
   * So every defaulted field is re-declared here WITHOUT its default. The
   * inner defaults still apply when the caller DOES send the key — `{}` for
   * conditions remains a real instruction ("clear them") — and only the
   * absent key is now genuinely absent.
   */
  enabled: z.boolean().optional(),
  conditions: NcConditionsSchema.optional(),
  media: NcMediaPolicySchema.optional(),
  throttle: NcThrottleSchema.optional(),
  priority: z.number().int().min(1).max(5).optional(),
})
export type NcRulePatch = z.infer<typeof NcRulePatchSchema>

/**
 * Keys an older client may still name in `clear` (D692 §2.3). Accepted so its saves are never
 * refused. They are no longer rule fields: `NcRuleStore.update` only strips them from the
 * STORED row, and `NcRuleStore.load` projects what a stored row still carries (D692 §9).
 * Removed one release after the viewer pin in camstack-server stops sending them.
 */
export const NC_RULE_RETIRED_CLEAR_KEYS = ['waitForEnhancement', 'groupIdleSec'] as const

/**
 * Is this clearable key one of the retired ones? A type guard, so the store can split the
 * `clear` list WITHOUT a cast: a retired key is no property of `NcRulePatch` or `NcRule`, and
 * indexing either with it does not compile.
 */
export function isRetiredClearKey(key: string): key is (typeof NC_RULE_RETIRED_CLEAR_KEYS)[number] {
  return NC_RULE_RETIRED_CLEAR_KEYS.some((retired) => retired === key)
}

/**
 * Optional rule fields an editor may EMPTY on an update.
 *
 * `updateRule` merges `{ ...existing, ...patch }`, so an omitted key keeps its
 * stored value — which is what a partial patch must do, and exactly why a
 * field emptied in an editor used to survive the save. An editor names here
 * the keys it AUTHORS and found empty; the store removes them before the
 * merge. A `schedule` cannot be sent empty at all (`windows.min(1)`), so this
 * is the only way to remove one.
 */
export const NC_RULE_CLEARABLE_KEYS = [
  'template',
  'schedule',
  'targetUsers',
  'snoozeOptions',
  'snoozeAllowGlobal',
  'actions',
  'confirm',
  'groupingSec',
  // The retired keys, spelled out (not spread) so the viewer-mirror guard can read the
  // list as literals; the grouping spec pins that this tail EQUALS NC_RULE_RETIRED_CLEAR_KEYS.
  'waitForEnhancement',
  'groupIdleSec',
] as const
export const NcRuleClearableKeySchema = z.enum(NC_RULE_CLEARABLE_KEYS)
export type NcRuleClearableKey = z.infer<typeof NcRuleClearableKeySchema>

export const NcRuleUpdateInputSchema = z.object({
  ruleId: z.string(),
  patch: NcRulePatchSchema,
  clear: z.array(NcRuleClearableKeySchema).optional(),
})
export type NcRuleUpdateInput = z.infer<typeof NcRuleUpdateInputSchema>

/** A persisted rule. */
export const NcRuleSchema = NcRuleInputSchema.extend({
  id: z.string(),
  /** userId of the admin who created the rule (server-stamped caller). */
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * Per-target opt-out set. A targetId here is suppressed for THIS rule at
   * send time. Only a target's OWNER may add/remove its id (server-checked
   * in `nc.setRuleTargetEnabled`). Defaults to empty.
   */
  disabledTargetIds: z.array(z.string()).default([]),
})
export type NcRule = z.infer<typeof NcRuleSchema>

// ── previewStateSummary output (D647) ───────────────────────────────

/**
 * The state-summary SECTIONS (D647 / D698 / D708): the D637 kind groups that
 * report a still-true state. `addons` is the crash-looped addons only and
 * `addon-updates` the addons that are behind (D708 split them). `backups-exports` and `alarm` are not sections — a completed
 * job is not an open state, and the alarm stays instant.
 */
export const NC_STATE_SUMMARY_SECTION_IDS = [
  'device-state',
  'streams',
  'battery',
  'consumables',
  'detection-blind',
  'nodes',
  'addons',
  'addon-updates',
  'updates',
] as const

export const NcStateSummarySectionIdSchema = z.enum(NC_STATE_SUMMARY_SECTION_IDS)
export type NcStateSummarySectionId = z.infer<typeof NcStateSummarySectionIdSchema>

/** One section of a previewed state summary. `unavailable` = its state could not be read. */
export const NcStateSummaryPreviewSectionSchema = z.object({
  id: NcStateSummarySectionIdSchema,
  status: z.enum(['read', 'unavailable']),
  items: z.number().int().nonnegative(),
  reason: z.string().optional(),
})
export type NcStateSummaryPreviewSection = z.infer<typeof NcStateSummaryPreviewSectionSchema>

/**
 * One notification a previewed summary would send (D698): the whole summary on
 * a `rule` split (no `section`), one section's on a `section` split.
 */
export const NcStateSummaryPreviewRowSchema = z.object({
  section: NcStateSummarySectionIdSchema.optional(),
  /** The section's name on a per-section row; every reported section's, joined, on a combined one. */
  title: z.string(),
  text: z.string(),
  count: z.number().int().nonnegative(),
})
export type NcStateSummaryPreviewRow = z.infer<typeof NcStateSummaryPreviewRowSchema>

/**
 * The summary a rule would send now. `empty` = nothing to report and every
 * section read: such a summary is NOT sent. `dropped` counts the open states
 * the rule's own filters (or a camera mute) left out, by reason.
 * `excludedGroups` names the kind groups selected that have no state to report
 * (backups & exports). `split` and `rows` (D698) say how it would be sent —
 * optional, so an older hub's answer still parses.
 */
export const NcStateSummaryPreviewSchema = z.object({
  empty: z.boolean(),
  count: z.number().int().nonnegative(),
  text: z.string(),
  sections: z.array(NcStateSummaryPreviewSectionSchema),
  dropped: z.record(z.string(), z.number().int().nonnegative()),
  excludedGroups: z.array(z.string()),
  split: NcStateSummarySplitSchema.optional(),
  rows: z.array(NcStateSummaryPreviewRowSchema).optional(),
})
export type NcStateSummaryPreview = z.infer<typeof NcStateSummaryPreviewSchema>

// ── testRule dry-run output ─────────────────────────────────────────

export const NcTestResultSchema = z.object({
  recordId: z.string(),
  recordKind: z.enum(['object-event', 'track', 'device-event', 'package-event', 'system-event']),
  deviceId: z.number(),
  timestamp: z.number(),
  wouldFire: z.boolean(),
  /** Condition id that failed (first failing group), when `wouldFire` is false. */
  failedCondition: z.string().optional(),
  className: z.string().optional(),
  label: z.string().optional(),
})
export type NcTestResult = z.infer<typeof NcTestResultSchema>

// ── Template-variable catalog ───────────────────────────────────────

/** The rule kinds, as data. `NcRuleKind` in `notification/rule-kinds.ts` is
 *  `z.infer` of this schema — one shape, no twin. `mixed` is DERIVED
 *  (a stored system rule whose kinds span families, D637) and never authored. */
export const NcRuleKindSchema = z.enum([
  'detection',
  'sensor',
  'occupancy',
  'sound',
  'device-events',
  'system',
  'alarm',
  'mixed',
])

/**
 * The kinds a SERVED template-variable descriptor may name: the five that
 * existed before D637, frozen. `getTemplateCatalog` ships `kinds` to every
 * installed viewer, and a viewer at `@camstack/types` 1.2.25x parses them with a
 * strict five-member enum — one `device-events` in one descriptor fails the
 * whole catalog parse. So the WIRE says `system`, and the MATCH widens it:
 * `templateVarKindApplies` reads a `system` descriptor as applying to every
 * system rule kind (`device-events`, `system`, `alarm`, `mixed`).
 */
export const NcTemplateVarKindSchema = z.enum([
  'detection',
  'sensor',
  'occupancy',
  'sound',
  'system',
])
export type NcTemplateVarKind = z.infer<typeof NcTemplateVarKindSchema>

/** Which producer renders a template: an ordinary rule, a timelapse, a digest. */
export const NcTemplateFamilySchema = z.enum(['rule', 'timelapse', 'summary'])
export type NcTemplateFamily = z.infer<typeof NcTemplateFamilySchema>

/** Which text field of that producer. `previewText` is the timelapse frame
 *  caption, `captionText` the digest mosaic caption — both see fewer vars. */
export const NcTemplateFieldSchema = z.enum(['title', 'body', 'previewText', 'captionText'])
export type NcTemplateField = z.infer<typeof NcTemplateFieldSchema>

export const NcTemplateVarGroupSchema = z.enum([
  'subject',
  'place',
  'time',
  'rule',
  'occupancy',
  'sound',
  'sensor',
  'system',
  'digest',
  'ai',
])
export type NcTemplateVarGroup = z.infer<typeof NcTemplateVarGroupSchema>

/**
 * ONE `{{var}}` a notification template may name.
 *
 * `families` / `fields` / `kinds` / `deliveries` / `systemEventKinds` say WHERE
 * it has a value; absent = no restriction on that axis. `systemEventKinds` is
 * read only for a system-event rule (any family, or `mixed`). `dynamic` declares a FAMILY of names
 * (`count_<class>`): the descriptor's `name` is the example member.
 */
export const NcTemplateVarDescriptorSchema = z.object({
  name: z.string().regex(/^\w+$/),
  label: z.string(),
  description: z.string().optional(),
  example: z.string(),
  group: NcTemplateVarGroupSchema,
  families: z.array(NcTemplateFamilySchema).min(1),
  fields: z.array(NcTemplateFieldSchema).optional(),
  kinds: z.array(NcTemplateVarKindSchema).optional(),
  deliveries: z.array(NcDeliverySchema).optional(),
  systemEventKinds: z.array(NcSystemEventKindSchema).optional(),
  /**
   * Which system-event DELIVERY has a value for it (D647). Absent = an
   * instant row only when the descriptor names `systemEventKinds` (a
   * per-event fact: a summary row has no single device), and both otherwise.
   * `['summary']` marks the state-summary vocabulary (`{{summaryText}}`, ...).
   */
  systemEventDeliveries: z.array(NcSystemEventDeliveryModeSchema).optional(),
  dynamic: z.object({ prefix: z.literal('count_'), from: z.literal('classes') }).optional(),
})
export type NcTemplateVarDescriptor = z.infer<typeof NcTemplateVarDescriptorSchema>

/** What an editor knows about the field being edited. */
export const NcTemplateVarContextSchema = z.object({
  family: NcTemplateFamilySchema,
  field: NcTemplateFieldSchema,
  kind: NcRuleKindSchema.optional(),
  delivery: NcDeliverySchema.optional(),
  systemEventKinds: z.array(NcSystemEventKindSchema).optional(),
  /** The rule's system-event delivery (D647); absent = instant. */
  systemEventDelivery: NcSystemEventDeliveryModeSchema.optional(),
})
export type NcTemplateVarContext = z.infer<typeof NcTemplateVarContextSchema>

/** Input to `previewTemplate` — the editor's own context, plus the draft text. */
export const NcTemplatePreviewInputSchema = z.object({
  context: NcTemplateVarContextSchema,
  template: z.object({
    title: z.string().max(500).optional(),
    body: z.string().max(2000).optional(),
  }),
})
export type NcTemplatePreviewInput = z.infer<typeof NcTemplatePreviewInputSchema>

export const NcTemplatePreviewSchema = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  /** Names the template uses that this context never fills — they render empty. */
  unknown: z.array(z.string()),
})
export type NcTemplatePreview = z.infer<typeof NcTemplatePreviewSchema>

// ── Machine-readable condition catalog ──────────────────────────────

export const NcConditionDescriptorSchema = z.object({
  /** Field id inside `NcConditions` (or `'schedule'` for the rule-level group). */
  id: z.string(),
  group: z.enum([
    'scope',
    'class',
    'zones',
    'quality',
    'label',
    'schedule',
    /** DEVICE-EVENT trigger conditions (sensor kinds / event-type tokens). */
    'device',
    /** PACKAGE-EVENT trigger conditions (phase). */
    'package',
    /** DEVICE-EVENT occupancy-edge conditions (ZoneAnalytics count). */
    'occupancy',
    /**
     * IMMEDIATE sustained-sound conditions. The viewer mirrored this member
     * before the hub served it (its parse DROPS an undecodable descriptor), so
     * a client older than this train loses the widget and never the rule.
     */
    'audio',
    /** Infrastructure/liveness/update event conditions. */
    'system',
  ]),
  label: z.string(),
  /** Editor widget the UI renders — never hardcode per-condition forms. */
  valueType: z.enum([
    'deviceIdList',
    /**
     * A device list that EXCLUDES (`devicesExclude`, D641). The same picker as
     * `deviceIdList`; a separate member so a client that binds every
     * `deviceIdList` to `devices` drops it instead of mis-writing it.
     */
    'deviceIdExcludeList',
    'stringList',
    'number01',
    /** Unbounded non-negative number (e.g. dwell seconds). */
    'number',
    /** Single choice over the detection-source set. */
    'sourceSelect',
    'zoneSelection',
    'zoneIdList',
    'schedule',
    'plateMatcher',
    /** Single choice over the package-phase set (delivered/picked-up/both). */
    'packagePhase',
    /** Single choice over the zone-crossing direction set (enter/exit/any). */
    'crossingSelect',
    /** Single choice over a boolean sensor's edge (absent/raised/cleared) — D640. */
    'sensorTransition',
    /** Personal-rule polygon draw (MaskPolygonShape[]). */
    'polygonDraw',
    /** Occupancy-edge editor (zone/class + op + count + sustain). */
    'occupancy',
    /** Sustained-sound editor (labels + dBFS floor + hit % + window), as a set. */
    'audio',
    /** Device picker + multi-select over THAT device's state vocabulary. */
    'deviceState',
    /** Scene picker (live state beside each) + required state + which boolean. */
    'scene',
    /** System-event kind picker with optional device/node/package filters. */
    'systemEvent',
  ]),
  operator: z.enum(['in', 'notIn', 'anyOf', 'allOf', 'gte', 'fuzzyIn', 'withinSchedule']),
  /** Which delivery kinds the condition applies to. */
  appliesTo: z.array(NcDeliverySchema),
  phase: z.string(),
  description: z.string().optional(),
  /**
   * The CHOICES for a single-choice widget (`sourceSelect`, `crossingSelect`,
   * `packagePhase`, …), served with the descriptor.
   *
   * Before this the descriptor said which widget to render and not what to put
   * in it, so every option list lived in three places: this file's enums, the
   * admin's `NC_*_OPTIONS` and the viewer's `NC_*_VALUES`. That triple mirror
   * is the drift that emptied the viewer's rule editor on 2026-08-04 — the app
   * mirrors the cap by hand, so it is only ever as current as its last build.
   *
   * With the options on the wire, a condition of an EXISTING `valueType` costs
   * zero client changes. Clients keep a local fallback for an older hub that
   * does not send them; absent here is "use your own list", not "no choices".
   */
  options: z
    .array(
      z.object({
        /** Written to the rule verbatim. `''` means the ABSENT state. */
        value: z.string(),
        label: z.string(),
        /** What THIS choice matches — shown one at a time, under the control. */
        hint: z.string().optional(),
      }),
    )
    .readonly()
    .optional(),
})
export type NcConditionDescriptor = z.infer<typeof NcConditionDescriptorSchema>

/**
 * The P1 condition surface as data — served by `getConditionCatalog` so
 * rule editors render from the catalog, not hardcoded forms (spec §4.2).
 */
export const NC_CONDITION_CATALOG: readonly NcConditionDescriptor[] = [
  {
    id: 'systemEvent',
    group: 'system',
    label: 'System event',
    valueType: 'systemEvent',
    options: [
      { value: 'device-online', label: 'Device online' },
      { value: 'device-offline', label: 'Device offline' },
      { value: 'device-disabled', label: 'Device switched off' },
      { value: 'device-enabled', label: 'Device switched on' },
      { value: 'stream-online', label: 'Stream online' },
      { value: 'stream-offline', label: 'Stream offline' },
      { value: 'node-online', label: 'Node online' },
      { value: 'node-offline', label: 'Node offline' },
      { value: 'node-restarting', label: 'Node restarting' },
      { value: 'node-updating', label: 'Node updating (restart imminent)' },
      { value: 'node-inference-unavailable', label: 'Node has no usable inference device' },
      { value: 'detection-blind', label: 'Camera detecting nothing' },
      { value: 'motion-noisy', label: 'Camera motion constant, no subject' },
      { value: 'motion-calm', label: 'Camera motion calm again' },
      { value: 'package-llm-silent', label: 'Package confirm not answering' },
      { value: 'package-llm-answered', label: 'Package confirm answering again' },
      { value: 'recording-stalled', label: 'Recording stalled' },
      { value: 'recording-healthy', label: 'Recording healthy again' },
      { value: 'recording-degraded', label: 'Recording degraded (restart storm)' },
      { value: 'device-attention-required', label: 'Device needs attention' },
      { value: 'device-attention-resolved', label: 'Device attention resolved' },
      { value: 'storage-location-low', label: 'Storage location low' },
      { value: 'storage-location-critical', label: 'Storage location critical' },
      { value: 'storage-location-ok', label: 'Storage location ok again' },
      { value: 'addon-crash-loop', label: 'Addon stopped after repeated crashes' },
      { value: 'addon-update-available', label: 'Addon update available' },
      { value: 'server-update-available', label: 'Server update available' },
      { value: 'wrapper-update-available', label: 'Container / app update available' },
      { value: 'addon-updated', label: 'Addons updated' },
      { value: 'server-updated', label: 'Server updated' },
      { value: 'device-battery-low', label: 'Battery low' },
      { value: 'device-battery-normal', label: 'Battery back to normal' },
      { value: 'device-consumable-low', label: 'Consumable low' },
      { value: 'device-consumable-normal', label: 'Consumable replaced' },
      { value: 'export-completed', label: 'Export completed' },
      { value: 'backup-completed', label: 'Backup completed' },
      { value: 'alert-critical', label: 'Critical alert raised' },
      { value: 'alert-error', label: 'Error alert raised' },
      { value: 'alert-critical-resolved', label: 'Critical alert resolved' },
      { value: 'rule-broken', label: 'Notification rule broken' },
      { value: 'rule-repaired', label: 'Notification rule repaired' },
      { value: 'alarm-arm-refused', label: 'Alarm arm refused' },
      { value: 'alarm-check-failed', label: 'Alarm check failed (armed anyway)' },
      { value: 'alarm-arming', label: 'Alarm arming (exit delay)' },
      { value: 'alarm-armed', label: 'Alarm armed' },
      { value: 'alarm-pending', label: 'Alarm entry delay started' },
      { value: 'alarm-triggered', label: 'Alarm triggered' },
      { value: 'alarm-rearmed', label: 'Alarm re-armed after siren' },
      { value: 'alarm-sensor-bypass', label: 'Alarm sensor bypass' },
      { value: 'alarm-disarmed', label: 'Alarm disarmed' },
    ],
    operator: 'in',
    appliesTo: ['system-event'],
    phase: 'P1',
    description:
      'Infrastructure and update events. Device liveness covers EVERY device type — narrow it by device type (cameras only, say) and/or by device, node events by node id, and addon updates by package name.',
  },
  {
    id: 'devices',
    group: 'scope',
    // Not "Cameras". The list has offered every device type since the Devices
    // tab shipped, and a label that says cameras is how an operator concludes
    // their contact sensor does not belong here.
    label: 'Devices',
    valueType: 'deviceIdList',
    operator: 'in',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P1',
    description:
      'Restrict the rule to these devices; absent = all devices. A sensor event ' +
      'matches either the SENSOR that fired or the camera it is attributed to, so ' +
      'a rule may name either one.',
  },
  {
    // D641. Its own valueType, not `deviceIdList`: a viewer built before D641
    // renders EVERY `deviceIdList` descriptor as the `devices` picker, so a
    // second one would draw the include list twice and write the exclusion
    // into `devices`. An unknown valueType is dropped by the viewer's per-item
    // parse instead — the widget is missing, never wrong.
    id: 'devicesExclude',
    group: 'scope',
    label: 'Excluded devices',
    valueType: 'deviceIdExcludeList',
    operator: 'notIn',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P1',
    description:
      'Every device except these. Judged on the same device ids as Devices: a sensor event ' +
      'is excluded by the SENSOR that fired or by the camera it is attributed to.',
  },
  {
    id: 'classes',
    group: 'class',
    label: 'Object classes',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
    description: 'Any overlap with the detection class set passes.',
  },
  {
    id: 'classesExclude',
    group: 'class',
    label: 'Excluded classes',
    valueType: 'stringList',
    operator: 'notIn',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
  },
  {
    id: 'minConfidence',
    group: 'quality',
    label: 'Minimum confidence',
    valueType: 'number01',
    operator: 'gte',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
  },
  {
    id: 'zones',
    group: 'zones',
    label: 'Zones',
    valueType: 'zoneSelection',
    operator: 'anyOf',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
    description: 'The zones the subject must be in (included) or never in (excluded).',
  },
  {
    id: 'zonesExclude',
    group: 'zones',
    label: 'Excluded zones',
    valueType: 'zoneIdList',
    operator: 'notIn',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
  },
  {
    id: 'crossing',
    group: 'zones',
    label: 'Zone crossing',
    valueType: 'crossingSelect',
    // Three choices and no "not set" (D690): absent IS entering, so entering
    // is served as the ABSENT value `''` — the wire an old viewer (≤1.0.565)
    // reads as "unset = entering" (it filters `enter` out and binds
    // `value ?? ''`). Serving `enter` instead left that viewer with no way
    // back to entering. Editors show `''` as Entering and write it as absent.
    options: [
      { value: '', label: 'Entering', hint: 'Entries and ordinary movement; never an exit.' },
      { value: 'exit', label: 'Leaving', hint: 'Only an exit from a zone.' },
      { value: 'any', label: 'Entering or leaving', hint: 'Entries, exits and ordinary movement.' },
    ],
    operator: 'in',
    // Immediate only: a crossing is a per-event fact; a closed track carries
    // none (see the condition's schema doc).
    appliesTo: ['immediate'],
    phase: 'P1',
    description: 'Which way the subject crosses the zone.',
  },
  {
    id: 'labelEquals',
    group: 'label',
    label: 'Label equals',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['immediate', 'track-end'],
    phase: 'P1',
    description: 'Exact match on the collapsed label (identity / plate / subclass).',
  },
  {
    id: 'identities',
    group: 'label',
    label: 'Known faces',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['immediate', 'track-end'],
    phase: 'P1',
    description:
      'Only recognised people. Selecting NOBODY means every identity in the face gallery; selecting some narrows to those. Matched on the gallery id, so renaming a person does not break the rule. On Immediate delivery the name must already be known when an event is written — choose Immediate, grouped to wait for it.',
  },
  {
    id: 'plates',
    group: 'label',
    label: 'Known plates',
    valueType: 'plateMatcher',
    operator: 'fuzzyIn',
    appliesTo: ['immediate', 'track-end'],
    phase: 'P1',
    description:
      'Only vehicles whose plate was read. Selecting NO plate means any readable plate; listed plates are matched Levenshtein-tolerantly, because OCR noise makes an exact match useless.',
  },
  {
    id: 'identitiesExclude',
    group: 'label',
    label: 'Excluded faces',
    valueType: 'stringList',
    operator: 'notIn',
    appliesTo: ['immediate', 'track-end'],
    phase: 'P1',
    description:
      'Veto by identity (mirror of Known faces, same gallery ids). A subject nobody recognised passes — there is nothing to exclude.',
  },
  {
    id: 'minLabelConfidence',
    group: 'label',
    label: 'Minimum label confidence',
    valueType: 'number01',
    operator: 'gte',
    // Track-end only: object-event subjects do not carry the recognition
    // match confidence in P1 (see the condition's schema doc).
    appliesTo: ['track-end'],
    phase: 'P1',
    description:
      'Best identity/plate recognition match confidence [0,1] for the label the track carries at close (peak assigned-identity cosine / peak plate OCR score; the higher of the two when both were read). Distinct from detection confidence. Fails closed for a track that ended un-recognized.',
  },
  {
    id: 'minImportance',
    group: 'quality',
    label: 'Minimum importance',
    valueType: 'number01',
    operator: 'gte',
    // Track-end only: importance is scored at track close, so it does not
    // exist at immediate / object-event evaluation time (see the schema doc).
    appliesTo: ['track-end'],
    phase: 'P1',
    description:
      'Server-computed key-event importance [0,1]; track-end rules only (importance is scored at close). Fails when the record has none.',
  },
  {
    id: 'minDwellSeconds',
    group: 'quality',
    label: 'Minimum dwell (seconds)',
    valueType: 'number',
    operator: 'gte',
    // Track-end only: an object-event subject has no closed lifespan.
    appliesTo: ['track-end'],
    phase: 'P1',
    description: 'Track lifespan in seconds (lastSeen − firstSeen); track-end rules only.',
  },
  {
    id: 'source',
    group: 'scope',
    label: 'Detection source',
    valueType: 'sourceSelect',
    options: [
      { value: 'any', label: 'Any source' },
      { value: 'pipeline', label: 'Pipeline' },
      { value: 'onboard', label: 'Onboard (camera)' },
      { value: 'sensor', label: 'Sensor' },
      { value: 'audio', label: 'Audio marker' },
    ],
    operator: 'in',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P1',
    description:
      'pipeline / onboard / sensor / audio; a record with no stamped source counts as pipeline.',
  },
  {
    id: 'deviceState',
    group: 'scope',
    label: 'Device state',
    valueType: 'deviceState',
    operator: 'in',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P2',
    description:
      'Only fire while another device is in one of the chosen states — the alarm armed, a switch on, a contact closed. A state that cannot be read does NOT fire.',
  },
  {
    id: 'scene',
    group: 'scope',
    label: 'Scene state',
    valueType: 'scene',
    operator: 'in',
    // Every trigger a GATE can narrow — the same four `deviceState` carries.
    // Deliberately NOT `system-event`: a node leaving the cluster is not a fact
    // about what a camera can see, and gating it on a scene would make an
    // infrastructure alarm depend on a snapshot that is very likely the thing
    // that broke.
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P3',
    description: 'Only fire while a scene is matched or diverged.',
  },
  {
    id: 'sensorKinds',
    group: 'device',
    label: 'Sensor kinds',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['device-event'],
    phase: 'P1',
    description:
      'Sensor/control taxonomy kinds (doorbell / contact / button / …) matched against the persisted device event.',
  },
  {
    id: 'eventTypeTokens',
    group: 'device',
    label: 'Event-type tokens',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['device-event'],
    phase: 'P1',
    description:
      'Raw device event-type tokens (e.g. doorbell press / press_long) from the event-emitter slice; absent on doorbell-pulse / passive sensors.',
  },
  {
    id: 'sensorTransition',
    group: 'device',
    label: 'Notify when',
    valueType: 'sensorTransition',
    // `''` is the ABSENT state — both edges, what every earlier rule does.
    options: [
      {
        value: '',
        label: 'It triggers and when it clears',
        hint: 'Every change: water detected, and back to dry.',
      },
      {
        value: 'raised',
        label: 'Only when it triggers',
        hint: 'Water detected, smoke, a contact opening — never the return to normal.',
      },
      {
        value: 'cleared',
        label: 'Only when it clears',
        hint: 'Back to dry, smoke gone, a contact closing — never the alert itself.',
      },
    ],
    operator: 'in',
    appliesTo: ['device-event'],
    phase: 'P2',
    description:
      'Fire on one edge of a boolean sensor. Offered only when every chosen sensor kind raises and clears; a reading that cannot be placed still notifies.',
  },
  {
    id: 'packagePhase',
    group: 'package',
    label: 'Package phase',
    valueType: 'packagePhase',
    options: [
      { value: 'delivered', label: 'Delivered' },
      { value: 'picked-up', label: 'Picked up' },
      { value: 'both', label: 'Both' },
    ],
    operator: 'in',
    appliesTo: ['package-event'],
    phase: 'P1',
    description: 'Delivered / picked-up / both.',
  },
  {
    id: 'occupancy',
    group: 'occupancy',
    label: 'Occupancy',
    valueType: 'occupancy',
    operator: 'anyOf',
    appliesTo: ['device-event'],
    phase: 'P1',
    description:
      'ZoneAnalytics occupancy edge (optionally zone/class-scoped): count crosses the threshold and holds for sustainSeconds. Fail-closed on a missing snapshot.',
  },
  {
    id: 'audio',
    group: 'audio',
    label: 'Sound',
    valueType: 'audio',
    operator: 'anyOf',
    // Audio rides `immediate` — it has no delivery of its own (`event-intake`:
    // an `audio-window` subject is delivered immediate, like an object event).
    // Carrying the condition is what makes a rule an AUDIO rule: it then fires
    // ONLY on a confirmed sampling window, never on a detection or a track.
    appliesTo: ['immediate'],
    phase: 'P2',
    description:
      'Fires when at least hitPercent% of the samples in a samplingSeconds window are hits — a hit clears the dBFS floor AND carries one of the chosen sounds. Both filters are optional and independent, but naming NEITHER never matches: every sample would be a hit, so the engine refuses rather than notifying on silence. dBFS is negative-going (0 = full scale, -96 = silence).',
  },
  {
    id: 'customZones',
    group: 'zones',
    label: 'Custom zones',
    valueType: 'polygonDraw',
    operator: 'anyOf',
    appliesTo: ['immediate', 'track-end', 'package-event'],
    phase: 'P1',
    description: 'User-drawn polygons; a detection whose bbox overlaps any polygon matches.',
  },
  {
    id: 'schedule',
    group: 'schedule',
    label: 'Schedule',
    valueType: 'schedule',
    operator: 'withinSchedule',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event', 'system-event'],
    phase: 'P1',
    description: 'Weekly activation windows (invertible); absent = always active.',
  },
]

// ── Delivery history (§3.2 / §4.2 getHistory) ───────────────────────

/**
 * The delivery lifecycle status of a history row — a straight read of the
 * durable outbox row's own status (single source of truth):
 *  - `pending` — enqueued, in-flight or retrying with backoff
 *  - `sent`    — delivered (terminal)
 *  - `dead`    — dead-lettered after exhausting retries / a permanent
 *                backend rejection / a deleted target (terminal; carries
 *                the failure `error`)
 *
 * P1 has no `suppressed-quiet-hours` / `snoozed` states — those ride the P2
 * user dimension (quiet hours / snooze) and are additive when they land.
 */
export const NcHistoryStatusSchema = z.enum(['pending', 'sent', 'dead'])
export type NcHistoryStatus = z.infer<typeof NcHistoryStatusSchema>

/** The evaluated record kind a history row descends from (one per trigger). */
export const NcHistoryRecordKindSchema = z.enum([
  'object-event',
  'track-end',
  'device-event',
  'package-event',
  'system-event',
])
export type NcHistoryRecordKind = z.infer<typeof NcHistoryRecordKindSchema>

/** Subject summary frozen on the row at fire time (survives rule/record edits). */
export const NcHistorySubjectSchema = z.object({
  className: z.string(),
  label: z.string().optional(),
  confidence: z.number().optional(),
  zones: z.array(z.string()),
  timestamp: z.number(),
  systemEvent: z
    .object({
      kind: NcSystemEventKindSchema,
      subject: z.string(),
      title: z.string(),
      body: z.string(),
      data: z.record(z.string(), z.unknown()),
    })
    .optional(),
})
export type NcHistorySubject = z.infer<typeof NcHistorySubjectSchema>

/**
 * One delivery-history row. This is a read-only VIEW over the durable
 * outbox row (single source of truth — the same row the drain loop drives;
 * NO second write path, so history can never drift from delivery state).
 * The §3.2 fields map directly: `ruleId`/`targetId`/`deviceId` are columns,
 * `eventRef` is `recordKind`+`recordId`, `timestamps` are `createdAt`
 * (fire) / `updatedAt` (last transition), `status` + `error` are the
 * lifecycle. `ruleName` + `subject` are the intent snapshot frozen at
 * enqueue. `userId?` (per-recipient history) is P2 — no user dimension in
 * P1 (admin scope only).
 */
export const NcHistoryEntrySchema = z.object({
  /** Outbox row id — the stable dedup id `ruleId:dedupRef:targetId`. */
  id: z.string(),
  ruleId: z.string(),
  /** Rule name frozen at fire time (outlives a later rename / delete). */
  ruleName: z.string(),
  /** The rule urgency/trigger that produced this delivery. */
  delivery: NcDeliverySchema,
  targetId: z.string(),
  deviceId: z.number(),
  recordKind: NcHistoryRecordKindSchema,
  /** Event / track ref of the evaluated record (§3.2 `eventRef`). */
  recordId: z.string(),
  /** Present for track-scoped deliveries (object-event / track-end). */
  trackId: z.string().optional(),
  status: NcHistoryStatusSchema,
  /** Delivery attempts made so far. */
  attempts: z.number().int(),
  /** Fire time (outbox enqueue). */
  createdAt: z.number(),
  /** Last transition time (terminal for sent / dead). */
  updatedAt: z.number(),
  /** Failure detail — present on a `dead` row. */
  error: z.string().optional(),
  subject: NcHistorySubjectSchema,
  /**
   * Ids of the artefacts (still, then gif, then clip) this row's successful
   * delivery indexed in the artefact library — a REFERENCE, never the bytes
   * (an artefact is often megabytes; this row is durable JSON rewritten on
   * every delivery attempt). Absent on a row still pending/dead, a row
   * delivered before this field shipped, or a wiring with no artefact index.
   *
   * Resolve one to a fetchable URL with `resolveArtifactUrl` — an id
   * outlives any one URL's TTL, so a caller mints a fresh link on demand
   * rather than trusting one frozen at delivery time. `resolveArtifactUrl`
   * also answers `null` for an id whose artefact has since expired past the
   * retained shelf's own age bound — the degrade a caller (the Home
   * Assistant export) must render as "no image right now", never as a
   * broken link.
   */
  artifactIds: z.array(z.string().min(1)).optional(),
})
export type NcHistoryEntry = z.infer<typeof NcHistoryEntrySchema>

/** `getHistory` default page size + hard ceiling (bounded output). */
export const NC_HISTORY_LIMIT_DEFAULT = 100
export const NC_HISTORY_LIMIT_MAX = 500

/**
 * Query filter for `getHistory` (spec §4.2). Every field is a narrowing
 * AND; absent = unbounded on that axis. `since`/`until` bound the fire time
 * (`createdAt`, epoch ms, inclusive). `limit` is clamped to
 * {@link NC_HISTORY_LIMIT_MAX}. `userId` (per-recipient filtering) is P2.
 */
export const NcHistoryFilterSchema = z.object({
  ruleId: z.string().optional(),
  deviceId: z.number().optional(),
  status: NcHistoryStatusSchema.optional(),
  since: z.number().optional(),
  until: z.number().optional(),
  limit: z.number().int().min(1).max(NC_HISTORY_LIMIT_MAX).default(NC_HISTORY_LIMIT_DEFAULT),
})
export type NcHistoryFilter = z.infer<typeof NcHistoryFilterSchema>

// ── Last run per rule (getRuleLastRuns) ─────────────────────────────

/**
 * The newest delivery row of ONE rule — the "Last run" of a rules table.
 *
 * A projection of the same outbox rows `getHistory` returns, so it records
 * DELIVERIES only: a throttled or unmatched evaluation never produced a row
 * and is not a run here. When one fire reached several targets (several rows
 * at the same `lastAt`), `status` is the least successful of them
 * (`dead` > `pending` > `sent`): "the last run delivered" must be true for
 * every target it names.
 */
export const NcRuleLastRunSchema = z.object({
  ruleId: z.string(),
  /** Fire time of the newest row (`createdAt`, epoch ms). */
  lastAt: z.number(),
  status: NcHistoryStatusSchema,
  /** The camera/device of that row (a digest row files under its first camera). */
  deviceId: z.number(),
})
export type NcRuleLastRun = z.infer<typeof NcRuleLastRunSchema>

/**
 * Every rule's last run, in one answer.
 *
 * A rule ABSENT from `runs` produced no delivery inside `horizonMs` — how far
 * back this answer looked, in ms before the hub's now. It is the outbox prune
 * window (7 days by default, operator-configurable), NARROWED when the read hit
 * its row bound: the answer never claims a window it did not read. `null` means
 * the operator keeps the outbox forever AND the read reached its end, so absent
 * means "never on record". A UI derives its "not in the last N days" from this
 * value, never from a constant — and only when the call ANSWERED (D315).
 */
export const NcRuleLastRunsSchema = z.object({
  runs: z.array(NcRuleLastRunSchema),
  horizonMs: z.number().nonnegative().nullable(),
})
export type NcRuleLastRuns = z.infer<typeof NcRuleLastRunsSchema>

// ── Snooze ──────────────────────────────────────────────────────────

/**
 * What a snooze covers. Broader scopes win when several overlap, so one window
 * leaves ONE digest rather than a rule snooze and a whole-feed snooze both
 * summarising the same silence.
 */
export const NcSnoozeScopeSchema = z.enum(['rule', 'device', 'all'])
export type NcSnoozeScope = z.infer<typeof NcSnoozeScopeSchema>

/**
 * Client-authored snooze. The server stamps `userId`, `startedAt` and
 * `expiresAt` — a DURATION is sent rather than an instant so a client with a
 * skewed clock cannot author a window that is already over, or never ends.
 */
export const NcSnoozeInputSchema = z.object({
  scope: NcSnoozeScopeSchema,
  /** Required when `scope: 'rule'` — a scoped snooze with no id matches
   *  NOTHING rather than degrading to "everything". */
  ruleId: z.string().optional(),
  /** Required when `scope: 'device'`. */
  deviceId: z.number().int().optional(),
  /**
   * Narrow the window to these subject classes — "the cat, not the person".
   *
   * ORTHOGONAL to `scope`, deliberately, and absent means EVERY class: that is
   * what every window authored before this field meant, so no persisted row
   * changes meaning and no client has to learn anything to keep working.
   *
   * It is what makes the window's real key `(deviceId, classes[])` and lets it
   * cross rules (D133): the operator points at a camera and a kind of thing,
   * not at whichever of their four rules happened to produce the notification
   * they are dismissing.
   */
  classes: z.array(z.string().min(1)).min(1).optional(),
  durationMinutes: z.number().int().min(1).max(NC_SNOOZE_MAX_MINUTES),
  /**
   * Silence this for EVERY recipient, not just the caller. Permission is
   * checked server-side (the rule's `snoozeAllowGlobal`, or admin for the
   * broader scopes). Absent = personal.
   */
  global: z.boolean().optional(),
  /**
   * Deliver a summary of what was suppressed when the window ends. Absent =
   * ON: someone silencing a nuisance camera wants it off, someone silencing a
   * SECURITY camera wants to know what they missed, and choosing "off" for
   * everybody is how a snooze becomes an outage. Resolved to a concrete
   * boolean by the server at create time — never left to a Zod default, which
   * does not run on the addon cap path.
   */
  summary: z.boolean().optional(),
})
export type NcSnoozeInput = z.infer<typeof NcSnoozeInputSchema>

/** A persisted snooze window. */
export const NcSnoozeSchema = z.object({
  id: z.string(),
  /** Who set it. Also who it silences, unless `global`. */
  userId: z.string(),
  scope: NcSnoozeScopeSchema,
  ruleId: z.string().optional(),
  deviceId: z.number().int().optional(),
  /** Subject classes this window covers. ABSENT = every class — see
   *  {@link NcSnoozeInputSchema.shape.classes}. Lives in the JSON blob and has
   *  no SQLite column: nothing queries a window by class. */
  classes: z.array(z.string().min(1)).min(1).optional(),
  startedAt: z.number(),
  /** Exclusive: at exactly this instant the snooze is over. Expiry is a
   *  COMPARISON, not a job — no sweeper can leave the operator silenced. */
  expiresAt: z.number(),
  global: z.boolean(),
  summary: z.boolean(),
  /** When the end-of-window digest went out. Absent = not sent (yet, or the
   *  window has not closed, or `summary` is false). */
  digestSentAt: z.number().optional(),
})
export type NcSnooze = z.infer<typeof NcSnoozeSchema>

/** One line of an end-of-window digest: what one rule hid on one camera. */
export const NcSnoozeSuppressedSchema = z.object({
  snoozeId: z.string(),
  targetId: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  deviceId: z.number().int(),
  /** How many notifications this snooze hid for that pair. */
  count: z.number().int(),
  firstAt: z.number(),
  lastAt: z.number(),
})
export type NcSnoozeSuppressed = z.infer<typeof NcSnoozeSuppressedSchema>

// ── Alarm panel configuration ───────────────────────────────────────

/** The bounds every alarm delay field carries — settings, per-mode overrides, both editors. */
export const NC_ALARM_DELAY_MAX_SEC = 600
export const NC_ALARM_TRIGGERED_MAX_SEC = 3600
/** At most this many ids on one mode's non-blocking list. */
export const NC_ALARM_NONBLOCKING_MAX = 200
const NcAlarmDelaySecSchema = z.number().int().min(0).max(NC_ALARM_DELAY_MAX_SEC)
const NcAlarmTriggeredSecSchema = z.number().int().min(0).max(NC_ALARM_TRIGGERED_MAX_SEC)

/** Anything keyed by an arm mode — a non-blocking list, a delays entry, an edit. */
interface NcAlarmModeKeyed {
  readonly mode: AlarmArmMode
}
const uniqueModes = (entries: readonly NcAlarmModeKeyed[]): boolean =>
  new Set(entries.map((e) => e.mode)).size === entries.length

/**
 * What the panel does when a bounded triggered window ends.
 * - `rearmAfter` — return to the armed mode
 * - `disableAfter` — auto-disarm
 * - `doNothing` — stay triggered until a human disarms
 */
export const NcAlarmPostTriggeredActionSchema = z.enum(['rearmAfter', 'disableAfter', 'doNothing'])
export type NcAlarmPostTriggeredAction = z.infer<typeof NcAlarmPostTriggeredActionSchema>

/** One mode's OVERRIDES. An absent field inherits the global value (D697). */
export const NcAlarmModeDelaysSchema = z.object({
  mode: AlarmArmModeSchema,
  exitDelaySec: NcAlarmDelaySecSchema.optional(),
  entryDelaySec: NcAlarmDelaySecSchema.optional(),
  /**
   * Duration of `triggered` before {@link postTriggeredAction}. Kept as the
   * historical field name so older clients still read/write a number.
   */
  triggeredDurationSec: NcAlarmTriggeredSecSchema.optional(),
  postTriggeredAction: NcAlarmPostTriggeredActionSchema.optional(),
  /**
   * When this mode may be armed. Absent / null = always allowed (same as a
   * rule with no `schedule`). Evaluated with {@link isScheduleActive}.
   */
  schedule: NcScheduleSchema.optional(),
  /**
   * D706: while this mode's ENTRY DELAY runs, do the alarm rules' own pushes go out (as an
   * intrusion naming the locations)? Absent = false — the entry-delay notification is the
   * only one, and the matches ride the triggered notification's mosaic (D705).
   */
  notifyDuringEntryDelay: z.boolean().optional(),
  /**
   * D706: notify "watched again" when a sensor this arm bypassed closes and opens again.
   * Absent = false (logged, not sent). Even when true it is not sent when that same sensor
   * is the one that starts the entry delay — the entry-delay notification already names it.
   */
  notifySensorRewatched: z.boolean().optional(),
  /**
   * D735: notify "ignored" when a sensor this arm bypassed really MOVED while armed (its own
   * change time is after the arm) and set nothing off. Absent = false (logged, not sent). A
   * re-sync, a recovery from `unavailable` or a duplicate is never announced, switch or not.
   */
  notifySensorIgnored: z.boolean().optional(),
})
export type NcAlarmModeDelays = z.infer<typeof NcAlarmModeDelaysSchema>

const NcAlarmModeDelaysListSchema = z
  .array(NcAlarmModeDelaysSchema)
  .max(8)
  .refine(uniqueModes, { message: 'modeDelays: at most one entry per arm mode' })

/**
 * One mode's EDIT in a patch: a number sets the override, `null` removes it (the mode inherits
 * again), an absent field leaves it alone. Per field, so two editors changing two different
 * delays of one mode never undo each other.
 */
export const NcAlarmModeDelaysEditSchema = z.object({
  mode: AlarmArmModeSchema,
  exitDelaySec: NcAlarmDelaySecSchema.nullable().optional(),
  entryDelaySec: NcAlarmDelaySecSchema.nullable().optional(),
  triggeredDurationSec: NcAlarmTriggeredSecSchema.nullable().optional(),
  postTriggeredAction: NcAlarmPostTriggeredActionSchema.nullable().optional(),
  /** Set a schedule, or `null` to clear (mode always allowed again). */
  schedule: NcScheduleSchema.nullable().optional(),
  /** D706: set the switch, or `null` to clear it (back to the default, false). */
  notifyDuringEntryDelay: z.boolean().nullable().optional(),
  /** D706: set the switch, or `null` to clear it (back to the default, false). */
  notifySensorRewatched: z.boolean().nullable().optional(),
  /** D735: set the switch, or `null` to clear it (back to the default, false). */
  notifySensorIgnored: z.boolean().nullable().optional(),
})
export type NcAlarmModeDelaysEdit = z.infer<typeof NcAlarmModeDelaysEditSchema>

const NcAlarmModeDelaysEditListSchema = z
  .array(NcAlarmModeDelaysEditSchema)
  .max(8)
  .refine(uniqueModes, { message: 'modeDelays: at most one edit per arm mode' })

/** One switch of the alarm table: put ONE device on, or take it off, ONE mode's list. */
export const NcAlarmNonBlockingEditSchema = z.object({
  mode: AlarmArmModeSchema,
  deviceId: z.number().int().positive(),
  /** true = on the list (may be open, does not block); false = off the list (blocks). */
  nonBlocking: z.boolean(),
})
export type NcAlarmNonBlockingEdit = z.infer<typeof NcAlarmNonBlockingEditSchema>

/**
 * Controllable openings: opt IN to blocking (default is do not block). Contacts
 * keep using {@link NcAlarmNonBlockingEditSchema}.
 */
export const NcAlarmBlockingEditSchema = z.object({
  mode: AlarmArmModeSchema,
  deviceId: z.number().int().positive(),
  /** true = on the list (blocks when open); false = off the list (default). */
  blocking: z.boolean(),
})
export type NcAlarmBlockingEdit = z.infer<typeof NcAlarmBlockingEditSchema>

/**
 * Controllable openings: opt OUT of secure-on-arm (default is secure ON —
 * close / lock / turn off when this mode arms).
 */
export const NcAlarmSecureOnArmEditSchema = z.object({
  mode: AlarmArmModeSchema,
  deviceId: z.number().int().positive(),
  /** true = secure on arm (default); false = do not actuate on arm. */
  secureOnArm: z.boolean(),
})
export type NcAlarmSecureOnArmEdit = z.infer<typeof NcAlarmSecureOnArmEditSchema>

/**
 * One arm mode's device-id list (non-blocking, blocking, or secure-on-arm-off).
 */
export const NcAlarmModeDeviceListSchema = z.object({
  mode: AlarmArmModeSchema,
  deviceIds: z.array(z.number().int()).max(NC_ALARM_NONBLOCKING_MAX),
})
export type NcAlarmModeDeviceList = z.infer<typeof NcAlarmModeDeviceListSchema>

/**
 * One arm mode's non-blocking list: devices that may be open when that mode
 * arms, without the arm being refused.
 */
export const NcAlarmNonBlockingSchema = NcAlarmModeDeviceListSchema
export type NcAlarmNonBlocking = z.infer<typeof NcAlarmNonBlockingSchema>

/** Controllable devices that DO block when open (opt-in; default empty). */
export const NcAlarmBlockingSchema = NcAlarmModeDeviceListSchema
export type NcAlarmBlocking = z.infer<typeof NcAlarmBlockingSchema>

/**
 * Controllable devices that do NOT secure on arm (opt-out; default empty =
 * every controllable secures).
 */
export const NcAlarmSecureOnArmOffSchema = NcAlarmModeDeviceListSchema
export type NcAlarmSecureOnArmOff = z.infer<typeof NcAlarmSecureOnArmOffSchema>

/**
 * The per-mode lists, at most one per mode. Two lists for one mode have no
 * meaning a reader could agree on (union? the last one?), so they are refused
 * at the boundary rather than interpreted.
 */
const NcAlarmNonBlockingListSchema = z
  .array(NcAlarmNonBlockingSchema)
  .max(8)
  .refine(uniqueModes, { message: 'nonBlocking: at most one list per arm mode' })

const NcAlarmBlockingListSchema = z
  .array(NcAlarmBlockingSchema)
  .max(8)
  .refine(uniqueModes, { message: 'blocking: at most one list per arm mode' })

const NcAlarmSecureOnArmOffListSchema = z
  .array(NcAlarmSecureOnArmOffSchema)
  .max(8)
  .refine(uniqueModes, { message: 'secureOnArmOff: at most one list per arm mode' })

/**
 * The three durations — global, and per mode since D697 — the panel's state
 * machine runs on, who hears about its transitions, and which openings each mode tolerates.
 *
 * They live on the NOTIFICATION-RULES cap, not on `alarm-panel`, on purpose:
 * `alarm-panel` is `deviceNative` and its other provider mirrors somebody
 * else's panel, which has its own delays and no way to be told these. This is
 * configuration of the panel CamStack owns, and the Notification Center owns
 * that panel.
 */
export const NcAlarmSettingsSchema = z.object({
  /** Grace period between arming and the mode taking effect. 0 = immediate. */
  exitDelaySec: NcAlarmDelaySecSchema,
  /** Grace period between a trigger and the alarm firing. 0 = immediate. */
  entryDelaySec: NcAlarmDelaySecSchema,
  /**
   * How long `triggered` lasts before {@link postTriggeredAction} runs.
   * Ignored when the action is `doNothing`. Historical name kept so older
   * clients still round-trip a number.
   */
  triggeredDurationSec: NcAlarmTriggeredSecSchema,
  /**
   * What happens when the triggered window ends. Absent on a blob older than
   * this field → derived from {@link triggeredDurationSec} (`>0` ⇒ rearmAfter,
   * else doNothing).
   */
  postTriggeredAction: NcAlarmPostTriggeredActionSchema.optional(),
  /**
   * Deprecated by D630 — every transition is announced. Parsed, never read;
   * remove after one release. Optional so an older admin's patch (which still
   * sends it) parses rather than failing the whole save.
   */
  announceArm: z.boolean().optional(),
  /**
   * Target ids from `notification-output`: every alarm transition goes here.
   *
   * Explicit rather than "everyone": an alarm announcement is a household
   * message, and broadcasting it to every configured endpoint (including a
   * webhook wired to something else) is not a default anybody would choose.
   * Empty sends nothing, and the server logs that — silence must be
   * attributable.
   */
  announceTargets: z.array(z.string().min(1)).max(16),
  /**
   * Per arm mode, the covered devices whose being OPEN does not refuse the
   * arm (a window left ajar for the cat under `home`, say). At most one entry
   * per mode is meaningful. Defaulted to `[]` so a blob stored before D630
   * parses as "every opening blocks" — the behaviour it was written under.
   * Contacts use this list; controllable openings use {@link blocking} instead
   * (default: do not block).
   */
  nonBlocking: NcAlarmNonBlockingListSchema.default([]),
  /**
   * Per arm mode, controllable openings that DO refuse the arm when open.
   * Default `[]` = none block (secure-on-arm closes them instead). Absent on a
   * blob older than this field — read as empty.
   */
  blocking: NcAlarmBlockingListSchema.default([]),
  /**
   * Per arm mode, controllable openings that must NOT be actuated on arm.
   * Default `[]` = every controllable secures (close / lock / off). Absent on
   * an older blob — read as empty (secure ON).
   */
  secureOnArmOff: NcAlarmSecureOnArmOffListSchema.default([]),
  /**
   * Per arm mode, the delays that mode OVERRIDES (D697). A mode with no entry, or an entry
   * without a field, uses the global value above — so `[]`, the default, is exactly the
   * behaviour of a blob stored before this field existed. Read through `resolveModeDelays`.
   */
  modeDelays: NcAlarmModeDelaysListSchema.default([]),
})
export type NcAlarmSettings = z.infer<typeof NcAlarmSettingsSchema>

/**
 * One named alarm configuration profile — a full {@link NcAlarmSettings} blob
 * (memberships including secure-on-arm, delays, announce targets). The id is
 * assigned by the server; clients show the name.
 */
export const NcAlarmProfileMetaSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  /** The seeded Default profile — cannot be deleted. */
  isDefault: z.boolean(),
})
export type NcAlarmProfileMeta = z.infer<typeof NcAlarmProfileMetaSchema>

/**
 * Profiles ride on {@link NcAlarmConfig}: one globally active profile, whose
 * settings are what arm decisions and `settings` already expose. Switching
 * active applies that profile's blob onto the panel.
 */
export const NcAlarmProfilesViewSchema = z.object({
  activeId: z.string().min(1),
  items: z.array(NcAlarmProfileMetaSchema).min(1),
})
export type NcAlarmProfilesView = z.infer<typeof NcAlarmProfilesViewSchema>

export const NcAlarmCreateProfileInputSchema = z.object({
  name: z.string().min(1).max(64),
  /**
   * Omit / undefined → system defaults (empty memberships, stock delays).
   * Set → clone that profile's settings.
   */
  cloneFromId: z.string().min(1).max(64).optional(),
})
export type NcAlarmCreateProfileInput = z.infer<typeof NcAlarmCreateProfileInputSchema>

export const NcAlarmRenameProfileInputSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
})
export type NcAlarmRenameProfileInput = z.infer<typeof NcAlarmRenameProfileInputSchema>

export const NcAlarmProfileIdInputSchema = z.object({
  id: z.string().min(1).max(64),
})
export type NcAlarmProfileIdInput = z.infer<typeof NcAlarmProfileIdInputSchema>

/**
 * Every field optional — a tab edits one control at a time.
 *
 * List fields and `modeDelays` are re-declared WITHOUT their defaults:
 * `.partial()` does not remove an inner `.default()`, so a patch that never
 * named the field would parse to `[]` and wipe every mode's list on an
 * unrelated edit (the same trap {@link NcRulePatchSchema} documents). Here
 * `modeDelays` means EDITS, not the stored overrides.
 */
export const NcAlarmSettingsPatchSchema = NcAlarmSettingsSchema.extend({
  nonBlocking: NcAlarmNonBlockingListSchema,
  blocking: NcAlarmBlockingListSchema,
  secureOnArmOff: NcAlarmSecureOnArmOffListSchema,
  /** Per-mode, per-field edits — NOT the whole list (see NcAlarmModeDelaysEditSchema). */
  modeDelays: NcAlarmModeDelaysEditListSchema,
  /** ONE membership change; the panel applies it to the list it holds at its turn. */
  nonBlockingEdit: NcAlarmNonBlockingEditSchema,
  blockingEdit: NcAlarmBlockingEditSchema,
  secureOnArmEdit: NcAlarmSecureOnArmEditSchema,
})
  .partial()
  .refine((p) => p.nonBlocking === undefined || p.nonBlockingEdit === undefined, {
    message: 'nonBlocking and nonBlockingEdit are exclusive — send the whole lists or one edit',
  })
  .refine((p) => p.blocking === undefined || p.blockingEdit === undefined, {
    message: 'blocking and blockingEdit are exclusive — send the whole lists or one edit',
  })
  .refine((p) => p.secureOnArmOff === undefined || p.secureOnArmEdit === undefined, {
    message: 'secureOnArmOff and secureOnArmEdit are exclusive — send the whole lists or one edit',
  })
export type NcAlarmSettingsPatch = z.infer<typeof NcAlarmSettingsPatchSchema>

/**
 * What one arm mode actually arms, DERIVED from the enabled rules gated on it.
 * Never authored, never stored — see `alarm-mode-coverage.ts` for why a stored
 * copy would lie the first time a rule is disabled.
 */
/**
 * Why a device a mode NAMES is nonetheless not armed by it.
 *
 * Each value is an existing authority, never a new flag (D62): `muted` is the
 * per-camera notification switch the Notification Center already owns,
 * `detection-off` is the device's own detection binding being inactive, and
 * `offline` is the device manager's liveness. A fourth reason would mean a
 * fourth authority, and inventing one here is how a panel starts disagreeing
 * with the switches the operator actually used.
 */
export const NcAlarmSkipReasonSchema = z.enum(['muted', 'detection-off', 'offline'])
export type NcAlarmSkipReason = z.infer<typeof NcAlarmSkipReasonSchema>

export const NcAlarmSkippedDeviceSchema = z.object({
  deviceId: z.number().int(),
  reason: NcAlarmSkipReasonSchema,
})
export type NcAlarmSkippedDevice = z.infer<typeof NcAlarmSkippedDeviceSchema>

export const NcAlarmModeCoverageSchema = z.object({
  mode: AlarmArmModeSchema,
  /** Enabled rules gated on `armed_<mode>`. Zero means the mode does nothing. */
  ruleCount: z.number().int().min(0),
  /** At least one covering rule has no device scope, so the mode covers all. */
  allDevices: z.boolean(),
  /** Ids named by the covering rules. A SUBSET when `allDevices` is true. */
  deviceIds: z.array(z.number().int()),
  /**
   * D641: the ids NOT covered although `allDevices` is true — every unscoped
   * covering rule EXCLUDES them (`conditions.devicesExclude`) and no named rule
   * covers them. Always `[]` when `allDevices` is false. Excluded by the rules,
   * which is not the same as skipped by a switch: never in `skippedDevices`.
   * Defaulted so an answer computed before this field parses as "none".
   */
  allDevicesExcept: z.array(z.number().int()).default([]),
  /**
   * Devices this mode NAMES but cannot actually arm, each with the switch that
   * excludes it.
   *
   * "Away armed — 12 cameras" is a promise, and a muted camera among those
   * twelve makes it false in exactly the way nobody notices until an incident.
   * Defaulted to `[]` so a coverage answer computed before this field existed
   * still parses as "nothing known to be skipped" rather than failing the whole
   * alarm tab.
   */
  skippedDevices: z.array(NcAlarmSkippedDeviceSchema).default([]),
})
export type NcAlarmModeCoverage = z.infer<typeof NcAlarmModeCoverageSchema>

/** One covered device that reads open, and whether that refuses the arm. */
export const NcAlarmOpeningSchema = z.object({
  deviceId: z.number().int(),
  name: z.string(),
  /** The device's state word as read (`open`, `unlocked`, …). */
  state: z.string(),
  /** False when the mode's non-blocking list names this device. */
  blocking: z.boolean(),
})
export type NcAlarmOpening = z.infer<typeof NcAlarmOpeningSchema>

/** A device the panel is currently ignoring, and which side of it it is on. */
export const NcAlarmExclusionViewSchema = z.object({
  deviceId: z.number().int(),
  name: z.string(),
  phase: z.enum(['open', 'closed']),
})
export type NcAlarmExclusionView = z.infer<typeof NcAlarmExclusionViewSchema>

/** One mode's openings: devices read open, plus those whose state is unknown. */
export const NcAlarmModeOpeningsSchema = z.object({
  mode: AlarmArmModeSchema,
  devices: z.array(NcAlarmOpeningSchema),
  /** Covered devices whose state could not be read (D49): neither open nor closed. */
  unknown: z.array(z.number().int()),
})
export type NcAlarmModeOpenings = z.infer<typeof NcAlarmModeOpeningsSchema>

/**
 * One alarm INPUT — a (rule, device) pair — the operator bypassed until the
 * next disarm ("Bypass this input until disarm" on a trigger notification, or
 * `nc.bypassAlarmInput`). Reported so an armed alarm with a silenced input
 * never looks fully armed (D62: off must never look like broken).
 */
export const NcAlarmInputBypassViewSchema = z.object({
  ruleId: z.string(),
  /** The rule's current name (its frozen name when the rule is gone). */
  ruleName: z.string(),
  /** The input: the sensor of the match, else its camera. */
  deviceId: z.number().int(),
  /** The input's current name. */
  name: z.string(),
  /** When it was bypassed (ms epoch). */
  since: z.number(),
  /** Triggers from this input dropped since. */
  dropped: z.number().int().min(0),
})
export type NcAlarmInputBypassView = z.infer<typeof NcAlarmInputBypassViewSchema>

export const NcAlarmLiveSchema = z.object({
  state: AlarmStateSchema,
  /** The mode being armed into (exit delay) or held; null when disarmed. */
  targetMode: AlarmArmModeSchema.nullable(),
  availableModes: z.array(AlarmArmModeSchema),
  openings: z.array(NcAlarmModeOpeningsSchema),
  exclusions: z.array(NcAlarmExclusionViewSchema),
  /**
   * Inputs bypassed for the rest of this arm session; cleared on disarm.
   * Defaulted so an older hub answer still parses (as "none known").
   */
  bypassedInputs: z.array(NcAlarmInputBypassViewSchema).default([]),
})
export type NcAlarmLive = z.infer<typeof NcAlarmLiveSchema>

export const NcAlarmConfigSchema = z.object({
  /**
   * The panel's device id, or null when this install has no panel (the ensure
   * step failed, or this is not the hub). Null is the honest answer: an editor
   * that rendered delays for a panel that does not exist would be a form whose
   * Save does nothing.
   */
  deviceId: z.number().int().nullable(),
  settings: NcAlarmSettingsSchema,
  /**
   * Named configuration profiles. Optional so an older hub answer still parses;
   * a client without this field shows no picker (single implicit Default).
   */
  profiles: NcAlarmProfilesViewSchema.optional(),
  coverage: z.array(NcAlarmModeCoverageSchema),
  /**
   * The panel as it is NOW — state, what each mode would find open, what is
   * excluded. Optional: a panel-less hub answers without it, and a client
   * must not read its absence as "nothing is open".
   */
  live: NcAlarmLiveSchema.optional(),
})
export type NcAlarmConfig = z.infer<typeof NcAlarmConfigSchema>

/** At most this many ids in one `getAlarmSensors` call — a validation bound, not a target. */
export const NC_ALARM_SENSORS_MAX = 500

export const NcAlarmSensorReadingSchema = z.enum(['open', 'closed', 'unknown', 'not-opening'])
export type NcAlarmSensorReading = z.infer<typeof NcAlarmSensorReadingSchema>

/** One device's state as the alarm reads it — the classifier the arm check uses. */
export const NcAlarmSensorStateSchema = z.object({
  deviceId: z.number().int().positive(),
  reading: NcAlarmSensorReadingSchema,
  /** The word as read (`open`, `closed`, `unlocked`, `stopped`, …); null when unknown / not an opening. */
  state: z.string().nullable(),
  /** Why `unknown`: the read failed, or the slice holds no word its cap defines (a placeholder included). */
  unknownWhy: z.enum(['read-failed', 'unknown-word']).nullable(),
  /** The device manager's liveness as the centre mirrors it; null = not known. */
  online: z.boolean().nullable(),
  /**
   * True when the opening is a cover / lock / switch — the table shows the
   * Secure-on-arm switch and uses the controllable defaults. False for contacts
   * and for non-openings. Defaulted so an older hub answer still parses.
   */
  controllable: z.boolean().default(false),
})
export type NcAlarmSensorState = z.infer<typeof NcAlarmSensorStateSchema>

export const NcAlarmSensorsInputSchema = z.object({
  deviceIds: z.array(z.number().int().positive()).max(NC_ALARM_SENSORS_MAX),
})
export type NcAlarmSensorsInput = z.infer<typeof NcAlarmSensorsInputSchema>

export const NcAlarmSensorsSchema = z.object({
  sensors: z.array(NcAlarmSensorStateSchema),
  readAt: z.number().int().nonnegative(),
})
export type NcAlarmSensors = z.infer<typeof NcAlarmSensorsSchema>

// ── Clip retention asks (proactive per-camera ring sizing) ──────────────

/**
 * The most seconds of footage any notification rule may ask a camera to retain.
 *
 * Sixty, and it is the OCCUPANCY number. An occupancy edge is confirmed by an
 * independent read that lands long after the fact (D279) plus the condition's
 * own `sustainSeconds` (29 s on this hub), so its clip is anchored well in the
 * past — and the other source, the recordings, cannot cover a recent moment:
 * measured against `recording.getAvailability` for a 10 s window at several
 * anchors, full coverage arrived at −18 s on device 104 and −26 s on 101 and
 * 102. That edge is a PHASE of the 10-second segment cycle, not a number. The
 * ring therefore has to hold the moment until the recordings can take it over:
 * the worst measured phase (26 s) plus the confirmation lag (29 s) is 55 s, and
 * 60 is the round number above it.
 *
 * It is a ceiling, not a default. Every other rule kind asks for its own window
 * plus the dispatch margin, which is roughly a third of this.
 */
export const NC_CLIP_RETENTION_MAX_SEC = 60

/**
 * ONE rule's demand on ONE camera's clip ring.
 *
 * A rule, not a camera: the broker takes the MAX over the asks that reach a
 * camera, so the answer stays a faithful description of the rules and the
 * bounding (the byte budget, the broker's own ceiling) stays where the cost
 * lives. A camera that appears in no ask is being told **nothing** — which is
 * a different thing from never having been told, and only the envelope
 * (`rulesLoaded`) can tell those apart.
 */
export const NcClipRetentionAskSchema = z.object({
  /**
   * The camera this ask is about. **Absent = every camera**, which is what a
   * rule with no `conditions.devices` means: it can fire anywhere, so it is
   * asking everywhere.
   */
  deviceId: z.number().int().nonnegative().optional(),
  /** Seconds of history the rule needs held for it. Never zero — a rule that
   *  needs nothing produces no ask at all. */
  seconds: z.number().min(0).max(NC_CLIP_RETENTION_MAX_SEC),
  /** The profile the rule cuts from, when it named one. Absent = the cheapest
   *  assigned, which is what the cut defaults to. */
  profile: CamProfileSchema.optional(),
  /** Who is asking — so a retention the operator did not expect names a rule. */
  ruleId: z.string(),
  ruleName: z.string(),
  /** Why this many seconds: the rule's own window, or the occupancy ceiling. */
  reason: z.enum(['window', 'occupancy']),
})
export type NcClipRetentionAsk = z.infer<typeof NcClipRetentionAskSchema>

/**
 * The whole answer, with the one bit that keeps absence from reading as zero.
 *
 * `rulesLoaded` is false until the rule ledger has completed a load at least
 * once. A centre that is up but has not read its rules yet answers with an
 * empty ask list that means nothing at all — applying it would drop every
 * camera's ring to zero for the first events after a restart, which is the
 * footage this mechanism exists to keep.
 */
export const NcClipRetentionPlanSchema = z.object({
  rulesLoaded: z.boolean(),
  asks: z.array(NcClipRetentionAskSchema).readonly(),
})
export type NcClipRetentionPlan = z.infer<typeof NcClipRetentionPlanSchema>

// ── Capability definition ───────────────────────────────────────────

export const notificationRulesCapability = {
  name: 'notification-rules',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listRules: method(z.object({}), z.object({ rules: z.array(NcRuleSchema) }), {
      auth: 'admin',
    }),
    getRule: method(z.object({ ruleId: z.string() }), z.object({ rule: NcRuleSchema.nullable() }), {
      auth: 'admin',
    }),
    // First `caller: 'required'` adopters (D-1 / NC P0): the hub router
    // injects `{ userId, isAdmin }` from the authenticated session; the
    // provider stamps `createdBy` from it — never from client input.
    createRule: method(z.object({ rule: NcRuleInputSchema }), z.object({ rule: NcRuleSchema }), {
      kind: 'mutation',
      auth: 'admin',
      caller: 'required',
    }),
    updateRule: method(NcRuleUpdateInputSchema, z.object({ rule: NcRuleSchema }), {
      kind: 'mutation',
      auth: 'admin',
      caller: 'required',
    }),
    deleteRule: method(z.object({ ruleId: z.string() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    setRuleEnabled: method(
      z.object({ ruleId: z.string(), enabled: z.boolean() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Shared action sequences — named step lists rules and buttons bind to by
     * id. One store for the whole notification centre so two rules sharing a
     * gate share its throttle too.
     */
    listSequences: method(z.object({}), z.object({ sequences: z.array(NcSharedSequenceSchema) }), {
      auth: 'admin',
    }),
    getSequence: method(
      z.object({ sequenceId: z.string().min(1) }),
      z.object({ sequence: NcSharedSequenceSchema.nullable() }),
      { auth: 'admin' },
    ),
    createSequence: method(
      z.object({ sequence: NcSharedSequenceInputSchema }),
      z.object({ sequence: NcSharedSequenceSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    updateSequence: method(
      z.object({
        sequenceId: z.string().min(1),
        sequence: NcSharedSequenceInputSchema,
      }),
      z.object({ sequence: NcSharedSequenceSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteSequence: method(
      z.object({ sequenceId: z.string().min(1) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * WHAT THE RULES ACTUALLY ASK the stream broker to retain, per camera.
     *
     * The notification centre owns the rules, so it is the only thing that can
     * say how much history a camera's notifications will ever reach back for.
     * Before this the broker guessed — a flat minute on every camera — and
     * learned the PROFILE reactively, after the first clip had already been cut
     * from the wrong one. This is the same ask stated once, in front.
     *
     * A QUERY, pulled by each node's broker, not a push: brokers are per node
     * (a camera's ring lives wherever its stream is ingested) while this cap is
     * a singleton, so a push would have to enumerate the cluster. The pull also
     * makes the failure mode right — a broker that cannot reach the centre
     * keeps the plan it has, and a plan that has never arrived is UNKNOWN
     * rather than empty (D49: a read that fails changes nothing).
     */
    getClipRetentionAsks: method(z.object({}), NcClipRetentionPlanSchema, { auth: 'admin' }),

    /**
     * PERMANENT per-camera mute — the notifications half of the per-camera
     * function switch group ([D61](../../../../docs/decisions/adr-0067.md)).
     *
     * Deliberately NOT a snooze. A snooze is bounded at
     * {@link NC_SNOOZE_MAX_MINUTES} on purpose — "a snooze that could not
     * expire would be an outage the operator asked for once and forgot" — and
     * widening it to express "this camera never notifies" would destroy that
     * property for every snooze. A mute is the other thing: an explicit,
     * indefinite, admin-only decision, visible in the switch group next to the
     * other four, and reported on `CameraStatus.switchedOff` so a silent
     * camera never reads as a working one.
     *
     * Returned as ONE list rather than a per-camera query: the group's reader
     * needs every camera's state, and a per-camera fan-out over the viewer's
     * single WebSocket is N frames serialised on one socket.
     */
    listDeviceMutes: method(
      z.object({}),
      z.object({ mutedDeviceIds: z.array(z.number().int()).readonly() }),
      { auth: 'admin' },
    ),
    /**
     * Mute or unmute one camera. Idempotent; an unmute of a camera that was
     * never muted succeeds.
     */
    setDeviceMuted: method(
      z.object({ deviceId: z.number().int(), muted: z.boolean() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Dry-run a rule against recently persisted records (object events for
     * `immediate`, closed tracks for `track-end`). Mutation kind only to
     * carry the full rule object safely; no side effects.
     */
    testRule: method(
      z.object({
        rule: NcRuleInputSchema,
        lookbackMinutes: z.number().int().min(1).max(1440).default(60),
      }),
      z.object({ results: z.array(NcTestResultSchema) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * The STATE SUMMARY a system rule would send now (D647) — for a saved rule
     * or an unsaved draft. Pure: sends nothing, stamps nothing. A MUTATION
     * only for transport (a whole rule does not belong in a GET URL). Admin,
     * like `testRule`: it names devices and nodes across the installation.
     */
    previewStateSummary: method(
      z.object({ rule: NcRuleInputSchema }),
      NcStateSummaryPreviewSchema,
      { kind: 'mutation', auth: 'admin', access: 'view' },
    ),
    /**
     * The machine-readable condition surface a rule editor renders from, plus
     * the picker VOCABULARY those conditions draw on.
     *
     * `taxonomy` is optional so an older provider that only returns `catalog`
     * still validates; a client that receives none keeps free-text inputs.
     * It was previously served ONLY on the `nc.getConditionCatalog` bridge
     * action, which is why the viewer had grouped pickers and the admin UI —
     * which reaches this cap — was stuck typing `person` from memory.
     */
    getConditionCatalog: method(
      z.object({}),
      z.object({
        catalog: z.array(NcConditionDescriptorSchema),
        taxonomy: NcTaxonomySchema.optional(),
      }),
    ),
    /** The declared `{{var}}` vocabulary; editors filter it with `templateVarsFor`. */
    getTemplateCatalog: method(
      z.object({}),
      z.object({ vars: z.array(NcTemplateVarDescriptorSchema) }),
    ),
    /**
     * Render a template with example values, through the hub's text catalog.
     * Pure: sends nothing. A MUTATION only for transport — a 2.5k-char draft in
     * a batched GET URL risks length limits — so access stays `view`, the same
     * as `getTemplateCatalog`.
     */
    previewTemplate: method(NcTemplatePreviewInputSchema, NcTemplatePreviewSchema, {
      kind: 'mutation',
      access: 'view',
    }),
    /**
     * Queryable delivery history — a read-only view over the durable outbox
     * (fired rule, subject summary, target, status, timestamps, error on a
     * dead row). Newest-first, bounded by `filter.limit`. Retention follows
     * the outbox's own terminal-row prune horizon (no separate history
     * horizon — single collection, single source of truth). Admin-only in
     * P1 (no user dimension); the P2 viewer History screen adds per-caller
     * scoping on the same method.
     */
    getHistory: method(
      z.object({ filter: NcHistoryFilterSchema.default({ limit: NC_HISTORY_LIMIT_DEFAULT }) }),
      z.object({ entries: z.array(NcHistoryEntrySchema) }),
      { auth: 'admin' },
    ),
    /**
     * The newest delivery of every rule, in ONE bounded read of the outbox —
     * the "Last run" column. Never a `getHistory` per rule. A rule with no
     * delivery inside `horizonMs` is absent from `runs`; see
     * {@link NcRuleLastRunsSchema} for what absent means. A store that cannot
     * answer FAILS the call rather than answering "nothing ran". Admin-only,
     * like `getHistory`, of which it is a projection.
     */
    getRuleLastRuns: method(z.object({}), NcRuleLastRunsSchema, { auth: 'admin' }),
    /**
     * Mint a fresh, externally-reachable URL for one artefact a history row
     * named in {@link NcHistoryEntrySchema.shape.artifactIds} — the SAME
     * signed-link mechanism the dispatcher uses to attach media to an
     * outgoing notification (one derivation; this never re-implements it).
     *
     * `url: null` on THREE causes a caller must treat identically ("no image
     * right now", never a broken link): the id is unknown, its artefact has
     * expired past the retained shelf's own age bound, or this install has no
     * externally-reachable base URL. A caller that received a URL on a
     * previous call and now gets `null` must stop showing it — a link that
     * worked five minutes ago is not proof it works now.
     */
    resolveArtifactUrl: method(
      z.object({ artifactId: z.string().min(1) }),
      z.object({ url: z.string().nullable() }),
      { auth: 'admin' },
    ),

    /**
     * Snooze windows currently in effect, plus any whose digest has not yet
     * gone out. `caller: 'required'`: a user sees their OWN windows and the
     * global ones that silence them, never another person's private silence.
     * An admin sees every window — a household-wide silence is exactly the
     * thing an operator has to be able to find and cancel.
     */
    listSnoozes: method(z.object({}), z.object({ snoozes: z.array(NcSnoozeSchema) }), {
      caller: 'required',
    }),
    /**
     * Open a window. `userId` is stamped from the caller; a GLOBAL window is
     * permission-checked server-side (the rule's `snoozeAllowGlobal` for a
     * rule-scoped one, admin for a camera or the whole feed) — a client asking
     * for one it may not have is rejected, never silently downgraded, because
     * a snooze the operator believes is in effect and is not is the same
     * failure as one they cannot end.
     */
    createSnooze: method(
      z.object({ snooze: NcSnoozeInputSchema }),
      z.object({ snooze: NcSnoozeSchema }),
      { kind: 'mutation', caller: 'required' },
    ),
    /**
     * End a window NOW. The digest still goes out (what was hidden while it
     * was open is still what the operator missed); only the silence stops.
     * A user may cancel their own; an admin may cancel any.
     */
    cancelSnooze: method(
      z.object({ snoozeId: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', caller: 'required' },
    ),

    /**
     * The alarm panel's settings, what each mode ACTUALLY arms, and — when a
     * panel exists — its `live` state: current state and target mode, what
     * each mode would find open (blocking or not, and what is unknown), and
     * the devices currently excluded.
     *
     * Coverage is returned by the same call as the settings on purpose: they
     * are read together or not at all. An editor that showed the delays
     * without the coverage would let an operator tune an exit delay for a mode
     * that arms nothing, which is the failure this whole surface exists to
     * make visible.
     */
    getAlarmConfig: method(z.object({}), NcAlarmConfigSchema, { auth: 'admin' }),
    /**
     * Patch the settings (durations — global and per mode —, recipients,
     * per-mode non-blocking lists or one membership edit; `announceArm` is
     * accepted and ignored — D630). Returns the WHOLE config,
     * coverage and `live` included, so a
     * client never has to guess what the server settled on — the panel clamps
     * and normalises, and a form that re-rendered from its own input would
     * show a value the alarm is not using.
     */
    setAlarmConfig: method(z.object({ patch: NcAlarmSettingsPatchSchema }), NcAlarmConfigSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Create a named profile. Without `cloneFromId` the new profile starts at
     * system defaults (empty memberships); with it, a copy of that profile.
     * Does not activate — the operator switches explicitly.
     */
    createAlarmProfile: method(NcAlarmCreateProfileInputSchema, NcAlarmConfigSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Rename a profile (Default included — only the name, never the id). */
    renameAlarmProfile: method(NcAlarmRenameProfileInputSchema, NcAlarmConfigSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Delete a non-default profile. If it was active, Default becomes active
     * and its settings are applied for arm decisions.
     */
    deleteAlarmProfile: method(NcAlarmProfileIdInputSchema, NcAlarmConfigSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Make this profile active: its membership/delays blob is applied to the
     * panel so the next arm uses it.
     */
    activateAlarmProfile: method(NcAlarmProfileIdInputSchema, NcAlarmConfigSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * The CURRENT state of each asked device as the alarm reads it (D697) — open, closed,
     * unknown (why) or not an opening, plus liveness. Classified by the same table the arm
     * check uses (`alarm-openings.ts`), so the editor and the arm can never disagree. The
     * caller names the ids (the household openings it already holds); at most
     * `NC_ALARM_SENSORS_MAX`.
     */
    getAlarmSensors: method(NcAlarmSensorsInputSchema, NcAlarmSensorsSchema, { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type INotificationRulesProvider = InferProvider<typeof notificationRulesCapability>
