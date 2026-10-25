/**
 * A state summary as an ORDINARY system-event subject (D647), so it reaches the
 * phone the way every system rule does: `buildEntries` → the durable outbox →
 * the drain's snooze gate, retries and per-target history → the dispatcher,
 * which renders the rule's own template with the summary's variables.
 *
 * - `recordId` is `state-summary:<ruleId>:<windowEndMs>` — the outbox dedup
 *   key, so a restart can never enqueue one window twice. Split per SECTION
 *   (D698), each row is `state-summary:<ruleId>:<windowEndMs>:<sectionId>`:
 *   the same guarantee, per section.
 * - The row files under the system device (0): a summary spans devices.
 *   `targetUsers` therefore reach admins only — a user whose grant is
 *   narrower than the whole installation must not be sent the names of
 *   devices they cannot open.
 * - The words are FROZEN at enqueue (`textParams`), like the digest's: the
 *   state is the state at the window's end, not at a retry hours later. The
 *   LANGUAGE is frozen with them.
 * - `kind` is the rule's first kind — on a per-section row, its first kind OF
 *   THAT SECTION (D708, `sectionKindOf`), which is what the row taps through
 *   to. No kind is "the" event of a summary — `data.stateSummary` says what
 *   the row is, and `{{eventKind}}` renders empty on it.
 */
import { type NcRule, type NcStateSummarySplit, templateCarriesSummary } from '@camstack/types'
import { NC_SYSTEM_DEVICE_ID, type NcRuleSubject } from '../rule-engine.js'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import {
  isStateSectionId,
  NC_STATE_SECTION_VAR,
  type NcStateSectionId,
  sectionKinds,
} from './state-model.js'
import type { NcStateSectionText, NcStateSummary, NcStateSummaryText } from './state-summary.js'

export const NC_STATE_SUMMARY_TITLE_KEY = 'system.state-summary.title'
const NC_STATE_SUMMARY_BODY_KEY = 'system.state-summary.body'

/** A per-section row's title and body (D698): the rule's name and the section's. */
export const NC_STATE_SUMMARY_SECTION_TITLE_KEY = 'system.state-summary.section.title'
export const NC_STATE_SUMMARY_SECTION_BODY_KEY = 'system.state-summary.section.body'

function stateSummaryRecordId(ruleId: string, windowEndMs: number): string {
  return `state-summary:${ruleId}:${String(windowEndMs)}`
}

/**
 * The record id of a TEST of the rule (D698, `nc.testRule`): its own prefix,
 * so a test can never take — or be swallowed by — a real window's dedup key.
 */
export function stateSummaryTestRecordId(ruleId: string, nowMs: number): string {
  return `state-summary-test:${ruleId}:${String(nowMs)}`
}

/** One section's row: the record id of the whole, plus `:<sectionId>` — the per-section dedup key. */
function sectionRecordId(base: string, sectionId: string): string {
  return `${base}:${sectionId}`
}

/** Is this system-event data the data of a state-summary row? */
export function isStateSummaryData(data: Readonly<Record<string, unknown>>): boolean {
  return data['stateSummary'] === true
}

export interface NcStateSummarySubjectInput {
  readonly rule: NcRule
  readonly summary: NcStateSummary
  readonly text: NcStateSummaryText
  readonly window: ClosedWindow
  /**
   * The record id of the row (a section row appends `:<sectionId>`). Absent =
   * the window's, {@link stateSummaryRecordId}; a test passes
   * {@link stateSummaryTestRecordId}.
   */
  readonly recordBase?: string
}

function recordBaseOf(input: NcStateSummarySubjectInput): string {
  return input.recordBase ?? stateSummaryRecordId(input.rule.id, input.window.endMs)
}

/** `null` when the rule has no system-event condition (the guard refuses that). */
export function stateSummarySubject(input: NcStateSummarySubjectInput): NcRuleSubject | null {
  const kind = input.rule.conditions.systemEvent?.kinds[0]
  if (kind === undefined) return null
  return {
    kind: 'system-event',
    recordId: recordBaseOf(input),
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: input.window.endMs,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `state-summary:${input.rule.id}`,
      titleKey: NC_STATE_SUMMARY_TITLE_KEY,
      bodyKey: NC_STATE_SUMMARY_BODY_KEY,
      textParams: {
        summaryText: input.text.text,
        summaryCount: String(input.text.count),
        // Every section the row reports, named (D698) — one on a per-section row.
        summarySection: input.text.sections.map((section) => section.title).join(', '),
        ...input.text.sectionVars,
      },
      textCount: input.text.count,
      data: {
        stateSummary: true,
        windowStartMs: input.window.startMs,
        windowEndMs: input.window.endMs,
        sections: input.summary.sections.map((section) => ({
          id: section.id,
          status: section.status,
          items: section.items.length,
        })),
      },
    },
  }
}

