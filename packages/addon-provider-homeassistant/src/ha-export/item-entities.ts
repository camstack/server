/**
 * Per-item entities — the reconcile-time mint `CAP_ENTITY_MAP` cannot express.
 *
 * `CAP_ENTITY_MAP` is static per capability: one row, a fixed set of
 * entities, each reading one flat field. A capability whose value is an
 * ARRAY of provider-named items (`consumables.items`: a brush, a filter, a
 * clean-water tank, a dishwasher's salt) has a different entity set on every
 * device, and the set changes when the provider reports a new item. This
 * module mints that set from the device's OWN slice, pure:
 *
 *   slice → `ItemEntity[]` (structure, announced by the catalog)
 *   slice → `StateValue[]` (values, pushed by the addon)
 *
 * Both halves come from the same function per capability, so an entity can
 * never be announced under one id and fed under another.
 *
 * The STRUCTURE goes through a `ReadMirror` in the addon before it reaches
 * the plan: an item that appears is announced at once, an item that leaves
 * is removed only when two consecutive reads agree (D49) — a removal deletes
 * the entity and its recorder history in Home Assistant.
 *
 * A capability listed here is CLASSIFIED for the export-coverage guard
 * (`scripts/check-export-coverage.ts`), which checks `itemsField` against the
 * capability's status schema exactly as it checks a `CAP_ENTITY_MAP` field.
 */
import {
  type ConsumableForm,
  ConsumableFormSchema,
  ConsumableItemSchema,
  ConsumableStatusSchema,
  type ConsumableKind,
  type ConsumableRemainingUnit,
  consumableFormOf,
  consumableKindOf,
} from '@camstack/types'
import { z } from 'zod'
import { stateTopic, toSlug } from './topics.js'
import type { StateValue } from './types.js'

/** Which value of an item an entity carries. `reset` is the write-only button. */
export type ItemFacet = 'level' | 'status' | 'remaining' | 'reset'

/** The two platforms a per-item entity is built on. */
export type ItemEntityPlatform = 'sensor' | 'button'

/**
 * One entity minted for one item. STRUCTURE only — the value travels
 * separately on its state topic, and a button has none.
 */
export interface ItemEntity {
  readonly capName: string
  /** The provider's item key, verbatim — what a command sends back. */
  readonly itemKey: string
  readonly facet: ItemFacet
  /** The topic / component segment. Snake, from the slug of the key. */
  readonly entity: string
  /** `<deviceId>_<uniqueSuffix>` is the HA unique_id. Uses the RAW key. */
  readonly uniqueSuffix: string
  readonly platform: ItemEntityPlatform
  readonly label: string
  readonly unit?: string
  readonly deviceClass?: string
  readonly stateClass?: string
  readonly icon?: string
  readonly entityCategory?: 'config' | 'diagnostic'
  /** `device_class: enum` only — the closed vocabulary the value is one of. */
  readonly options?: readonly string[]
  /** Static entity attributes, announced with the structure (`HaComponent.attributes`). */
  readonly attributes?: Readonly<Record<string, string>>
}

/** A per-item capability: where its items are, and how they become entities. */
export interface ItemEntityMapping {
  /** Slice field carrying the item array. Checked against the status schema. */
  readonly itemsField: string
  /** The slice → its entities, or `null` when the slice is not the cap's shape. */
  readonly entities: (slice: unknown) => readonly ItemEntity[] | null
  /** The slice → the values of its entities, or `null` likewise. */
  readonly values: (slice: unknown) => readonly ItemEntityValue[] | null
}

/** One value for one per-item entity, before it is put on a topic. */
export interface ItemEntityValue {
  readonly entity: string
  readonly value: string
}

// ── consumables ─────────────────────────────────────────────────────────

const CONSUMABLE_PREFIX = 'consumable'

/** Outside `ConsumableStatusSchema` on purpose: the component reads it as unknown. */
const STATUS_UNKNOWN = 'unknown'

