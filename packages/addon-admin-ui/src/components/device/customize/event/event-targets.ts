/**
 * Event targets the Customize tab renders, narrowed from the catalog so a
 * missing path is not a pulse and a span without the camera-sensors
 * authority is not offered.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CameraSensorMode,
  type CustomizeCatalogTarget,
  type DeviceType,
} from '@camstack/types'

export interface PulseCatalogView {
  readonly id: string
  readonly timestampPath: string
  readonly counterPath: string
  readonly debounceMs: number
  readonly apply: 'add' | 'replace'
  readonly deviceTypes: readonly DeviceType[]
}

export interface SpanCatalogView {
  readonly id: string
  readonly timeoutMs: number
  readonly cooldownMs: number | null
  readonly sourceModes: readonly CameraSensorMode[]
  readonly deviceTypes: readonly DeviceType[]
}

export interface EventCardTarget {
  readonly cap: string
  readonly pulse: PulseCatalogView | null
  readonly span: SpanCatalogView | null
}

export function eventCardTargets(): readonly EventCardTarget[] {
  return Object.entries(CAP_CUSTOMIZE_CATALOG).flatMap(([cap, entry]) =>
    entry.targets
      .filter((target) => target.cardinality === 'event')
      .map((target) => ({
        cap,
        pulse: pulseView(target),
        span: spanView(target),
      }))
      .filter((card) => card.pulse !== null || card.span !== null),
  )
}

function pulseView(target: CustomizeCatalogTarget): PulseCatalogView | null {
  if (target.shape !== 'pulse') return null
  const apply = pulseApply(target.apply)
  if (
    target.timestampPath === undefined ||
    target.counterPath === undefined ||
    target.debounceMs === undefined ||
    apply === null
  ) {
    return null
  }
  return {
    id: target.id,
    timestampPath: target.timestampPath,
    counterPath: target.counterPath,
    debounceMs: target.debounceMs,
    apply,
    deviceTypes: target.deviceTypes,
  }
}

function spanView(target: CustomizeCatalogTarget): SpanCatalogView | null {
  if (target.shape !== 'span' || target.timeoutMs === undefined) return null
  if (target.applyAuthority?.kind !== 'camera-sensors') return null
  return {
    id: target.id,
    timeoutMs: target.timeoutMs,
    cooldownMs: target.cooldownMs ?? null,
    sourceModes: target.sourceModes ?? ['in-addition'],
    deviceTypes: target.deviceTypes,
  }
}

export function eventBadgeKey(text: string, state: string): string {
  if (text === 'Native' || text.startsWith('Native')) return 'customize.assign.native'
  if (text === 'pending') return 'customize.event.checking'
  if (text === 'unknown' || text === 'unreadable') return 'customize.event.badge.unavailable'
  return `customize.event.badge.${state}`
}

function pulseApply(apply: CustomizeCatalogTarget['apply']): 'add' | 'replace' | null {
  if (apply === 'add' || apply === 'replace') return apply
  return null
}
