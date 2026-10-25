/**
 * The consumables a device ALREADY has, before anything is added in Customize.
 * Derived from what the device's own capabilities declare, never from a vendor
 * list:
 *
 * - a state field of a native cap typed by the supply level enum
 *   (`ok | low | empty`), read from `getWireableFields` — none ships today:
 *   since D915 the dishwasher's salt and rinse aid are `consumables` items;
 * - the items of the device's native `consumables` cap, read from its slice.
 *
 * Each is a `Known` (D315): nothing is claimed absent before both the bindings
 * and the fields have answered, and a failed read says why.
 */
import { type ConsumableItem, ConsumablesStatusSchema } from '@camstack/types'
import { isConsumableLevelField } from '@camstack/ui-library'
import type { Known } from './known'
import type { LiveValue } from './assignments/live-value'
import type { WireableCatalog } from './source-picker-model'

/** The cap whose items are consumables by definition. */
export const CONSUMABLES_CAP = 'consumables'

/** The path of the item array inside the `consumables` slice. */
export const CONSUMABLE_ITEMS_PATH = 'items'

export type DefaultConsumable =
  | {
      readonly kind: 'field'
      /** `saltLevel` → `salt`: the name the label is looked up by. */
      readonly key: string
      readonly cap: string
      readonly path: string
    }
  | {
      readonly kind: 'item'
      readonly key: string
      readonly item: ConsumableItem
    }

const ItemsSchema = ConsumablesStatusSchema.shape.items

/** `saltLevel` → `salt`, `rinseAidLevel` → `rinseAid`; a path without the suffix is kept. */
export function consumableFieldKey(path: string): string {
  const leaf = path.split('.').pop() ?? path
  const stripped = leaf.replace(/Level$/, '')
  return stripped === '' ? leaf : stripped
}

/** `rinseAid` → `Rinse aid`: the label when no translation names the field. */
export function humanizeConsumableKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The consumable level fields of the device's OWN caps. */
export function defaultConsumableFields(
  catalog: WireableCatalog,
  nativeCaps: ReadonlySet<string>,
): readonly DefaultConsumable[] {
  return catalog.caps
    .filter((cap) => nativeCaps.has(cap.cap) && cap.cap !== CONSUMABLES_CAP)
    .flatMap((cap) =>
      cap.fields
        .filter((f) => f.item !== true && isConsumableLevelField(f))
        .map(
          (f): DefaultConsumable => ({
            kind: 'field',
            key: consumableFieldKey(f.path),
            cap: cap.cap,
            path: f.path,
          }),
        ),
    )
}

/** The items a native `consumables` slice reports; an unreadable list is `unknown`, never empty. */
export function defaultConsumableItems(items: LiveValue): Known<readonly DefaultConsumable[]> {
  switch (items.kind) {
    case 'pending':
      return { kind: 'pending' }
    case 'unknown':
      return { kind: 'unknown', reason: items.reason }
    case 'absent':
      return { kind: 'known', value: [] }
    case 'value': {
      if (items.value === null) return { kind: 'known', value: [] }
      const parsed = ItemsSchema.safeParse(items.value)
      if (!parsed.success) return { kind: 'unknown', reason: parsed.error.message }
      return {
        kind: 'known',
        value: parsed.data.map((item) => ({
          kind: 'item',
          key: item.key,
          item,
        })),
      }
    }
  }
}

/**
 * Every consumable the device has by default: its level fields, then its
 * native items. `items` is the `consumables` slice read, or null when the
 * device has no native `consumables` cap.
 */
export function defaultConsumables(
  nativeCaps: Known<ReadonlySet<string>>,
  catalog: Known<WireableCatalog>,
  items: LiveValue | null,
): Known<readonly DefaultConsumable[]> {
  if (nativeCaps.kind !== 'known') return nativeCaps
  if (catalog.kind !== 'known') return catalog
  const fields = defaultConsumableFields(catalog.value, nativeCaps.value)
  if (!nativeCaps.value.has(CONSUMABLES_CAP) || items === null) {
    return { kind: 'known', value: fields }
  }
  const native = defaultConsumableItems(items)
  if (native.kind !== 'known') return native
  return { kind: 'known', value: [...fields, ...native.value] }
}
