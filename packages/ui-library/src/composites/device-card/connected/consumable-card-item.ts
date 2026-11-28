/**
 * One `consumables` cap item as the card's compact row (D915, D1023). The
 * kind-aware level (`consumableItemLevel`) decides which direction is bad, so
 * a full dust bin warns and an unknown reading is never ok (D393); the state
 * is also said in words, so colour never carries it alone.
 */
import {
  consumableFormOf,
  convertUnit,
  type DisplayPreference,
  formatReading,
  type ConsumableItem,
  type ConsumableRemaining,
} from '@dominevo/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import { consumableItemLevel, consumableLevelLabel } from '../../consumable-level-badge'
import type { CardConsumable } from '../shell/model'

const METRES_PER_KM = 1000
const MILES_MIN = 0.1

/** A distance stored in metres, in the unit system the operator reads: km / m, or mi. */
function formatDistance(metres: number, system: DisplayPreference, precision?: number): string {
  const digits = (value: number): string =>
    precision === undefined
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(2).replace(/\.?0+$/, '')
      : value.toFixed(precision)
  if (system === 'imperial') {
    const miles = convertUnit(metres, 'm', 'mi')
    return miles >= MILES_MIN
      ? `${digits(miles)} mi`
      : `${digits(convertUnit(metres, 'm', 'ft'))} ft`
  }
  return metres >= METRES_PER_KM ? `${digits(metres / METRES_PER_KM)} km` : `${digits(metres)} m`
}

/** `value` null = unknown (D393) — an em-dash, never a fake `0`. */
function formatRemaining(
  t: UiTextFn,
  r: ConsumableRemaining,
  system: DisplayPreference,
  precision?: number,
): string {
  if (r.value === null) return '—'
  if (r.kind === 'distance') return formatDistance(r.value, system, precision)
  if (r.kind === 'count') {
    return t(
      'uiLibrary.consumablesPanel.cycles',
      { one: '{{count}} cycle', other: '{{count}} cycles' },
      { count: r.value },
    )
  }
  const rendered = formatReading({
    value: r.value,
    quantity: 'duration',
    ...(precision === undefined ? {} : { precision }),
  })
  return rendered.unit.length === 0 ? rendered.text : `${rendered.text} ${rendered.unit}`
}

/** A ms-epoch as a compact local date for the "replaced" hint. */
function formatResetAt(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

function wordOf(item: ConsumableItem, t: UiTextFn): string {
  const level = consumableItemLevel(item)
  if (item.status === 'replace') return t('uiLibrary.consumablesPanel.replace', 'Replace')
  if (consumableFormOf(item) === 'product') {
    if (level === 'low') return t('uiLibrary.consumablesPanel.refillSoon', 'Refill soon')
    if (level === 'empty') return t('uiLibrary.consumablesPanel.refillNow', 'Refill now')
  }
  return consumableLevelLabel(level, t)
}

export function toCardConsumable(
  item: ConsumableItem,
  canReset: boolean,
  t: UiTextFn,
  precision?: number,
  system: DisplayPreference = 'metric',
): CardConsumable {
  const parts: string[] = []
  if (item.remaining) parts.push(formatRemaining(t, item.remaining, system, precision))
  if (item.lastResetAt !== null) {
    parts.push(
      t('uiLibrary.consumablesPanel.replacedOn', 'Replaced {{date}}', {
        date: formatResetAt(item.lastResetAt),
      }),
    )
  }
  return {
    key: item.key,
    label: item.label,
    percent: item.level,
    level: consumableItemLevel(item),
    form: consumableFormOf(item),
    levelWord: wordOf(item, t),
    ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
    resetLabel: item.resettable ? t('uiLibrary.deviceCard.consumables.reset', 'Reset') : null,
    ...(item.resettable && !canReset ? { resetDisabled: true } : {}),
  }
}
