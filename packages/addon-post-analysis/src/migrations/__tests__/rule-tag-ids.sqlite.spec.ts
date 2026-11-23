/**
 * Every notification rule that carries tags gets `tagIds` beside its kept `tags` names (D1089),
 * as ONE plan on the REAL records engine and real SQLite. A marked field per rule kind survives,
 * a rule with ids and a rule without tags are left alone, a rerun plans nothing, a rule that
 * changed since the plan read it refuses the whole plan, and a failing edit rolls every kind back.
 */
import {
  NcRuleInputSchema,
  type MigrationPlan,
  tagIdFromKey,
  TimelapseRuleInputSchema,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { migrateTargetOf } from '../../../../system/src/builtins/sqlite-storage/migrations/migration-pass.js'
import { NcCalendarEventsRuleInputSchema } from '../../notification-center/calendar-events/calendar-events-rule.js'
import { ncRecordKinds, RuleBodySchema } from '../../notification-center/record-kinds.js'
import { NcSummaryRuleInputSchema } from '../../notification-center/summary/summary-rule.js'
import { ADDON_MIGRATIONS, RULE_TAG_IDS_MIGRATION_ID } from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const GARDEN = tagIdFromKey('garden')
const NIGHT = tagIdFromKey('night')
const SCHEDULE = { windows: [{ days: [1, 2, 3], startMinute: 480, endMinute: 1080 }] }
const TARGETS = [{ targetId: 'tgt-1' }]
const STAMP = { createdBy: 'admin', createdAt: 1, updatedAt: 1 }

async function world() {
  const w = await makeNcWorld()
  const kinds = w.ncPorts.tagRuleKinds
  await kinds.rules.put({
    id: 'rule-1',
    data: RuleBodySchema.parse({
      ...NcRuleInputSchema.parse({
        name: 'Marked rule',
        delivery: 'immediate',
        targets: TARGETS,
        conditions: { classes: ['person'] },
        tags: [' Garden ', 'garden', 'Night'],
      }),
      disabledTargetIds: [],
      ...STAMP,
    }),
  })
  await kinds.rules.put({
    id: 'rule-untagged',
    data: RuleBodySchema.parse({
      ...NcRuleInputSchema.parse({
        name: 'No tags',
        delivery: 'immediate',
        targets: TARGETS,
        conditions: { classes: ['person'] },
      }),
      disabledTargetIds: [],
      ...STAMP,
    }),
  })
  await kinds.summaryRules.put({
    id: 'sum-1',
    data: {
      ...NcSummaryRuleInputSchema.parse({
        name: 'Marked digest',
        deviceIds: [101],
        window: { kind: 'schedule', schedule: SCHEDULE },
        targets: TARGETS,
        tags: ['Garden'],
      }),
      ...STAMP,
    },
  })
  await kinds.timelapseRules.put({
    id: 'tl-1',
    data: {
      ...TimelapseRuleInputSchema.parse({
        name: 'Marked timelapse',
        targets: TARGETS,
        deviceIds: [101],
        schedule: SCHEDULE,
        tags: ['Night'],
      }),
      ...STAMP,
    },
  })
  await kinds.calendarEventsRules.put({
    id: 'cal-1',
    data: {
      ...NcCalendarEventsRuleInputSchema.parse({
        name: 'Marked calendar',
        schedule: SCHEDULE,
        targets: TARGETS,
        tags: ['Garden'],
        tagIds: ['tag_already'],
      }),
      ...STAMP,
    },
  })
  const entry = ADDON_MIGRATIONS.find((m) => m.meta.id === RULE_TAG_IDS_MIGRATION_ID)
  if (entry === undefined || !('plan' in entry)) throw new Error('catalogue entry missing')
  const target = migrateTargetOf(w.db, 'settings', [], w.engine.migrationWriter())
  let boot = 0
  return {
    w,
    kinds,
    plan: (): Promise<MigrationPlan> =>
      entry.plan({
        ...w.ncPorts,
        listDeviceIds: async () => [],
        readDeviceField: async () => new Map(),
        readStored: async () => ({}),
        announceRetired: async () => undefined,
      }),
    apply: async (plan: MigrationPlan) => {
      boot += 1
      return target.applyPlan({
        meta: entry.meta,
        plan,
        bootId: `boot-${boot}`,
        codeVersion: '1.0.0',
      })
    },
  }
}

describe('rule tag ids (D1089)', () => {
  it('adds the ids beside the names on every kind and keeps every marked field', async () => {
    const f = await world()
    expect((await f.apply(await f.plan())).status).toBe('applied')

    const rule = (await f.kinds.rules.get('rule-1'))?.data
    expect(rule).toMatchObject({
      name: 'Marked rule',
      tags: ['Garden', 'Night'],
      tagIds: [GARDEN, NIGHT],
    })
    expect(rule?.conditions).toMatchObject({ classes: ['person'] })
    expect((await f.kinds.summaryRules.get('sum-1'))?.data).toMatchObject({
      name: 'Marked digest',
      deviceIds: [101],
      tags: ['Garden'],
      tagIds: [GARDEN],
    })
    expect((await f.kinds.timelapseRules.get('tl-1'))?.data).toMatchObject({
      name: 'Marked timelapse',
      tags: ['Night'],
      tagIds: [NIGHT],
    })
    // A rule that already carries ids keeps exactly those; one without tags gains nothing.
    expect((await f.kinds.calendarEventsRules.get('cal-1'))?.data).toMatchObject({
      tags: ['Garden'],
      tagIds: ['tag_already'],
    })
    expect((await f.kinds.rules.get('rule-untagged'))?.data.tagIds).toBeUndefined()
  })

  it('a rerun plans nothing', async () => {
    const f = await world()
    await f.apply(await f.plan())
    expect((await f.plan()).edits).toEqual([])
  })

  it('refuses the whole plan when a rule changed since the plan read it', async () => {
    const f = await world()
    const plan = await f.plan()
    const current = await f.kinds.timelapseRules.get('tl-1')
    if (current === null) throw new Error('fixture')
    await f.kinds.timelapseRules.put({
      id: 'tl-1',
      data: { ...current.data, name: 'Edited since' },
    })
    const out = await f.apply(plan)
    expect(out.status).toBe('failed')
    // Nothing of the other kinds was written either: one transaction.
    expect((await f.kinds.rules.get('rule-1'))?.data.tagIds).toBeUndefined()
    expect((await f.kinds.summaryRules.get('sum-1'))?.data.tagIds).toBeUndefined()
  })

  it('rolls every kind back when one edit cannot be applied', async () => {
    const f = await world()
    const plan = await f.plan()
    const broken: MigrationPlan = {
      edits: [
        ...plan.edits,
        {
          op: 'deleteRecord',
          owner: 'pipeline-analytics',
          kind: ncRecordKinds.rules.name,
          recordKey: 'no-such-rule',
          precondition:
            plan.edits[0]?.op === 'upsertRecord' ? plan.edits[0].precondition : undefined,
        },
      ],
    }
    const out = await f.apply(broken)
    expect(out.status).toBe('failed')
    expect((await f.kinds.rules.get('rule-1'))?.data.tagIds).toBeUndefined()
    expect((await f.kinds.timelapseRules.get('tl-1'))?.data.tagIds).toBeUndefined()
  })
})
