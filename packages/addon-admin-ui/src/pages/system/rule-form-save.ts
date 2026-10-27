/**
 * The Notification Rules editor's SAVE: form → `NcRuleInput` and the `clear`
 * list beside it — split out of `notification-rules.helpers.ts` (review M7).
 * Pure.
 */

import type {
  NC_RULE_RETIRED_CLEAR_KEYS,
  NcConditionDescriptor,
  NcConditions,
  NcDelivery,
  NcMediaPolicy,
  NcRule,
  NcRuleClearableKey,
  NcRuleInput,
  NcRuleKind,
  NcSchedule,
  NcSystemEventFamily,
} from '@camstack/types'
import {
  conditionVisibleForKind,
  NC_CONDITION_CATALOG,
  ruleKindOf,
  ruleKindSpec,
  ruleTriggerZoneIds,
  subjectHasPath,
  systemFamilyOfKind,
} from '@camstack/types'
import { pruneSystemEventForSave } from './notification-system-events'
import { formToActions } from './notification-rule-actions'
import { conditionSupportedByRule } from './rule-form-parsers'
import {
  formScopedConditions,
  groupingIsSent,
  isStateSummaryForm,
  type NcRuleFormState,
  systemEventDeliveryForSave,
  verdictApplies,
} from './rule-form-state'

/** True when the descriptor applies to the rule's current trigger. */
export function conditionApplies(descriptor: NcConditionDescriptor, delivery: NcDelivery): boolean {
  return descriptor.appliesTo.includes(delivery)
}

/**
 * Condition keys with an explicit "no restriction" member in their value set,
 * which is omitted from the wire rather than authored.
 *
 * ONLY `source` has one: `any` matches every source, which is exactly what
 * absent means. `crossing` deliberately does NOT — absent means `enter` (exits
 * excluded) while its `any` INCLUDES exits, so treating the two strings alike
 * would save "entered or left" as "entering" and the operator would never see
 * the exits they asked for. This map is why emptiness needs the key.
 */
const UNRESTRICTED_VALUE_BY_KEY: Readonly<Record<string, string>> = { source: 'any' }

/**
 * Is an authored condition value effectively unset (→ omit from the wire)?
 *  - `undefined` / empty array → unset
 *  - `zoneSelection` with no ids → unset
 *  - `plateMatcher` with no values → unset
 *  - the key's unrestricted member, if it has one → unset
 *  - a finite number → SET (0 is a legitimate authored threshold)
 *
 * Takes the KEY as well as the value: `'any'` means "no restriction" for
 * `source` and something quite different for `crossing`, so no value-only rule
 * can be correct for both.
 */
export function isConditionValueEmpty(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') {
    return value.length === 0 || UNRESTRICTED_VALUE_BY_KEY[key] === value
  }
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'object') {
    if ('ids' in value) {
      const ids = value.ids
      return !Array.isArray(ids) || ids.length === 0
    }
    if ('values' in value) {
      const values = value.values
      return !Array.isArray(values) || values.length === 0
    }
    return false
  }
  return false
}

/**
 * Descriptors this build can author against a hub that does not serve them yet.
 *
 * The catalog is authoritative about what the SERVER evaluates, and this list
 * never contradicts it — a served descriptor always wins (see
 * {@link withLocalConditionDescriptors}). It exists because the two halves of a
 * condition ship on different vehicles: the ENGINE arrives with an addon deploy
 * and the DESCRIPTOR only with the next release train, so between the two an
 * operator has a hub that matches on sound and an editor that has never heard
 * of it — and `buildConditions`, which prunes to the served catalog, would
 * quietly strip `conditions.audio` from the live rule on the next save.
 *
 * Same rule as the served `options` (`descriptorOptions`): absent means "use
 * your own list", never "there is nothing here".
 */
const LOCAL_CONDITION_DESCRIPTORS: readonly NcConditionDescriptor[] = NC_CONDITION_CATALOG.filter(
  (d) => d.id === 'audio',
)

/**
 * The served catalog, plus any locally-known descriptor it does not carry.
 *
 * An EMPTY catalog is left empty: that is "the hub has not answered", which the
 * editor already reports, and injecting one lone condition there would render
 * an editor offering sound and nothing else.
 */
export function withLocalConditionDescriptors(
  served: readonly NcConditionDescriptor[],
): readonly NcConditionDescriptor[] {
  if (served.length === 0) return served
  const known = new Set(served.map((d) => d.id))
  const missing = LOCAL_CONDITION_DESCRIPTORS.filter((d) => !known.has(d.id))
  return missing.length === 0 ? served : [...served, ...missing]
}

