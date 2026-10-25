/**
 * nc-actions — the `pipeline-analytics` rule-bridge action catalog.
 *
 * The Notification Center viewer NEVER adds a cap method: every rule read/write
 * rides the generic `addons.custom` bridge (`{ addonId, action, input }`) with a
 * per-action `nc.*` name, and THIS module enforces the per-action auth +
 * ownership server-side (spec C1/C2). The addon id is `'pipeline-analytics'`.
 *
 * Auth model (spec §3.1 / §5 — server-derived, never client-trusted):
 *  - `nc.listRules` / `nc.getConditionCatalog` — any authenticated caller;
 *    listRules is SCOPED (own personal + global rules only) and stamps a
 *    per-row `readOnly` verdict.
 *  - `nc.createRule` / `nc.updateRule` / `nc.deleteRule` — operate ONLY on
 *    caller-OWNED rules; `ownerUserId` is stamped from the caller and can
 *    never be re-owned through a patch.
 *  - `nc.setRuleTargetEnabled` — a user opting HIS OWN target out of a rule
 *    VISIBLE to him (his own personal rule OR a global/admin rule).
 *  - the TIMELAPSE and DIGEST families (`nc.*TimelapseRule*`,
 *    `nc.*SummaryRule*`) repeat that model exactly over their own stores. The
 *    digest half was `auth: 'admin'` in v1 and was relaxed once the operator
 *    closed the cost question; `nc.listSummaryRules` reports the current answer
 *    as `canAuthor` so a client talking to an older hub degrades to a read-only
 *    list instead of discovering the refusal as a 403 on a filled-in form.
 *  - the three TEST actions (`nc.injectTestEvent`, `nc.testRule`,
 *    `nc.testTimelapseRule`, `nc.testSummaryRule`) stay `auth: 'admin'`
 *    regardless of who owns the rule: they DELIVER, to every target the rule
 *    addresses, on other people's phones.
 *
 * Target-ownership limits (personal-rule delivery target list + the opt-out
 * target) are enforced against the notifiers target catalog; ADMINS bypass the
 * target-ownership limit (they may deliver to / opt any target) but NEVER the
 * fail-closed caller check — an absent caller (UDS version-skew can still
 * deliver `undefined`) is rejected before any ownership decision.
 */

import {
  type AlarmArmMode,
  AlarmArmModeSchema,
  assertTimelapseCadences,
  type CustomActionCaller,
  customAction,
  defineCustomActions,
  deriveRecordingMode,
  type IScopedLogger,
  NC_CONDITION_CATALOG,
  NC_TAXONOMY,
  type NcAlarmConfig,
  NcAlarmConfigSchema,
  type NcAlarmSensors,
  type NcAlarmSensorsInput,
  NcAlarmSensorsInputSchema,
  NcAlarmSensorsSchema,
  type NcAlarmSettingsPatch,
  NcAlarmSettingsPatchSchema,
  NcConditionDescriptorSchema,
  type NcRule,
  NcRuleInputSchema,
  type NcRulePatch,
  NcRulePatchSchema,
  NcRuleSchema,
  type NcRuleTarget,
  NcRuleUpdateInputSchema,
  type NcSnooze,
  type NcSnoozeInput,
  NcSnoozeInputSchema,
  NcSnoozeSchema,
  NcTaxonomySchema,
  NcTemplatePreviewInputSchema,
  NcTemplatePreviewSchema,
  NcTemplateVarDescriptorSchema,
  isSystemEventSummaryRule,
  type RecordingConfig,
  type TimelapseRule,
  TimelapseRuleInputSchema,
  TimelapseRulePatchSchema,
  TimelapseRuleSchema,
  servedTemplateVars,
} from '@camstack/types'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { type NcAlarmArmOutcome, NcAlarmArmOutcomeSchema } from './alarm/alarm-arm-guard.js'
import { NcGroupMemberFateSchema } from './grouped/nc-group-store.js'
import {
  type NcArtifactIndex,
  NcArtifactQuerySchema,
  NcArtifactRecordSchema,
} from './artifact-index.js'
import { type NcPruneRecord, NcPruneRecordSchema } from './device-prune-ledger.js'
import { type NcRuleAi, NcRuleAiSchema } from './rule-ai.js'
import type { NcRuleAiStore } from './rule-ai-store.js'
import { guardPatchDevicesExclude, guardRuleDevicesExclude } from './device-scope-guard.js'
import {
  guardPatchDeviceCompat,
  guardRuleDeviceCompat,
  type ListDeviceIdsByCaps,
  NcDeviceCompatWarnSampler,
} from './device-compat-guard.js'
import { guardPatchFamily, guardRuleFamily } from './rule-family-guard.js'
import {
  guardPatchSystemEventDelivery,
  guardRuleSystemEventDelivery,
} from './rule-summary-guard.js'
import { guardPatchSensorTransition, guardRuleSensorTransition } from './sensor-transition-guard.js'
import { guardPatchDetectionAudio, guardRuleDetectionAudio } from './detection-audio-guard.js'
import { guardPatchGrouping, guardRuleGrouping } from './grouping-guard.js'
import { guardPatchMedia, guardRuleMedia } from './media-guard.js'
import { type NcRuleStatus, NcRuleStatusSchema } from './rule-status.js'
import type { NcRuleStore } from './rule-store.js'
import { planRuleTest } from './rule-test-plan.js'
import {
  type NcStateSummaryTest,
  NcStateSummaryTestSchema,
} from './state-summary/state-summary-test.js'
import type { SummaryRunResult } from './summary/summary-producer.js'
import { previewTemplate } from './template-preview.js'
import {
  assertSummaryBudget,
  type NcSummaryRule,
  NcSummaryRuleInputSchema,
  NcSummaryRulePatchSchema,
  NcSummaryRuleSchema,
} from './summary/summary-rule.js'
import type { NcSummaryStore } from './summary/summary-store.js'
import {
  type NcCalendarEventsRule,
  NcCalendarEventsRuleInputSchema,
  NcCalendarEventsRulePatchSchema,
  NcCalendarEventsRuleSchema,
} from './calendar-events/calendar-events-rule.js'
import type { NcCalendarEventsStore } from './calendar-events/calendar-events-store.js'
import {
  type NcTestEventInput,
  NcTestEventInputSchema,
  type NcTestEventResult,
  NcTestEventResultSchema,
} from './test-event.js'
import { NcLanguageSchema, type NcTextCatalog } from './text-catalog.js'
import type { NcTextCatalogEditor } from './text-catalog-editor.js'
import { NcTextCatalogViewSchema, NcTextOverridePatchSchema } from './text-catalog-view.js'
import type { TimelapseRunNowResult } from './timelapse/timelapse-scheduler.js'
import type { TimelapseStore } from './timelapse/timelapse-store.js'
import { TimelapseRuleClearableKeySchema } from './timelapse/timelapse-rule-clear.js'
import { SummaryRuleClearableKeySchema } from './summary/summary-rule-clear.js'

/** A rule as served to the viewer — carries the server's `readOnly` verdict. */
const NcViewerRuleSchema = NcRuleSchema.extend({ readOnly: z.boolean() })

/** Same verdict, for a timelapse rule. */
const NcViewerTimelapseRuleSchema = TimelapseRuleSchema.extend({ readOnly: z.boolean() })

/** Same verdict, for a multi-camera digest rule. */
const NcViewerSummaryRuleSchema = NcSummaryRuleSchema.extend({ readOnly: z.boolean() })

/**
 * One vision profile, as a RULE AI PICKER needs to see it.
 *
 * Three fields, and the omissions are the point: `baseUrl`, `apiKey`,
 * `extraHeaders` and the four timeout bounds are infrastructure an operator
 * authoring a notification rule neither chooses nor should read.
 */
export const NcAiProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The vendor model id, shown beside the name — two profiles are routinely
   *  the same endpoint at two models, and the name alone cannot tell them
   *  apart. */
  model: z.string(),
})
export type NcAiProfile = z.infer<typeof NcAiProfileSchema>

/**
 * One grouped burst, as the viewer reads it.
 *
 * The LIGHT half of the Phase-2 group entity on purpose: ids and timestamps, no
 * representative frame and no clustering verdict. A card needs to know which
 * tracks were one arrival and when; anything more would be a second source of
 * truth about a relation the entity has not been built for yet.
 */
export const NcTrackGroupSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  deviceId: z.number().int(),
  openedAt: z.number().int(),
  lastGrowthAt: z.number().int(),
  memberTrackIds: z.array(z.string()).readonly(),
  memberCount: z.number().int(),
  /**
   * 1 on a D692 window row (a window is one message). A D143 burst row written before its
   * removal keeps the revisions it counted.
   */
  revision: z.number().int(),
  /** False while the window is open. */
  sealed: z.boolean(),
  /** The window's close (D692); absent while it is open. */
  closedAt: z.number().int().optional(),
  outcome: z.enum(['sent', 'dropped']).optional(),
  closeReason: z
    .enum(['all-final', 'deadline', 'shutdown', 'replayed', 'test', 'orphaned-at-start'])
    .optional(),
  /** Each member's fate: `sent`, or why it (or the whole window) said nothing. */
  members: z
    .array(z.object({ trackId: z.string(), className: z.string(), fate: NcGroupMemberFateSchema }))
    .readonly()
    .optional(),
  waitedMs: z.number().int().optional(),
})
export type NcTrackGroup = z.infer<typeof NcTrackGroupSchema>

/**
 * `nc.getAlarmStatus` — the panel as it is now (admin-only for now; see the
 * envelope's comment). `deviceId: null`
 * with `live: null` is a node with no panel, which a client must not read as
 * "disarmed, nothing open". `live` is the published `NcAlarmConfig.live`
 * schema, taken from it rather than re-declared.
 */
export const NcAlarmStatusSchema = z.object({
  deviceId: z.number().int().nullable(),
  live: NcAlarmConfigSchema.shape.live.unwrap().nullable(),
})
export type NcAlarmStatus = z.infer<typeof NcAlarmStatusSchema>

/** `nc.bypassAlarmInput` — one (rule, input) pair, until the next disarm. */
const NcAlarmBypassInputRequestSchema = z.object({
  ruleId: z.string().min(1),
  /** The input: the sensor whose match pressed the panel, else the camera. */
  deviceId: z.number().int(),
})
export type NcAlarmBypassInputRequest = z.infer<typeof NcAlarmBypassInputRequestSchema>

const NcAlarmBypassInputResultSchema = z.object({
  outcome: z.enum(['bypassed', 'already-bypassed', 'refused']),
  /**
   * Why a `refused` did nothing: the panel is disarmed, the rule is not an
   * alarm rule with this input, or the per-arm bound is reached. Null otherwise.
   */
  reason: z.enum(['disarmed', 'stale', 'full', 'not-an-input']).nullable(),
})
export type NcAlarmBypassInputResult = z.infer<typeof NcAlarmBypassInputResultSchema>

/**
 * The action catalog — the tRPC contract Group B (the viewer client) consumes
 * against `addonId: 'pipeline-analytics'`. Every entry that depends on the
 * caller identity is declared `caller: 'required'` so the dispatcher forwards
 * the server-derived `{ userId, isAdmin }` as the handler's second argument.
 */
