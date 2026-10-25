/**
 * Catalog-driven CONDITION editor for a notification rule (slice D2 / Phase 3).
 *
 * Renders fields dynamically from `getConditionCatalog` — grouped sections,
 * one widget per `valueType`, writing to the `NcConditions` key named by
 * `descriptor.id`. Only the values the operator touches are authored — the pure
 * `buildConditions` helper prunes empties and inapplicable keys at save time, so
 * an untouched condition stays unrestricted (and a previously-authored one is
 * preserved on edit).
 *
 * WHICH CONDITIONS ARE OFFERED AT ALL is `@camstack/types` → `rule-kinds.ts`, and the
 * answer is `delivery` × `kind`. A condition that does not apply is NOT
 * rendered: it used to be drawn greyed-out with a "not for this trigger" badge,
 * which put a dozen dead rows above the two fields an occupancy rule actually
 * has and three fields that rule can never satisfy in among them (the operator's
 * report, 2026-08-14).
 *
 * WHERE each is drawn is `notification-condition-layout.ts` (D690): every
 * condition always visible, and each include/exclude pair — classes, zones,
 * known faces — as ONE scope field, like the labels. The detection source and
 * the zone-crossing direction are drawn by {@link RuleConditionsAdvancedFields}
 * instead, mounted in the rule-level Advanced tab (2026-10-01 — D690 had put
 * them in a second "Advanced" group inside THIS tab, which the operator asked
 * to be merged into the one Advanced tab a rule already has).
 *
 * WHAT IS AND IS NOT DERIVED FROM THE CATALOG
 * ───────────────────────────────────────────
 * Derived: which conditions exist, their order and grouping, their labels and
 * descriptions, which trigger each applies to, which widget renders it, and
 * WHICH FIELD it writes to. Adding a condition of an existing `valueType`
 * server-side costs one key-table line here and nothing else.
 *
 * Not derived, because the descriptor has no field for it: the option lists
 * behind `sourceSelect` / `crossingSelect` / `packagePhase` / the occupancy op,
 * the numeric bounds of `number` and `number01`, and which of the `stringList`
 * conditions is backed by the face gallery / the per-device event-kind
 * catalogue rather than the shared taxonomy. Those are mirrored locally and are
 * the catalog's open gaps — see the package report rather than adding a widget
 * for the next one.
 *
 * A descriptor this editor cannot bind renders an explicit note and preserves
 * whatever the rule already carries. It must never fall through to a
 * neighbouring field: an operator cannot see that a rule was written into the
 * wrong condition, and a wrong rule that looks authored is worse than a missing
 * widget.
 *
 * The `schedule` group maps to the rule-level `NcSchedule` (weekly windows),
 * not a `conditions` field, so it is threaded through its own callback.
 */

import type {
  NcConditionDescriptor,
  NcConditions,
  NcDelivery,
  NcRuleAction,
  NcRuleActions,
  NcRuleKind,
  NcSchedule,
  NcTaxonomy,
  TaxonomyOption,
} from '@camstack/types'
import {
  conditionVisibleForKind,
  NC_SENSOR_TRANSITION_NEVER_FIRES_WARNING,
  pickerForCondition,
  ruleKindOf,
  sensorTransitionNeverFires,
  systemFamilyOfKind,
} from '@camstack/types'
import { Select } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { RuleCameraOption } from './notification-condition-fields'
import type { DeviceFleetView } from './device-fleet-view'
import {
  isAudioKey,
  isCrossingSelectKey,
  isDeviceIdListKey,
  isDeviceStateKey,
  isNumber01Key,
  isNumberKey,
  isOccupancyKey,
  isPackagePhaseKey,
  isPlateMatcherKey,
  isSceneKey,
  isSensorTransitionKey,
  isSourceSelectKey,
  isStringListKey,
  isSystemEventKey,
  readNumber,
  readStringList,
} from './notification-condition-fields'
import {
  AudioField,
  CrossingSelectField,
  DeviceListField,
  DeviceStateField,
  EventTokensField,
  type GateableDevice,
  type GateableScene,
  HINT_CLASS,
  LABEL_CLASS,
  NumberField,
  OccupancyField,
  PlateMatcherField,
  SceneConditionField,
  TagListField,
  TaxonomyPickerField,
} from './notification-condition-widgets'
import { layoutConditionGroups } from './notification-condition-layout'
import { IdentityScopeField, LabelScopeField, ZoneScopeField } from './notification-scope-fields'
import {
  conditionSupportedByRule,
  descriptorOptions,
  NC_PACKAGE_PHASE_OPTIONS,
  NC_SENSOR_TRANSITION_OPTIONS,
  NC_SOURCE_OPTIONS,
  parseSensorTransition,
} from './notification-rules.helpers'
import { ClassScopeField } from './notification-class-scope-field'
import { ScheduleField } from './notification-schedule-field'
import { MixedSystemEventNote, SystemEventField } from './notification-system-event-field'
import type { RuleDeviceOption } from './rule-device-filter'
import type { RuleScopeDraft } from './rule-scope-model'

