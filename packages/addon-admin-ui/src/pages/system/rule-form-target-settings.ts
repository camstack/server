/**
 * Per-target settings of a rule (#483, #487), read from what each selected
 * target's notifier DECLARES (`TargetKind.caps` → `deliverableFields`). The
 * editor names no service: a speaker that says only a title is told apart from
 * a phone by its declaration, never by its kind string.
 *
 *  - {@link fieldSupportForSelection} — the union the rule-level form shows,
 *    with the targets that drop each field (the per-field hint);
 *  - {@link overridesForSave} — the overrides map as saved: only selected
 *    targets, only fields each one delivers (an unsupported override cannot
 *    be set, whatever the form held);
 *  - {@link writeTargetOverride} / {@link writeTargetParam} — one target's
 *    entry, the others untouched.
 */
import {
  deliverableFields,
  fieldSupportForTargets,
  attachmentKindsOf,
  type NcTargetAttachment,
  type NcTargetOverride,
  type NcTargetOverrides,
  type NotificationField,
  type NotificationFieldSupport,
  priorityLevelsOf,
  sanitizeTargetOverride,
  type Target,
  type TargetKindLevel,
} from '@camstack/types'
import type { NotificationTargetOption } from '@camstack/ui-library'
import type { DeliveryKindRef } from './rule-form-delivery'
import type { NcTargetParamsMap } from './rule-form-state'

/** The fields a target delivers; `undefined` = its kind is not described (unknown). */
export type TargetFieldsOf = (targetId: string) => readonly NotificationField[] | undefined

export function targetFieldsOf(
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): TargetFieldsOf {
  return (targetId) => {
    const target = targets.find((t) => t.id === targetId)
    if (target === undefined) return undefined
    const caps = kinds.find((k) => k.kind === target.kind && k.addonId === target.addonId)?.caps
    return caps === undefined ? undefined : deliverableFields(caps)
  }
}

export type NotificationFieldSupportMap = ReadonlyMap<NotificationField, NotificationFieldSupport>

/** What the rule-level form shows for the selected targets. */
export function fieldSupportForSelection(
  targetIds: readonly string[],
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): NotificationFieldSupportMap {
  const fieldsOf = targetFieldsOf(targets, kinds)
  const support = fieldSupportForTargets(
    targetIds.map((id) => ({
      name: targets.find((t) => t.id === id)?.name ?? id,
      fields: fieldsOf(id),
    })),
  )
  return new Map(support.map((entry) => [entry.field, entry]))
}

/** The overrides as saved: selected targets only, each pruned to what it delivers. */
export function overridesForSave(
  targetIds: readonly string[],
  overrides: NcTargetOverrides,
  fieldsOf: TargetFieldsOf | undefined,
): NcTargetOverrides {
  const saved: Record<string, NcTargetOverride> = {}
  for (const id of targetIds) {
    const own = overrides[id]
    if (own === undefined) continue
    const clean = sanitizeTargetOverride(own, fieldsOf?.(id))
    if (clean !== undefined) saved[id] = clean
  }
  return saved
}

/** Set (or, with `undefined`, clear) one target's override. */
export function writeTargetOverride(
  overrides: NcTargetOverrides,
  targetId: string,
  next: NcTargetOverride | undefined,
): NcTargetOverrides {
  const { [targetId]: _previous, ...others } = overrides
  return next === undefined ? others : { ...others, [targetId]: next }
}

/** Set (or, with `undefined`, clear) one declared delivery parameter on one target. */
export function writeTargetParam(
  targetParams: NcTargetParamsMap,
  targetId: string,
  key: string,
  value: string | number | boolean | undefined,
): NcTargetParamsMap {
  const { [targetId]: current, ...others } = targetParams
  const { [key]: _dropped, ...rest } = current ?? {}
  const merged = value === undefined ? rest : { ...rest, [key]: value }
  return Object.keys(merged).length === 0 ? others : { ...others, [targetId]: merged }
}

/** What one target's notifier declares beyond its fields: the choices a panel offers. */
export interface TargetChoices {
  /** The declared levels a priority can pick (empty = the generic scale). */
  readonly levels: readonly TargetKindLevel[]
  /** `none` plus the picture kinds the notifier can send (empty = no pictures). */
  readonly attachmentKinds: readonly NcTargetAttachment[]
}

/** `undefined` = the kind is not described (unknown): the panel offers the generic scale. */
export function targetChoicesOf(
  targetId: string,
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): TargetChoices | undefined {
  const target = targets.find((t) => t.id === targetId)
  if (target === undefined) return undefined
  const caps = kinds.find((k) => k.kind === target.kind && k.addonId === target.addonId)?.caps
  if (caps === undefined) return undefined
  return { levels: priorityLevelsOf(caps), attachmentKinds: attachmentKindsOf(caps) }
}

/**
 * Which kind of rule a per-target panel edits. What a panel offers is decided
 * from what the server honours for that kind (`target-settings.ts` at enqueue,
 * `deliverable-fields.ts` at send), not from what the notifier could do: an
 * override the kind never produces would be a control that does nothing.
 */
export type TargetSettingsSurface = 'rule' | 'summary' | 'timelapse' | 'calendar-events'

export interface TargetSettingsSurfaceSpec {
  /** The message fields a panel for this kind shows (the schedule is always shown). */
  readonly fields: readonly NotificationField[]
  /** The picture kinds this kind produces; empty = it produces none. */
  readonly attachmentKinds: readonly NcTargetAttachment[]
}

export const TARGET_SETTINGS_SURFACES: Readonly<
  Record<TargetSettingsSurface, TargetSettingsSurfaceSpec>
> = {
  // An event rule: stills, clips, GIFs and action buttons.
  rule: {
    fields: ['title', 'body', 'priority', 'attachments', 'actions'],
    attachmentKinds: ['none', 'image', 'clip', 'gif'],
  },
  // One mosaic image; no buttons.
  summary: {
    fields: ['title', 'body', 'priority', 'attachments'],
    attachmentKinds: ['none', 'image'],
  },
  // A preview image and the rendered clip; no buttons.
  timelapse: {
    fields: ['title', 'body', 'priority', 'attachments'],
    attachmentKinds: ['none', 'image', 'clip'],
  },
  // Text only.
  'calendar-events': { fields: ['title', 'body', 'priority'], attachmentKinds: [] },
}

export function surfaceShows(surface: TargetSettingsSurface, field: NotificationField): boolean {
  return TARGET_SETTINGS_SURFACES[surface].fields.includes(field)
}

/** The picture kinds to offer: what the notifier declares, cut to what this kind produces. */
export function surfaceAttachmentKinds(
  surface: TargetSettingsSurface,
  declared: readonly NcTargetAttachment[],
): readonly NcTargetAttachment[] {
  const produced = TARGET_SETTINGS_SURFACES[surface].attachmentKinds
  return declared.filter((kind) => produced.includes(kind))
}

/**
 * The picker options an editor already holds, as the `Target`s the panel reads.
 * An option without a kind is a target whose kind is unknown: it gets the empty
 * kind, which matches no catalog entry (every field offered, never narrowed).
 */
export function targetsFromOptions(
  options: readonly NotificationTargetOption[],
): readonly Target[] {
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    enabled: option.enabled,
    kind: option.kind ?? '',
    addonId: option.addonId ?? '',
    config: {},
  }))
}
