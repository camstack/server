/**
 * D692 §9 — the READ projection of a stored rule that still carries a retired delivery field.
 *
 * `waitForEnhancement` (D142's deferral) and `groupIdleSec` (D143's burst merge) are gone from
 * `NcRuleInputSchema`. A rule an operator saved before the removal still holds them on disk, and
 * Zod would silently STRIP them on parse — a rule that "waited for the name" would become plain
 * immediate with no trace. This module decides, from the RAW stored values, what each one means
 * now. It is a pure function; `NcRuleStore` applies it inside `fromRecord`, which only builds
 * the in-RAM mirror, so NOTHING here is ever written back to the store.
 *
 * | Stored | Projected |
 * | --- | --- |
 * | `waitForEnhancement: true` on a grouping-capable rule WITH `identities` or `plates` | `groupingSec: NC_GROUPING_DEFAULT_SEC`, unless `groupingSec` is already set |
 * | `waitForEnhancement` anything else | dropped |
 * | `groupIdleSec > 0` on a grouping-capable rule | `groupingSec: clamp(groupIdleSec, 5, 60)`, unless already set |
 * | `groupIdleSec` anything else | dropped |
 *
 * An explicitly stored `groupingSec` always wins: the operator authored it in the new editor.
 * When both retired keys would set it, `waitForEnhancement` wins — it is the one that asked to
 * wait for a name, and the window is what carries that wait.
 */
import {
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
  type NcRuleConditionsSubject,
  ruleGroupingApplies,
} from '@camstack/types'

/** A stored rule row as the ledger hands it over, before projection. */
export interface NcRetiredFieldsRow {
  readonly delivery: string
  readonly conditions: NcRuleConditionsSubject
  readonly waitForEnhancement?: unknown
  readonly groupIdleSec?: unknown
  readonly groupingSec?: number
}

export type NcRetiredFieldProjection =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'projected'
      /** The window the retired keys map to; absent when they were only dropped. */
      readonly groupingSec?: number
      readonly dropped: readonly ('waitForEnhancement' | 'groupIdleSec')[]
      readonly from: { readonly waitForEnhancement?: unknown; readonly groupIdleSec?: unknown }
    }

/** The recognition scope a `waitForEnhancement` wait was FOR: a face list or a plate matcher. */
function hasRecognitionScope(conditions: NcRuleConditionsSubject): boolean {
  return conditions['identities'] !== undefined || conditions['plates'] !== undefined
}

function clampGroupingSec(seconds: number): number {
  return Math.min(NC_GROUPING_MAX_SEC, Math.max(NC_GROUPING_MIN_SEC, Math.round(seconds)))
}

/** D692 §9 — a projection on READ, never written back. */
export function projectRetiredRuleFields(row: NcRetiredFieldsRow): NcRetiredFieldProjection {
  const hasWait = row.waitForEnhancement !== undefined
  const hasIdle = row.groupIdleSec !== undefined
  if (!hasWait && !hasIdle) return { kind: 'unchanged' }

  const dropped: ('waitForEnhancement' | 'groupIdleSec')[] = []
  if (hasWait) dropped.push('waitForEnhancement')
  if (hasIdle) dropped.push('groupIdleSec')
  const from = {
    ...(hasWait ? { waitForEnhancement: row.waitForEnhancement } : {}),
    ...(hasIdle ? { groupIdleSec: row.groupIdleSec } : {}),
  }

  // An explicit window beats anything derived from a retired key.
  if (row.groupingSec !== undefined) return { kind: 'projected', dropped, from }

  const groupable = ruleGroupingApplies(row)
  if (groupable && row.waitForEnhancement === true && hasRecognitionScope(row.conditions)) {
    return { kind: 'projected', groupingSec: NC_GROUPING_DEFAULT_SEC, dropped, from }
  }
  if (groupable && typeof row.groupIdleSec === 'number' && row.groupIdleSec > 0) {
    return { kind: 'projected', groupingSec: clampGroupingSec(row.groupIdleSec), dropped, from }
  }
  return { kind: 'projected', dropped, from }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A stored `groupingSec` the schema would refuse, mapped to what it can only have meant.
 * `to: null` = the window is dropped (plain immediate / no window).
 */
export type NcGroupingRepair =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'repaired'; readonly from: unknown; readonly to: number | null }

