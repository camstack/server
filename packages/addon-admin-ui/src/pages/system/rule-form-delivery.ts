/**
 * The delivery parameters a rule offers, derived from what the SELECTED
 * notifiers declare (`TargetKind.deliveryParams`, D938). The editor knows no
 * service by name: no selected kind declares a key, no control for it.
 *
 * A value is written onto every selected target whose kind declares that key,
 * as that target's `params[key]`; a target whose kind does not declare it is
 * left alone (the dispatcher would ignore it anyway).
 */
import {
  type DeliveryParam,
  deliveryParamsDeclaredBy,
  type Target,
  type TargetKind,
} from '@camstack/types'
import type { NcTargetParamsMap } from './rule-form-state'

/** The slice of a kind descriptor this editor reads. */
export type DeliveryKindRef = Pick<TargetKind, 'kind' | 'addonId' | 'deliveryParams'>

function kindOf(target: Target, kinds: readonly DeliveryKindRef[]): DeliveryKindRef | undefined {
  return kinds.find((k) => k.kind === target.kind && k.addonId === target.addonId)
}

function declaredBy(
  targetId: string,
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): readonly DeliveryParam[] {
  const target = targets.find((t) => t.id === targetId)
  return (target === undefined ? undefined : kindOf(target, kinds)?.deliveryParams) ?? []
}

/** The parameters to offer for the current selection (empty = offer nothing). */
export function deliveryParamsForSelection(
  targetIds: readonly string[],
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): readonly DeliveryParam[] {
  return deliveryParamsDeclaredBy(targetIds.map((id) => declaredBy(id, targets, kinds)))
}

/** The value shown for a key: the first selected target that has one set. */
export function readDeliveryValue(
  targetIds: readonly string[],
  targetParams: NcTargetParamsMap,
  key: string,
): unknown {
  for (const id of targetIds) {
    const value = targetParams[id]?.[key]
    if (value !== undefined) return value
  }
  return undefined
}

export interface DeliveryWriteInput {
  readonly targetIds: readonly string[]
  readonly targets: readonly Target[]
  readonly kinds: readonly DeliveryKindRef[]
  readonly targetParams: NcTargetParamsMap
}

/** Set (or, with `undefined`, clear) one key on every selected target that declares it. */
export function writeDeliveryValue(
  input: DeliveryWriteInput,
  key: string,
  value: string | number | boolean | undefined,
): NcTargetParamsMap {
  const next: Record<string, Readonly<Record<string, unknown>>> = { ...input.targetParams }
  for (const id of input.targetIds) {
    if (!declaredBy(id, input.targets, input.kinds).some((p) => p.key === key)) continue
    const { [key]: _dropped, ...rest } = next[id] ?? {}
    const merged = value === undefined ? rest : { ...rest, [key]: value }
    if (Object.keys(merged).length === 0) delete next[id]
    else next[id] = merged
  }
  return next
}
