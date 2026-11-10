/**
 * The two interviews and their gated saves. The fake hub answers the reads the
 * interview makes; the writes are asserted on the recorded calls.
 */
import { describe, expect, it } from 'vitest'
import { automationQuestionnaire, saveAutomation } from '../mcp/configure-automations.js'
import { ncRuleQuestionnaire, saveRule } from '../mcp/configure-nc-rules.js'
import { notificationTargetAnswers } from './configure-fixtures.js'
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
  ...notificationTargetAnswers([
    {
      id: 'tg-1',
      name: 'Phone',
      kind: 'ntfy',
      enabled: true,
      config: { chatId: 'SECRET-CHAT' },
    },
  ]),
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

  it('writes the target shape: a deviceId list becomes target.devices, a domain target passes through', async () => {
    const { ctx } = fakeHub(hubReads)
    const ready = await automationQuestionnaire(ctx, {
      name: 'Feed everyone',
      trigger: { kind: 'schedule', time: '07:30' },
      conditions: [],
      actions: [
        { kind: 'cap', deviceId: [7, 9], cap: 'pet-feeder', method: 'feed', args: { grams: 30 } },
        {
          kind: 'cap',
          target: { kind: 'domain', roomId: 'Kitchen' },
          actionId: 'cover.open',
          cap: 'pet-feeder',
          method: 'feed',
        },
      ],
    })
    if (ready.status !== 'ready') throw new Error(JSON.stringify(ready))
    expect(ready.recipe.actions[0]).toMatchObject({ target: { kind: 'devices', ids: [7, 9] } })
    expect(ready.recipe.actions[0]).not.toHaveProperty('deviceId')
    expect(ready.recipe.actions[1]).toMatchObject({
      target: { kind: 'domain', roomId: 'Kitchen' },
      actionId: 'cover.open',
    })
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

  describe('device templates in step text', () => {
    const textRecipe = (message: string) => ({
      when: { kind: 'schedule' as const, cron: '30 7 * * *' },
      actions: [
        {
          kind: 'cap' as const,
          target: { kind: 'devices' as const, ids: [7] },
          cap: 'notifier',
          method: 'send',
          args: { message },
        },
      ],
    })

    it('vets a templated argument before offering the save, and passes a valid one', async () => {
      const { ctx, calls } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': { results: [{ ok: true, aliases: [] }] },
      })
      const out = await saveAutomation(
        withWrites(ctx),
        {
          name: 'Door',
          recipe: textRecipe('Door is {{ door.state }} {{ vars.who }}'),
          enabled: true,
        },
        undefined,
      )
      expect(out.status).toBe('dry-run')
      const check = calls.find((c) => c.path === 'deviceManager.checkDeviceTemplates')
      expect(check?.input).toEqual({ templates: ['Door is {{ door.state }} ·'] })
    })

    it('prints the hub refusal with its reason and offers no save', async () => {
      const { ctx, calls } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': {
          results: [{ ok: false, refusal: { reason: 'syntax', message: 'unexpected }}' } }],
        },
      })
      const out = await saveAutomation(
        withWrites(ctx),
        { name: 'Door', recipe: textRecipe('{{ door.state'), enabled: true },
        undefined,
      )
      expect(JSON.stringify(out)).toMatch(/refused \(syntax\): unexpected/)
      expect(calls.some((c) => c.path === 'coreBlocks.create')).toBe(false)
    })

    it('does not ask the hub when no step text carries a device template', async () => {
      const { ctx, calls } = fakeHub(hubReads)
      await saveAutomation(
        withWrites(ctx),
        { name: 'Door', recipe: textRecipe('plain {{ vars.who }}'), enabled: true },
        undefined,
      )
      expect(calls.some((c) => c.path === 'deviceManager.checkDeviceTemplates')).toBe(false)
    })

    it('a bare {{name}} is template markup at run time, so it is vetted (only {{vars.x}} is a held slot)', async () => {
      const { ctx, calls } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': { results: [{ ok: true, aliases: [] }] },
      })
      await saveAutomation(
        withWrites(ctx),
        { name: 'Door', recipe: textRecipe('hi {{who}} {{vars.x}}'), enabled: true },
        undefined,
      )
      expect(calls.find((c) => c.path === 'deviceManager.checkDeviceTemplates')?.input).toEqual({
        templates: ['hi {{who}} ·'],
      })
    })

    it('refuses when the hub cannot be asked', async () => {
      const { ctx, calls } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': new Error('hub unreachable'),
      })
      const out = await saveAutomation(
        withWrites(ctx),
        { name: 'Door', recipe: textRecipe('{{ door.state }}'), enabled: true },
        undefined,
      )
      expect(JSON.stringify(out)).toMatch(/could not vet the device templates: .*hub unreachable/)
      expect(JSON.stringify(out)).not.toContain('confirm_token')
      expect(calls.some((c) => c.path === 'coreBlocks.create')).toBe(false)
    })

    it('refuses when the hub answers fewer verdicts than templates', async () => {
      const { ctx } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': { results: [] },
      })
      const out = await saveAutomation(
        withWrites(ctx),
        { name: 'Door', recipe: textRecipe('{{ door.state }}'), enabled: true },
        undefined,
      )
      expect(JSON.stringify(out)).toMatch(/0 verdict\(s\) for 1 template/)
    })

    it('vets more than 64 templates in several calls and stops at the first refusal', async () => {
      const many = {
        when: { kind: 'schedule' as const, cron: '30 7 * * *' },
        actions: Array.from({ length: 70 }, (_, i) => ({
          kind: 'cap' as const,
          target: { kind: 'devices' as const, ids: [7] },
          cap: 'notifier',
          method: 'send',
          args: { message: `{{ door${i}.state }}` },
        })),
      }
      const sizes: number[] = []
      const { ctx } = fakeHub({
        ...hubReads,
        'deviceManager.checkDeviceTemplates': (input: { templates: string[] }) => {
          sizes.push(input.templates.length)
          return { results: input.templates.map(() => ({ ok: true, aliases: [] })) }
        },
      })
      const out = await saveAutomation(
        withWrites(ctx),
        { name: 'Many', recipe: many, enabled: true },
        undefined,
      )
      expect(sizes).toEqual([64, 6])
      expect(out.status).toBe('dry-run')
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
