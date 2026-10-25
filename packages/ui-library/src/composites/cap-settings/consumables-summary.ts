/**
 * What a COLLAPSED Consumables section says in one line, and whether the
 * section starts open (D915).
 *
 * An item needs attention when its kind-aware level (`consumableItemLevel`)
 * is `low`, `empty` or `full` — which covers a part to replace (a wear item
 * whose provider says `replace` reads `low`) and a waste tank to empty. The
 * section opens itself while any item needs attention and stays closed while
 * every item is ok or unknown. Unknown is never counted as ok (D393): "All OK"
 * is said only when every item is KNOWN to be ok.
 */
import type { ConsumableItem, ConsumableLevel } from '@camstack/types'
import { consumableItemLevel } from '../consumable-level-badge'

/** A level that needs the operator. */
export type ConsumableAttentionLevel = Exclude<ConsumableLevel, 'ok'>

/** The item the summary names. */
export interface ConsumableSummaryItem {
  readonly label: string
  readonly level: ConsumableAttentionLevel
  /** The provider asked for the part to be replaced (worded "Replace", not "Low"). */
  readonly replace: boolean
}

export type ConsumablesSummary =
  | { readonly kind: 'none'; readonly needsAttention: false }
  | { readonly kind: 'ok'; readonly needsAttention: false; readonly count: number }
  | {
      readonly kind: 'partial'
      readonly needsAttention: false
      readonly ok: number
      readonly unknown: number
    }
  | {
      readonly kind: 'attention'
      readonly needsAttention: true
      readonly count: number
      /** The most urgent item: empty, then full, then low. */
      readonly worst: ConsumableSummaryItem
    }

const SEVERITY: Readonly<Record<ConsumableAttentionLevel, number>> = {
  empty: 3,
  full: 2,
  low: 1,
}

function isAttention(level: ConsumableLevel | null): level is ConsumableAttentionLevel {
  return level === 'low' || level === 'empty' || level === 'full'
}

export function summarizeConsumables(items: readonly ConsumableItem[]): ConsumablesSummary {
  if (items.length === 0) return { kind: 'none', needsAttention: false }
  const attention: ConsumableSummaryItem[] = []
  let ok = 0
  let unknown = 0
  for (const item of items) {
    const level = consumableItemLevel(item)
    if (isAttention(level)) {
      attention.push({ label: item.label, level, replace: item.status === 'replace' })
    } else if (level === 'ok') {
      ok += 1
    } else {
      unknown += 1
    }
  }
  const worst = [...attention].sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level])[0]
  if (worst !== undefined) {
    return { kind: 'attention', needsAttention: true, count: attention.length, worst }
  }
  return unknown === 0
    ? { kind: 'ok', needsAttention: false, count: ok }
    : { kind: 'partial', needsAttention: false, ok, unknown }
}