/**
 * Prune the authored conditions to the wire shape: keep only keys the operator
 * touched (non-empty) AND that are VISIBLE for this rule's trigger **and kind**.
 *
 * Two dimensions, not one. `appliesTo` (the server's answer) drops a condition
 * the trigger does not evaluate; the KIND (`@camstack/types` → `rule-kinds.ts`) drops
 * one the sub-type cannot satisfy — the three device-event fields an occupancy
 * edge fails closed on, the detection fields a sound window carries none of.
 * Both drops are the same act and for the same reason: writing a condition the
 * engine refuses leaves a rule enabled, in the list and permanently silent, and
 * the editor SAYS which keys it is about to drop (`droppedConditions`) rather
 * than doing it quietly.
 */
export function buildConditions(
  conditions: NcConditions,
  delivery: NcDelivery,
  catalog: readonly NcConditionDescriptor[],
  kind: NcRuleKind = ruleKindOf({ delivery, conditions }),
): NcConditions {
  // With no catalog we cannot judge applicability, so keep every touched key
  // (defensive — the editor renders nothing to author without a catalog anyway).
  const applicableIds =
    catalog.length === 0
      ? null
      : new Set(
          catalog
            .filter((d) => d.id !== 'schedule' && conditionVisibleForKind(d, delivery, kind))
            .map((d) => d.id),
        )
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(conditions)) {
    if (applicableIds !== null && !applicableIds.has(key)) continue
    if (!conditionSupportedByRule(key, conditions)) continue
    if (isConditionValueEmpty(key, value)) continue
    out[key] = value
  }
  // Preserve the schema-inferred shape without an `as` cast at the call site.
  return out as NcConditions
}

/** The pruned `systemEvent` of a family rule, as a spreadable patch. */
function systemEventForSave(
  family: NcSystemEventFamily | undefined,
  conditions: NcConditions,
): Pick<NcConditions, 'systemEvent'> {
  if (family === undefined) return {}
  const pruned = pruneSystemEventForSave(family, conditions.systemEvent)
  return pruned !== undefined ? { systemEvent: pruned } : {}
}

/** True when the schedule carries at least one window (else it is omitted). */
export function scheduleHasWindows(schedule: NcSchedule | undefined): boolean {
  return schedule !== undefined && schedule.windows.length > 0
}

/**
 * Fields the form does not author, from the edited OR duplicated rule.
 *
 * `throttle` is required (the P1 default fills a brand-new rule); `confirm`
 * is omitted rather than carried as `undefined`, because the caller spreads it
 * back in only when present.
 *
 * `media` carries the {@link NcPreservedMedia} keys the viewer authors and
 * this form does not. The hub REPLACES `media` whole, so a `media` rebuilt
 * without them reverted the phone's choice on every admin save (final review
 * I5).
 */
export type NcRulePreserved = Pick<NcRule, 'confirm'> & {
  readonly media?: NcPreservedMedia
}

/**
 * The `media` keys authored ONLY by the viewer — the whole list, checked
 * against `NcMediaPolicySchema` on 2026-09-25: the clip window
 * (`clipPreRollSec` / `clipPostRollSec`). Every other media key this form
 * authors itself — `linkedCameras` included since ADR 0632's editor option
 * (`mediaLinkedCameras`): carrying it here as well would let a stale stored
 * value override the operator setting it back to the default.
 */
export type NcPreservedMedia = Pick<NcMediaPolicy, 'clipPreRollSec' | 'clipPostRollSec'>