export type { RuleCameraOption } from './notification-condition-fields'

/** Sets a condition field; `undefined` deletes the key. */
export type ConditionFieldSetter = <K extends keyof NcConditions>(
  key: K,
  value: NcConditions[K],
) => void

interface RuleConditionsEditorProps {
  readonly catalog: readonly NcConditionDescriptor[]
  /** Picker vocabulary. Absent on a hub that predates it → free-text inputs. */
  readonly taxonomy: NcTaxonomy | undefined
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
  /**
   * The detection-class scope (D641): the `classes` and `classesExclude`
   * catalog rows render as ONE field — a pre-selector over one class picker —
   * and write this draft, never `conditions` (the form projects it at save).
   */
  readonly classScope: RuleScopeDraft<string>
  readonly onClassScopeChange: (next: RuleScopeDraft<string>) => void
  /** The rule's actions as authored on the Actions tab — one of the two things
   *  that make a rule belong to the alarm (D630), which the "Notify when" field
   *  needs to warn about a rule that can never fire. */
  readonly actions?: NcRuleActions
  /** Resolve shared-sequence steps for alarm-membership (D630). */
  readonly sequenceActionsOf?: (sequenceId: string) => readonly NcRuleAction[] | undefined
  /** The rule's conditions as OPENED (the saved rule, or a new rule's seed):
   *  a device picker whose empty value means "all" warns from it, so the
   *  warning survives the picker's remount on a tab switch. */
  readonly savedConditions: NcConditions | undefined
  readonly schedule: NcSchedule | undefined
  /**
   * The devices the rule is scoped to, as authored on the DEVICES TAB.
   *
   * Threaded in rather than read from `conditions.devices`: the device scope
   * moved out of `conditions` into its own tab (2026-08-05) and is only folded
   * back at save time, so every picker that resolves a device's zones or event
   * kinds from `conditions.devices` saw an EMPTY list while a new rule was being
   * authored — the zone select of an occupancy rule offered "whole frame" and
   * nothing else, and only an already-saved rule ever showed its zones.
   */
  readonly deviceIds: readonly number[]
  /**
   * The cameras whose zones the zone field lists (`zoneCameraIds`, R14): every
   * camera the rule covers, in every device-scope mode. Absent → `deviceIds`.
   */
  readonly zoneCameraIds?: readonly number[]
  readonly cameras: readonly RuleCameraOption[]
  /** The whole fleet, and whether it ANSWERED — the device pickers claim an id
   *  removed, or the hub camera-less, only from an answered fleet (D315). */
  readonly fleet: DeviceFleetView
  /** EVERY device of the fleet (type, room, container) — what a system rule's
   *  include/exclude pickers list: a battery, a vacuum or a plug is not a
   *  camera. Absent → the camera list (D636). */
  readonly allDevices?: readonly RuleDeviceOption[]
  /** Devices the `deviceState` gate can read, with each one's vocabulary.
   *  Empty on a hub that cannot answer — the condition then offers no device
   *  rather than offering one that could never match. */
  readonly gateable: readonly GateableDevice[]
  /** Every scene on every camera, with its live state — the `scene` gate's
   *  picker source. Empty on a hub whose scene provider cannot answer, which
   *  renders as "no scenes yet" rather than as an empty select. */
  readonly gateableScenes: readonly GateableScene[]
  readonly onConditionsChange: (next: NcConditions) => void
  readonly onScheduleChange: (next: NcSchedule | undefined) => void
  /** A scheduled STATE SUMMARY system rule (D647, D906). */
  readonly summary?: boolean
}

