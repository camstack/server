/**
 * D905 — a notification rule that CANNOT work is said out loud, once.
 *
 * 2026-10-22: the operator's stream-offline rule had been skipped as
 * "malformed" on every 30 s load for four days (a stored `groupingSec: 0`), and
 * that morning a robot rule had stopped because its device was re-created
 * under a new id. Neither said anything anywhere an operator looks.
 *
 * Three reasons, each from a reading that ANSWERED:
 *
 *  - `unparseable` — the last SUCCESSFUL rule load skipped the row
 *    (`NcRuleStore.skippedRows`, `null` until one succeeded).
 *  - `device-deleted` / `target-deleted` — the prune ledger holds a `kept` /
 *    `kept-disabled` record for the rule (its LAST device or target was
 *    deleted, so the prune kept the id and switched the rule off) and the rule
 *    still names it. The prune writes that record only after two answered
 *    directory reads and `getDevice === null` agree (D49), so a registry that
 *    did not answer can never produce one here.
 *
 * A reading that is not available (`null`) keeps the verdict it had: it can
 * neither raise nor clear (D49 / D315). One `broken` edge per rule per distinct
 * set of reasons — the 30 s reload never repeats it — and one `repaired` when a
 * broken rule loads and names nothing deleted. A rule that disappears (deleted
 * by the operator) is forgotten without an edge.
 *
 * Pure: the centre emits the edges this returns. The verdicts live in RAM, so a
 * restart re-announces a rule that is still broken — once.
 */
import type { NcRule } from '@camstack/types'
import type { NcPruneRecord } from './device-prune-ledger.js'
import { referencedDeviceIds, referencedTargetIds } from './device-prune.js'
import type { NcSkippedRuleRow } from './rule-store.js'

export type NcRuleBrokenReasonCode = 'unparseable' | 'device-deleted' | 'target-deleted'

export interface NcRuleBrokenReason {
  readonly code: NcRuleBrokenReasonCode
  /** Device ids (decimal) or target ids; empty for `unparseable`. */
  readonly ids: readonly string[]
  readonly detail?: string
}

export type NcRuleHealthEdge =
  | {
      readonly kind: 'broken'
      readonly ruleId: string
      readonly ruleName: string | null
      readonly reasons: readonly NcRuleBrokenReason[]
    }
  | { readonly kind: 'repaired'; readonly ruleId: string; readonly ruleName: string | null }

export interface NcRuleHealthInputs {
  /** The loaded rule set, `null` before a load succeeded. */
  readonly rules: readonly NcRule[] | null
  readonly skipped: readonly NcSkippedRuleRow[] | null
  /** The prune record, `null` while it has not been read. */
  readonly prunes: readonly NcPruneRecord[] | null
}

interface Verdict {
  readonly name: string | null
  readonly unparseable: NcRuleBrokenReason | null
  readonly deleted: readonly NcRuleBrokenReason[]
  readonly fingerprint: string
}

const EMPTY_SNAPSHOT = { timelapse: [], summary: [], alarm: null, mutedDeviceIds: [] } as const

function fingerprintOf(reasons: readonly NcRuleBrokenReason[]): string {
  return reasons.map((r) => `${r.code}:${[...r.ids].sort().join(',')}`).join('|')
}

/** The deleted subjects a rule still names, from the prune's `kept*` records. */
function deletedReasons(rule: NcRule, prunes: readonly NcPruneRecord[]): NcRuleBrokenReason[] {
  const snapshot = { ...EMPTY_SNAPSHOT, rules: [rule] }
  const devices = referencedDeviceIds(snapshot)
  const targets = referencedTargetIds(snapshot)
  const deadDevices = new Set<string>()
  const deadTargets = new Set<string>()
  for (const p of prunes) {
    if (p.kind !== 'rule' || p.ruleId !== rule.id) continue
    if (p.outcome !== 'kept' && p.outcome !== 'kept-disabled') continue
    if (p.subjectKind === 'device' && devices.has(Number(p.subject))) deadDevices.add(p.subject)
    if (p.subjectKind === 'target' && targets.has(p.subject)) deadTargets.add(p.subject)
  }
  const reasons: NcRuleBrokenReason[] = []
  if (deadDevices.size > 0) reasons.push({ code: 'device-deleted', ids: [...deadDevices].sort() })
  if (deadTargets.size > 0) reasons.push({ code: 'target-deleted', ids: [...deadTargets].sort() })
  return reasons
}

export class NcRuleHealthMonitor {
  private readonly verdicts = new Map<string, Verdict>()

  /** Judge every rule once; return the edges to announce. */
  evaluate(inputs: NcRuleHealthInputs): readonly NcRuleHealthEdge[] {
    const next = new Map<string, Verdict>()
    const seen = new Set<string>()

    if (inputs.skipped !== null) {
      for (const row of inputs.skipped) {
        seen.add(row.ruleId)
        const unparseable: NcRuleBrokenReason = { code: 'unparseable', ids: [], detail: row.reason }
        next.set(row.ruleId, this.verdict(row.name, unparseable, []))
      }
    }
    if (inputs.rules !== null) {
      for (const rule of inputs.rules) {
        seen.add(rule.id)
        const previous = this.verdicts.get(rule.id)
        const deleted =
          inputs.prunes !== null ? deletedReasons(rule, inputs.prunes) : (previous?.deleted ?? [])
        // It loaded, so it is not unparseable — when the skipped list ANSWERED.
        const unparseable = inputs.skipped !== null ? null : (previous?.unparseable ?? null)
        next.set(rule.id, this.verdict(rule.name, unparseable, deleted))
      }
    }

    const edges: NcRuleHealthEdge[] = []
    const answeredAll = inputs.rules !== null && inputs.skipped !== null
    for (const [ruleId, previous] of this.verdicts) {
      if (seen.has(ruleId)) continue
      // Not in an answered rule set at all: deleted by the operator — forget it.
      // Not answered: keep what we knew.
      if (!answeredAll) next.set(ruleId, previous)
    }
    for (const [ruleId, verdict] of next) {
      const previous = this.verdicts.get(ruleId)
      const reasons = reasonsOf(verdict)
      if (reasons.length > 0) {
        if (previous?.fingerprint !== verdict.fingerprint) {
          edges.push({ kind: 'broken', ruleId, ruleName: verdict.name, reasons })
        }
      } else if (previous !== undefined && reasonsOf(previous).length > 0) {
        edges.push({ kind: 'repaired', ruleId, ruleName: verdict.name })
      }
    }
    this.verdicts.clear()
    for (const [ruleId, verdict] of next) {
      if (reasonsOf(verdict).length > 0) this.verdicts.set(ruleId, verdict)
    }
    return edges
  }

  private verdict(
    name: string | null,
    unparseable: NcRuleBrokenReason | null,
    deleted: readonly NcRuleBrokenReason[],
  ): Verdict {
    const reasons = [...(unparseable !== null ? [unparseable] : []), ...deleted]
    return { name, unparseable, deleted, fingerprint: fingerprintOf(reasons) }
  }
}

function reasonsOf(verdict: Verdict): readonly NcRuleBrokenReason[] {
  return [...(verdict.unparseable !== null ? [verdict.unparseable] : []), ...verdict.deleted]
}
