/**
 * The client half of `nc.testRule` — the per-rule "Test now" answer.
 *
 * Hand-written shapes for the same reason as `notification-rule-status.ts`: the
 * authority is an addon-internal Zod schema reached through the generic
 * `addons.custom` bridge, whose output is `z.unknown()`. Mirrored once, beside
 * the parser, so a drift reads as "this build could not read the answer" rather
 * than as a wrong render.
 *
 * {@link summariseRuleTest} is the sentence the operator actually reads, and it
 * is pure so the four outcomes that matter can be pinned:
 *  - it matched and something was enqueued → the notification is on its way
 *  - it matched and NOTHING was enqueued → every target is opted out
 *  - it did not match → which condition refused it
 *  - it never reached a rule → what dropped the event first
 */

import i18n from '../../i18n/index'

export interface NcRuleTestRuleOutcome {
  readonly ruleId: string
  readonly ruleName: string
  readonly matched: boolean
  readonly failedCondition?: string
  readonly cooldown: string
  readonly enqueued: number
  readonly targetIds: readonly string[]
}

export interface NcRuleTestNote {
  readonly conditionId: string
  readonly note: string
}

/** One section's read in a summary rule's test (D698). */
export interface NcRuleTestSummarySection {
  readonly id: string
  readonly status: 'read' | 'unavailable'
  readonly items: number
}

/** One notification a summary rule's test queued (D698). */
export interface NcRuleTestSummaryRow {
  readonly section?: string
  readonly enqueued: number
}

/** A STATE-SUMMARY rule's test (D698): the summary built now, mirrored from `NcStateSummaryTestSchema`. */
export interface NcRuleTestSummary {
  readonly split: 'rule' | 'section'
  readonly nothingToReport: boolean
  readonly sections: readonly NcRuleTestSummarySection[]
  readonly rows: readonly NcRuleTestSummaryRow[]
}

