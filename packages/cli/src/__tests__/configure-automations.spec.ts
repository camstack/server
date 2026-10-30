/**
 * The two interviews and their gated saves. The fake hub answers the reads the
 * interview makes; the writes are asserted on the recorded calls.
 */
import { describe, expect, it } from 'vitest'
import { automationQuestionnaire, saveAutomation } from '../mcp/configure-automations.js'
import { ncRuleQuestionnaire, saveRule } from '../mcp/configure-nc-rules.js'
import { withWrites } from './configure-gate-ctx.js'
import { fakeHub } from './ops-fake-hub.js'

const ZONE_ID = '11111111-1111-4111-8111-111111111111'

const hubReads = {
  'deviceManager.listAll': [
    { id: 7, name: 'Driveway' },
    { id: 8, name: 'Garden' },
  ],
  'zones.listZones': [{ id: ZONE_ID, name: 'Gate', kind: 'polygon' }],
  'deviceManager.getWireableFields': {
    caps: [
      {
        cap: 'pet-feeder',
        fields: [{ path: 'bowlFood', kind: 'number', quantity: 'mass' }],
      },
    ],
  },
  'deviceManager.getBindings': { entries: [{ capName: 'pet-feeder' }] },
  'coreBlocks.list': [],
  'coreBlocks.create': { id: 'blk-1' },
  'notificationOutput.listTargets': [
    {
      id: 'tg-1',
      name: 'Phone',
      kind: 'ntfy',
      enabled: true,
      config: { chatId: 'SECRET-CHAT' },
    },
  ],
}

describe('configure_automation_questionnaire', () => {
  it('asks for the trigger first, then only what is missing', async () => {
    const { ctx } = fakeHub(hubReads)
    const first = await automationQuestionnaire(ctx, {})
    expect(first).toMatchObject({
      status: 'need-answers',
      questions: [{ field: 'trigger.kind' }],
    })

    const second = await automationQuestionnaire(ctx, {
      trigger: {
        kind: 'detection',
        cameras: [7],
        classes: ['person'],
        zones: [],
      },
    })
    if (second.status !== 'need-answers') throw new Error('expected need-answers')
    expect(second.questions.map((q) => q.field)).toEqual(['conditions', 'actions', 'name'])
  })

  it('offers the hub cameras and refuses a camera that does not exist', async () => {
    const { ctx } = fakeHub(hubReads)
    const ask = await automationQuestionnaire(ctx, {
      trigger: { kind: 'detection' },
    })
    if (ask.status !== 'need-answers') throw new Error('expected need-answers')
    expect(ask.questions[0]?.choices).toEqual([
      { value: 7, label: 'Driveway' },
      { value: 8, label: 'Garden' },
    ])
    const bad = await automationQuestionnaire(ctx, {
      trigger: { kind: 'detection', cameras: [99], classes: ['person'] },
    })
    expect(bad).toMatchObject({
      status: 'need-answers',
      problems: [{ field: 'trigger.cameras' }],
    })
  })

  it('resolves a zone by name to its id', async () => {
    const { ctx } = fakeHub(hubReads)
    const ready = await automationQuestionnaire(ctx, {
      name: 'Gate alert',
      trigger: {
        kind: 'detection',
        cameras: [7],
        classes: ['person'],
        zones: ['gate'],
      },
      conditions: [],
      actions: [{ kind: 'wait', seconds: 1 }],
    })
    if (ready.status !== 'ready') throw new Error(JSON.stringify(ready))
    expect(ready.recipe.when).toMatchObject({
      kind: 'detection',
      zones: [ZONE_ID],
      subjects: [{ macro: 'person' }],
    })
  })

  it('stamps a bare quantity number with its base unit and says so', async () => {
    const { ctx } = fakeHub(hubReads)
    const ready = await automationQuestionnaire(ctx, {
      name: 'Feed',
      trigger: { kind: 'schedule', time: '07:30' },
      conditions: [
        {
          deviceId: 201,
          cap: 'pet-feeder',
          fieldPath: 'bowlFood',
          operator: 'lt',
          value: 0.05,
        },
      ],
      actions: [
        {
          kind: 'cap',
          deviceId: 201,
          cap: 'pet-feeder',
          method: 'feed',
          args: { grams: 30 },
        },
      ],
    })
    if (ready.status !== 'ready') throw new Error(JSON.stringify(ready))
    expect(ready.recipe.when).toMatchObject({
      kind: 'all',
      children: [{ kind: 'schedule' }, { kind: 'device-is', value: 0.05, unit: 'kg' }],
    })
    expect(ready.quantities).toContainEqual(expect.objectContaining({ value: 0.05, unit: 'kg' }))
  })

  it('refuses a unit of another dimension with the reason', async () => {
    const { ctx } = fakeHub(hubReads)
    const out = await automationQuestionnaire(ctx, {
      name: 'Feed',
      trigger: { kind: 'schedule', time: '07:30' },
      conditions: [
        {
          deviceId: 201,
          cap: 'pet-feeder',
          fieldPath: 'bowlFood',
          operator: 'lt',
          value: { value: 3, unit: 'm' },
        },
      ],
      actions: [{ kind: 'wait', seconds: 1 }],
    })
    expect(out).toMatchObject({ status: 'need-answers' })
    expect(JSON.stringify(out)).toMatch(/cross-dimension/)
  })
})

