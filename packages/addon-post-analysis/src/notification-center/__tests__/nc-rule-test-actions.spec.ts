/**
 * The two bridge actions behind the per-rule Test button and the live status
 * line: `nc.testRule` and `nc.getRuleStatus`.
 *
 * What is pinned here is the part the pure planner cannot be: the AUTH and the
 * WIRING. `nc.testRule` delivers to other people's phones and bypasses two side
 * gates, so it is admin-only with a fail-closed caller check, exactly like the
 * injection it wraps. `nc.getRuleStatus` is a live fact about somebody's camera,
 * so it refuses a rule the caller cannot see BEFORE reading anything.
 *
 * And one thing that is easy to get wrong and invisible when wrong: the status
 * action has to route by WHICH STORE owns the id — the same id space holds
 * detection rules and timelapse rules — and apply that store's own ownership
 * rule.
 */

import { NcRuleAiStore } from '../rule-ai-store.js'
import { ncRecordKinds } from '../record-kinds.js'
import type { NcRuleInput } from '@camstack/types'
import { NcRuleInputSchema, RecordingConfigSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcActionHandlers, type NcActionHandlers } from '../nc-actions.js'
import { NcRuleStore } from '../rule-store.js'
import type { NcTestEventInput, NcTestEventResult } from '../test-event.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const ADMIN = { userId: 'admin', isAdmin: true }
const USER = { userId: 'u1', isAdmin: false }

const SCHEDULE = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1320, endMinute: 360 }],
  timezone: 'UTC',
}

function ruleInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Animale su aiuola',
    delivery: 'immediate',
    targets: [{ targetId: 't-own' }],
    conditions: { devices: [102], classes: ['animal'] },
    ...overrides,
  })
}

interface Ctx {
  readonly handlers: NcActionHandlers
  readonly ruleStore: NcRuleStore
  readonly timelapse: TimelapseStore
  readonly injections: NcTestEventInput[]
  readonly statusCalls: string[]
}

async function makeCtx(): Promise<Ctx> {
  const world = makeNcRecords()
  const ruleStore = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
    newId: () => 'r1',
  })
  const ruleAiStore = NcRuleAiStore.of(world.records, makeSilentLogger())
  const timelapse = new TimelapseStore({
    kind: world.records.kind(ncRecordKinds['timelapse-rules']),
    logger: makeSilentLogger(),
    newId: () => 'tl1',
  })

  const injections: NcTestEventInput[] = []
  const statusCalls: string[] = []
  const handlers = makeNcActionHandlers({
    ruleStore,
    ruleAiStore,
    logger: makeSilentLogger(),
    listCallerTargetIds: async (userId) => (userId === 'u1' ? ['t-own'] : []),
    snooze: {
      list: () => [],
      create: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
    },
    injectTestEvent: async (input): Promise<NcTestEventResult> => {
      injections.push(input)
      return {
        recordId: 'synthetic:1',
        origin: 'synthetic',
        delivery: 'immediate',
        candidates: 1,
        outcomes: [
          {
            ruleId: 'r1',
            ruleName: 'Animale su aiuola',
            matched: true,
            cooldown: 'bypassed',
            enqueued: 1,
            targetIds: ['t-own'],
          },
        ],
        still: 'live',
        notes: [],
      }
    },
    timelapse: {
      store: timelapse,
      getRecordingConfig: async () =>
        RecordingConfigSchema.parse({
          enabled: true,
          bands: [
            { mode: 'continuous', days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1439 },
          ],
        }),
      runNow: async () => ({ produced: 1, window: { startMs: 1, endMs: 2 } }),
    },
    ruleStatus: {
      forRule: async (rule) => {
        statusCalls.push(`rule:${rule.id}`)
        return { kind: 'none', reason: 'nothing to report' }
      },
      forTimelapseRule: async (rule) => {
        statusCalls.push(`timelapse:${rule.id}`)
        return { kind: 'timelapse', devices: [], settleMs: 300_000 }
      },
    },
  })
  return { handlers, ruleStore, timelapse, injections, statusCalls }
}