function consumableEntity(key: string, facet: ItemFacet): string {
  return `${CONSUMABLE_PREFIX}_${toSlug(key)}_${facet}`
}

/** Home Assistant's own duration units; a cycle count is a plain count. */
const REMAINING_UNIT: Readonly<Record<ConsumableRemainingUnit, string>> = {
  days: 'd',
  hours: 'h',
  cycles: 'cycles',
}

// ── form ────────────────────────────────────────────────────────────────

/** What `consumableForm` reads: the kind, and a `form` the provider may name. */
export interface ConsumableFormSource {
  readonly kind?: ConsumableKind
  readonly form?: unknown
}

/**
 * The item's form (the capability's own derivation, `consumableFormOf`): the one
 * the provider declared when it is a form the capability knows, else the one its
 * kind implies. An unknown spelling is not trusted — it falls back to the kind
 * rather than to an icon for nothing.
 */
export function consumableForm(item: ConsumableFormSource): ConsumableForm {
  const declared = ConsumableFormSchema.safeParse(item.form)
  return consumableFormOf({
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    ...(declared.success ? { form: declared.data } : {}),
  })
}

/** A part is drawn by what it is when its key or label says so. */
function partIcon(key: string, label: string): string {
  const name = `${key} ${label}`.toLowerCase()
  if (name.includes('brush')) return 'mdi:brush'
  return 'mdi:air-filter'
}

function formIcon(item: ExportConsumableItem, form: ConsumableForm): string {
  switch (form) {
    case 'part':
      return partIcon(item.key, item.label)
    case 'tank':
      return consumableKindOf(item) === 'waste' ? 'mdi:water-off' : 'mdi:water'
    case 'product':
      return 'mdi:shaker-outline'
    case 'bin':
      return 'mdi:delete'
  }
}

/**
 * The item as this export reads it: the capability's own item, plus a
 * `form` read as `unknown` and narrowed by {@link consumableForm} — so a
 * form this export does not know degrades one icon instead of refusing the
 * whole slice.
 */
const ExportConsumableItemSchema = ConsumableItemSchema.extend({
  form: z.unknown().optional(),
})
type ExportConsumableItem = z.infer<typeof ExportConsumableItemSchema>

const ExportConsumablesSchema = z.object({ items: z.array(ExportConsumableItemSchema) })

/**
 * A worn part's life is a diagnostic; a tank's fill is what the device page
 * is for (a vacuum's clean water, a dishwasher's salt), so it is not hidden.
 */
function levelCategory(kind: ConsumableKind): 'diagnostic' | undefined {
  return kind === 'wear' ? 'diagnostic' : undefined
}

function consumableEntities(item: ExportConsumableItem): readonly ItemEntity[] {
  const base = { capName: 'consumables', itemKey: item.key } as const
  const kind = consumableKindOf(item)
  const form = consumableForm(item)
  const icon = formIcon(item, form)
  /** What the item IS, on the sensors that describe it (not on a counter or a button). */
  const attributes = { form, kind, label: item.label }
  const out: ItemEntity[] = []
  const unique = (facet: ItemFacet): string => `${CONSUMABLE_PREFIX}_${item.key}_${facet}`

  if (item.level !== null) {
    const category = levelCategory(kind)
    out.push({
      ...base,
      facet: 'level',
      entity: consumableEntity(item.key, 'level'),
      uniqueSuffix: unique('level'),
      platform: 'sensor',
      label: item.label,
      unit: '%',
      stateClass: 'measurement',
      icon,
      attributes,
      ...(category !== undefined ? { entityCategory: category } : {}),
    })
  }
  if (item.status !== null) {
    /**
     * An `enum` sensor over the cap's own vocabulary — the options come from
     * `ConsumableStatusSchema`, never a second list here.
     */
    out.push({
      ...base,
      facet: 'status',
      entity: consumableEntity(item.key, 'status'),
      uniqueSuffix: unique('status'),
      platform: 'sensor',
      label: `${item.label} status`,
      deviceClass: 'enum',
      options: ConsumableStatusSchema.options,
      icon,
      attributes,
      entityCategory: 'diagnostic',
    })
  }
  if (item.remaining !== undefined) {
    const isDuration = item.remaining.unit !== 'cycles'
    out.push({
      ...base,
      facet: 'remaining',
      entity: consumableEntity(item.key, 'remaining'),
      uniqueSuffix: unique('remaining'),
      platform: 'sensor',
      label: `${item.label} remaining`,
      unit: REMAINING_UNIT[item.remaining.unit],
      stateClass: 'measurement',
      ...(isDuration ? { deviceClass: 'duration' } : {}),
      icon: isDuration ? 'mdi:timer-sand' : 'mdi:counter',
      entityCategory: 'diagnostic',
    })
  }
  if (item.resettable) {
    out.push({
      ...base,
      facet: 'reset',
      entity: consumableEntity(item.key, 'reset'),
      uniqueSuffix: unique('reset'),
      platform: 'button',
      label: `Reset ${item.label}`,
      icon: 'mdi:restore',
      entityCategory: 'config',
    })
  }
  return out
}