function preservedMedia(media: NcMediaPolicy): NcPreservedMedia | undefined {
  const kept: NcPreservedMedia = {
    ...(media.clipPreRollSec !== undefined ? { clipPreRollSec: media.clipPreRollSec } : {}),
    ...(media.clipPostRollSec !== undefined ? { clipPostRollSec: media.clipPostRollSec } : {}),
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/** Pull the fields `NcRulePreserved` carries off a persisted rule, for an
 *  edit or a Duplicate seed alike. */
export function rulePreservedFields(rule: NcRule): NcRulePreserved {
  const media = preservedMedia(rule.media)
  return {
    ...(rule.confirm !== undefined ? { confirm: rule.confirm } : {}),
    ...(media !== undefined ? { media } : {}),
  }
}

/**
 * Assemble the wire `NcRuleInput` from the form state.
 *
 * Conditions come from the form (pruned to touched + applicable keys), the
 * schedule is emitted only when it has windows and applies to the trigger, and
 * per-target `params` are re-attached from the preserved map (L2). The
 * cooldown is authored; the `throttle` scope/granularity and `confirm`
 * are not, so they are preserved via `preserve` (falling back
 * to the P1 default throttle for a brand-new rule). When both template fields
 * are blank the `template` key is OMITTED entirely.
 */
export function buildRuleInput(
  form: NcRuleFormState,
  preserve?: NcRulePreserved,
  catalog: readonly NcConditionDescriptor[] = [],
): NcRuleInput {
  const title = form.templateTitle.trim()
  const body = form.templateBody.trim()
  const template =
    title.length > 0 || body.length > 0
      ? {
          ...(title.length > 0 ? { title } : {}),
          ...(body.length > 0 ? { body } : {}),
        }
      : undefined

  const actions = formToActions(form.actions)
  const kind = ruleKindOf(form)
  const spec = ruleKindSpec(kind)
  const family = systemFamilyOfKind(kind)

  const scheduleApplies =
    catalog.length === 0
      ? true
      : catalog.some((d) => d.id === 'schedule' && conditionApplies(d, form.delivery))
  // A SUMMARY rule (D647) is sent on its summary schedule; the hub refuses a
  // second, active-hours one beside it, so it is left out — and `clear` then
  // removes a stored one.
  const summary = isStateSummaryForm(form)
  const schedule =
    !summary && scheduleApplies && scheduleHasWindows(form.schedule) ? form.schedule : undefined

  // The Devices tab is folded back into `conditions.devices` — but only where
  // the catalog says the condition is evaluated. `system-event` does not
  // evaluate it (it narrows by `systemEvent.deviceIds` instead), and writing a
  // `devices` key the engine ignores is a filter the operator can see and the
  // rule does not have. Same shape as `scheduleApplies` above.
  const devicesApply =
    catalog.length === 0
      ? true
      : catalog.some((d) => d.id === 'devices' && conditionApplies(d, form.delivery))
  // Same gate for the exclusion (D641): a hub that does not serve it would
  // strip it, and a system rule has its own (`systemEvent.excludeDeviceIds`).
  const devicesExcludeApply =
    catalog.length === 0
      ? true
      : catalog.some((d) => d.id === 'devicesExclude' && conditionApplies(d, form.delivery))
  // Both scope axes projected (D641): ONLY the active mode's list is written.
  // The device lists are then re-gated above rather than by `buildConditions`,
  // because they are authored on their own tab.
  const { devices, devicesExclude, ...scoped } = formScopedConditions(form)
  const conditions = buildConditions(scoped, form.delivery, catalog, kind)

  return {
    name: form.name.trim(),
    enabled: form.enabled,
    delivery: form.delivery,
    // The device scope is authored on its own tab and folded back in here. An
    // empty list is no restriction, so the key is OMITTED rather than written
    // as `[]` — an empty array would be a condition that matches nothing.
    conditions: {
      ...conditions,
      ...(devicesApply && devices !== undefined ? { devices } : {}),
      ...(devicesExcludeApply && devicesExclude !== undefined ? { devicesExclude } : {}),
      // One family (D637): a filter the family does not carry, or that its
      // kinds no longer use, is dropped here — the hub refuses the first, and
      // the editor no longer shows the second.
      ...systemEventForSave(family, form.conditions),
    },
    ...(schedule ? { schedule } : {}),
    ...systemEventDeliveryForSave(form),
    targets: form.targetIds.map((targetId) => {
      const params = form.targetParams[targetId]
      return params && Object.keys(params).length > 0 ? { targetId, params } : { targetId }
    }),
    ...(form.targetUsers.length > 0 ? { targetUsers: [...form.targetUsers] } : {}),
    // A subject that owns NO FRAME gets `image: 'none'`: a system event freezes
    // no media owner, and the editor SAYS so rather than showing controls that
    // would do nothing.
    //
    // ONE picture mode (D897) — the hub refuses a mode the kind cannot honour
    // (`imageModesForKind`) and a `showTriggerZone` on a rule whose trigger is
    // not a zone, so neither is written: the flag only for a zone rule and a
    // scene mode.
    media: !spec.carriesMedia
      ? { image: 'none' }
      : {
          image: form.mediaImage,
          ...(form.mediaShowTriggerZone &&
          form.mediaImage !== 'crop' &&
          form.mediaImage !== 'none' &&
          ruleTriggerZoneIds(conditions).length > 0
            ? { showTriggerZone: true }
            : {}),
          // D903: the subject's path — any picture, a kind with a tracked subject.
          ...(form.mediaShowSubjectPath && form.mediaImage !== 'none' && subjectHasPath(kind)
            ? { showSubjectPath: true }
            : {}),
          ...(form.mediaGif ? { gif: true } : {}),
          ...(form.mediaClip ? { clip: true } : {}),
          ...(form.mediaProfile !== undefined ? { profile: form.mediaProfile } : {}),
          ...(form.mediaClipSpeed !== undefined ? { clipSpeed: form.mediaClipSpeed } : {}),
          // Sensor rules only (ADR 0632): only a sensor has linked cameras
          // to photograph, and a key no other kind reads is a knob the rule
          // does not have. Absent = the hub's default, a mosaic.
          ...(kind === 'sensor' &&
          form.mediaImage !== 'none' &&
          form.mediaLinkedCameras !== undefined
            ? { linkedCameras: form.mediaLinkedCameras }
            : {}),
          // The clip window only while footage is cut, as the viewer writes it:
          // a roll with no gif or clip is a knob nothing reads.
          ...((form.mediaGif || form.mediaClip) && preserve?.media?.clipPreRollSec !== undefined
            ? { clipPreRollSec: preserve.media.clipPreRollSec }
            : {}),
          ...((form.mediaGif || form.mediaClip) && preserve?.media?.clipPostRollSec !== undefined
            ? { clipPostRollSec: preserve.media.clipPostRollSec }
            : {}),
        },
    // All three throttle keys are AUTHORED by the form (D654). `granularity`
    // is omitted when the form holds none rather than written as `undefined`
    // or an explicit value, because a rule that never chose must stay one
    // that never chose. (It was once dropped here on every save — a
    // `per-class` rule silently reverted to `shared`; the round-trip spec
    // pins it.) Since 2026-10-01 (D36's dated note) absent reads as
    // `per-class`, not `shared` — the engine's default flipped, not this
    // write-nothing-when-untouched rule.
    throttle: {
      cooldownSec: form.cooldownSec,
      scope: form.cooldownScope,
      ...(form.cooldownGranularity !== undefined ? { granularity: form.cooldownGranularity } : {}),
    },
    priority: form.priority,
    ...(template ? { template } : {}),
    // Only written when granted: absence is the default-off, and an explicit
    // `false` on every rule would make the flag look authored when it is not.
    ...(form.snoozeAllowGlobal ? { snoozeAllowGlobal: true } : {}),
    // "Immediate, grouped" (D692): written only while the rule can group, so a
    // value left on the form by a trigger the operator moved away from never
    // reaches the hub's save guard. `buildRuleClears` removes a stored one.
    ...(groupingIsSent(form) ? { groupingSec: form.groupingSec } : {}),
    // EMITTED when the operator chose a list, INCLUDING an empty one — `[]` is
    // "no snooze buttons on this rule" and omitting it would hand the rule
    // back the hub's defaults on every save. Absent stays absent.
    ...(form.snoozeOptions !== undefined ? { snoozeOptions: [...form.snoozeOptions] } : {}),
    // Written only while the rule reports a track, and as an explicit boolean
    // either way: `false` is what switches a stored `true` off.
    ...(form.askVerdict !== undefined && verdictApplies(form)
      ? { askVerdict: form.askVerdict }
      : {}),
    // Not authored here, carried verbatim: on an edit the merge would keep
    // them anyway, but a DUPLICATE is a create and would lose them.
    ...(preserve?.confirm !== undefined ? { confirm: preserve.confirm } : {}),
    // OMITTED when empty, never `{}` — an empty object is not a meaningful
    // actions value. An edit that empties the actions removes them through
    // `clear`: `buildRuleClears` names `actions` whenever this key is absent.
    ...(actions !== undefined ? { actions } : {}),
  }
}

/**
 * A clearable key this editor can author: every one EXCEPT the retired ones (D692), which are
 * no property of the rule input and which this editor never sends.
 */
export type NcAuthoredClearKey = Exclude<
  NcRuleClearableKey,
  (typeof NC_RULE_RETIRED_CLEAR_KEYS)[number]
>

/**
 * The optional fields this editor AUTHORS and the form leaves empty.
 *
 * Sent as `clear` beside the patch: the hub merges a patch over the stored
 * rule, so an omitted key survives the save — the operator empties the
 * template, saves, reopens, and finds it back. Only authored keys: a field the
 * form never shows (`confirm`) is never cleared by it.
 */
export function buildRuleClears(
  form: NcRuleFormState,
  catalog: readonly NcConditionDescriptor[],
): NcAuthoredClearKey[] {
  const input = buildRuleInput(form, undefined, catalog)
  const authored: readonly NcAuthoredClearKey[] = [
    'template',
    'schedule',
    'targetUsers',
    'snoozeOptions',
    'snoozeAllowGlobal',
    'groupingSec',
    'actions',
  ]
  return authored.filter((key) => input[key] === undefined)
}
