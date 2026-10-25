/**
 * The client half of `nc.listPrunes` — why a rule switched itself off.
 *
 * When a device (or a delivery target) is deleted, the notification centre
 * removes it from every rule that names it. When it was the rule's LAST one it
 * cannot: removing it would widen the rule to every camera. So it keeps the id
 * and switches the rule off, and records that in the prune ledger
 * (`addon-post-analysis/.../device-prune-ledger.ts`). This module turns that
 * record into the one sentence the editor shows.
 *
 * WHY THE SHAPE IS HAND-WRITTEN: same reason as `notification-rule-status.ts` —
 * the authority is an addon-internal Zod schema reached through the generic
 * `addons.custom` bridge, whose output is `unknown`, and the admin UI may not
 * import an addon's source. A drift shows up as "nothing to show", never as a
 * wrong sentence.
 */

import i18n from '../../i18n/index'

export const NC_LIST_PRUNES_ACTION = 'nc.listPrunes'

/** Which rule store a prune names. */
export type NcPruneRuleKind = 'rule' | 'timelapse' | 'summary'

/** One recorded prune — the fields a banner reads. */
export interface NcPruneView {
  readonly kind: NcPruneRuleKind
  readonly ruleId: string
  readonly subjectKind: 'device' | 'target'
  /** Device id as a decimal string, or the target id. */
  readonly subject: string
  readonly field: string
  readonly outcome: 'removed' | 'kept-disabled' | 'kept' | 'sequence-removed' | 'binding-removed'
  readonly at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const KINDS: ReadonlySet<string> = new Set(['rule', 'timelapse', 'summary'])
const OUTCOMES: ReadonlySet<string> = new Set([
  'removed',
  'kept-disabled',
  'kept',
  'sequence-removed',
  'binding-removed',
])

function isKind(value: unknown): value is NcPruneRuleKind {
  return typeof value === 'string' && KINDS.has(value)
}

function isOutcome(value: unknown): value is NcPruneView['outcome'] {
  return typeof value === 'string' && OUTCOMES.has(value)
}

function isSubjectKind(value: unknown): value is NcPruneView['subjectKind'] {
  return value === 'device' || value === 'target'
}

function parseOne(value: unknown): NcPruneView | null {
  if (!isRecord(value)) return null
  const { kind, ruleId, subjectKind, subject, field, outcome, at } = value
  if (!isKind(kind) || !isSubjectKind(subjectKind) || !isOutcome(outcome)) return null
  if (typeof ruleId !== 'string' || typeof subject !== 'string' || typeof field !== 'string') {
    return null
  }
  if (typeof at !== 'number') return null
  return { kind, ruleId, subjectKind, subject, field, outcome, at }
}

/**
 * The action's answer, or `null` when it is not one this build can read. Never
 * `[]` for an unreadable answer: "nothing was pruned" is a claim, and an
 * unreadable answer does not make it (D315).
 */
export function parsePrunes(raw: unknown): readonly NcPruneView[] | null {
  if (!isRecord(raw) || !Array.isArray(raw['prunes'])) return null
  return raw['prunes'].map(parseOne).filter((row): row is NcPruneView => row !== null)
}

/**
 * The prune that switched THIS rule off, while it is still off — else `null`.
 *
 * And only while the rule has not been touched since the LAST prune write of
 * any outcome (every prune write records a row stamped after it, so a later
 * removal on the still-disabled rule keeps the banner): a rule the operator
 * edited — re-enabled and switched off again — is off for their reason.
 *
 * Only `kept-disabled`: a `kept` row is a rule the operator had already
 * switched off, and blaming that on a deletion would be a false sentence. And
 * never once the rule is back on: that was the operator's explicit choice.
 */
export function pruneBannerFor(
  prunes: readonly NcPruneView[],
  kind: NcPruneRuleKind,
  ruleId: string,
  enabled: boolean,
  updatedAt: number,
): NcPruneView | null {
  if (enabled) return null
  const own = prunes.filter((p) => p.kind === kind && p.ruleId === ruleId)
  const lastWrite = own.reduce((max, p) => Math.max(max, p.at), Number.NEGATIVE_INFINITY)
  if (updatedAt > lastWrite) return null
  return own
    .filter((p) => p.outcome === 'kept-disabled')
    .reduce<NcPruneView | null>((best, p) => (best === null || p.at > best.at ? p : best), null)
}

/** The banner's sentence. `formatDate` is the caller's locale formatter. */
export function pruneBannerText(prune: NcPruneView, formatDate: (at: number) => string): string {
  const when = formatDate(prune.at)
  return prune.subjectKind === 'device'
    ? i18n.t('helpers.notificationPrunes.lastDevice', { when, subject: prune.subject })
    : i18n.t('helpers.notificationPrunes.lastTarget', { when, subject: prune.subject })
}