describe('configure_automation_save', () => {
  const recipe = {
    when: { kind: 'schedule' as const, cron: '30 7 * * *' },
    actions: [{ kind: 'wait' as const, seconds: 1 }],
  }

  it('previews without writing, then creates the block with the confirm token', async () => {
    const { ctx, calls } = fakeHub(hubReads)
    const writable = withWrites(ctx)
    const preview = await saveAutomation(
      writable,
      { name: 'Morning', recipe, enabled: true },
      undefined,
    )
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    expect(calls.some((c) => c.path === 'coreBlocks.create')).toBe(false)

    const done = await saveAutomation(
      writable,
      { name: 'Morning', recipe, enabled: true },
      preview.confirm_token,
    )
    expect(done.status).toBe('executed')
    const create = calls.find((c) => c.path === 'coreBlocks.create')
    expect(create?.input).toMatchObject({
      block: { name: 'Morning', enabled: true, placement: 'hub' },
    })
  })

  it('refuses a name that already exists', async () => {
    const { ctx } = fakeHub({
      ...hubReads,
      'coreBlocks.list': [{ id: 'b', name: 'Morning' }],
    })
    const out = await saveAutomation(
      withWrites(ctx),
      { name: 'Morning', recipe, enabled: true },
      undefined,
    )
    expect(JSON.stringify(out)).toMatch(/already exists/)
  })

  it('refuses a non-admin session', async () => {
    const { ctx } = fakeHub(hubReads, 'protected')
    const out = await saveAutomation(
      withWrites(ctx),
      { name: 'x', recipe, enabled: true },
      undefined,
    )
    expect(out).toMatchObject({ status: 'refused' })
  })
})

describe('configure_notification_rule_questionnaire', () => {
  it('asks the open questions with hub choices, never leaking a target config', async () => {
    const { ctx } = fakeHub(hubReads)
    const out = await ncRuleQuestionnaire(ctx, { cameras: [7] })
    if (out.status !== 'need-answers') throw new Error('expected need-answers')
    expect(out.questions.map((q) => q.field)).toEqual(
      expect.arrayContaining(['delivery', 'classes', 'zones', 'quietHours', 'targets', 'name']),
    )
    expect(JSON.stringify(out)).not.toContain('SECRET-CHAT')
  })

  it('builds a rule with quiet hours as an inverted schedule and zone ids', async () => {
    const { ctx } = fakeHub(hubReads)
    const out = await ncRuleQuestionnaire(ctx, {
      name: 'Gate person',
      delivery: 'immediate',
      cameras: [7],
      classes: ['person'],
      zones: ['Gate'],
      quietHours: { from: '22:00', to: '06:00' },
      targets: ['Phone'],
    })
    if (out.status !== 'ready') throw new Error(JSON.stringify(out))
    expect(out.rule.conditions).toMatchObject({
      devices: [7],
      classes: ['person'],
      zones: { ids: [ZONE_ID] },
    })
    expect(out.rule.schedule).toMatchObject({
      invert: true,
      windows: [{ startMinute: 1320, endMinute: 360 }],
    })
    expect(out.rule.targets).toEqual([{ targetId: 'tg-1' }])
  })

  it('treats quietHours null as answered (none)', async () => {
    const { ctx } = fakeHub(hubReads)
    const out = await ncRuleQuestionnaire(ctx, {
      name: 'n',
      delivery: 'track-end',
      cameras: [],
      classes: ['person'],
      zones: [],
      quietHours: null,
      targets: ['tg-1'],
    })
    if (out.status !== 'ready') throw new Error(JSON.stringify(out))
    expect(out.rule.schedule).toBeUndefined()
  })
})

describe('configure_notification_rule_save', () => {
  const ruleBase = {
    name: 'Gate person',
    enabled: true,
    delivery: 'immediate' as const,
    conditions: { classes: ['person'], source: 'pipeline' as const },
    targets: [{ targetId: 'tg-1' }],
    media: { image: 'crop' as const },
    throttle: { cooldownSec: 60, scope: 'rule-device' as const },
    priority: 3,
  }

  it('creates through createRule', async () => {
    const { ctx, calls } = fakeHub({
      ...hubReads,
      'notificationRules.createRule': { id: 'r1' },
    })
    const writable = withWrites(ctx)
    const preview = await saveRule(writable, { rule: ruleBase }, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    await saveRule(writable, { rule: ruleBase }, preview.confirm_token)
    expect(calls.find((c) => c.path === 'notificationRules.createRule')?.input).toMatchObject({
      rule: { name: 'Gate person' },
    })
  })

  it('an update sends the FULL conditions: stored keys the interview does not author survive', async () => {
    const stored = {
      id: 'r1',
      name: 'old',
      conditions: {
        classes: ['dog'],
        labelEquals: ['Anna'],
        classesExclude: ['cat'],
        minConfidence: 0.9,
      },
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 60 }] },
    }
    const { ctx, calls } = fakeHub({
      ...hubReads,
      'notificationRules.getRule': stored,
      'notificationRules.updateRule': { id: 'r1' },
    })
    const writable = withWrites(ctx)
    const preview = await saveRule(writable, { rule: ruleBase, ruleId: 'r1' }, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    await saveRule(writable, { rule: ruleBase, ruleId: 'r1' }, preview.confirm_token)
    const sent = calls.find((c) => c.path === 'notificationRules.updateRule')?.input
    expect(sent).toMatchObject({
      ruleId: 'r1',
      patch: {
        conditions: {
          classes: ['person'],
          labelEquals: ['Anna'],
          classesExclude: ['cat'],
        },
      },
      clear: ['schedule'],
    })
  })

  it('refuses a rule that names an unknown target', async () => {
    const { ctx } = fakeHub(hubReads)
    const out = await saveRule(
      withWrites(ctx),
      { rule: { ...ruleBase, targets: [{ targetId: 'ghost' }] } },
      undefined,
    )
    expect(JSON.stringify(out)).toMatch(/unknown notification target/)
  })
})
