/**
 * Pure mapping helpers for notification-target OptionSelect options.
 */

import { notificationTargetKindOf } from '@camstack/types'
import type { LinkableInstance } from '../hooks/use-instances-of-cap'
import type { OptionSelectOption } from './option-select/option-select-model'

export type NotificationTargetOption = {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly kind?: string
  readonly addonId?: string
}

function kindIconKey(addonId: string, kind: string): string {
  return `${addonId}:${kind}`
}

export function targetsToOptions(
  targets: readonly NotificationTargetOption[],
  kindIconUrls: ReadonlyMap<string, string>,
  noteIds: ReadonlySet<string> | undefined,
  noteLabel: string,
): readonly OptionSelectOption[] {
  return targets.map((target) => {
    const iconUrl =
      target.addonId !== undefined && target.kind !== undefined
        ? kindIconUrls.get(kindIconKey(target.addonId, target.kind))
        : undefined
    let badge: string | undefined
    if (noteIds?.has(target.id) === true) {
      badge = noteLabel
    } else if (!target.enabled) {
      badge = 'disabled'
    }
    return {
      value: target.id,
      label: target.name,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      ...(badge !== undefined ? { badge } : {}),
    }
  })
}

export function buildKindIconMap(rows: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const kind = Reflect.get(row, 'kind')
    const addonId = Reflect.get(row, 'addonId')
    const iconUrl = Reflect.get(row, 'iconUrl')
    if (typeof kind !== 'string' || typeof addonId !== 'string') continue
    if (typeof iconUrl === 'string' && iconUrl.length > 0) {
      map.set(kindIconKey(addonId, kind), iconUrl)
    }
  }
  return map
}

/** The targets as picker options: the instances of `notification-output`, kind named as its adapter. */
export function toTargetOptions(
  instances: readonly LinkableInstance[] | undefined,
): readonly NotificationTargetOption[] {
  return (instances ?? []).map((instance) => ({
    id: instance.id,
    name: instance.name,
    enabled: instance.enabled,
    kind: notificationTargetKindOf(instance.recordKind),
    addonId: instance.addonId,
  }))
}
