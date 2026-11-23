/**
 * Every notification rule that carries tags gets the ids of those tags (D1089, the
 * notification-center step of the tags migration): `tagIds` is added beside the kept `tags`
 * names, index-aligned, each id derived from the folded name (`tagIdFromKey`) exactly as the
 * device manager and the core-blocks steps derive it, so the three owners agree without
 * reading each other. The names stay for one release.
 *
 * One PLAN, one transaction: the four rule kinds (event rules, digests, timelapses,
 * calendar-events rules) are rewritten together or not at all, each edit guarded by the body
 * the plan read. A rule with no tags, or one that already has ids, is left alone, so a rerun
 * plans nothing. A rule whose names repeat one tag in two spellings is rewritten with the
 * names de-duplicated too, so the alignment holds.
 */
import {
  type MigrationPlan,
  normalizeTags,
  type RecordKindHandle,
  recordUpsertEdit,
  tagIdFromKey,
  tagKey,
} from '@camstack/types'
import {
  type CalendarEventsRuleBody,
  ncRecordKinds,
  type RuleBody,
  type SummaryRuleBody,
  type TimelapseRuleBody,
} from '../notification-center/record-kinds.js'
import { allRows } from './device-template-var.js'
import { PIPELINE_ANALYTICS_ID } from './split-enabled-key.js'

export const RULE_TAG_IDS_MIGRATION_ID = 'pipeline-analytics/2026-11-23-rule-tag-ids'

/** The four stores whose rules carry tags, as the migration reads them. */
export interface RuleTagIdsPorts {
  readonly tagRuleKinds: {
    readonly rules: RecordKindHandle<RuleBody>
    readonly summaryRules: RecordKindHandle<SummaryRuleBody>
    readonly timelapseRules: RecordKindHandle<TimelapseRuleBody>
    readonly calendarEventsRules: RecordKindHandle<CalendarEventsRuleBody>
  }
}

interface Tagged {
  readonly tags?: readonly string[]
  readonly tagIds?: readonly string[]
}

/** What to add to a rule, or `null` when it has no tags or already has ids. */
function tagFieldsOf(body: Tagged): { tags?: string[]; tagIds: string[] } | null {
  if (body.tagIds !== undefined) return null
  const names = normalizeTags(body.tags ?? [])
  if (names.length === 0) return null
  const tagIds = names.map((name) => tagIdFromKey(tagKey(name)))
  return names.length === (body.tags ?? []).length ? { tagIds } : { tags: names, tagIds }
}

export async function planRuleTagIds(ports: RuleTagIdsPorts): Promise<MigrationPlan> {
  const kinds = ports.tagRuleKinds
  const owner = PIPELINE_ANALYTICS_ID
  const edits: MigrationPlan['edits'][number][] = []
  for (const row of await allRows(kinds.rules)) {
    const add = tagFieldsOf(row.data)
    if (add === null) continue
    edits.push(
      recordUpsertEdit({
        owner,
        kind: ncRecordKinds.rules,
        id: row.id,
        data: { ...row.data, ...add },
        read: row.data,
      }),
    )
  }
  for (const row of await allRows(kinds.summaryRules)) {
    const add = tagFieldsOf(row.data)
    if (add === null) continue
    edits.push(
      recordUpsertEdit({
        owner,
        kind: ncRecordKinds['summary-rules'],
        id: row.id,
        data: { ...row.data, ...add },
        read: row.data,
      }),
    )
  }
  for (const row of await allRows(kinds.timelapseRules)) {
    const add = tagFieldsOf(row.data)
    if (add === null) continue
    edits.push(
      recordUpsertEdit({
        owner,
        kind: ncRecordKinds['timelapse-rules'],
        id: row.id,
        data: { ...row.data, ...add },
        read: row.data,
      }),
    )
  }
  for (const row of await allRows(kinds.calendarEventsRules)) {
    const add = tagFieldsOf(row.data)
    if (add === null) continue
    edits.push(
      recordUpsertEdit({
        owner,
        kind: ncRecordKinds['calendar-events-rules'],
        id: row.id,
        data: { ...row.data, ...add },
        read: row.data,
      }),
    )
  }
  return { edits }
}