export const ncActions = defineCustomActions({
  'nc.listRules': customAction(z.object({}), z.object({ rules: z.array(NcViewerRuleSchema) }), {
    caller: 'required',
  }),
  'nc.getConditionCatalog': customAction(
    z.object({}),
    // ADDITIVE `taxonomy`: the fixed class/label vocabulary the rule editor
    // renders as pickers (video classes + audio kinds + sensor/control labels),
    // sourced server-side from the real `EVENT_TAXONOMY` registry. Rides the
    // generic bridge (no cap method / codegen), so it ships train-free.
    z.object({ catalog: z.array(NcConditionDescriptorSchema), taxonomy: NcTaxonomySchema }),
  ),
  'nc.getTemplateCatalog': customAction(
    z.object({}),
    z.object({ vars: z.array(NcTemplateVarDescriptorSchema) }),
  ),
  // A mutation only for transport (a long draft does not fit a GET URL); it sends nothing.
  'nc.previewTemplate': customAction(NcTemplatePreviewInputSchema, NcTemplatePreviewSchema, {
    kind: 'mutation',
  }),
  'nc.createRule': customAction(
    z.object({ rule: NcRuleInputSchema }),
    z.object({ rule: NcRuleSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.updateRule': customAction(NcRuleUpdateInputSchema, z.object({ rule: NcRuleSchema }), {
    kind: 'mutation',
    caller: 'required',
  }),
  'nc.deleteRule': customAction(
    z.object({ ruleId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.setRuleTargetEnabled': customAction(
    z.object({ ruleId: z.string(), targetId: z.string(), enabled: z.boolean() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  /**
   * THE AI SECTION of the ordinary rules — read and write.
   *
   * A pair of its own rather than two more keys on the rule CRUD, and that is
   * the whole point of the design. The addon builds self-contained and INLINES
   * `@camstack/types`, so its own copy of `NcRuleInputSchema` is never the
   * problem and nothing here fails at load. The coupling is the HUB: the cap
   * route (`notificationRules.createRule` / `updateRule`, which the admin
   * editor uses) validates input against the copy of `@camstack/types` that
   * `@camstack/system` inlines (`bundleTypesMainEntry`), so a new key on
   * `NcRuleInputSchema` is SILENTLY STRIPPED there until a `@camstack/server`
   * release carrying it is installed. These two validate only here, against a
   * schema that lives in the addon (`rule-ai.ts`), so a field added to it is
   * live on the next `camstack deploy packages/addon-post-analysis`.
   *
   * Scoped exactly as the rule CRUD is: reading needs a rule the caller can
   * SEE, writing needs one they own (admins bypass ownership, never the caller
   * check). `ai: null` CLEARS the section, which is distinct from
   * `enabled: false` only in what it leaves on disk — both deliver identically.
   */
  'nc.getRuleAi': customAction(
    z.object({ ruleId: z.string().optional() }),
    z.object({
      sections: z.array(z.object({ ruleId: z.string(), ai: NcRuleAiSchema })),
    }),
    { caller: 'required' },
  ),
  'nc.setRuleAi': customAction(
    z.object({ ruleId: z.string(), ai: NcRuleAiSchema.nullable() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  /**
   * The ALARM, for the viewer and the admin Alarm tab (D630).
   *
   * Bridge actions and not cap methods, for one reason each way:
   *
   *  - A REFUSED ARM IS A RESULT HERE. `alarm-panel.arm` is validated by the
   *    hub's generated router against the HOST's copy of the cap, which says
   *    `z.void()` — so on the cap a refusal can only be a thrown string. The
   *    response schema of these actions ({@link NcAlarmArmOutcomeSchema})
   *    lives in the addon and is validated only here, so a refusal travels as
   *    `{ outcome: 'refused', refusalId, blocking }` and the viewer can offer
   *    the Arm anyway bound to exactly that refusal.
   *  - The UIs never send a device id. There is one panel per hub and the
   *    centre already holds it; an id on the wire would be one more thing a
   *    client could get wrong.
   *
   * WHO may call what. The WRITES — arm, Arm anyway, disarm — are ADMIN-ONLY,
   * in the envelope and again in the handler. This is not the cap's authority
   * and must not pretend to be: `alarm-panel.arm` / `disarm` are DEVICE-scoped
   * (the host checks the caller's grant on THAT panel), while `addons.custom`
   * is SYSTEM-scoped and knows nothing about per-device grants. Opening these
   * to any authenticated user would widen who can disarm the house to anyone
   * with a login. A non-admin keeps arming and disarming through the
   * device-scoped cap, exactly as today, and gets past a refusal with the Arm
   * anyway button on the refusal notification (an HMAC grant bound to that one
   * refusal).
   *
   * `nc.getAlarmStatus` is READ-ONLY, and ADMIN-ONLY too until the viewer
   * work scopes it. It names every covered device, open or not, with its name
   * and state — a map of which windows of the house are open, served over the
   * system-scoped `addons.custom` to ANY login, regardless of which devices
   * that login may see. The device-scoped way to read a panel is the cap's
   * `getStatus`; this one opens up once it filters to the caller's grants.
   * The config pair is the admin's, as `getAlarmConfig` / `setAlarmConfig` are
   * on the cap: it carries the delays, the recipients and the non-blocking
   * lists. `getAlarmSensors` is the admin's too: it names which of the asked
   * devices are open.
   */
  'nc.getAlarmStatus': customAction(z.object({}), NcAlarmStatusSchema, {
    auth: 'admin',
    caller: 'required',
  }),
  'nc.armAlarm': customAction(z.object({ mode: AlarmArmModeSchema }), NcAlarmArmOutcomeSchema, {
    kind: 'mutation',
    auth: 'admin',
    caller: 'required',
  }),
  /**
   * `panel.armAnyway(refusalId)` — the same bound, one-shot path the refusal
   * notification's button takes: a second press is `used`, a panel that moved
   * since is `stale`, and a device that opened since is a NEW refusal.
   */
  'nc.armAlarmAnyway': customAction(
    z.object({ refusalId: z.string().min(1) }),
    NcAlarmArmOutcomeSchema,
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),
  'nc.disarmAlarm': customAction(z.object({}), z.object({ success: z.literal(true) }), {
    kind: 'mutation',
    auth: 'admin',
    caller: 'required',
  }),
  /**
   * "Bypass this input until disarm" from the app — the same panel path the
   * trigger notification's button takes, for the same principals who may
   * disarm here (admin). The live view (`nc.getAlarmStatus`) then lists it
   * under `bypassedInputs` until the next disarm.
   */
  'nc.bypassAlarmInput': customAction(
    NcAlarmBypassInputRequestSchema,
    NcAlarmBypassInputResultSchema,
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),
  /**
   * What the deleted-device / deleted-target prune did to the rules
   * (`device-prune-runner.ts`) — the source of the banner both UIs show on a
   * rule it switched off ("Disabled on <date>: its last device (#id) was
   * deleted"). Admin-only, like the other admin reads: it names devices and
   * targets across every user's rules.
   */
  'nc.listPrunes': customAction(z.object({}), z.object({ prunes: z.array(NcPruneRecordSchema) }), {
    auth: 'admin',
    caller: 'required',
  }),
  'nc.getAlarmConfig': customAction(z.object({}), NcAlarmConfigSchema, {
    auth: 'admin',
    caller: 'required',
  }),
  'nc.getAlarmSensors': customAction(NcAlarmSensorsInputSchema, NcAlarmSensorsSchema, {
    auth: 'admin',
    caller: 'required',
  }),
  'nc.setAlarmConfig': customAction(
    z.object({ patch: NcAlarmSettingsPatchSchema }),
    NcAlarmConfigSchema,
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),
  /**
   * The profiles a rule's AI section may be PINNED to — the picker's options.
   *
   * A bridge action and not `llm.listProfiles` straight from the client, for
   * the reason this whole module exists: the viewer never adds a cap method,
   * and a phone that had to speak the `llm` cap would need an SDK train to
   * learn a field this addon already owns.
   *
   * NARROWED, not proxied. Only `enabled` + `supportsVision` rows come back:
   * a vision call against a text profile is REFUSED by the provider (never
   * degraded to text), so offering one would be an option whose only outcome
   * is the fail-open path. And only the three fields a picker draws — a
   * `baseUrl`, an `extraHeaders` map or a redaction-shaped `apiKey` is
   * infrastructure the caller of this action has no business reading.
   *
   * An EMPTY list is a real answer ("this hub has no vision profile") and so
   * is the absent dependency, which refuses — the two must not be confused,
   * so the refusal throws rather than answering `[]`.
   */
  'nc.listAiProfiles': customAction(
    z.object({}),
    z.object({ profiles: z.array(NcAiProfileSchema) }),
    { caller: 'required' },
  ),
  /**
   * Snooze, from the phone — the surface that matters most for this feature,
   * because "silence this until morning" is a thing you press in bed, not at a
   * desk. Scoped to the caller: their own windows plus the global ones that
   * silence them.
   */
  /**
   * The BURSTS this hub has grouped — the data half of the timeline's
   * expandable group card.
   *
   * Rides the generic bridge, like every other viewer read here: no cap method,
   * no codegen, ships train-free. Read-only and deliberately thin — it answers
   * "which tracks were one arrival", and the per-subject tracks stay the record
   * and stay clickable. A group card EXPANDS to its members; it never replaces
   * them.
   */
  'nc.listTrackGroups': customAction(
    z.object({
      deviceId: z.number().int().optional(),
      ruleId: z.string().optional(),
      since: z.number().int().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    z.object({ groups: z.array(NcTrackGroupSchema) }),
    { caller: 'required' },
  ),
  'nc.listSnoozes': customAction(z.object({}), z.object({ snoozes: z.array(NcSnoozeSchema) }), {
    caller: 'required',
  }),
  'nc.createSnooze': customAction(
    z.object({ snooze: NcSnoozeInputSchema }),
    z.object({ snooze: NcSnoozeSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.cancelSnooze': customAction(
    z.object({ snoozeId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  /**
   * Inject a SYNTHETIC event through the whole notification path — match,
   * media, delivery — without producing a track, an event row or anything else
   * durable. See `test-event.ts` for what it does and does not do.
   *
   * A bridge action rather than a cap method, deliberately: it needs no
   * codegen, no `@camstack/system` republish and no place on a release train,
   * so the tester can ship and change at the speed of the addon it tests.
   *
   * `auth: 'admin'` because an injection DELIVERS: it reaches every target the
   * matched rule addresses, on other people's phones. `caller: 'required'` so
   * the log line names who pressed it.
   */
  'nc.injectTestEvent': customAction(NcTestEventInputSchema, NcTestEventResultSchema, {
    kind: 'mutation',
    auth: 'admin',
    caller: 'required',
  }),
  /**
   * FIRE THIS RULE NOW — the per-rule Test button.
   *
   * `nc.injectTestEvent` asks the operator to describe an event; this asks the
   * RULE. The server plans the synthetic subject from the rule's own conditions
   * (`rule-test-plan.ts`) and hands it to exactly the same injection, so the
   * notification travels the whole real path: `evaluateRule` → durable outbox →
   * the ordinary drain → the ordinary media ladders → the notifier. It arrives
   * on the phone, which is the entire point.
   *
   * It BYPASSES the cooldown and the per-camera mute, deliberately: the
   * operator pressed a button and must receive the notification, not a report
   * that a window from ten minutes ago swallowed it. Neither window is
   * CONSUMED, so the next real fire is unaffected. It never runs the rule's
   * action sequences — those unlock doors, and "does this notify" is not a
   * request to open a gate.
   *
   * `auth: 'admin'` for the same reason as the injection it wraps: it delivers
   * to every target the rule addresses, on other people's phones.
   */
  'nc.testRule': customAction(
    z.object({
      ruleId: z.string(),
      /** The camera to attribute the event to when the rule scopes none. */
      deviceId: z.number().int().optional(),
    }),
    NcTestEventResultSchema.extend({
      /** The subject kind the rule was tested with — the answer to "why was my
       *  rule not a candidate". `state-summary` for a summary rule (D698). */
      trigger: z.string(),
      /** What the plan could not reproduce (a device-state gate, a polygon). */
      planNotes: z.array(z.object({ conditionId: z.string(), note: z.string() })),
      /**
       * A STATE-SUMMARY rule's test (D698): the summary built now and the rows
       * it enqueued, or why nothing was — absent on every other rule.
       */
      stateSummary: NcStateSummaryTestSchema.optional(),
    }),
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),
  /**
   * What this rule is doing RIGHT NOW — a discriminated union per rule kind.
   *
   * Answers the question a rule LIST structurally cannot: an occupancy rule's
   * subject is a live count, and a timelapse rule's output arrives hours after
   * the window it is about. Everything returned is DERIVED from the watcher's
   * mirror, the live snapshot and the stores — nothing is a second copy of
   * state that could disagree with them.
   *
   * `caller: 'required'` and not admin-only: a personal rule's owner may read
   * the status of their own rule, and the handler refuses a rule they cannot
   * see rather than returning a redacted one.
   */
  'nc.getRuleStatus': customAction(z.object({ ruleId: z.string() }), NcRuleStatusSchema, {
    caller: 'required',
  }),

  // ── Scheduled timelapse (POST-HOC producer) ───────────────────────
  //
  // Same bridge, same auth model and same ownership rules as the detection
  // rules above; a different store. Deliberately NOT cap methods: a timelapse
  // rule rides no `NcDelivery` member (that enum is frozen), so a cap would
  // buy a release train and nothing else.
  'nc.listTimelapseRules': customAction(
    z.object({}),
    z.object({ rules: z.array(NcViewerTimelapseRuleSchema) }),
    { caller: 'required' },
  ),
  /**
   * ONE action for create AND update, unlike the detection-rule pair.
   *
   * A timelapse rule is edited as a whole in a single form (schedule +
   * cameras + targets), and the guards a create must pass — every camera
   * actually records, every target is owned — are the SAME ones a patch that
   * adds a camera must pass. Two entry points would be two places to forget
   * the recording check, and forgetting it is invisible until 06:05.
   *
   * `ruleId` absent ⇒ create from `rule`; `ruleId` present ⇒ patch.
   *
   * `clear` (edit only) names optional fields to REMOVE — the patch merges, so
   * an omitted key keeps its stored value. See `timelapse-rule-clear.ts`.
   */
  'nc.upsertTimelapseRule': customAction(
    z.object({
      ruleId: z.string().optional(),
      rule: TimelapseRuleInputSchema.optional(),
      patch: TimelapseRulePatchSchema.optional(),
      clear: z.array(TimelapseRuleClearableKeySchema).optional(),
    }),
    z.object({ rule: TimelapseRuleSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.deleteTimelapseRule': customAction(
    z.object({ ruleId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),
  /**
   * Produce the LAST CLOSED window for one camera of one rule, right now.
   *
   * `auth: 'admin'` for the same reason as `nc.injectTestEvent`: it DELIVERS,
   * to every target the rule addresses, on other people's phones. It does not
   * consume the schedule guard — pressing Test at noon must not cancel
   * tonight's run.
   */
  'nc.testTimelapseRule': customAction(
    z.object({ ruleId: z.string(), deviceId: z.number() }),
    z.object({
      produced: z.number().int(),
      exportId: z.string().optional(),
      coveragePercent: z.number().optional(),
      enqueued: z.number().int().optional(),
      windowStartMs: z.number().optional(),
      windowEndMs: z.number().optional(),
      error: z.string().optional(),
    }),
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),

  // ── Multi-camera DIGEST (summaries) ───────────────────────────────
  //
  // Same bridge, same auth model and same ownership rules as the two blocks
  // above. Deliberately NOT cap methods, and for one more reason than the
  // timelapse had: the rule SCHEMA itself lives in this addon (see
  // `summary/summary-rule.ts`), so a field added to it is live on the next
  // `camstack deploy` rather than on the next framework train.
  'nc.listSummaryRules': customAction(
    z.object({}),
    z.object({
      rules: z.array(NcViewerSummaryRuleSchema),
      /**
       * DOES THIS HUB LET THE CALLER AUTHOR ONE? The capability probe, and the
       * only honest way a client can know.
       *
       * `nc.upsertSummaryRule` was `auth: 'admin'` until the operator closed
       * that decision, and a viewer talking to a hub that still refuses has to
       * find out BEFORE it offers a "New summary rule" button — otherwise the
       * only feedback is a 403 taken in front of the operator on a form they
       * had already filled in. ADDITIVE and therefore `.optional()` on every
       * client mirror: absent means an older hub, which the viewer reads as "no
       * authoring" and degrades to a read-only list with a note.
       *
       * Derived from the same predicate the handlers enforce — never a constant
       * `true` — so a hub that re-tightened the auth could not say otherwise.
       */
      canAuthor: z.boolean(),
    }),
    { caller: 'required' },
  ),
  /**
   * ONE action for create AND update, like `nc.upsertTimelapseRule`: a digest
   * rule is authored as a whole (cameras + window + filters + targets) and the
   * guards a create must pass are the guards a patch that widens it must pass
   * too. Two entry points would be two places to forget one.
   *
   * `ruleId` absent ⇒ create from `rule`; present ⇒ patch.
   *
   * `caller: 'required'`, NOT `auth: 'admin'`. It was admin-only in v1 because
   * a digest spans cameras and consumes the local vision model, and that cost
   * had not been watched yet. The operator closed the decision, so this now
   * carries exactly the auth the two rule families beside it carry: ownership
   * is enforced in the handler, `ownerUserId` is STAMPED from the resolved
   * caller, a personal rule may deliver only to targets that caller OWNS, and an
   * admin still authors GLOBAL rules. No new ownership model was invented for
   * it — `NcSummaryStore` has had `ownerUserId` / `listForOwner` since it was
   * written and they were simply not reachable.
   *
   * `nc.testSummaryRule` stays admin: that one DELIVERS, on other people's
   * phones.
   */
  'nc.upsertSummaryRule': customAction(
    z.object({
      ruleId: z.string().optional(),
      rule: NcSummaryRuleInputSchema.optional(),
      patch: NcSummaryRulePatchSchema.optional(),
      /** Edit only: optional fields to REMOVE — the patch merges, so an omitted
       *  key keeps its stored value. See `summary/summary-rule-clear.ts`. */
      clear: z.array(SummaryRuleClearableKeySchema).optional(),
    }),
    z.object({ rule: NcSummaryRuleSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.deleteSummaryRule': customAction(
    z.object({ ruleId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),

  // ── Calendar events (scheduled upcoming-events digest) ─────────────
  'nc.listCalendarEventsRules': customAction(
    z.object({}),
    z.object({
      rules: z.array(NcCalendarEventsRuleSchema.extend({ readOnly: z.boolean() })),
      canAuthor: z.boolean(),
    }),
    { caller: 'required' },
  ),
  'nc.upsertCalendarEventsRule': customAction(
    z.object({
      ruleId: z.string().optional(),
      rule: NcCalendarEventsRuleInputSchema.optional(),
      patch: NcCalendarEventsRulePatchSchema.optional(),
    }),
    z.object({ rule: NcCalendarEventsRuleSchema }),
    { kind: 'mutation', caller: 'required' },
  ),
  'nc.deleteCalendarEventsRule': customAction(
    z.object({ ruleId: z.string() }),
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', caller: 'required' },
  ),

  /**
   * Produce one digest window RIGHT NOW — the operator's Test button.
   *
   * `auth: 'admin'` for the same reason as `nc.injectTestEvent` and
   * `nc.testTimelapseRule`: it DELIVERS, to every target the rule addresses, on
   * other people's phones. It does not consume the schedule guard — pressing
   * Test at noon must not cancel tonight's run.
   *
   * `windowStartMs`/`windowEndMs` are optional and are the whole point of the
   * action for a live check: they let an operator aim it at a range he KNOWS
   * held traffic, instead of waiting for one to close.
   */
  'nc.testSummaryRule': customAction(
    z.object({
      ruleId: z.string(),
      windowStartMs: z.number().optional(),
      windowEndMs: z.number().optional(),
    }),
    z.object({
      produced: z.number().int(),
      tiles: z.number().int().optional(),
      cameras: z.number().int().optional(),
      matched: z.number().int().optional(),
      /**
       * PARKED objects the window held and the rule dropped (`filters
       * .includeStationary`). Without it a Test that returns two tiles out of
       * forty tracks cannot tell the operator whether the night was quiet or
       * whether it was the car park — and that is the exact question this
       * option exists to answer.
       */
      droppedStationary: z.number().int().optional(),
      enqueued: z.number().int().optional(),
      mosaicBytes: z.number().int().optional(),
      mosaicUrl: z.string().optional(),
      windowStartMs: z.number().optional(),
      windowEndMs: z.number().optional(),
      error: z.string().optional(),
      /**
       * What the AI pass did (#35 P2), so a Test that delivered a digest with
       * NO sentence says why. Without these three the operator's only signal
       * that a rule with AI on failed open is a notification that looks normal.
       */
      aiText: z.string().optional(),
      aiFailure: z.string().optional(),
      aiImages: z.number().int().optional(),
      /** The window WAS produced and withheld by `ai.onFailure: 'skip'`. */
      skippedByAi: z.boolean().optional(),
    }),
    { kind: 'mutation', auth: 'admin', caller: 'required' },
  ),

  // ── The TEXT CATALOG edit surface (i18n Phase 2) ───────────────────
  //
  // Deliberately NOT cap methods, for the same reason as the timelapse block
  // above and one more: a cap change buys a release train, and the whole point
  // of the catalog is that a household can re-word its notifications the day
  // it wants to. These ride the generic bridge, so they are live the moment
  // `addon-post-analysis` is deployed.
  //
  // `auth: 'admin'` on all three, INCLUDING the read: the catalog is a
  // system-wide setting and its keys spell out every sentence the hub can
  // print — that is an operator surface, not a per-user one. No
  // `caller: 'required'`: there is no per-caller decision to make, and asking
  // for a caller we would not use is a fail-closed check that can only ever
  // produce false refusals.
  /**
   * The whole catalog for ONE language, each key carrying which layer answered
   * it. `language` defaults to the hub's own; passing another one inspects (and
   * lets an operator pre-translate) a locale the hub does not speak yet.
   */
  'nc.getTexts': customAction(
    z.object({ language: NcLanguageSchema.optional() }),
    NcTextCatalogViewSchema,
    { auth: 'admin' },
  ),
  /** Change the language every notification is written in. Returns the fresh
   *  view so the client never re-renders from its own optimistic guess. */
  'nc.setLanguage': customAction(
    z.object({ language: NcLanguageSchema }),
    NcTextCatalogViewSchema,
    { kind: 'mutation', auth: 'admin' },
  ),
  /**
   * One edit round: `key → text` overrides the shipped wording, `key → null`
   * resets it. A PATCH and not the whole map, so two admins editing different
   * keys do not overwrite each other.
   */
  'nc.setTextOverrides': customAction(
    z.object({ language: NcLanguageSchema, overrides: NcTextOverridePatchSchema }),
    NcTextCatalogViewSchema,
    { kind: 'mutation', auth: 'admin' },
  ),

  // ── Artifacts (task #36) ──────────────────────────────────────────
  //
  // The READ surface for what the notification centre has produced —
  // timelapses, their previews, digest mosaics. `protected`, not `admin`: an
  // artefact is the thing a NOTIFICATION already showed its recipient, and a
  // library only an admin can open is a library the operator asked for and
  // cannot use ("li voglio usare sulla app viewer" [I want to use them on the viewer app]). Visibility is enforced
  // per row instead: global artefacts plus the caller's own, everything for an
  // admin — the same rule `nc.listRules` applies.
  //
  // NO BYTES ride these actions. The payload is metadata plus the RELATIVE path
  // of an `authenticated` data-plane route; base64 over tRPC is how a list of
  // twenty timelapses becomes a hundred megabytes of envelope.
  /**
   * One page of artefacts, newest `capturedAt` first.
   *
   * `deviceIds` filters on the camera an artefact is FILED under. A digest
   * spans cameras and is filed under its rule's first one (the same camera its
   * outbox row uses); to ask "everything this digest produced" use `ruleId`.
   */
  'nc.listArtifacts': customAction(
    NcArtifactQuerySchema,
    z.object({
      artifacts: z.array(NcArtifactRecordSchema),
      /** Rows matching the filter, not rows on this page. */
      total: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    }),
    { caller: 'required' },
  ),
  /** One artefact's metadata. `null` for unknown, expired AND not-yours alike —
   *  a surface that distinguishes them reports what other people own. */
  'nc.getArtifact': customAction(
    z.object({ artifactId: z.string().min(1) }),
    z.object({ artifact: NcArtifactRecordSchema.nullable() }),
    { caller: 'required' },
  ),
  /**
   * Remove one artefact — the row and the bytes.
   *
   * `deleted: false` for unknown, expired and not-yours alike, exactly as
   * {@link 'nc.getArtifact'} answers `null` for all three. A video's poster
   * goes with it, which is why the answer is a LIST and not a boolean: an
   * operator who removed one card and freed two files should be able to see
   * that in the response rather than infer it.
   *
   * Ownership, not visibility: a GLOBAL artefact is visible to everyone and
   * removable by an admin only.
   */
  'nc.deleteArtifact': customAction(
    z.object({ artifactId: z.string().min(1) }),
    z.object({
      deleted: z.boolean(),
      /** The ids whose rows are gone — the artefact plus any poster. */
      removedIds: z.array(z.string()),
    }),
    { kind: 'mutation', caller: 'required' },
  ),
})

export type NcActions = typeof ncActions

/**
 * The typed handler map — one async handler per catalog entry, shaped exactly
 * like `AddonInitResult.actionHandlers` so it drops straight into the addon's
 * init result (each input/output collapses to the concrete `z.infer` of its
 * schema, and every handler takes the optional forwarded caller).
 */
export type NcActionHandlers = {
  readonly [K in keyof NcActions & string]: (
    input: z.infer<NcActions[K]['input']>,
    caller?: CustomActionCaller,
  ) => Promise<z.infer<NcActions[K]['output']>>
}

export interface NcActionDeps {
  readonly ruleStore: NcRuleStore
  /** The AI sections of those rules — see `rule-ai.ts` for why they are a side
   *  table and not fields on `NcRule`. */
  readonly ruleAiStore: NcRuleAiStore
  /**
   * The vision profiles a section may pin. Absent on a node whose wiring has
   * no `llm` consumer — the action then REFUSES rather than answering an empty
   * list, because "this hub has no vision profile" is advice an operator acts
   * on (they go and create one) and "I cannot ask" is not.
   */
  readonly listAiProfiles?: () => Promise<readonly NcAiProfile[]>
  readonly logger: IScopedLogger
  /**
   * The grouped-burst record. Absent on a node that hosts no centre — the
   * action then answers an EMPTY list, which is the truth about a node that has
   * never grouped anything, rather than a refusal a viewer would render as an
   * error on every camera page.
   */
  readonly listTrackGroups?: (query: {
    readonly deviceId?: number
    readonly ruleId?: string
    readonly since?: number
    readonly limit?: number
  }) => Promise<readonly NcTrackGroup[]>
  /** The `targetId`s the given user owns (from the notifiers target catalog). */
  readonly listCallerTargetIds: (userId: string) => Promise<readonly string[]>
  /**
   * Drop every MOSAIC a rule owns — the digest group shots filed under
   * `ownerKind: 'mosaic'`, `ownerId: <ruleId>` (D480).
   *
   * The mosaic's lifetime is its writer's bound, and a deleted rule never
   * writes again: without this, a rule's last ≤200 mosaics would be kept by a
   * bound nothing will ever run and collected by a sweep that is (correctly)
   * told not to have an opinion about them. Optional and best-effort — a
   * picture that will not delete must never make the rule look still present,
   * which is the same rule `ruleAiStore.clear` already follows here.
   */
  readonly dropRuleMosaics?: (ruleId: string) => Promise<void>
  /**
   * The snooze half, as three functions rather than the center itself: the
   * permission decision for a GLOBAL window needs the rule, so it lives in the
   * center — this module's job is only to prove who is asking.
   */
  readonly snooze: NcSnoozeActionDeps
  /**
   * The synthetic producer. Absent on a node that hosts no centre (or an older
   * wiring): the action then refuses honestly instead of returning an empty
   * result an operator would read as "the rule did not match".
   */
  readonly injectTestEvent?: (input: NcTestEventInput) => Promise<NcTestEventResult>
  /**
   * The TEST of a state-summary rule (D698): the summary built now, enqueued.
   * A summary rule sends nothing per event, so the injection above could
   * never deliver for it. Absent = the action refuses a summary rule honestly.
   */
  readonly testStateSummary?: (rule: NcRule) => Promise<NcStateSummaryTest>
  /**
   * The scheduled-timelapse half. Absent on a node that hosts no producer —
   * the actions then REFUSE honestly rather than answering an empty list, which
   * an operator reads as "my rule is gone".
   */
  readonly timelapse?: NcTimelapseActionDeps
  /**
   * The multi-camera digest half. Absent on a node that hosts no producer — the
   * actions then REFUSE honestly rather than answering an empty list, which an
   * operator reads as "my rule is gone".
   */
  readonly summary?: NcSummaryActionDeps
  /** Calendar-events digest rules. Absent ⇒ actions refuse honestly. */
  readonly calendarEvents?: NcCalendarEventsActionDeps
  /**
   * The text catalog's edit surface. Absent on a node that hosts no centre (or
   * an older wiring): the three actions then REFUSE honestly rather than
   * answering an empty catalog, which an operator reads as "my words are gone".
   */
  readonly texts?: NcTextCatalogEditor
  /** The live text catalog, for `nc.previewTemplate`. Absent ⇒ the action refuses by name. */
  readonly previewTexts?: NcTextCatalog
  /**
   * The browsable artefact index. Absent on a node that hosts no centre — the
   * two read actions then REFUSE honestly rather than answering an empty list,
   * which an operator reads as "my timelapses are gone".
   */
  readonly artifacts?: NcArtifactIndex
  /**
   * The shelf the bytes live on — only its delete leg, so this catalog cannot
   * accidentally grow a path that reads or writes artefact bytes over tRPC.
   * Absent on a node with no shelf: the row still goes, and the file was never
   * here to unlink.
   */
  readonly artifactShelf?: { readonly remove: (id: string) => Promise<boolean> }
  /**
   * The LIVE-STATUS half. Absent on a node that hosts no centre — the action
   * then refuses honestly rather than answering `none`, which an operator would
   * read as "this rule has nothing to show" instead of "ask the hub".
   */
  readonly ruleStatus?: NcRuleStatusDeps
  /**
   * The alarm half. Absent on a node that hosts no centre — the actions then
   * refuse by name rather than answering "disarmed", which is a claim about a
   * panel nobody asked.
   */
  readonly alarm?: NcAlarmActionDeps
  /**
   * The prune record. Absent on a node that hosts no centre — the action then
   * refuses by name rather than answering an empty list, which a UI would read
   * as "nothing was ever pruned" (D315).
   */
  readonly listPrunes?: () => Promise<readonly NcPruneRecord[]>
  /**
   * Which device ids carry ANY of the given capability names
   * (`deviceManager.listDeviceIdsByCaps`) — the save-time device-compatibility
   * guard (`device-compat-guard.ts`, operator ruling 2026-10-01), the SAME
   * check the cap-provider route (`notificationRules.createRule/updateRule`)
   * runs. Absent on an older wiring: the guard then FAILS OPEN and refuses
   * nothing, because a save must never become un-makeable over one
   * unreachable capability read.
   */
  readonly listDeviceIdsByCaps?: ListDeviceIdsByCaps
}

/**
 * The centre's alarm surface, as functions — this module owns only who may
 * call them. A centre with no panel answers `deviceId: null` for the reads and
 * refuses the writes (`this node has no alarm panel`).
 */
export interface NcAlarmActionDeps {
  readonly status: () => Promise<NcAlarmStatus>
  /** `userId` is who pressed it — logged by the centre, tagged with the panel id. */
  readonly arm: (mode: AlarmArmMode, userId: string) => Promise<NcAlarmArmOutcome>
  readonly armAnyway: (refusalId: string, userId: string) => Promise<NcAlarmArmOutcome>
  readonly disarm: (userId: string) => Promise<void>
  readonly bypassInput: (
    input: NcAlarmBypassInputRequest,
    userId: string,
  ) => Promise<NcAlarmBypassInputResult>
  readonly getConfig: () => Promise<NcAlarmConfig>
  readonly getSensors: (input: NcAlarmSensorsInput) => Promise<NcAlarmSensors>
  readonly setConfig: (patch: NcAlarmSettingsPatch) => Promise<NcAlarmConfig>
}

/** The two live-status readers, as functions — the centre owns the watcher and
 *  the scheduler, this module owns only the visibility check in front of them. */
export interface NcRuleStatusDeps {
  readonly forRule: (rule: NcRule) => Promise<NcRuleStatus>
  readonly forTimelapseRule: (rule: TimelapseRule) => Promise<NcRuleStatus>
}

export interface NcTimelapseActionDeps {
  readonly store: TimelapseStore
  /**
   * `recording.getDeviceConfig` — the recording AUTHORITY, and the only one.
   *
   * Returning `null` means the config could not be READ (device unknown, cap
   * unreachable). That is NOT "recording is off" and it is NOT "recording is
   * on": it is a refusal, because saving a rule on an unreadable camera is
   * saving a rule that may never produce anything.
   */
  readonly getRecordingConfig: (deviceId: number) => Promise<RecordingConfig | null>
  /** The scheduler's `runNow` — produce the last closed window, now. */
  readonly runNow: (input: {
    readonly ruleId: string
    readonly deviceId: number
  }) => Promise<TimelapseRunNowResult>
}

export interface NcSummaryActionDeps {
  readonly store: NcSummaryStore
  /** The producer's `runNow` — render and DELIVER one window, now. */
  readonly runNow: (input: {
    readonly ruleId: string
    readonly window?: { readonly startMs: number; readonly endMs: number }
  }) => Promise<SummaryRunResult>
}

export interface NcCalendarEventsActionDeps {
  readonly store: NcCalendarEventsStore
}

export interface NcSnoozeActionDeps {
  readonly list: (userId: string, isAdmin: boolean) => readonly NcSnooze[]
  readonly create: (input: NcSnoozeInput, caller: CustomActionCaller) => Promise<NcSnooze>
  readonly cancel: (snoozeId: string, caller: CustomActionCaller) => Promise<void>
}

/**
 * Does THIS build let a non-admin author a digest rule?
 *
 * A named constant rather than a literal `true` at the call site, so the one
 * fact `nc.listSummaryRules.canAuthor` reports and the auth the upsert actually
 * carries sit beside each other and are changed together. If the operator ever
 * re-tightens the action, this goes to `false` in the same edit and the viewer
 * degrades on the next list — instead of the app discovering it by taking a 403
 * on a form the operator had already filled in.
 */
const SUMMARY_AUTHORING_OPEN = true

/** Fail-closed caller resolution — an absent forwarded caller is NEVER admin. */
function requireCaller(caller: CustomActionCaller | undefined): CustomActionCaller {
  if (!caller || typeof caller.userId !== 'string' || caller.userId.length === 0) {
    throw new Error('forbidden: authenticated caller required')
  }
  return caller
}

/**
 * Rule fields only an admin may author through the rule bridge.
 *
 * `actions` runs cap methods on devices when the rule fires (a lock, a siren),
 * and `targetUsers` delivers to OTHER people's phones. A personal rule owned by
 * a non-admin must not be able to do either, and the phone's mirror stripping
 * them was the only thing stopping it.
 */
const NC_ADMIN_ONLY_RULE_FIELDS = ['actions', 'targetUsers'] as const
type NcAdminOnlyRuleField = (typeof NC_ADMIN_ONLY_RULE_FIELDS)[number]
type NcAdminOnlyRuleInput = Partial<Record<NcAdminOnlyRuleField, unknown>>

/** An empty list says the same as an absent field: nobody, nothing. */
function normalizeAdminOnlyValue(value: unknown): unknown {
  return Array.isArray(value) && value.length === 0 ? undefined : value
}

/**
 * Refuses a non-admin that CHANGES or CLEARS an admin-only field.
 *
 * The guard refuses a CHANGE, not an ECHO: a value deep-equal to what the rule
 * already stores (`stored`) passes, so a client that round-trips a rule an
 * admin wired (the viewer's editor sends the whole rule back) never fails an
 * owner's unrelated save. On create there is nothing stored, so any non-empty
 * value is a change. An empty list counts as absent on both sides.
 *
 * Clearing is refused too, deliberately: authoring a field and removing it are
 * the same authority. A non-admin who could clear `actions` could silently
 * disarm the siren an admin wired onto his rule, and one who could clear
 * `targetUsers` could cut the other people an admin addressed off it. The
 * owner keeps every other edit (and every other `clear` key); these two stay
 * the admin's to change in either direction.
 */
function assertAdminOnlyFields(
  input: NcAdminOnlyRuleInput,
  clear: readonly string[],
  caller: CustomActionCaller,
  stored: NcAdminOnlyRuleInput = {},
): void {
  if (caller.isAdmin) return
  for (const field of NC_ADMIN_ONLY_RULE_FIELDS) {
    const changed =
      input[field] !== undefined &&
      !isDeepStrictEqual(
        normalizeAdminOnlyValue(input[field]),
        normalizeAdminOnlyValue(stored[field]),
      )
    if (changed || clear.includes(field)) {
      throw new Error(`forbidden: '${field}' requires admin`)
    }
  }
}

/**
 * A rule must keep at least one addressee — a delivery target or a user.
 *
 * THE authority for this invariant: the rule bridge here and the cap-provider
 * route (`notificationRules.createRule` / `updateRule` in `index.ts`) both call
 * it, so the two save paths cannot drift apart. It is not in Zod because the schema allows empty `targets` (a
 * users-only rule) and a cross-field refine would break the `.partial()` patch.
 * The bridge must run it too: without it a caller of `nc.updateRule` could
 * empty a rule's targets and leave a rule that fires to nobody.
 */
export function assertRuleHasAddressee(
  targets: readonly NcRuleTarget[],
  targetUsers: readonly string[] | undefined,
): void {
  if (targets.length === 0 && (targetUsers?.length ?? 0) === 0) {
    throw new Error('a rule needs at least one delivery target or user')
  }
}

/** The addressee half of a stored rule and of a patch. */
type NcRuleAddressees = Pick<NcRule, 'targets' | 'targetUsers'>
type NcRuleAddresseePatch = Pick<NcRulePatch, 'targets' | 'targetUsers'>

/**
 * The addressee invariant applied to an UPDATE. Checked only when the edit
 * touches an addressee (a rename of a legacy addressee-less rule is not
 * refused), and a cleared `targetUsers` counts as absent. `existing` is `null`
 * when the rule is unknown — the store refuses that update on its own.
 */
export function assertPatchKeepsAddressee(
  existing: NcRuleAddressees | null,
  patch: NcRuleAddresseePatch,
  clear: readonly string[],
): void {
  const clearsUsers = clear.includes('targetUsers')
  if (patch.targets === undefined && patch.targetUsers === undefined && !clearsUsers) return
  assertRuleHasAddressee(
    patch.targets ?? existing?.targets ?? [],
    clearsUsers ? undefined : (patch.targetUsers ?? existing?.targetUsers),
  )
}

/**
 * An ADMIN caller, or a refusal. The dispatcher already gates an
 * `auth: 'admin'` action; this is the same check on this side of the bridge,
 * so a dispatcher that did not forward the flag cannot open it.
 */
function requireAdmin(caller: CustomActionCaller | undefined): CustomActionCaller {
  const c = requireCaller(caller)
  if (!c.isAdmin) throw new Error('forbidden: admin required')
  return c
}

/** What `nc.testRule` answers. */
type NcRuleTestResult = z.infer<NcActions['nc.testRule']['output']>

export function makeNcActionHandlers(deps: NcActionDeps): NcActionHandlers {
  /** One sampler per handler set: an unchecked save warns once per rule per window. */
  const deviceCompatWarnSampler = new NcDeviceCompatWarnSampler()
  /** The alarm half, or a refusal by name — never a made-up "disarmed". */
  const requireAlarm = (action: string): NcAlarmActionDeps => {
    if (deps.alarm === undefined) throw new Error(`${action}: the alarm is not wired on this node`)
    return deps.alarm
  }
  /** A rule the caller may EDIT — must exist and be owned by the caller. */
  const assertOwnsRule = (ruleId: string): NcRule => {
    const rule = deps.ruleStore.get(ruleId)
    if (rule === null) throw new Error(`forbidden: rule not found: ${ruleId}`)
    return rule
  }
  /**
   * A rule the caller may EDIT. Ownership binds non-admins; an ADMIN
   * administers every rule — global ones (`ownerUserId: undefined`, what the
   * admin UI creates) and, for support, a user's personal rule.
   *
   * Without the admin bypass the comparison `rule.ownerUserId === userId` is
   * false for EVERY caller on a global rule, so the viewer refused to let an
   * admin edit an admin rule (operator report, 2026-07-30). Same bypass shape
   * as `assertTargetsOwned`.
   */
  const assertRuleEditable = (ruleId: string, caller: CustomActionCaller): NcRule => {
    const rule = assertOwnsRule(ruleId)
    if (caller.isAdmin) return rule
    if (rule.ownerUserId !== caller.userId) throw new Error(`forbidden: rule not owned: ${ruleId}`)
    return rule
  }
  /** A rule the caller may SEE — his own personal rule, a global/admin rule, or
   *  (for an admin) any rule at all. */
  const assertRuleVisible = (ruleId: string, caller: CustomActionCaller): NcRule => {
    const rule = assertOwnsRule(ruleId)
    if (caller.isAdmin) return rule
    if (rule.ownerUserId !== undefined && rule.ownerUserId !== caller.userId) {
      throw new Error(`forbidden: rule not owned: ${ruleId}`)
    }
    return rule
  }
  /**
   * TEST a STATE-SUMMARY rule (D698). The per-event injection cannot deliver
   * for it — a summary rule sends nothing per event (D647), and that test used
   * to be dropped without a word — so the summary is built NOW and enqueued.
   * The answer is shaped like every rule test's, plus the summary's own report.
   */
  const testSummaryRule = async (rule: NcRule, by: string): Promise<NcRuleTestResult> => {
    const test = deps.testStateSummary
    if (test === undefined) {
      throw new Error('this node does not host the notification centre — test on the hub')
    }
    deps.logger.info('rule test requested', {
      meta: {
        by,
        ruleId: rule.id,
        ruleName: rule.name,
        trigger: 'state-summary',
        // Said, like every rule test's bypass: a muted camera's state is in the
        // test's summary. A summary has no cooldown, so there is none to skip.
        bypassMute: true,
      },
    })
    const report = await test(rule)
    const enqueued = report.rows.reduce((sum, row) => sum + row.enqueued, 0)
    const notes: string[] = ['per-camera notification mute bypassed']
    if (report.nothingToReport) {
      notes.push(
        `nothing to report — ${report.sections
          .map(
            (section) =>
              `${section.id}: ${section.status === 'read' ? `${String(section.items)} open` : 'unavailable'}`,
          )
          .join(', ')} — nothing was sent, as the scheduled summary would send nothing`,
      )
    } else if (enqueued === 0) {
      notes.push('the summary was built but no row was enqueued — the rule reaches no target')
    }
    return {
      recordId: report.recordId,
      origin: 'synthetic',
      delivery: rule.delivery,
      candidates: 1,
      outcomes: [
        {
          ruleId: rule.id,
          ruleName: rule.name,
          matched: !report.nothingToReport,
          cooldown: 'bypassed',
          enqueued,
          targetIds: [...new Set(report.rows.flatMap((row) => row.targetIds))],
        },
      ],
      still: 'unattachable',
      notes,
      ...(report.nothingToReport ? { droppedBy: 'nothing-to-report' } : {}),
      trigger: 'state-summary',
      planNotes: [],
      stateSummary: report,
    }
  }
  /** The producer half, or an honest refusal. */
  const requireTimelapse = (): NcTimelapseActionDeps => {
    const tl = deps.timelapse
    if (tl === undefined) {
      throw new Error('this node does not host the timelapse producer — use the hub')
    }
    return tl
  }

  /** The digest producer half, or an honest refusal. */
  const requireSummary = (): NcSummaryActionDeps => {
    const sum = deps.summary
    if (sum === undefined) {
      throw new Error('this node does not host the summary producer — use the hub')
    }
    return sum
  }

  const requireCalendarEvents = (): NcCalendarEventsActionDeps => {
    const ce = deps.calendarEvents
    if (ce === undefined) {
      throw new Error('this node does not host calendar-events rules — use the hub')
    }
    return ce
  }

  /** The artefact index, or an honest refusal. */
  const requireArtifacts = (): NcArtifactIndex => {
    const index = deps.artifacts
    if (index === undefined) {
      throw new Error('this node does not host the notification artifact index — use the hub')
    }
    return index
  }

  /** The text catalog editor, or an honest refusal. */
  const requireTexts = (): NcTextCatalogEditor => {
    const editor = deps.texts
    if (editor === undefined) {
      throw new Error('this node does not host the notification text catalog — use the hub')
    }
    return editor
  }

  /**
   * A digest rule the caller may EDIT. Same shape and same admin bypass as
   * {@link assertTimelapseEditable} — deliberately, because a second ownership
   * model for the third rule family is a second place to get it wrong.
   *
   * A GLOBAL rule (no `ownerUserId`, what an admin authors) is VISIBLE to
   * everyone and editable by admins only: `listForOwner` returns it, so a user
   * sees it in the list, and `readOnly` says so.
   */
  const assertSummaryEditable = (
    ruleId: string,
    caller: CustomActionCaller,
    sum: NcSummaryActionDeps,
  ): NcSummaryRule => {
    const rule = sum.store.get(ruleId)
    if (rule === null) throw new Error(`forbidden: summary rule not found: ${ruleId}`)
    if (caller.isAdmin) return rule
    if (rule.ownerUserId !== caller.userId) {
      throw new Error(`forbidden: summary rule not owned: ${ruleId}`)
    }
    return rule
  }

  const assertCalendarEventsEditable = (
    ruleId: string,
    caller: CustomActionCaller,
    ce: NcCalendarEventsActionDeps,
  ): NcCalendarEventsRule => {
    const rule = ce.store.get(ruleId)
    if (rule === null) throw new Error(`forbidden: calendar-events rule not found: ${ruleId}`)
    if (caller.isAdmin) return rule
    if (rule.ownerUserId !== caller.userId) {
      throw new Error(`forbidden: calendar-events rule not owned: ${ruleId}`)
    }
    return rule
  }

  /** A timelapse rule the caller may EDIT. Same admin bypass as `NcRule`. */
  const assertTimelapseEditable = (
    ruleId: string,
    caller: CustomActionCaller,
    tl: NcTimelapseActionDeps,
  ): TimelapseRule => {
    const rule = tl.store.get(ruleId)
    if (rule === null) throw new Error(`forbidden: timelapse rule not found: ${ruleId}`)
    if (caller.isAdmin) return rule
    if (rule.ownerUserId !== caller.userId) {
      throw new Error(`forbidden: timelapse rule not owned: ${ruleId}`)
    }
    return rule
  }

  /**
   * THE RECORDING GUARD.
   *
   * A post-hoc timelapse renders RECORDED footage — a camera that is not
   * recording can never produce one, no matter how the rule is written. Save
   * time is the only moment an operator is present to be told: at 06:05 the
   * next morning the window is closed, the footage was never written, and the
   * only signal available is a log line nobody is reading.
   *
   * The authority is `RecordingConfig` through `deriveRecordingMode` — the
   * same pair camera-status reads. Never a second opinion, and never a guess:
   * `enabled: true` with no bands records NOTHING, which is exactly the case a
   * naive `config.enabled` check would wave through.
   *
   * FAIL-CLOSED on an unreadable config: a read that failed is not permission
   * to save.
   */
  const assertCamerasRecord = async (
    deviceIds: readonly number[],
    tl: NcTimelapseActionDeps,
  ): Promise<void> => {
    for (const deviceId of deviceIds) {
      const config = await tl.getRecordingConfig(deviceId).catch(() => null)
      if (config === null) {
        throw new Error(
          `camera ${deviceId}: recording configuration could not be read — cannot save a timelapse rule for it`,
        )
      }
      if (deriveRecordingMode(config) === 'off') {
        throw new Error(
          `camera ${deviceId}: recording is not enabled — a timelapse renders recorded footage, so enable recording for this camera first`,
        )
      }
    }
  }

  const assertTargetsOwned = async (
    targetIds: readonly string[],
    caller: CustomActionCaller,
  ): Promise<void> => {
    if (caller.isAdmin) return
    const owned = new Set(await deps.listCallerTargetIds(caller.userId))
    for (const id of targetIds) {
      if (!owned.has(id)) throw new Error(`forbidden: target not owned: ${id}`)
    }
  }

  return {
    'nc.listRules': async (_input, caller) => {
      const c = requireCaller(caller)
      // An admin administers the whole rule set (global + every user's), and
      // nothing is read-only to him. A user sees his own plus the global ones,
      // the latter read-only.
      const rules = c.isAdmin ? deps.ruleStore.list() : deps.ruleStore.listForOwner(c.userId)
      return {
        rules: rules.map((r) => ({ ...r, readOnly: !c.isAdmin && r.ownerUserId !== c.userId })),
      }
    },

    'nc.listTrackGroups': async (input, caller) => {
      requireCaller(caller)
      const list = deps.listTrackGroups
      if (list === undefined) return { groups: [] }
      return { groups: [...(await list(input))] }
    },

    'nc.getConditionCatalog': async () => ({
      catalog: [...NC_CONDITION_CATALOG],
      taxonomy: NC_TAXONOMY,
    }),

    // The SERVED catalog (D642): kinds the installed viewers cannot parse are held back.
    'nc.getTemplateCatalog': async () => ({ vars: servedTemplateVars() }),

    'nc.previewTemplate': async (input) => {
      const texts = deps.previewTexts
      if (texts === undefined) throw new Error('nc.previewTemplate: text catalog not wired')
      return previewTemplate(texts, input)
    },

    'nc.createRule': async (input, caller) => {
      const c = requireCaller(caller)
      const parsed = NcRuleInputSchema.parse(input.rule)
      assertAdminOnlyFields(parsed, [], c)
      assertRuleHasAddressee(parsed.targets, parsed.targetUsers)
      guardRuleFamily(parsed, { logger: deps.logger, by: c.userId })
      guardRuleSensorTransition(parsed, { logger: deps.logger, by: c.userId })
      guardRuleDetectionAudio(parsed, { logger: deps.logger, by: c.userId })
      guardRuleGrouping(parsed, { logger: deps.logger, by: c.userId })
      guardRuleMedia(parsed, { logger: deps.logger, by: c.userId })
      guardRuleDevicesExclude(parsed, { logger: deps.logger, by: c.userId })
      await guardRuleDeviceCompat(parsed, {
        logger: deps.logger,
        by: c.userId,
        listDeviceIdsByCaps: deps.listDeviceIdsByCaps,
        sampler: deviceCompatWarnSampler,
      })
      guardRuleSystemEventDelivery(parsed, { logger: deps.logger, by: c.userId })
      await assertTargetsOwned(
        parsed.targets.map((t) => t.targetId),
        c,
      )
      // `ownerUserId` + `createdBy` are stamped from the caller, never trusted
      // from the client payload.
      const rule = await deps.ruleStore.create({ ...parsed, ownerUserId: c.userId }, c.userId)
      deps.logger.info('nc rule created', { meta: { ruleId: rule.id, owner: c.userId } })
      return { rule }
    },

    'nc.updateRule': async (input, caller) => {
      const c = requireCaller(caller)
      const existing = assertRuleEditable(input.ruleId, c)
      const patch = NcRulePatchSchema.parse(input.patch)
      const clear = input.clear ?? []
      assertAdminOnlyFields(patch, clear, c, existing)
      assertPatchKeepsAddressee(existing, patch, clear)
      guardPatchFamily(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      guardPatchSensorTransition(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      guardPatchDetectionAudio(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      guardPatchGrouping(existing, patch, clear, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      guardPatchMedia(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      guardPatchDevicesExclude(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      await guardPatchDeviceCompat(existing, patch, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
        listDeviceIdsByCaps: deps.listDeviceIdsByCaps,
        sampler: deviceCompatWarnSampler,
      })
      guardPatchSystemEventDelivery(existing, patch, clear, {
        logger: deps.logger,
        by: c.userId,
        ruleId: input.ruleId,
      })
      if (patch.targets !== undefined) {
        await assertTargetsOwned(
          patch.targets.map((t) => t.targetId),
          c,
        )
      }
      // Drop persisted-/server-only fields a stale full-object patch may carry:
      // `ownerUserId` (never re-own a rule) and `disabledTargetIds` (the
      // per-target opt-out set is owner-toggled via nc.setRuleTargetEnabled and
      // must never be clobbered by a rule edit).
      const { ownerUserId: _owner, disabledTargetIds: _optOut, ...safe } = patch
      const rule = await deps.ruleStore.update(input.ruleId, safe, clear)
      deps.logger.info('nc rule updated', {
        meta: {
          ruleId: rule.id,
          owner: c.userId,
          ...(clear.length > 0 ? { cleared: clear } : {}),
        },
      })
      return { rule }
    },

    'nc.deleteRule': async (input, caller) => {
      const c = requireCaller(caller)
      assertRuleEditable(input.ruleId, c)
      await deps.ruleStore.delete(input.ruleId)
      // The AI section's lifetime is the rule's. Best-effort: a side row that
      // outlives its rule is inert (nothing reads it without a rule to fire),
      // and failing the delete over it would report the rule as still present.
      await deps.ruleAiStore.clear(input.ruleId).catch((err: unknown) => {
        deps.logger.warn('nc rule AI section left behind by a delete', {
          meta: { ruleId: input.ruleId, error: String(err) },
        })
      })
      await deps.dropRuleMosaics?.(input.ruleId).catch((err: unknown) => {
        deps.logger.warn('nc rule mosaics left behind by a delete', {
          meta: { ruleId: input.ruleId, error: String(err) },
        })
      })
      deps.logger.info('nc rule deleted', { meta: { ruleId: input.ruleId, owner: c.userId } })
      return { success: true }
    },

    'nc.getRuleAi': async (input, caller) => {
      const c = requireCaller(caller)
      if (input.ruleId !== undefined) {
        assertRuleVisible(input.ruleId, c)
        const ai = deps.ruleAiStore.get(input.ruleId)
        return { sections: ai === undefined ? [] : [{ ruleId: input.ruleId, ai }] }
      }
      // Unscoped: every section whose RULE the caller may see. Filtered through
      // the rule store rather than answered wholesale — a section is metadata
      // about a rule, and a rule the caller cannot see must not be
      // discoverable by the existence of its row.
      const rules = c.isAdmin ? deps.ruleStore.list() : deps.ruleStore.listForOwner(c.userId)
      const visible = new Set(rules.map((r) => r.id))
      return {
        sections: deps.ruleAiStore
          .list()
          .filter((row) => visible.has(row.ruleId))
          .map((row) => ({ ruleId: row.ruleId, ai: row.ai })),
      }
    },

    'nc.setRuleAi': async (input, caller) => {
      const c = requireCaller(caller)
      assertRuleEditable(input.ruleId, c)
      if (input.ai === null) {
        await deps.ruleAiStore.clear(input.ruleId)
        deps.logger.info('nc rule AI section cleared', {
          meta: { ruleId: input.ruleId, owner: c.userId },
        })
        return { success: true }
      }
      const ai: NcRuleAi = NcRuleAiSchema.parse(input.ai)
      await deps.ruleAiStore.set(input.ruleId, ai)
      deps.logger.info('nc rule AI section saved', {
        meta: {
          ruleId: input.ruleId,
          owner: c.userId,
          enabled: ai.enabled,
          ...(ai.maxWords !== undefined ? { maxWords: ai.maxWords } : {}),
          ...(ai.language !== undefined ? { language: ai.language } : {}),
        },
      })
      return { success: true }
    },

    'nc.getAlarmStatus': async (_input, caller) => {
      requireAdmin(caller)
      return requireAlarm('nc.getAlarmStatus').status()
    },

    'nc.armAlarm': async (input, caller) => {
      const c = requireAdmin(caller)
      return requireAlarm('nc.armAlarm').arm(input.mode, c.userId)
    },

    'nc.armAlarmAnyway': async (input, caller) => {
      const c = requireAdmin(caller)
      return requireAlarm('nc.armAlarmAnyway').armAnyway(input.refusalId, c.userId)
    },

    'nc.disarmAlarm': async (_input, caller) => {
      const c = requireAdmin(caller)
      await requireAlarm('nc.disarmAlarm').disarm(c.userId)
      return { success: true }
    },

    'nc.bypassAlarmInput': async (input, caller) => {
      const c = requireAdmin(caller)
      return requireAlarm('nc.bypassAlarmInput').bypassInput(input, c.userId)
    },

    'nc.listPrunes': async (_input, caller) => {
      requireAdmin(caller)
      const list = deps.listPrunes
      if (list === undefined)
        throw new Error('nc.listPrunes: the prune record is not wired on this node')
      return { prunes: [...(await list())] }
    },

    'nc.getAlarmConfig': async (_input, caller) => {
      requireAdmin(caller)
      return requireAlarm('nc.getAlarmConfig').getConfig()
    },

    'nc.getAlarmSensors': async (input, caller) => {
      requireAdmin(caller)
      return requireAlarm('nc.getAlarmSensors').getSensors(input)
    },

    'nc.setAlarmConfig': async (input, caller) => {
      requireAdmin(caller)
      return requireAlarm('nc.setAlarmConfig').setConfig(input.patch)
    },
    'nc.listAiProfiles': async (_input, caller) => {
      requireCaller(caller)
      const list = deps.listAiProfiles
      if (list === undefined) {
        throw new Error('this node cannot list vision profiles (no llm consumer wired)')
      }
      return { profiles: [...(await list())] }
    },

    'nc.listSnoozes': async (_input, caller) => {
      const c = requireCaller(caller)
      return { snoozes: [...deps.snooze.list(c.userId, c.isAdmin)] }
    },

    'nc.createSnooze': async (input, caller) => {
      const c = requireCaller(caller)
      // A rule-scoped window must be one the caller can SEE — otherwise the
      // existence of another person's private rule is discoverable by trying to
      // snooze ids until one stops throwing "not found".
      const parsed = NcSnoozeInputSchema.parse(input.snooze)
      if (parsed.ruleId !== undefined) assertRuleVisible(parsed.ruleId, c)
      const snooze = await deps.snooze.create(parsed, c)
      deps.logger.info('nc snooze opened', {
        meta: { snoozeId: snooze.id, scope: snooze.scope, by: c.userId, global: snooze.global },
      })
      return { snooze }
    },

    'nc.cancelSnooze': async (input, caller) => {
      const c = requireCaller(caller)
      // Ownership is checked by the center (it holds the window); this only
      // proves who is asking.
      await deps.snooze.cancel(input.snoozeId, c)
      return { success: true }
    },

    'nc.injectTestEvent': async (input, caller) => {
      const c = requireCaller(caller)
      // Belt AND braces: the action is declared `auth: 'admin'`, and the
      // handler refuses a non-admin anyway. An injection delivers to other
      // people's phones and can bypass a camera mute — the two checks cost
      // nothing and the failure mode of getting it wrong is somebody else's
      // notification.
      if (!c.isAdmin) throw new Error('forbidden: admin required to inject a test event')
      const inject = deps.injectTestEvent
      if (inject === undefined) {
        throw new Error('this node does not host the notification centre — inject on the hub')
      }
      const parsed = NcTestEventInputSchema.parse(input)
      deps.logger.info('synthetic notification test requested', {
        tags: { deviceId: parsed.deviceId },
        meta: {
          by: c.userId,
          trigger: parsed.trigger,
          ...(parsed.onlyRuleId !== undefined ? { ruleId: parsed.onlyRuleId } : {}),
        },
      })
      return inject(parsed)
    },

    'nc.testRule': async (input, caller) => {
      const c = requireCaller(caller)
      // Belt AND braces, exactly like `nc.injectTestEvent`: this delivers to
      // other people's phones and bypasses two side gates.
      if (!c.isAdmin) throw new Error('forbidden: admin required to test a rule')
      const inject = deps.injectTestEvent
      if (inject === undefined) {
        throw new Error('this node does not host the notification centre — test on the hub')
      }
      const rule = assertRuleVisible(input.ruleId, c)
      if (isSystemEventSummaryRule(rule)) return testSummaryRule(rule, c.userId)
      const plan = planRuleTest({
        rule,
        now: Date.now(),
        ...(input.deviceId !== undefined ? { fallbackDeviceId: input.deviceId } : {}),
      })
      deps.logger.info('rule test requested', {
        tags: { deviceId: plan.input.deviceId },
        meta: {
          by: c.userId,
          ruleId: rule.id,
          ruleName: rule.name,
          trigger: plan.trigger,
          // A bypass is never silent: the two windows this skips are the two
          // most common reasons a live rule is quiet, and a log that did not
          // say so would make a test indistinguishable from a real fire.
          bypassCooldown: true,
          bypassMute: true,
          planNotes: plan.notes.map((n) => n.conditionId),
        },
      })
      const result = await inject(plan.input)
      return {
        ...result,
        trigger: plan.trigger,
        planNotes: plan.notes.map((n) => ({ conditionId: n.conditionId, note: n.note })),
      }
    },

    'nc.getRuleStatus': async (input, caller) => {
      const c = requireCaller(caller)
      const status = deps.ruleStatus
      if (status === undefined) {
        throw new Error('this node does not host the notification centre — ask the hub')
      }
      // Which store owns the id decides which visibility check applies, and the
      // check runs BEFORE the read: a status is a live fact about somebody's
      // camera, and answering it for a rule the caller cannot see would leak it.
      const detection = deps.ruleStore.get(input.ruleId)
      if (detection !== null) {
        assertRuleVisible(input.ruleId, c)
        return status.forRule(detection)
      }
      const timelapse = deps.timelapse?.store.get(input.ruleId) ?? null
      if (timelapse !== null) {
        if (!c.isAdmin && timelapse.ownerUserId !== c.userId) {
          throw new Error(`forbidden: timelapse rule not owned: ${input.ruleId}`)
        }
        return status.forTimelapseRule(timelapse)
      }
      throw new Error(`rule not found: ${input.ruleId}`)
    },

    // ── Scheduled timelapse ─────────────────────────────────────────

    'nc.listTimelapseRules': async (_input, caller) => {
      const c = requireCaller(caller)
      const tl = requireTimelapse()
      const rules = c.isAdmin ? tl.store.list() : tl.store.listForOwner(c.userId)
      return {
        rules: rules.map((r) => ({ ...r, readOnly: !c.isAdmin && r.ownerUserId !== c.userId })),
      }
    },

    'nc.upsertTimelapseRule': async (input, caller) => {
      const c = requireCaller(caller)
      const tl = requireTimelapse()

      if (input.ruleId === undefined) {
        if (input.rule === undefined)
          throw new Error('upsertTimelapseRule: rule or ruleId required')
        // A create has nothing stored to remove — a `clear` here is a caller
        // that confused the two paths, refused rather than dropped unread.
        if (input.clear !== undefined && input.clear.length > 0) {
          throw new Error('upsertTimelapseRule: clear applies to an edit (ruleId) only')
        }
        const parsed = TimelapseRuleInputSchema.parse(input.rule)
        assertTimelapseCadences(parsed)
        await assertTargetsOwned(
          parsed.targets.map((t) => t.targetId),
          c,
        )
        await assertCamerasRecord(parsed.deviceIds, tl)
        // An ADMIN authors GLOBAL rules (no `ownerUserId`) — the same
        // convention `nc.listRules` already encodes and the admin UI already
        // relies on. A user authors his own personal rule. Ownership is a
        // server decision either way; `TimelapseStore.create` re-parses the
        // input so it can never ride in on the blob.
        const rule = await tl.store.create(parsed, c.userId, c.isAdmin ? undefined : c.userId)
        deps.logger.info('timelapse rule created', {
          meta: { ruleId: rule.id, owner: c.userId, devices: rule.deviceIds.join(',') },
        })
        return { rule }
      }

      const existing = assertTimelapseEditable(input.ruleId, c, tl)
      if (input.patch === undefined) throw new Error('upsertTimelapseRule: patch required')
      const patch = TimelapseRulePatchSchema.parse(input.patch)
      const clear = input.clear ?? []
      // On the MERGED pair, never the patch alone: lowering `cadenceSec` by
      // itself can invalidate a `denseCadenceSec` set months earlier, and
      // checking the patch in isolation would persist that broken pair. A
      // CLEARED dense cadence is absent from the merge, so it constrains nothing.
      const keptDense = clear.includes('denseCadenceSec') ? undefined : existing.denseCadenceSec
      const mergedDense = patch.denseCadenceSec ?? keptDense
      assertTimelapseCadences({
        cadenceSec: patch.cadenceSec ?? existing.cadenceSec,
        ...(mergedDense !== undefined ? { denseCadenceSec: mergedDense } : {}),
      })
      if (patch.targets !== undefined) {
        await assertTargetsOwned(
          patch.targets.map((t) => t.targetId),
          c,
        )
      }
      // Only the cameras the patch ADDS need re-checking — a camera already on
      // the rule was checked when it was added, and re-refusing it would make a
      // rename impossible after a camera's recording was turned off.
      if (patch.deviceIds !== undefined) {
        const known = new Set(existing.deviceIds)
        await assertCamerasRecord(
          patch.deviceIds.filter((id) => !known.has(id)),
          tl,
        )
      }
      const rule = await tl.store.update(input.ruleId, patch, clear)
      deps.logger.info('timelapse rule updated', {
        meta: {
          ruleId: rule.id,
          owner: c.userId,
          ...(clear.length > 0 ? { cleared: clear.join(',') } : {}),
        },
      })
      return { rule }
    },

    'nc.deleteTimelapseRule': async (input, caller) => {
      const c = requireCaller(caller)
      const tl = requireTimelapse()
      assertTimelapseEditable(input.ruleId, c, tl)
      await tl.store.delete(input.ruleId)
      deps.logger.info('timelapse rule deleted', {
        meta: { ruleId: input.ruleId, owner: c.userId },
      })
      return { success: true }
    },

    'nc.testTimelapseRule': async (input, caller) => {
      const c = requireCaller(caller)
      // Belt AND braces, exactly like `nc.injectTestEvent`: the action is
      // declared `auth: 'admin'` and the handler refuses a non-admin anyway.
      // A test DELIVERS to every target the rule addresses.
      if (!c.isAdmin) throw new Error('forbidden: admin required to produce a test timelapse')
      const tl = requireTimelapse()
      deps.logger.info('timelapse test requested', {
        tags: { deviceId: input.deviceId },
        meta: { by: c.userId, ruleId: input.ruleId },
      })
      const out = await tl.runNow({ ruleId: input.ruleId, deviceId: input.deviceId })
      return {
        produced: out.produced,
        ...(out.exportId !== undefined ? { exportId: out.exportId } : {}),
        ...(out.coveragePercent !== undefined ? { coveragePercent: out.coveragePercent } : {}),
        ...(out.enqueued !== undefined ? { enqueued: out.enqueued } : {}),
        ...(out.window !== null
          ? { windowStartMs: out.window.startMs, windowEndMs: out.window.endMs }
          : {}),
        ...(out.error !== undefined ? { error: out.error } : {}),
      }
    },

    'nc.setRuleTargetEnabled': async (input, caller) => {
      const c = requireCaller(caller)
      // The rule must be visible to the caller (own personal OR global), and
      // the target must be owned by the caller (admins bypass ownership).
      assertRuleVisible(input.ruleId, c)
      await assertTargetsOwned([input.targetId], c)
      await deps.ruleStore.setRuleTargetEnabled(input.ruleId, input.targetId, input.enabled)
      return { success: true }
    },

    // ── Multi-camera digest ────────────────────────────────────────

    'nc.listSummaryRules': async (_input, caller) => {
      const c = requireCaller(caller)
      const sum = requireSummary()
      const rules = c.isAdmin ? sum.store.list() : sum.store.listForOwner(c.userId)
      return {
        // Identical to `nc.listRules` and `nc.listTimelapseRules`: the caller's
        // OWN rule is editable, a global/admin one is not, and nothing is
        // read-only to an admin. It was `!c.isAdmin` while authoring was
        // admin-only, which came back locked for the owner of a rule the store
        // was already willing to let them edit.
        rules: rules.map((r) => ({ ...r, readOnly: !c.isAdmin && r.ownerUserId !== c.userId })),
        // DERIVED from the same predicate the upsert enforces, not a constant:
        // an admin authors global rules, everyone else authors personal ones,
        // and either way this hub accepts the write. See the schema's note.
        canAuthor: SUMMARY_AUTHORING_OPEN,
      }
    },

    'nc.upsertSummaryRule': async (input, caller) => {
      const c = requireCaller(caller)
      const sum = requireSummary()

      if (input.ruleId === undefined) {
        if (input.rule === undefined) throw new Error('upsertSummaryRule: rule or ruleId required')
        // A create has nothing stored to remove — a `clear` here is a caller
        // that confused the two paths, refused rather than dropped unread.
        if (input.clear !== undefined && input.clear.length > 0) {
          throw new Error('upsertSummaryRule: clear applies to an edit (ruleId) only')
        }
        const parsed = NcSummaryRuleInputSchema.parse(input.rule)
        assertSummaryBudget(parsed)
        await assertTargetsOwned(
          parsed.targets.map((t) => t.targetId),
          c,
        )
        // An ADMIN authors GLOBAL rules (no `ownerUserId`) — the convention
        // `nc.listRules` already encodes and the admin UI already relies on. A
        // user authors his own personal rule. Ownership is a server decision
        // either way; `NcSummaryStore.create` re-parses the input so it can
        // never ride in on the blob.
        const rule = await sum.store.create(parsed, c.userId, c.isAdmin ? undefined : c.userId)
        deps.logger.info('summary rule created', {
          meta: { ruleId: rule.id, owner: c.userId, devices: rule.deviceIds.join(',') },
        })
        return { rule }
      }

      const existing = assertSummaryEditable(input.ruleId, c, sum)
      if (input.patch === undefined) throw new Error('upsertSummaryRule: patch required')
      const patch = NcSummaryRulePatchSchema.parse(input.patch)
      // On the MERGED pair, never the patch alone: lowering `maxTiles` by itself
      // can invalidate a `maxAiImages` set weeks earlier, and checking the patch
      // in isolation persists that broken pair.
      assertSummaryBudget({
        maxTiles: patch.maxTiles ?? existing.maxTiles,
        maxAiImages: patch.maxAiImages ?? existing.maxAiImages,
      })
      if (patch.targets !== undefined) {
        await assertTargetsOwned(
          patch.targets.map((t) => t.targetId),
          c,
        )
      }
      const clear = input.clear ?? []
      const rule = await sum.store.update(input.ruleId, patch, clear)
      deps.logger.info('summary rule updated', {
        meta: {
          ruleId: rule.id,
          owner: c.userId,
          ...(clear.length > 0 ? { cleared: clear.join(',') } : {}),
        },
      })
      return { rule }
    },

    'nc.deleteSummaryRule': async (input, caller) => {
      const c = requireCaller(caller)
      const sum = requireSummary()
      // The SAME visibility+ownership gate the patch path takes. `store.delete`
      // is idempotent and would answer `success` for a rule the caller may not
      // touch — and a delete that reports success without deleting is the worst
      // of the three possible answers.
      assertSummaryEditable(input.ruleId, c, sum)
      await sum.store.delete(input.ruleId)
      deps.logger.info('summary rule deleted', { meta: { ruleId: input.ruleId, owner: c.userId } })
      return { success: true }
    },

    'nc.testSummaryRule': async (input, caller) => {
      const c = requireCaller(caller)
      if (!c.isAdmin) throw new Error('forbidden: admin required to produce a test summary')
      const sum = requireSummary()
      // A half-specified window is a caller ERROR, not a default: silently
      // filling the missing end with "now" would produce a digest over a range
      // nobody asked for and report it as the one they did.
      const startMs = input.windowStartMs
      const endMs = input.windowEndMs
      if ((startMs === undefined) !== (endMs === undefined)) {
        throw new Error('testSummaryRule: pass BOTH windowStartMs and windowEndMs, or neither')
      }
      if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
        throw new Error('testSummaryRule: windowEndMs must be after windowStartMs')
      }
      deps.logger.info('summary test requested', {
        meta: { by: c.userId, ruleId: input.ruleId, windowStartMs: startMs, windowEndMs: endMs },
      })
      const out = await sum.runNow({
        ruleId: input.ruleId,
        ...(startMs !== undefined && endMs !== undefined ? { window: { startMs, endMs } } : {}),
      })
      return {
        produced: out.produced,
        ...(out.tiles !== undefined ? { tiles: out.tiles } : {}),
        ...(out.cameras !== undefined ? { cameras: out.cameras } : {}),
        ...(out.matched !== undefined ? { matched: out.matched } : {}),
        ...(out.droppedStationary !== undefined
          ? { droppedStationary: out.droppedStationary }
          : {}),
        ...(out.enqueued !== undefined ? { enqueued: out.enqueued } : {}),
        ...(out.mosaicBytes !== undefined ? { mosaicBytes: out.mosaicBytes } : {}),
        ...(out.mosaicUrl !== undefined ? { mosaicUrl: out.mosaicUrl } : {}),
        ...(out.window !== null
          ? { windowStartMs: out.window.startMs, windowEndMs: out.window.endMs }
          : {}),
        ...(out.error !== undefined ? { error: out.error } : {}),
        ...(out.aiText !== undefined ? { aiText: out.aiText } : {}),
        ...(out.aiFailure !== undefined ? { aiFailure: out.aiFailure } : {}),
        ...(out.aiImages !== undefined ? { aiImages: out.aiImages } : {}),
        ...(out.skippedByAi === true ? { skippedByAi: true } : {}),
      }
    },

    // ── Calendar events ────────────────────────────────────────────

    'nc.listCalendarEventsRules': async (_input, caller) => {
      const c = requireCaller(caller)
      const ce = requireCalendarEvents()
      const rules = c.isAdmin ? ce.store.list() : ce.store.listForOwner(c.userId)
      return {
        rules: rules.map((r) => ({ ...r, readOnly: !c.isAdmin && r.ownerUserId !== c.userId })),
        canAuthor: true,
      }
    },

    'nc.upsertCalendarEventsRule': async (input, caller) => {
      const c = requireCaller(caller)
      const ce = requireCalendarEvents()
      if (input.ruleId === undefined) {
        if (input.rule === undefined) {
          throw new Error('upsertCalendarEventsRule: rule or ruleId required')
        }
        const parsed = NcCalendarEventsRuleInputSchema.parse(input.rule)
        await assertTargetsOwned(
          parsed.targets.map((t) => t.targetId),
          c,
        )
        const rule = await ce.store.create(parsed, c.userId, c.isAdmin ? undefined : c.userId)
        deps.logger.info('calendar-events rule created', {
          meta: { ruleId: rule.id, owner: c.userId },
        })
        return { rule }
      }
      assertCalendarEventsEditable(input.ruleId, c, ce)
      if (input.patch === undefined) throw new Error('upsertCalendarEventsRule: patch required')
      const patch = NcCalendarEventsRulePatchSchema.parse(input.patch)
      if (patch.targets !== undefined) {
        await assertTargetsOwned(
          patch.targets.map((t) => t.targetId),
          c,
        )
      }
      const rule = await ce.store.update(input.ruleId, patch)
      deps.logger.info('calendar-events rule updated', {
        meta: { ruleId: rule.id, owner: c.userId },
      })
      return { rule }
    },

    'nc.deleteCalendarEventsRule': async (input, caller) => {
      const c = requireCaller(caller)
      const ce = requireCalendarEvents()
      assertCalendarEventsEditable(input.ruleId, c, ce)
      await ce.store.delete(input.ruleId)
      deps.logger.info('calendar-events rule deleted', {
        meta: { ruleId: input.ruleId, owner: c.userId },
      })
      return { success: true }
    },

    // ── Text catalog (i18n Phase 2) ────────────────────────────────────
    //
    // Thin on purpose: every decision — the fallback chain, the refusal of an
    // unknown key, the live re-apply — belongs to `NcTextCatalogEditor`, which
    // is unit-tested against a real store. A handler that re-decided any of
    // them would be a second opinion nobody diffs.

    'nc.getTexts': async (input) => {
      const texts = requireTexts()
      return input.language === undefined ? texts.view() : texts.view(input.language)
    },

    'nc.setLanguage': async (input) => requireTexts().setLanguage(input.language),

    'nc.setTextOverrides': async (input) =>
      requireTexts().setOverrides(input.language, input.overrides),

    // ── Artifacts ──────────────────────────────────────────────────

    'nc.listArtifacts': async (input, caller) => {
      const c = requireCaller(caller)
      // The viewer is SERVER-derived, exactly like every other read here: an
      // `isAdmin` that could ride in on the input blob would hand any caller
      // every user's personal artefacts.
      const page = await requireArtifacts().list(input, {
        userId: c.userId,
        isAdmin: c.isAdmin,
      })
      return { artifacts: [...page.artifacts], total: page.total, hasMore: page.hasMore }
    },

    'nc.getArtifact': async (input, caller) => {
      const c = requireCaller(caller)
      const artifact = await requireArtifacts().get(input.artifactId, {
        userId: c.userId,
        isAdmin: c.isAdmin,
      })
      return { artifact }
    },

    'nc.deleteArtifact': async (input, caller) => {
      const c = requireCaller(caller)
      const removedIds = await requireArtifacts().deleteOwned(input.artifactId, {
        userId: c.userId,
        isAdmin: c.isAdmin,
      })
      // The rows are gone first, then the files. That order is the safe one:
      // a file left behind is collected by the shelf's age sweep, while a row
      // left behind is a card that opens nothing and nothing ever revisits.
      for (const id of removedIds) {
        await deps.artifactShelf?.remove(id)
      }
      return { deleted: removedIds.length > 0, removedIds: [...removedIds] }
    },
  }
}
