/**
 * The `consumables` slice — one vocabulary for every form (D934).
 *
 * Every item is a consumable reading: wear parts judged at the rule's threshold,
 * supply and waste judged on the provider's verdict (held like a float switch).
 */
import { consumableFormOf, type ConsumableForm, type ConsumableKind } from '@camstack/types'
import type { NcConsumableItemReading } from '../event-intake.js'

/** One item as the slice carries it, before parsing. */
export interface NcRawConsumableItem {
  readonly key: string
  readonly label: string
  readonly level: number | null
  readonly status?: string | null
  readonly kind?: string | undefined
  readonly form?: string | undefined
}

/** One parsed item — every form shares the same alert family. */
export interface NcConsumableSliceItem {
  readonly key: string
  readonly label: string
  readonly level: number | null
  /** Raw provider status from the slice. */
  readonly status: string | null
  readonly kind: string | undefined
  readonly form: ConsumableForm
  /** Wear items only — narrowed for the consumable band. */
  readonly wear: NcConsumableItemReading | null
}

function wearStatus(status: string | null | undefined): NcConsumableItemReading['status'] {
  switch (status) {
    case 'replace':
    case 'low':
    case 'empty':
      return 'replace'
    case 'ok':
      return 'ok'
    default:
      return null
  }
}

function consumableKindOf(raw: NcRawConsumableItem): string | undefined {
  return typeof raw.kind === 'string' ? raw.kind : undefined
}

function consumableFormOfRaw(raw: NcRawConsumableItem): ConsumableForm {
  const kind = consumableKindOf(raw)
  const formField = typeof raw.form === 'string' ? raw.form : undefined
  return consumableFormOf({
    ...(kind === 'wear' || kind === 'supply' || kind === 'waste'
      ? { kind: kind as ConsumableKind }
      : {}),
    ...(formField === 'part' ||
    formField === 'tank' ||
    formField === 'product' ||
    formField === 'bin'
      ? { form: formField }
      : {}),
  })
}

/** Parse one slice entry into the unified consumable item shape. */
export function parseConsumableSliceItem(raw: NcRawConsumableItem): NcConsumableSliceItem {
  const kind = consumableKindOf(raw)
  const form = consumableFormOfRaw(raw)
  const status = typeof raw.status === 'string' ? raw.status : null
  const isWear = kind === undefined || kind === 'wear'
  const wear: NcConsumableItemReading | null = isWear
    ? {
        key: raw.key,
        label: raw.label,
        level: raw.level,
        status: wearStatus(status),
      }
    : null
  return { key: raw.key, label: raw.label, level: raw.level, status, kind, form, wear }
}

/** The slice event as this reader needs it — a `SystemEvent` satisfies it. */
export interface NcSliceEvent {
  readonly category: string
  readonly data: Readonly<Record<string, unknown>>
}

/** One device's consumables — every form in one list. */
export interface NcConsumablesSlice {
  readonly deviceId: number
  readonly items: readonly NcConsumableSliceItem[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A `device.state-changed` carrying a `consumables` slice; `null` for any other
 * event, a malformed slice or an empty list.
 */
export function consumablesSliceOf(event: NcSliceEvent): NcConsumablesSlice | null {
  if (event.category !== 'device.state-changed') return null
  const data = event.data
  if (data['capName'] !== 'consumables') return null
  const deviceId = data['deviceId']
  const slice = data['slice']
  if (typeof deviceId !== 'number' || !isRecord(slice)) return null
  const rawItems = slice['items']
  if (!Array.isArray(rawItems)) return null
  const items: NcConsumableSliceItem[] = []
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue
    const key = entry['key']
    if (typeof key !== 'string' || key.length === 0) continue
    const label = entry['label']
    const level = entry['level']
    const status = entry['status']
    const kind = entry['kind']
    const form = entry['form']
    items.push(
      parseConsumableSliceItem({
        key,
        label: typeof label === 'string' && label.length > 0 ? label : key,
        level: typeof level === 'number' && Number.isFinite(level) ? level : null,
        status: typeof status === 'string' ? status : null,
        kind: typeof kind === 'string' ? kind : undefined,
        form: typeof form === 'string' ? form : undefined,
      }),
    )
  }
  if (items.length === 0) return null
  return { deviceId, items }
}

/** @deprecated D934 — use {@link parseConsumableSliceItem}. */
export function routeConsumableItem(raw: NcRawConsumableItem): {
  readonly family: 'consumable'
  readonly item: NcConsumableItemReading
} {
  const parsed = parseConsumableSliceItem(raw)
  if (parsed.wear === null) {
    return {
      family: 'consumable',
      item: { key: parsed.key, label: parsed.label, level: parsed.level, status: null },
    }
  }
  return { family: 'consumable', item: parsed.wear }
}