describe('nc.testRule', () => {
  it('plans the injection from the rule and narrows it to that rule', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput(), 'admin')
    const result = await ctx.handlers['nc.testRule']({ ruleId: created.id }, ADMIN)

    expect(ctx.injections).toHaveLength(1)
    const sent = ctx.injections[0]!
    expect(sent.onlyRuleId).toBe(created.id)
    expect(sent.trigger).toBe('object-event')
    expect(sent.deviceId).toBe(102)
    expect(sent.classNames).toEqual(['animal'])
    // Both side gates bypassed, the actions never run — see the plan's docblock.
    expect(sent.bypassCooldown).toBe(true)
    expect(sent.bypassMute).toBe(true)
    expect(sent.runActions).toBe(false)
    // The trigger travels back: "why was my rule not a candidate" is the
    // commonest reading of a test that reported nothing.
    expect(result.trigger).toBe('object-event')
    expect(result.outcomes[0]?.matched).toBe(true)
  })

  it('carries the plan’s notes to the caller', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(
      ruleInput({
        conditions: { devices: [102], deviceState: { deviceId: 9, states: ['armed_away'] } },
      }),
      'admin',
    )
    const result = await ctx.handlers['nc.testRule']({ ruleId: created.id }, ADMIN)
    expect(result.planNotes.map((n) => n.conditionId)).toContain('deviceState')
  })

  it('a GROUPED rule: the injection closes the window at once, and the report says so (D692)', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput({ groupingSec: 20 }), 'admin')
    const result = await ctx.handlers['nc.testRule']({ ruleId: created.id }, ADMIN)

    expect(result.planNotes).toContainEqual({
      conditionId: 'grouping',
      note: 'grouped: window of 20 s; a test sends a group of one',
    })
  })

  it('a plain rule says nothing about grouping', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput(), 'admin')
    const result = await ctx.handlers['nc.testRule']({ ruleId: created.id }, ADMIN)
    expect(result.planNotes.map((n) => n.conditionId)).not.toContain('grouping')
  })

  it('a SUMMARY rule still takes the summary route and injects nothing (D698)', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(
      NcRuleInputSchema.parse({
        name: 'Stato batterie',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-battery-low'] } },
        systemEventDelivery: { mode: 'summary', schedule: SCHEDULE },
        targets: [{ targetId: 't-own' }],
      }),
      'admin',
    )
    await expect(ctx.handlers['nc.testRule']({ ruleId: created.id }, ADMIN)).rejects.toThrow(
      'test on the hub',
    )
    expect(ctx.injections).toHaveLength(0)
  })

  it('uses the supplied camera when the rule scopes none', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput({ conditions: {} }), 'admin')
    await ctx.handlers['nc.testRule']({ ruleId: created.id, deviceId: 104 }, ADMIN)
    expect(ctx.injections[0]?.deviceId).toBe(104)
  })

  it('refuses a non-admin, and an absent caller', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput(), 'admin')
    await expect(ctx.handlers['nc.testRule']({ ruleId: created.id }, USER)).rejects.toThrow(
      /admin required/,
    )
    await expect(ctx.handlers['nc.testRule']({ ruleId: created.id }, undefined)).rejects.toThrow(
      /authenticated caller required/,
    )
    expect(ctx.injections).toHaveLength(0)
  })

  it('refuses honestly on a node that hosts no centre', async () => {
    const world = makeNcRecords()
    const ruleStore = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    const handlers = makeNcActionHandlers({
      ruleStore,
      ruleAiStore: NcRuleAiStore.of(world.records, makeSilentLogger()),
      logger: makeSilentLogger(),
      listCallerTargetIds: async () => [],
      snooze: {
        list: () => [],
        create: () => Promise.reject(new Error('unused')),
        cancel: () => Promise.resolve(),
      },
    })
    const created = await ruleStore.create(ruleInput(), 'admin')
    await expect(handlers['nc.testRule']({ ruleId: created.id }, ADMIN)).rejects.toThrow(/hub/)
  })
})

describe('nc.getRuleStatus', () => {
  it('routes a DETECTION rule id to the detection reader', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput(), 'admin')
    const status = await ctx.handlers['nc.getRuleStatus']({ ruleId: created.id }, ADMIN)
    expect(ctx.statusCalls).toEqual([`rule:${created.id}`])
    expect(status.kind).toBe('none')
  })

  it('routes a TIMELAPSE rule id to the timelapse reader — one id space, two stores', async () => {
    const ctx = await makeCtx()
    const created = await ctx.timelapse.create(
      {
        name: 'Notte',
        enabled: true,
        deviceIds: [102],
        schedule: SCHEDULE,
        cadenceSec: 15,
        framerate: 10,
        targets: [{ targetId: 't-own' }],
        previewMode: 'image',
        priority: 3,
      },
      'admin',
    )
    const status = await ctx.handlers['nc.getRuleStatus']({ ruleId: created.id }, ADMIN)
    expect(ctx.statusCalls).toEqual([`timelapse:${created.id}`])
    expect(status.kind).toBe('timelapse')
  })

  it('refuses a rule the caller cannot see, BEFORE reading anything', async () => {
    const ctx = await makeCtx()
    const created = await ctx.ruleStore.create(ruleInput({ ownerUserId: 'someone-else' }), 'other')
    await expect(ctx.handlers['nc.getRuleStatus']({ ruleId: created.id }, USER)).rejects.toThrow(
      /not owned/,
    )
    // Nothing was read — a status is a live fact about somebody's camera.
    expect(ctx.statusCalls).toEqual([])
  })

  it('refuses an id neither store owns', async () => {
    const ctx = await makeCtx()
    await expect(ctx.handlers['nc.getRuleStatus']({ ruleId: 'nope' }, ADMIN)).rejects.toThrow(
      /not found/,
    )
  })

  it('refuses honestly on a node that hosts no centre', async () => {
    const world = makeNcRecords()
    const ruleStore = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    })
    const handlers = makeNcActionHandlers({
      ruleStore,
      ruleAiStore: NcRuleAiStore.of(world.records, makeSilentLogger()),
      logger: makeSilentLogger(),
      listCallerTargetIds: async () => [],
      snooze: {
        list: () => [],
        create: () => Promise.reject(new Error('unused')),
        cancel: () => Promise.resolve(),
      },
    })
    const created = await ruleStore.create(ruleInput(), 'admin')
    await expect(handlers['nc.getRuleStatus']({ ruleId: created.id }, ADMIN)).rejects.toThrow(/hub/)
  })
})
