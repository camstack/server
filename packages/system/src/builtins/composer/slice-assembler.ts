/**
 * From the runtime's flat field values to the slice a target takes (D663).
 *
 * A top-level field is written under its path. An item leaf
 * (`consumables.items[desiccant].remaining.value`) is one entry of an ARRAY:
 * every leaf of one item is grouped by `(cap, arrayPath, key)` and set, by
 * path segment, onto the cap's OWN `status.itemArray.emptyItem` — so an
 * unsourced nullable leaf is `null` because the cap says so, not because this
 * module guessed. The key, the label and {@link COMPOSED_ITEM_FIXED_FIELDS}
 * are the composer's; items are sorted by key so two writes of the same
 * values are one slice.
 *
 * A cap the lookup does not know as an item array cannot be assembled: that
 * is thrown by name, and the runtime's write path turns a throw into a named,
 * retried failure — never a half-built array.
 */
import {
  type CapabilityLookup,
  type CapabilityStatusItemArray,
  COMPOSED_ITEM_FIXED_FIELDS,
  type CompositionFieldPlan,
  compositionItemFieldPath,
  type ExpressionValue,
} from '@camstack/types'

/** One item of an item-array field, as written. */
export type SliceItem = Readonly<Record<string, unknown>>
export type SliceValue = ExpressionValue | readonly SliceItem[]
export type SlicePatch = Readonly<Record<string, SliceValue>>

export interface AssemblerEntry {
  readonly plan: CompositionFieldPlan
  readonly value: ExpressionValue
}

interface ItemGroup {
  readonly cap: string
  readonly arrayPath: string
  readonly key: string
  readonly label: string
  readonly leaves: readonly AssemblerEntry[]
}

function isRecord(value: unknown): value is SliceItem {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `setPath(item, ['remaining', 'value'], 0)` → `{ ...item, remaining: { ...item.remaining, value: 0 } }`. */
function setPath(
  record: SliceItem,
  segments: readonly string[],
  value: ExpressionValue,
): SliceItem {
  const [head, ...rest] = segments
  if (head === undefined) return record
  if (rest.length === 0) return { ...record, [head]: value }
  const current = record[head]
  return { ...record, [head]: setPath(isRecord(current) ? current : {}, rest, value) }
}

function itemArrayOf(group: ItemGroup, lookupCap: CapabilityLookup): CapabilityStatusItemArray {
  const itemArray = lookupCap(group.cap)?.status?.itemArray
  if (itemArray === undefined || itemArray.path !== group.arrayPath) {
    throw new Error(
      `\`${group.cap}\` has no item array at \`${group.arrayPath}\` — ` +
        `\`${compositionItemFieldPath(group.arrayPath, group.key, '*')}\` cannot be assembled`,
    )
  }
  return itemArray
}

function assembleItem(group: ItemGroup, lookupCap: CapabilityLookup): SliceItem {
  const itemArray = itemArrayOf(group, lookupCap)
  const base: SliceItem = {
    ...itemArray.emptyItem,
    [itemArray.keyField]: group.key,
    ...(itemArray.labelField === undefined ? {} : { [itemArray.labelField]: group.label }),
    ...COMPOSED_ITEM_FIXED_FIELDS,
  }
  return group.leaves.reduce(
    (item, leaf) => setPath(item, leaf.plan.path.split('.'), leaf.value),
    base,
  )
}

function groupItems(entries: readonly AssemblerEntry[]): readonly ItemGroup[] {
  const groups = new Map<string, ItemGroup>()
  for (const entry of entries) {
    const item = entry.plan.item
    if (item === undefined) continue
    const id = `${entry.plan.cap}\u0000${item.arrayPath}\u0000${item.key}`
    const group = groups.get(id) ?? {
      cap: entry.plan.cap,
      arrayPath: item.arrayPath,
      key: item.key,
      label: item.label,
      leaves: [],
    }
    groups.set(id, { ...group, leaves: [...group.leaves, entry] })
  }
  return [...groups.values()]
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function assembleSlice(
  entries: readonly AssemblerEntry[],
  lookupCap: CapabilityLookup,
): SlicePatch {
  const top: SlicePatch = Object.fromEntries(
    entries.filter((e) => e.plan.item === undefined).map((e) => [e.plan.path, e.value]),
  )
  const groups = groupItems(entries)
  const arrays = [...new Set(groups.map((g) => g.arrayPath))].map(
    (arrayPath) =>
      [
        arrayPath,
        groups
          .filter((g) => g.arrayPath === arrayPath)
          .toSorted((a, b) => compareKeys(a.key, b.key))
          .map((g) => assembleItem(g, lookupCap)),
      ] as const,
  )
  return { ...top, ...Object.fromEntries(arrays) }
}