function consumableValues(item: ExportConsumableItem): readonly ItemEntityValue[] {
  const out: ItemEntityValue[] = []
  if (item.level !== null) {
    out.push({ entity: consumableEntity(item.key, 'level'), value: String(item.level) })
  }
  /**
   * A null verdict is published OUTSIDE the enum, which the component reads
   * as `unknown` — publishing nothing would leave the last verdict standing
   * (D393: unknown is never the previous value).
   */
  out.push({
    entity: consumableEntity(item.key, 'status'),
    value: item.status ?? STATUS_UNKNOWN,
  })
  // An unknown count (D393) publishes nothing: HA keeps `unknown`, never 0.
  if (item.remaining !== undefined && item.remaining.value !== null) {
    out.push({
      entity: consumableEntity(item.key, 'remaining'),
      value: String(item.remaining.value),
    })
  }
  return out
}

function parseConsumables(slice: unknown): readonly ExportConsumableItem[] | null {
  const parsed = ExportConsumablesSchema.safeParse(slice)
  return parsed.success ? parsed.data.items : null
}

/**
 * Two items whose keys slug alike would claim one entity id. The first
 * keeps it; the second is left out rather than announced twice under one
 * component key, where Home Assistant would show either value at random.
 */
function firstPerEntity<T extends { readonly entity: string }>(rows: readonly T[]): readonly T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.entity)) return false
    seen.add(row.entity)
    return true
  })
}

// ── The table ───────────────────────────────────────────────────────────

/** capability → its per-item mint. */
export const ITEM_ENTITY_MAP: Readonly<Record<string, ItemEntityMapping>> = {
  consumables: {
    itemsField: 'items',
    entities: (slice) => {
      const items = parseConsumables(slice)
      return items === null ? null : firstPerEntity(items.flatMap(consumableEntities))
    },
    values: (slice) => {
      const items = parseConsumables(slice)
      return items === null ? null : firstPerEntity(items.flatMap(consumableValues))
    },
  },
}

/** The entities one capability's slice mints, or `null` for a malformed slice. */
export function itemEntitiesFor(capName: string, slice: unknown): readonly ItemEntity[] | null {
  const mapping = ITEM_ENTITY_MAP[capName]
  return mapping === undefined ? null : mapping.entities(slice)
}

/** The values one capability's slice carries, on their state topics. */
export function projectItemSlice(
  deviceKey: string,
  capName: string,
  slice: unknown,
): readonly StateValue[] | null {
  const mapping = ITEM_ENTITY_MAP[capName]
  if (mapping === undefined) return null
  const values = mapping.values(slice)
  if (values === null) return null
  return values.map((v) => ({ topic: stateTopic(deviceKey, v.entity), value: v.value }))
}

/** True for a capability whose entities are minted per item. */
export function isItemEntityCap(capName: string): boolean {
  return Object.prototype.hasOwnProperty.call(ITEM_ENTITY_MAP, capName)
}
