/**
 * ConsumableLevelBadge — ONE look for a consumable's level (salt, rinse aid,
 * a filter, a brush, a tank), so the Consumables section and the Customize
 * list read the same colours.
 *
 * The vocabulary is the consumables cap's level enum (`ok | low | empty |
 * full`, `ConsumableLevelSchema`) plus `null` = unknown (D393: an unknown
 * level is never shown as ok or as empty). The level → tone mapping lives
 * here and nowhere else: ok = success, low = warning, empty = danger, full =
 * warning (a waste tank to empty), unknown = neutral. The badge always
 * carries its state in words — it never says anything by colour alone.
 */
import type { ReactElement } from 'react'
import {
  type ConsumableItem,
  consumableKindOf,
  type ConsumableLevel as CapConsumableLevel,
  ConsumableLevelSchema,
} from '@camstack/types'
import { Badge, type BadgeSize, type BadgeVariant } from '../primitives/badge'
import { useUiText, type UiTextFn } from '../contexts/ui-text'

/** A consumable's level as the caps say it; `null` = not known right now. */
export type ConsumableLevel = CapConsumableLevel | null

interface ConsumableLevelLook {
  readonly variant: BadgeVariant
  /** Fill-bar class for a level drawn as a bar (the Consumables panel). */
  readonly barClass: string
  readonly labelKey: string
  readonly labelFallback: string
}

const LOOKS: Readonly<Record<CapConsumableLevel | 'unknown', ConsumableLevelLook>> = {
  ok: {
    variant: 'success',
    barClass: 'bg-success',
    labelKey: 'uiLibrary.consumableLevel.ok',
    labelFallback: 'OK',
  },
  low: {
    variant: 'warning',
    barClass: 'bg-warning',
    labelKey: 'uiLibrary.consumableLevel.low',
    labelFallback: 'Low',
  },
  empty: {
    variant: 'danger',
    barClass: 'bg-danger',
    labelKey: 'uiLibrary.consumableLevel.empty',
    labelFallback: 'Empty',
  },
  full: {
    variant: 'warning',
    barClass: 'bg-warning',
    labelKey: 'uiLibrary.consumableLevel.full',
    labelFallback: 'Full',
  },
  unknown: {
    variant: 'neutral',
    barClass: 'bg-foreground-subtle',
    labelKey: 'uiLibrary.consumableLevel.unknown',
    labelFallback: 'Unknown',
  },
}

function lookOf(level: ConsumableLevel): ConsumableLevelLook {
  return LOOKS[level ?? 'unknown']
}

/** The badge variant a level is drawn in. */
export function consumableLevelVariant(level: ConsumableLevel): BadgeVariant {
  return lookOf(level).variant
}

/** The fill-bar class a level is drawn in. */
export function consumableLevelBarClass(level: ConsumableLevel): string {
  return lookOf(level).barClass
}

/** The word for a level. */
export function consumableLevelLabel(level: ConsumableLevel, t: UiTextFn): string {
  const look = lookOf(level)
  return t(look.labelKey, look.labelFallback)
}

/** A remaining-life (or supply fill) % at or below this is `low`. */
export const CONSUMABLE_LOW_PERCENT = 15

/** A waste fill % at or above this is `full`. */
export const CONSUMABLE_FULL_PERCENT = 85

/** The item fields the level is derived from. */
export type ConsumableLevelInput = Pick<ConsumableItem, 'level' | 'status'> &
  Partial<Pick<ConsumableItem, 'kind'>>

/** A waste item: full is bad, low or empty is what it should be. */
function wasteLevel(item: ConsumableLevelInput): ConsumableLevel {
  if (item.status === 'full' || item.status === 'replace') return 'full'
  if (item.level !== null) return item.level >= CONSUMABLE_FULL_PERCENT ? 'full' : 'ok'
  return item.status === null ? null : 'ok'
}

/** A wear part or a supply: low / empty is bad, a full supply is fine. */
function drawnLevel(item: ConsumableLevelInput): ConsumableLevel {
  if (item.level !== null) {
    if (item.level <= 0 || item.status === 'empty') return 'empty'
    if (item.level <= CONSUMABLE_LOW_PERCENT || item.status === 'replace' || item.status === 'low')
      return 'low'
    return 'ok'
  }
  switch (item.status) {
    case 'replace':
    case 'low':
      return 'low'
    case 'empty':
      return 'empty'
    case 'ok':
    case 'full':
      return 'ok'
    case null:
      return null
  }
}

/**
 * A `consumables` cap item as a level, by its kind (D915):
 *  - a `waste` item (a dust bin) is `full` when the provider says so or its
 *    fill is at or above {@link CONSUMABLE_FULL_PERCENT}, else ok;
 *  - a `wear` part or a `supply` reads a known % (0 = empty, at or below
 *    {@link CONSUMABLE_LOW_PERCENT} = low), never better than `low` when the
 *    provider says `replace` or `low`; without a % its discrete status.
 * Nothing known is unknown (`null`).
 */
export function consumableItemLevel(item: ConsumableLevelInput): ConsumableLevel {
  return consumableKindOf(item) === 'waste' ? wasteLevel(item) : drawnLevel(item)
}

/** A state-field description as `getWireableFields` reports it — only what is read here. */
export interface ConsumableLevelFieldView {
  readonly kind: string
  readonly enumValues?: readonly string[]
}

/** The supply vocabulary a level FIELD of a cap is typed by: `ok | low | empty`. */
const SUPPLY_LEVELS = ConsumableLevelSchema.exclude(['full']).options

/**
 * Whether a cap state field IS a consumable level: an enum whose members are
 * exactly the supply levels (`ok | low | empty`). Derived from the schema, so a
 * new cap that uses the vocabulary is recognised without naming it anywhere.
 */
export function isConsumableLevelField(field: ConsumableLevelFieldView): boolean {
  if (field.kind !== 'enum' || field.enumValues === undefined) return false
  const members = SUPPLY_LEVELS
  return (
    field.enumValues.length === members.length &&
    members.every((m) => field.enumValues?.includes(m))
  )
}

/** A value read from a slice as a level; anything that is not a member is unknown. */
export function parseConsumableLevel(value: unknown): ConsumableLevel {
  const parsed = ConsumableLevelSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export interface ConsumableLevelBadgeProps {
  readonly level: ConsumableLevel
  /** The consumable's name, shown before the state (`Salt · Low`). Omit when the row already names it. */
  readonly name?: string
  /** Replaces the state word (`Replace`, `72 %`) — the tone still follows `level`. */
  readonly label?: string
  readonly size?: BadgeSize
  readonly className?: string
}

export function ConsumableLevelBadge({
  level,
  name,
  label,
  size = 'md',
  className,
}: ConsumableLevelBadgeProps): ReactElement {
  const t = useUiText()
  const state = label ?? consumableLevelLabel(level, t)
  return (
    <Badge
      variant={consumableLevelVariant(level)}
      size={size}
      className={className}
      data-level={level ?? 'unknown'}
    >
      {name === undefined ? state : `${name} · ${state}`}
    </Badge>
  )
}