export interface NcRuleTestOutcome {
  readonly recordId: string
  readonly delivery: string
  readonly trigger: string
  readonly candidates: number
  readonly outcomes: readonly NcRuleTestRuleOutcome[]
  readonly still: string
  readonly notes: readonly string[]
  readonly droppedBy?: string
  readonly planNotes: readonly NcRuleTestNote[]
  readonly stateSummary?: NcRuleTestSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function strings(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function parseOutcome(value: unknown): NcRuleTestRuleOutcome | null {
  if (!isRecord(value)) return null
  const ruleId = str(value, 'ruleId')
  const ruleName = str(value, 'ruleName')
  if (ruleId === undefined || ruleName === undefined) return null
  if (typeof value['matched'] !== 'boolean') return null
  const failedCondition = str(value, 'failedCondition')
  return {
    ruleId,
    ruleName,
    matched: value['matched'],
    ...(failedCondition !== undefined ? { failedCondition } : {}),
    cooldown: str(value, 'cooldown') ?? 'n/a',
    enqueued: typeof value['enqueued'] === 'number' ? value['enqueued'] : 0,
    targetIds: strings(value, 'targetIds'),
  }
}

function parseNote(value: unknown): NcRuleTestNote | null {
  if (!isRecord(value)) return null
  const conditionId = str(value, 'conditionId')
  const note = str(value, 'note')
  if (conditionId === undefined || note === undefined) return null
  return { conditionId, note }
}

function parseSummary(value: unknown): NcRuleTestSummary | undefined {
  if (!isRecord(value)) return undefined
  const split = value['split']
  if (split !== 'rule' && split !== 'section') return undefined
  if (typeof value['nothingToReport'] !== 'boolean') return undefined
  const sections: NcRuleTestSummarySection[] = []
  for (const entry of Array.isArray(value['sections']) ? value['sections'] : []) {
    if (!isRecord(entry)) continue
    const id = str(entry, 'id')
    const status = entry['status']
    if (id === undefined || (status !== 'read' && status !== 'unavailable')) continue
    sections.push({ id, status, items: typeof entry['items'] === 'number' ? entry['items'] : 0 })
  }
  const rows: NcRuleTestSummaryRow[] = []
  for (const entry of Array.isArray(value['rows']) ? value['rows'] : []) {
    if (!isRecord(entry)) continue
    const section = str(entry, 'section')
    rows.push({
      ...(section !== undefined ? { section } : {}),
      enqueued: typeof entry['enqueued'] === 'number' ? entry['enqueued'] : 0,
    })
  }
  return { split, nothingToReport: value['nothingToReport'], sections, rows }
}

export function parseRuleTestResult(value: unknown): NcRuleTestOutcome | null {
  if (!isRecord(value)) return null
  const recordId = str(value, 'recordId')
  const delivery = str(value, 'delivery')
  if (recordId === undefined || delivery === undefined) return null
  if (value['origin'] !== 'synthetic') return null
  const outcomes: NcRuleTestRuleOutcome[] = []
  for (const entry of Array.isArray(value['outcomes']) ? value['outcomes'] : []) {
    const parsed = parseOutcome(entry)
    if (parsed !== null) outcomes.push(parsed)
  }
  const planNotes: NcRuleTestNote[] = []
  for (const entry of Array.isArray(value['planNotes']) ? value['planNotes'] : []) {
    const parsed = parseNote(entry)
    if (parsed !== null) planNotes.push(parsed)
  }
  const droppedBy = str(value, 'droppedBy')
  const stateSummary = parseSummary(value['stateSummary'])
  return {
    recordId,
    delivery,
    trigger: str(value, 'trigger') ?? delivery,
    candidates: typeof value['candidates'] === 'number' ? value['candidates'] : 0,
    outcomes,
    still: str(value, 'still') ?? 'none',
    notes: strings(value, 'notes'),
    ...(droppedBy !== undefined ? { droppedBy } : {}),
    planNotes,
    ...(stateSummary !== undefined ? { stateSummary } : {}),
  }
}

/**
 * The one sentence a Test answers with.
 *
 * It always says whether the notification IS ON ITS WAY, because that is the
 * question, and it never says "sent": delivery is asynchronous through the
 * durable outbox and claiming a send this side of the drain would be a claim
 * about something that has not happened yet.
 */
export function summariseRuleTest(result: NcRuleTestOutcome): string {
  if (result.stateSummary !== undefined) return summariseSummaryTest(result, result.stateSummary)
  if (result.droppedBy !== undefined) {
    return i18n.t('helpers.notificationRuleTest.dropped', { reason: result.droppedBy })
  }
  const outcome = result.outcomes[0]
  if (outcome === undefined) {
    return i18n.t('helpers.notificationRuleTest.notCandidate', { trigger: result.trigger })
  }
  if (!outcome.matched) {
    return outcome.failedCondition === undefined
      ? i18n.t('helpers.notificationRuleTest.noMatchOwn')
      : i18n.t('helpers.notificationRuleTest.noMatchCond', { condition: outcome.failedCondition })
  }
  if (outcome.enqueued === 0) {
    return i18n.t('helpers.notificationRuleTest.matchedNoQueue')
  }
  const stillNote =
    result.still === 'live'
      ? ` ${i18n.t('helpers.notificationRuleTest.stillLive')}`
      : result.still === 'unavailable'
        ? ` ${i18n.t('helpers.notificationRuleTest.stillUnavailable')}`
        : result.still === 'unattachable'
          ? ` ${i18n.t('helpers.notificationRuleTest.stillUnattachable')}`
          : ''
  return i18n.t('helpers.notificationRuleTest.matched', {
    queued: outcome.enqueued,
    targets: outcome.targetIds.length,
    still: stillNote,
  })
}

/**
 * A STATE-SUMMARY rule's test (D698): the summary was built NOW, not an event
 * injected. Nothing to report is an answer — per section — never a silence.
 */
function summariseSummaryTest(result: NcRuleTestOutcome, summary: NcRuleTestSummary): string {
  if (summary.nothingToReport) {
    const reads = summary.sections
      .map(
        (s) =>
          `${s.id}: ${s.status === 'unavailable' ? i18n.t('helpers.notificationRuleTest.unavailable') : i18n.t('helpers.notificationRuleTest.noneOpen')}`,
      )
      .join(', ')
    return i18n.t('helpers.notificationRuleTest.nothingToReport', { reads })
  }
  const queued = summary.rows.reduce((sum, row) => sum + row.enqueued, 0)
  const targets = result.outcomes[0]?.targetIds.length ?? 0
  if (queued === 0) {
    return i18n.t('helpers.notificationRuleTest.summaryNoQueue')
  }
  // Each category with the items it reports, e.g. "battery (2), streams (1)".
  const sections = summary.rows
    .flatMap((row) => (row.section !== undefined ? [row.section] : []))
    .map((id) => `${id} (${String(summary.sections.find((s) => s.id === id)?.items ?? 0)})`)
  const perCategory =
    summary.split === 'section'
      ? ` (${i18n.t('helpers.notificationRuleTest.perCategory', { sections: sections.join(', ') })})`
      : ''
  return i18n.t('helpers.notificationRuleTest.summaryBuilt', { queued, perCategory, targets })
}
