/**
 * The delivery parameters a target offers, derived from what its notifier
 * declares (`TargetKind.deliveryParams`, D938). The editor knows no service by
 * name: a kind that declares no key gets no control for it. A value is stored
 * as that target's `params[key]`, edited in the target's own panel (#487,
 * `NotificationRuleTargetSettings`).
 */
import type { DeliveryParam, Target, TargetKind } from '@camstack/types'

/**
 * The slice of a kind descriptor this editor reads. `caps` is the field
 * declaration (#483); a ref without it is a kind whose fields are UNKNOWN.
 */
export type DeliveryKindRef = Pick<TargetKind, 'kind' | 'addonId' | 'deliveryParams'> &
  Partial<Pick<TargetKind, 'caps'>>

function kindOf(target: Target, kinds: readonly DeliveryKindRef[]): DeliveryKindRef | undefined {
  return kinds.find((k) => k.kind === target.kind && k.addonId === target.addonId)
}

/** The parameters one target's notifier declares (empty = none, or unknown target). */
export function declaredBy(
  targetId: string,
  targets: readonly Target[],
  kinds: readonly DeliveryKindRef[],
): readonly DeliveryParam[] {
  const target = targets.find((t) => t.id === targetId)
  return (target === undefined ? undefined : kindOf(target, kinds)?.deliveryParams) ?? []
}