export function RuleConditionsEditor({
  catalog,
  taxonomy,
  delivery,
  conditions,
  classScope,
  onClassScopeChange,
  actions,
  sequenceActionsOf,
  savedConditions,
  schedule,
  deviceIds,
  zoneCameraIds,
  cameras,
  fleet,
  allDevices,
  gateable,
  gateableScenes,
  onConditionsChange,
  onScheduleChange,
  summary,
}: RuleConditionsEditorProps) {
  const { t } = useTranslation()
  const setField: ConditionFieldSetter = (key, value) => {
    const next: NcConditions = { ...conditions }
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
    onConditionsChange(next)
  }

  // WHICH conditions this rule has AT ALL — the kind, not only the trigger: a
  // condition a rule cannot use is not a disabled control, it is not a control.
  const kind = ruleKindOf({ delivery, conditions })
  // …and the one condition whose offer depends on another (D640): "Notify
  // when" appears once every chosen sensor kind raises and clears.
  const visible = useMemo(
    () =>
      catalog.filter(
        (d) =>
          conditionVisibleForKind(d, delivery, kind) && conditionSupportedByRule(d.id, conditions),
      ),
    [catalog, delivery, kind, conditions],
  )
  // Where each is drawn (D690): everything visible, one Advanced section, the
  // include/exclude pairs as one field each — `notification-condition-layout.ts`.
  const groups = useMemo(() => layoutConditionGroups(visible), [visible])
  const served = (id: string): boolean => visible.some((d) => d.id === id)

  const renderScopeField = (descriptor: NcConditionDescriptor): React.ReactNode => {
    if (CLASS_SCOPE_IDS.has(descriptor.id)) {
      return (
        <ClassScopeField
          taxonomy={taxonomy}
          scope={classScope}
          onChange={onClassScopeChange}
          exceptOffered={served('classesExclude')}
        />
      )
    }
    if (ZONE_SCOPE_IDS.has(descriptor.id)) {
      return (
        <ZoneScopeField
          conditions={conditions}
          onConditionsChange={onConditionsChange}
          exceptOffered={served('zonesExclude')}
          cameraIds={zoneCameraIds ?? deviceIds}
          cameras={cameras}
        />
      )
    }
    if (IDENTITY_SCOPE_IDS.has(descriptor.id)) {
      return (
        <IdentityScopeField
          conditions={conditions}
          onConditionsChange={onConditionsChange}
          exceptOffered={served('identitiesExclude')}
        />
      )
    }
    if (descriptor.id === 'labelEquals') {
      return <LabelScopeField conditions={conditions} onConditionsChange={onConditionsChange} />
    }
    return null
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.id} className="space-y-2.5" data-testid={`condition-group-${group.id}`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
            {t(`notificationRules.groups.${group.id}`, group.label)}
          </div>
          {group.descriptors.map((descriptor) => {
            const scopeField = renderScopeField(descriptor)
            return (
              <div key={descriptor.id} data-testid={`condition-${descriptor.id}`}>
                <label className={LABEL_CLASS}>{conditionLabel(descriptor, t)}</label>
                {scopeField ?? (
                  <ConditionWidget
                    descriptor={descriptor}
                    kind={kind}
                    summary={summary === true}
                    taxonomy={taxonomy}
                    conditions={conditions}
                    actions={actions}
                    sequenceActionsOf={sequenceActionsOf}
                    savedConditions={savedConditions}
                    schedule={schedule}
                    deviceIds={deviceIds}
                    cameras={cameras}
                    fleet={fleet}
                    {...(allDevices !== undefined ? { allDevices } : {})}
                    gateable={gateable}
                    gateableScenes={gateableScenes}
                    onFieldChange={setField}
                    onScheduleChange={onScheduleChange}
                  />
                )}
                {conditionHint(descriptor, t) !== undefined && (
                  <p className={HINT_CLASS}>{conditionHint(descriptor, t)}</p>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** The class scope's catalog rows (D641): wire ids unchanged, ONE field here. */
const CLASS_SCOPE_IDS: ReadonlySet<string> = new Set(['classes', 'classesExclude'])
/** The zone scope's rows (D690): `zones` + `zonesExclude`, ONE field. */
const ZONE_SCOPE_IDS: ReadonlySet<string> = new Set(['zones', 'zonesExclude'])
/** The known-face scope's rows (D690): `identities` + `identitiesExclude`, ONE field. */
const IDENTITY_SCOPE_IDS: ReadonlySet<string> = new Set(['identities', 'identitiesExclude'])

/**
 * The label a condition is drawn under. A merged scope field is named for the
 * axis rather than for whichever of its two rows anchored it, and the two the
 * editor re-words (D690) are translated; everything else is the catalog's.
 */
function conditionLabel(descriptor: NcConditionDescriptor, t: TFunction): string {
  if (CLASS_SCOPE_IDS.has(descriptor.id))
    return t('notificationRules.labels.classes', 'Object classes')
  if (ZONE_SCOPE_IDS.has(descriptor.id)) return t('notificationRules.labels.zones', 'Zones')
  if (IDENTITY_SCOPE_IDS.has(descriptor.id))
    return t('notificationRules.labels.faces', 'Known faces')
  if (descriptor.id === 'labelEquals') return t('notificationRules.labels.labels', 'Labels')
  if (descriptor.id === 'crossing') return t('notificationRules.labels.crossing', 'Zone crossing')
  if (descriptor.id === 'source') return t('notificationRules.labels.source', 'Detection source')
  return descriptor.label
}

/**
 * The one line under a condition. The fields D690 re-drew carry their own
 * (or none): the crossing select has its line inside it, a scope field says
 * what it does in its modes, and the scene gate's explanation lives in the
 * Scenes documentation (R10). Everything else keeps the catalog's description.
 */
function conditionHint(descriptor: NcConditionDescriptor, t: TFunction): string | undefined {
  if (OWN_HINT_IDS.has(descriptor.id)) return undefined
  if (descriptor.id === 'scene') {
    return t('notificationRules.scene.hint', 'Only fire while a scene is matched or diverged.')
  }
  return descriptor.description
}

const OWN_HINT_IDS: ReadonlySet<string> = new Set([
  ...CLASS_SCOPE_IDS,
  ...ZONE_SCOPE_IDS,
  ...IDENTITY_SCOPE_IDS,
  'labelEquals',
  'crossing',
])

interface ConditionWidgetProps {
  readonly descriptor: NcConditionDescriptor
  /** Picker vocabulary for the list conditions that have one. */
  readonly taxonomy: NcTaxonomy | undefined
  readonly conditions: NcConditions
  /** See `RuleConditionsEditorProps.actions`. */
  readonly actions?: NcRuleActions
  readonly sequenceActionsOf?: (sequenceId: string) => readonly NcRuleAction[] | undefined
  /** The rule's conditions as OPENED (the saved rule, or a new rule's seed):
   *  a device picker whose empty value means "all" warns from it, so the
   *  warning survives the picker's remount on a tab switch. */
  readonly savedConditions: NcConditions | undefined
  readonly schedule: NcSchedule | undefined
  /** The Devices tab's selection — see `RuleConditionsEditorProps.deviceIds`. */
  readonly deviceIds: readonly number[]
  readonly cameras: readonly RuleCameraOption[]
  /** The whole fleet, and whether it ANSWERED — the device pickers claim an id
   *  removed, or the hub camera-less, only from an answered fleet (D315). */
  readonly fleet: DeviceFleetView
  /** EVERY device of the fleet (type, room, container) — what a system rule's
   *  include/exclude pickers list: a battery, a vacuum or a plug is not a
   *  camera. Absent → the camera list (D636). */
  readonly allDevices?: readonly RuleDeviceOption[]
  /** Devices the `deviceState` gate can read, with each one's vocabulary. */
  readonly gateable: readonly GateableDevice[]
  /** Scenes the `scene` gate can read, with each one's live state. */
  readonly gateableScenes: readonly GateableScene[]
  readonly onFieldChange: ConditionFieldSetter
  readonly onScheduleChange: (next: NcSchedule | undefined) => void
  /** The rule's kind — a system rule's family picks the system-event field. */
  readonly kind: NcRuleKind
  /** A scheduled STATE SUMMARY system rule (D647, D906). */
  readonly summary?: boolean
}

/**
 * The per-`valueType` widget switch — mirrors the config-form-field idiom.
 *
 * Every branch narrows `descriptor.id` to the keys its value type can hold
 * before writing, so the catalog decides the target field. An unbindable id
 * (or an unknown `valueType`) falls through to {@link UnboundConditionNote}.
 */
function ConditionWidget({
  descriptor,
  kind,
  taxonomy,
  conditions,
  actions,
  sequenceActionsOf,
  savedConditions,
  schedule,
  deviceIds,
  cameras,
  fleet,
  allDevices,
  gateable,
  gateableScenes,
  onFieldChange,
  onScheduleChange,
  summary,
}: ConditionWidgetProps) {
  const { t } = useTranslation()
  switch (descriptor.valueType) {
    case 'deviceIdList': {
      if (!isDeviceIdListKey(descriptor.id)) break
      const key = descriptor.id
      const value = conditions[key] ?? []
      return (
        <DeviceListField
          cameras={cameras}
          fleet={fleet}
          emptyMeansAll
          savedHadDevices={(savedConditions?.[key]?.length ?? 0) > 0}
          value={value}
          onChange={(v) => onFieldChange(key, v.length > 0 ? v : undefined)}
        />
      )
    }
    case 'stringList': {
      if (!isStringListKey(descriptor.id)) break
      const key = descriptor.id
      const onChange = (v: string[]): void => onFieldChange(key, v.length > 0 ? v : undefined)
      // Classes, faces and labels never reach here — they are scope fields
      // (D641, D690). Event tokens come from the per-device kind list: the
      // descriptor carries no vocabulary hint, so this mapping is local —
      // reported as a catalog gap rather than hidden here.
      if (key === 'eventTypeTokens') {
        return (
          <EventTokensField
            deviceIds={deviceIds}
            value={readStringList(conditions, key)}
            onChange={onChange}
          />
        )
      }
      const picker = pickerForCondition(key, taxonomy)
      // A condition WITH a vocabulary gets the grouped picker; one without
      // keeps free text. Both keep a free-text escape hatch for values the
      // taxonomy does not know.
      return picker === null ? (
        <TagListField
          value={readStringList(conditions, key)}
          placeholder={t('system.notificationRuleConditions.addValue', 'Add value…')}
          onChange={onChange}
        />
      ) : (
        <TaxonomyPickerField
          picker={picker}
          value={readStringList(conditions, key)}
          onChange={onChange}
        />
      )
    }
    case 'number01': {
      if (!isNumber01Key(descriptor.id)) break
      const key = descriptor.id
      return (
        <NumberField
          value={readNumber(conditions, key)}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => onFieldChange(key, v)}
        />
      )
    }
    case 'number': {
      if (!isNumberKey(descriptor.id)) break
      const key = descriptor.id
      return (
        <NumberField
          value={readNumber(conditions, key)}
          min={0}
          step={1}
          onChange={(v) => onFieldChange(key, v)}
        />
      )
    }
    case 'sourceSelect': {
      if (!isSourceSelectKey(descriptor.id)) break
      const key = descriptor.id
      return sourceFieldNode(descriptor, conditions[key], (v) => onFieldChange(key, v))
    }
    case 'systemEvent': {
      if (!isSystemEventKey(descriptor.id)) break
      const key = descriptor.id
      // ONE family, or read-only (D637). A `mixed` rule is listed and never
      // opened for edit (the list's job); if one reaches this dialog anyway,
      // nothing here can write to its condition.
      const family = systemFamilyOfKind(kind)
      if (family === undefined) return <MixedSystemEventNote value={conditions[key]} />
      return (
        <SystemEventField
          family={family}
          value={conditions[key]}
          cameras={cameras}
          fleet={fleet}
          {...(allDevices !== undefined ? { allDevices } : {})}
          savedHadDevices={(savedConditions?.[key]?.deviceIds?.length ?? 0) > 0}
          onChange={(v) => onFieldChange(key, v)}
          summary={summary === true}
        />
      )
    }
    case 'deviceState': {
      if (!isDeviceStateKey(descriptor.id)) break
      return (
        <DeviceStateField
          gateable={gateable}
          value={conditions.deviceState}
          onChange={(v) => onFieldChange('deviceState', v)}
        />
      )
    }
    case 'scene': {
      if (!isSceneKey(descriptor.id)) break
      return (
        <SceneConditionField
          scenes={gateableScenes}
          value={conditions.scene}
          onChange={(v) => onFieldChange('scene', v)}
        />
      )
    }
    case 'crossingSelect': {
      if (!isCrossingSelectKey(descriptor.id)) break
      const key = descriptor.id
      return crossingFieldNode(descriptor, conditions[key], (v) => onFieldChange(key, v))
    }
    case 'packagePhase': {
      if (!isPackagePhaseKey(descriptor.id)) break
      const key = descriptor.id
      return (
        <Select
          value={conditions[key] ?? ''}
          options={[
            { value: '', label: t('system.notificationRuleConditions.anyPhase', '— any phase —') },
            ...descriptorOptions(descriptor, NC_PACKAGE_PHASE_OPTIONS).map((o) => ({
              value: o.value,
              label: o.label,
            })),
          ]}
          onChange={(e) => onFieldChange(key, parsePackagePhase(e.target.value))}
        />
      )
    }
    case 'sensorTransition': {
      if (!isSensorTransitionKey(descriptor.id)) break
      const key = descriptor.id
      // `''` is ABSENT (both edges): picking it deletes the key, so a rule
      // opened and closed round-trips byte-identically.
      // An alarm rule over openings that asks for the CLEAR is permanently
      // silent (D630 refuses every closing edge). Warned, not refused: alarm
      // membership is derived, and an Actions-tab edit can change it.
      const neverFires = sensorTransitionNeverFires({
        conditions,
        ...(actions !== undefined ? { actions } : {}),
        ...(sequenceActionsOf !== undefined ? { sequenceActionsOf } : {}),
      })
      return (
        <>
          <Select
            value={conditions[key] ?? ''}
            options={descriptorOptions(descriptor, NC_SENSOR_TRANSITION_OPTIONS).map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onChange={(e) => onFieldChange(key, parseSensorTransition(e.target.value))}
          />
          {neverFires && (
            <p
              className="mt-1 text-[11px] text-warning"
              data-testid="nc-sensor-transition-never-fires"
            >
              {NC_SENSOR_TRANSITION_NEVER_FIRES_WARNING}
            </p>
          )}
        </>
      )
    }
    case 'plateMatcher': {
      if (!isPlateMatcherKey(descriptor.id)) break
      const key = descriptor.id
      return <PlateMatcherField value={conditions[key]} onChange={(v) => onFieldChange(key, v)} />
    }
    case 'occupancy': {
      if (!isOccupancyKey(descriptor.id)) break
      const key = descriptor.id
      return (
        <OccupancyField
          deviceIds={deviceIds}
          cameras={cameras}
          classOptions={occupancyClassVocabulary(taxonomy)}
          value={conditions[key]}
          onChange={(v) => onFieldChange(key, v)}
        />
      )
    }
    case 'audio': {
      if (!isAudioKey(descriptor.id)) break
      const key = descriptor.id
      return (
        <AudioField
          taxonomy={taxonomy}
          value={conditions[key]}
          onChange={(v) => onFieldChange(key, v)}
        />
      )
    }
    case 'schedule':
      // Rule-level, not an `NcConditions` key — its own callback.
      return <ScheduleField value={schedule} onChange={onScheduleChange} />
    default:
      break
  }
  return <UnboundConditionNote descriptor={descriptor} conditions={conditions} />
}

/**
 * The class vocabulary the `classes` condition uses, flattened for widgets that
 * need a single `<Select>` rather than the grouped picker. Sharing the source
 * is the point: a local class list here would drift from the server taxonomy
 * the rest of the editor renders.
 */
function classVocabulary(taxonomy: NcTaxonomy | undefined): readonly TaxonomyOption[] {
  const picker = pickerForCondition('classes', taxonomy)
  return picker === null ? [] : picker.groups.flatMap((g) => g.options)
}

/**
 * The class vocabulary an OCCUPANCY scope may use: macro classes only.
 *
 * Not `classVocabulary` — occupancy is the one class condition that does not go
 * through the engine's macro-expanding `expandClassSelector`. It reads
 * `byClass[className]` from the ZoneAnalytics snapshot, which is keyed on macros
 * only, so a sub-type names a key that does not exist and the counter is 0
 * forever. Offering `car` here shipped two rules that could never fire
 * (device 102, 2026-08-12). The restriction is the shared picker's, not a local
 * filter, so the viewer's editor cannot disagree with this one.
 */
function occupancyClassVocabulary(taxonomy: NcTaxonomy | undefined): readonly TaxonomyOption[] {
  const picker = pickerForCondition('occupancy', taxonomy)
  return picker === null ? [] : picker.groups.flatMap((g) => g.options)
}

interface UnboundConditionNoteProps {
  readonly descriptor: NcConditionDescriptor
  readonly conditions: NcConditions
}

/**
 * Shown when the catalog offers a condition this editor has no widget for. The
 * one it used to cover, `customZones` (`polygonDraw`), is no longer drawn at
 * all (R9, D690 — `notification-condition-layout.ts`); a value type a newer
 * hub serves still lands here.
 *
 * It is deliberately loud rather than absent. The previous `default: return
 * null` rendered the condition's LABEL above an empty space, which reads as a
 * broken control, and an operator editing a rule that already carried the
 * value had no way to tell it was still there. The value IS preserved:
 * `buildConditions` keeps every non-empty key whose descriptor applies.
 */
function UnboundConditionNote({ descriptor, conditions }: UnboundConditionNoteProps) {
  const { t } = useTranslation()
  const entry = Object.entries(conditions).find(([key]) => key === descriptor.id)
  const authored = entry !== undefined && entry[1] !== undefined
  return (
    <p className={HINT_CLASS}>
      {authored
        ? t(
            'system.notificationRuleConditions.authoredElsewhereAndPreservedThis',
            'Authored elsewhere and preserved — this admin editor cannot change it yet.',
          )
        : t(
            'system.notificationRuleConditions.notEditableHereYetThis',
            'Not editable here yet — this condition has no admin editor.',
          )}{' '}
      <span className="text-foreground-muted">({descriptor.valueType})</span>
    </p>
  )
}

function parseSource(value: string): NcConditions['source'] {
  if (value === 'pipeline' || value === 'onboard' || value === 'sensor' || value === 'any') {
    return value
  }
  return undefined
}

function parsePackagePhase(value: string): NcConditions['packagePhase'] {
  return NC_PACKAGE_PHASE_OPTIONS.find((o) => o.value === value)?.value
}

/** The `source` widget — factored out so {@link RuleConditionsAdvancedFields}
 *  renders the identical control, never a second implementation that drifts. */
function sourceFieldNode(
  descriptor: NcConditionDescriptor,
  value: NcConditions['source'],
  onChange: (value: NcConditions['source']) => void,
): React.ReactNode {
  return (
    <Select
      value={value ?? 'any'}
      options={descriptorOptions(descriptor, NC_SOURCE_OPTIONS).map((o) => ({
        value: o.value,
        label: o.label,
      }))}
      onChange={(e) => onChange(parseSource(e.target.value))}
    />
  )
}

/** The `crossing` widget — see {@link sourceFieldNode}. */
function crossingFieldNode(
  descriptor: NcConditionDescriptor,
  value: NcConditions['crossing'],
  onChange: (value: NcConditions['crossing']) => void,
): React.ReactNode {
  return (
    <CrossingSelectField
      value={value}
      onChange={onChange}
      {...(descriptor.options ? { options: descriptor.options } : {})}
    />
  )
}

export interface RuleConditionsAdvancedFieldsProps {
  readonly catalog: readonly NcConditionDescriptor[]
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
  readonly onConditionsChange: (next: NcConditions) => void
}

/**
 * The detection-source and zone-crossing fields, drawn in the RULE-LEVEL
 * Advanced tab (operator ruling, 2026-10-01) rather than as a second
 * "Advanced" group inside the Conditions tab (D690's original placement). One
 * operator-visible Advanced surface per rule, not two.
 *
 * Same widgets, same catalog gate (`conditionVisibleForKind` +
 * `conditionSupportedByRule`) as every other condition — only the MOUNT POINT
 * moved, so a hub that cannot serve one of these (or a kind that cannot use
 * it) renders nothing, exactly as it did inside the Conditions tab.
 */
export function RuleConditionsAdvancedFields({
  catalog,
  delivery,
  conditions,
  onConditionsChange,
}: RuleConditionsAdvancedFieldsProps) {
  const { t } = useTranslation()
  const kind = ruleKindOf({ delivery, conditions })
  const setField: ConditionFieldSetter = (key, value) => {
    const next: NcConditions = { ...conditions }
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
    onConditionsChange(next)
  }
  const visibleOf = (id: string): NcConditionDescriptor | undefined =>
    catalog.find(
      (d) =>
        d.id === id &&
        conditionVisibleForKind(d, delivery, kind) &&
        conditionSupportedByRule(id, conditions),
    )
  const sourceDescriptor = visibleOf('source')
  const crossingDescriptor = visibleOf('crossing')
  if (sourceDescriptor === undefined && crossingDescriptor === undefined) return null

  return (
    <div className="space-y-2.5" data-testid="rule-advanced-conditions">
      {sourceDescriptor && isSourceSelectKey(sourceDescriptor.id) && (
        <div data-testid="condition-source">
          <label className={LABEL_CLASS}>{conditionLabel(sourceDescriptor, t)}</label>
          {sourceFieldNode(sourceDescriptor, conditions.source, (v) => setField('source', v))}
          {conditionHint(sourceDescriptor, t) !== undefined && (
            <p className={HINT_CLASS}>{conditionHint(sourceDescriptor, t)}</p>
          )}
        </div>
      )}
      {crossingDescriptor && isCrossingSelectKey(crossingDescriptor.id) && (
        <div data-testid="condition-crossing">
          <label className={LABEL_CLASS}>{conditionLabel(crossingDescriptor, t)}</label>
          {crossingFieldNode(crossingDescriptor, conditions.crossing, (v) =>
            setField('crossing', v),
          )}
          {conditionHint(crossingDescriptor, t) !== undefined && (
            <p className={HINT_CLASS}>{conditionHint(crossingDescriptor, t)}</p>
          )}
        </div>
      )}
    </div>
  )
}