export interface NcStateSummarySubjectsInput extends NcStateSummarySubjectInput {
  readonly split: NcStateSummarySplit
}

/**
 * The rows one summary window sends. `rule`: the one D647 row. `section`: one
 * row per section with something to say — its items, or the sentence that it
 * is UNAVAILABLE, exactly as the combined text words it. A section with
 * nothing open sends nothing; neither does a summary with nothing at all.
 */
export function stateSummarySubjects(input: NcStateSummarySubjectsInput): readonly NcRuleSubject[] {
  if (input.split === 'rule') {
    const subject = stateSummarySubject(input)
    return subject === null ? [] : [subject]
  }
  const kinds = input.rule.conditions.systemEvent?.kinds ?? []
  const first = kinds[0]
  if (first === undefined) return []
  return input.text.sections.map((section) =>
    sectionSubject(input, sectionKindOf(kinds, section.id) ?? first, section),
  )
}

type NcSummaryRowKind = NonNullable<NcRuleSubject['systemEvent']>['kind']

/**
 * The kind a per-section row carries (D708): the rule's first selected kind OF
 * THAT SECTION — never the rule's first kind overall, which put an addon
 * update's kind on the nodes row. A section is reported only because the rule
 * selected one of its kinds, so the fallback (the section's own first kind)
 * is defensive; `undefined` only for a section with no kinds (none exists).
 */
export function sectionKindOf(
  ruleKinds: readonly NcSummaryRowKind[],
  section: NcStateSectionId,
): NcSummaryRowKind | undefined {
  const own = sectionKinds(section)
  return ruleKinds.find((kind) => own.includes(kind)) ?? own[0]
}

function sectionSubject(
  input: NcStateSummarySubjectsInput,
  kind: NcSummaryRowKind,
  section: NcStateSectionText,
): NcRuleSubject {
  // Every section variable the rule reports is present, and only this
  // section's is filled: a custom body naming `{{summaryBattery}}` renders it
  // on the battery row and nothing on the others.
  const sectionVars: Record<string, string> = {}
  for (const name of Object.keys(input.text.sectionVars)) sectionVars[name] = ''
  sectionVars[NC_STATE_SECTION_VAR[section.id]] = section.text
  return {
    kind: 'system-event',
    recordId: sectionRecordId(recordBaseOf(input), section.id),
    deviceId: NC_SYSTEM_DEVICE_ID,
    timestamp: input.window.endMs,
    classNames: [],
    zones: [],
    systemEvent: {
      kind,
      subject: `state-summary:${input.rule.id}:${section.id}`,
      titleKey: NC_STATE_SUMMARY_SECTION_TITLE_KEY,
      bodyKey: NC_STATE_SUMMARY_SECTION_BODY_KEY,
      textParams: {
        summaryText: section.body,
        summaryCount: String(section.count),
        summarySection: section.title,
        ...sectionVars,
      },
      textCount: section.count,
      data: {
        stateSummary: true,
        section: section.id,
        windowStartMs: input.window.startMs,
        windowEndMs: input.window.endMs,
        sections: [{ id: section.id, status: section.status, items: section.count }],
      },
    },
  }
}

/** The section a per-section row is about (`data.section`), or `undefined` on a combined row. */
export function stateSummarySectionOf(subject: NcRuleSubject): NcStateSectionId | undefined {
  const section = subject.systemEvent?.data['section']
  return typeof section === 'string' && isStateSectionId(section) ? section : undefined
}

/** Does a body name `{{summaryText}}` or this section's own variable? */
function bodyCarriesSection(body: string, section: NcStateSectionId): boolean {
  const names = new RegExp(`\\{\\{\\s*(?:summaryText|${NC_STATE_SECTION_VAR[section]})\\s*\\}\\}`)
  return names.test(body)
}

/**
 * The rule as its summary is ENQUEUED: a custom body that carries none of the
 * summary's content gets `{{summaryText}}` appended on its own line, so an
 * operator's body never sends an empty summary (review M3). `null` = unchanged.
 *
 * On a per-SECTION row (D698 review M3) the content is THIS section's: a body
 * naming only `{{summaryBattery}}` carries the battery row and nothing on the
 * streams row, so every other section's row gets `{{summaryText}}` — its own
 * lines — appended.
 */
export function withSummaryBody(rule: NcRule, section?: NcStateSectionId): NcRule | null {
  const body = rule.template?.body
  if (templateCarriesSummary(body)) {
    if (section === undefined || body === undefined || body.trim().length === 0) return null
    if (bodyCarriesSection(body, section)) return null
  }
  return { ...rule, template: { ...rule.template, body: `${body ?? ''}\n{{summaryText}}` } }
}
