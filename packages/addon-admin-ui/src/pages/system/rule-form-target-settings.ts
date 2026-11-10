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