/**
 * Incident 2026-10-22: a row stored with `groupingSec: 0` failed `NcRuleSchema` (min
 * {@link NC_GROUPING_MIN_SEC}) and the WHOLE rule was skipped as malformed on every load — a
 * system-event rule on which a window cannot even apply vanished from the engine and from
 * `listRules`. A non-positive (or non-numeric) window only ever meant "no window": dropped. A
 * positive one outside the range is clamped. One bad optional field never costs the rule.
 */
function repairStoredGroupingSec(value: unknown): NcGroupingRepair {
  if (value === undefined) return { kind: 'unchanged' }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { kind: 'repaired', from: value, to: null }
  }
  const clamped = clampGroupingSec(value)
  return clamped === value ? { kind: 'unchanged' } : { kind: 'repaired', from: value, to: clamped }
}

/** What {@link projectRawStoredRule} hands `fromRecord`: the object to parse, and what was done. */
export interface NcRawRuleProjection {
  /** The stored value with the projected `groupingSec` merged in, ready for `NcRuleSchema`. */
  readonly candidate: unknown
  readonly projection: NcRetiredFieldProjection
  /** What was done to an out-of-range stored `groupingSec` before the projection saw it. */
  readonly groupingRepair: NcGroupingRepair
}

/**
 * Project a RAW stored rule value (`data['rule']`, before any Zod parse). A value that is not
 * an object, or has no string `delivery`, is returned untouched: the schema parse that follows
 * rejects it exactly as before, and a projection must never be what decides a row is valid.
 */
export function projectRawStoredRule(raw: unknown): NcRawRuleProjection {
  if (!isRecord(raw) || typeof raw['delivery'] !== 'string') {
    return {
      candidate: raw,
      projection: { kind: 'unchanged' },
      groupingRepair: { kind: 'unchanged' },
    }
  }
  const groupingRepair = repairStoredGroupingSec(raw['groupingSec'])
  const repaired = withRepairedGrouping(raw, groupingRepair)
  const groupingSec = repaired['groupingSec']
  const projection = projectRetiredRuleFields({
    delivery: raw['delivery'],
    conditions: isRecord(raw['conditions']) ? raw['conditions'] : {},
    waitForEnhancement: raw['waitForEnhancement'],
    groupIdleSec: raw['groupIdleSec'],
    ...(typeof groupingSec === 'number' ? { groupingSec } : {}),
  })
  if (projection.kind === 'unchanged' || projection.groupingSec === undefined) {
    return { candidate: repaired, projection, groupingRepair }
  }
  return {
    candidate: { ...repaired, groupingSec: projection.groupingSec },
    projection,
    groupingRepair,
  }
}

function withRepairedGrouping(
  raw: Readonly<Record<string, unknown>>,
  repair: NcGroupingRepair,
): Readonly<Record<string, unknown>> {
  if (repair.kind === 'unchanged') return raw
  const { groupingSec: _dropped, ...rest } = raw
  return repair.to === null ? rest : { ...rest, groupingSec: repair.to }
}

/**
 * A copy of a raw stored rule without `keys`, or `null` when it holds none of them (so the
 * caller knows there is nothing to write). The projected `groupingSec` is NOT part of the raw
 * value and is never added here.
 */
export function stripStoredKeys(
  rawRule: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!keys.some((key) => key in rawRule)) return null
  return Object.fromEntries(Object.entries(rawRule).filter(([key]) => !keys.includes(key)))
}
