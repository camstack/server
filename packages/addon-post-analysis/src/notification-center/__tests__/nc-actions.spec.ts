/**
 * nc-actions unit tests — the `pipeline-analytics` rule-bridge action catalog
 * consumed by the viewer (Group B). Drives the handlers directly with a real
 * `NcRuleStore` (over a fake settings store) + a fake caller-owned-target
 * resolver, asserting the server-side ownership + fail-closed guarantees:
 *
 *   - FAIL-CLOSED: every ownership-scoped action REJECTS when the forwarded
 *     caller is absent (UDS version-skew can still deliver `undefined`).
 *   - listRules is scoped (own personal + global only) and stamps `readOnly`
 *     on every rule the caller does not own.
 *   - create/update/delete operate ONLY on caller-owned rules.
 *   - createRule stamps `ownerUserId` from the caller, never from client input.
 *   - personal-rule create/update validate the delivery target list against
 *     the caller-owned target set; admins bypass the target-ownership limit
 *     (but NOT the fail-closed caller check).
 *   - setRuleTargetEnabled mutates only for a target OWNED by the caller and
 *     a rule VISIBLE to the caller.
 */

import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import type { NcRuleInput, NcSnoozeInput } from '@camstack/types'
import { NcRuleInputSchema, notificationRulesCapability } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  makeNcActionHandlers,
  ncActions,
  type NcActionDeps,
  type NcActionHandlers,
} from '../nc-actions.js'
import { NcDetectionAudioRefusal } from '../detection-audio-guard.js'
import { NcRuleAiStore } from '../rule-ai-store.js'
import { NcRuleStore } from '../rule-store.js'
import { NcTextCatalog } from '../text-catalog.js'

function input(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'immediate',
    targets: [{ targetId: 't-own' }],
    conditions: {},
    ...overrides,
  })
}

interface Ctx {
  readonly store: NcRuleStore
  readonly handlers: NcActionHandlers
  readonly fake: FakeSettingsStore
  /** What the bridge asked the center to do with a snooze. */
  readonly snoozeCalls: SnoozeCall[]
}

type SnoozeCall =
  | { readonly op: 'list'; readonly userId: string; readonly isAdmin: boolean }
  | { readonly op: 'create'; readonly input: NcSnoozeInput; readonly caller: string }
  | { readonly op: 'cancel'; readonly snoozeId: string; readonly caller: string }

/**
 * `listDeviceIdsByCaps` is absent by default — every existing test exercises
 * the fail-open path for the device-compat guard (D315-safe: a save must
 * never become un-makeable over an unwired capability read). Pass it to
 * exercise the guard ITSELF (the "one family per rule KIND" describe block
 * below).
 */
async function makeCtx(
  listDeviceIdsByCaps?: (capNames: readonly string[]) => Promise<readonly number[]>,
): Promise<Ctx> {
  const fake = makeFakeSettingsStore()
  const world = makeNcRecords()
  let n = 0
  const store = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
    newId: () => `r${(n += 1)}`,
  })
  // The AI sections live in their own collection (see `rule-ai.ts` for why they
  // are not a field on `NcRule`); the delete handler clears the row alongside
  // the rule, so the bridge needs a real store here rather than a stub.
  const ruleAiStore = new NcRuleAiStore({
    kind: world.records.kind(ncRecordKinds['rule-ai']),
    logger: makeSilentLogger(),
  })
  const snoozeCalls: SnoozeCall[] = []
  const handlers = makeNcActionHandlers({
    ruleStore: store,
    ruleAiStore,
    logger: makeSilentLogger(),
    // u1 owns t-own; everyone else owns nothing.
    listCallerTargetIds: async (userId) => (userId === 'u1' ? ['t-own'] : []),
    ...(listDeviceIdsByCaps ? { listDeviceIdsByCaps } : {}),
    snooze: {
      list: (userId, isAdmin) => {
        snoozeCalls.push({ op: 'list', userId, isAdmin })
        return []
      },
      create: async (snoozeInput, caller) => {
        snoozeCalls.push({ op: 'create', input: snoozeInput, caller: caller.userId })
        return {
          id: 's1',
          userId: caller.userId,
          scope: snoozeInput.scope,
          ...(snoozeInput.ruleId !== undefined ? { ruleId: snoozeInput.ruleId } : {}),
          startedAt: 0,
          expiresAt: snoozeInput.durationMinutes * 60_000,
          global: snoozeInput.global === true,
          summary: snoozeInput.summary !== false,
        }
      },
      cancel: async (snoozeId, caller) => {
        snoozeCalls.push({ op: 'cancel', snoozeId, caller: caller.userId })
      },
    },
  })
  return { store, handlers, fake, snoozeCalls }
}

const U1 = { userId: 'u1', isAdmin: false }
const ADMIN = { userId: 'admin1', isAdmin: true }

/**
 * The deps every handler needs to TYPE-CHECK, with no recording and no
 * snooze store wired — for specs (like `nc.previewTemplate`) that exercise
 * one action in isolation and only need `NcActionDeps` to be well-formed.
 */
async function baseDeps(): Promise<NcActionDeps> {
  const world = makeNcRecords()
  let n = 0
  const ruleStore = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
    newId: () => `r${(n += 1)}`,
  })
  const ruleAiStore = new NcRuleAiStore({
    kind: world.records.kind(ncRecordKinds['rule-ai']),
    logger: makeSilentLogger(),
  })
  return {
    ruleStore,
    ruleAiStore,
    logger: makeSilentLogger(),
    listCallerTargetIds: async (userId) => (userId === 'u1' ? ['t-own'] : []),
    snooze: {
      list: () => [],
      create: async (snoozeInput, caller) => ({
        id: 's1',
        userId: caller.userId,
        scope: snoozeInput.scope,
        ...(snoozeInput.ruleId !== undefined ? { ruleId: snoozeInput.ruleId } : {}),
        startedAt: 0,
        expiresAt: snoozeInput.durationMinutes * 60_000,
        global: snoozeInput.global === true,
        summary: snoozeInput.summary !== false,
      }),
      cancel: async () => {},
    },
  }
}

describe('nc rule actions — listRules', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('marks a non-owned (global/admin) rule readOnly', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't2' }] }), 'admin1')
    const res = await ctx.handlers['nc.listRules']({}, U1)
    expect(res.rules).toHaveLength(1)
    expect(res.rules[0]!.readOnly).toBe(true)
  })

  it('marks the caller-owned personal rule editable (readOnly false) and scopes out other users', async () => {
    await ctx.store.create(input({ name: 'mine', ownerUserId: 'u1' }), 'u1')
    await ctx.store.create(input({ name: 'global', targets: [{ targetId: 't2' }] }), 'admin1')
    await ctx.store.create(
      input({ name: 'other', ownerUserId: 'u2', targets: [{ targetId: 't2' }] }),
      'u2',
    )
    const res = await ctx.handlers['nc.listRules']({}, U1)
    const byName = new Map(res.rules.map((r) => [r.name, r]))
    expect([...byName.keys()].sort()).toEqual(['global', 'mine'])
    expect(byName.get('mine')!.readOnly).toBe(false)
    expect(byName.get('global')!.readOnly).toBe(true)
  })

  it('FAIL-CLOSED: rejects when the caller is absent', async () => {
    await expect(ctx.handlers['nc.listRules']({}, undefined)).rejects.toThrow(/forbidden|caller/i)
  })
})

describe('nc rule actions — getConditionCatalog', () => {
  it('returns the catalog for any authenticated caller (no caller required)', async () => {
    const { handlers } = await makeCtx()
    const res = await handlers['nc.getConditionCatalog']({}, U1)
    expect(res.catalog.length).toBeGreaterThan(0)
    expect(res.catalog.some((d) => d.id === 'customZones')).toBe(true)
  })

  it('carries the additive taxonomy (video classes + audio kinds + labels)', async () => {
    const { handlers } = await makeCtx()
    const { taxonomy } = await handlers['nc.getConditionCatalog']({}, U1)
    expect(taxonomy.videoClasses.some((e) => e.kind === 'person')).toBe(true)
    expect(taxonomy.videoClasses.some((e) => e.kind === 'car' && e.parentKind === 'vehicle')).toBe(
      true,
    )
    expect(taxonomy.audioKinds.some((e) => e.kind === 'audio-scream')).toBe(true)
    expect(taxonomy.labels.some((e) => e.kind === 'doorbell')).toBe(true)
  })
})

describe('nc rule actions — getTemplateCatalog / previewTemplate', () => {
  it('nc.getTemplateCatalog returns the declared vocabulary', async () => {
    const handlers = makeNcActionHandlers(await baseDeps())
    const res = await handlers['nc.getTemplateCatalog']({}, U1)
    expect(res.vars.length).toBeGreaterThan(0)
  })

  it('previewTemplate is a mutation (a long draft does not fit a GET URL), with view access', () => {
    expect(ncActions['nc.previewTemplate'].kind).toBe('mutation')
    expect(ncActions['nc.previewTemplate'].auth).toBe('protected')
    const method = notificationRulesCapability.methods.previewTemplate
    expect(method.kind).toBe('mutation')
    expect(method.access).toBe('view')
  })

  it('nc.previewTemplate refuses when no catalog is wired', async () => {
    const handlers = makeNcActionHandlers(await baseDeps())
    await expect(
      handlers['nc.previewTemplate'](
        {
          context: { family: 'rule', field: 'title', kind: 'detection' },
          template: { title: '{{camera}}' },
        },
        undefined,
      ),
    ).rejects.toThrow('text catalog not wired')
  })

  it('nc.previewTemplate renders through the wired catalog', async () => {
    const handlers = makeNcActionHandlers({
      ...(await baseDeps()),
      previewTexts: new NcTextCatalog({ language: 'it' }),
    })
    // A COMPOSITE, so the words come from the wired catalog: an Italian one
    // says 'occupata', and a handler that ignored `previewTexts` would not.
    const out = await handlers['nc.previewTemplate'](
      {
        context: { family: 'rule', field: 'title', kind: 'occupancy' },
        template: { title: '{{camera}}: {{op}}' },
      },
      undefined,
    )
    expect(out.title).toBe('Front door: occupata')
  })
})

describe('nc rule actions — createRule', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('stamps ownerUserId from the caller, ignoring any client-supplied value', async () => {
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ ownerUserId: 'someone-else' }) },
      U1,
    )
    expect(res.rule.ownerUserId).toBe('u1')
    expect(res.rule.createdBy).toBe('u1')
  })

  it('rejects a personal rule whose target the caller does not own', async () => {
    await expect(
      ctx.handlers['nc.createRule']({ rule: input({ targets: [{ targetId: 't-other' }] }) }, U1),
    ).rejects.toThrow(/forbidden|not owned/i)
  })

  it('an admin may deliver to a target it does not personally own (bypass)', async () => {
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ targets: [{ targetId: 't-other' }] }) },
      ADMIN,
    )
    expect(res.rule.ownerUserId).toBe('admin1')
  })

  it('FAIL-CLOSED: rejects when the caller is absent', async () => {
    await expect(ctx.handlers['nc.createRule']({ rule: input() }, undefined)).rejects.toThrow(
      /forbidden|caller/i,
    )
  })
})

describe('nc rule actions — updateRule', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('rejects a rule the caller does not own', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't2' }] }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'x' } }, U1),
    ).rejects.toThrow(/forbidden|not owned/i)
  })

  it('updates a caller-owned rule and never re-owns it via the patch', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { name: 'renamed', ownerUserId: 'u2' } },
      U1,
    )
    expect(res.rule.name).toBe('renamed')
    expect(res.rule.ownerUserId).toBe('u1')
  })

  it('strips a stale disabledTargetIds from the patch (opt-out set is persisted-only)', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    // Establish an opt-out through the owner-checked store path.
    await ctx.store.setRuleTargetEnabled('r1', 't-own', false)
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { name: 'renamed', disabledTargetIds: [] } },
      U1,
    )
    // The stale (empty) disabledTargetIds MUST NOT clobber the opt-out.
    expect(res.rule.disabledTargetIds).toEqual(['t-own'])
  })

  it('rejects re-pointing a personal rule at a target the caller does not own', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(
      ctx.handlers['nc.updateRule'](
        { ruleId: 'r1', patch: { targets: [{ targetId: 't-other' }] } },
        U1,
      ),
    ).rejects.toThrow(/forbidden|not owned/i)
  })

  it('FAIL-CLOSED: rejects when the caller is absent', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'x' } }, undefined),
    ).rejects.toThrow(/forbidden|caller/i)
  })

  it('forwards clear to the store', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1', template: { title: 'old' } }), 'u1')
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { name: 'n' }, clear: ['template'] },
      U1,
    )
    expect(res.rule.template).toBeUndefined()
  })
})

describe('nc rule actions — admin-only rule fields', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  const ACTIONS = {
    onTrigger: [{ kind: 'do' as const, action: { kind: 'wait' as const, seconds: 1 } }],
  }

  it('nc.createRule refuses actions from a non-admin', async () => {
    await expect(
      ctx.handlers['nc.createRule']({ rule: input({ actions: ACTIONS }) }, U1),
    ).rejects.toThrow("forbidden: 'actions' requires admin")
    expect(ctx.store.list()).toEqual([])
  })

  it('nc.createRule refuses targetUsers from a non-admin', async () => {
    await expect(
      ctx.handlers['nc.createRule']({ rule: input({ targetUsers: ['u2'] }) }, U1),
    ).rejects.toThrow("forbidden: 'targetUsers' requires admin")
  })

  it('nc.updateRule refuses targetUsers from a non-admin', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { targetUsers: ['u2'] } }, U1),
    ).rejects.toThrow("forbidden: 'targetUsers' requires admin")
  })

  it('nc.updateRule refuses actions from a non-admin', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { actions: ACTIONS } }, U1),
    ).rejects.toThrow("forbidden: 'actions' requires admin")
  })

  it('nc.updateRule refuses CLEARING an admin-only field from a non-admin', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1', actions: ACTIONS }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: {}, clear: ['actions'] }, U1),
    ).rejects.toThrow("forbidden: 'actions' requires admin")
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: {}, clear: ['targetUsers'] }, U1),
    ).rejects.toThrow("forbidden: 'targetUsers' requires admin")
    expect(ctx.store.get('r1')?.actions).toBeDefined()
  })

  it('a non-admin ECHOING the stored admin-only values may still save (not a change)', async () => {
    await ctx.store.create(
      input({ ownerUserId: 'u1', actions: ACTIONS, targetUsers: ['u2'] }),
      'admin1',
    )
    const stored = ctx.store.get('r1')
    // What a client that round-trips the rule it read sends back.
    const res = await ctx.handlers['nc.updateRule'](
      {
        ruleId: 'r1',
        patch: { name: 'renamed', actions: stored?.actions, targetUsers: stored?.targetUsers },
      },
      U1,
    )
    expect(res.rule.name).toBe('renamed')
    expect(res.rule.actions).toEqual(stored?.actions)
    expect(res.rule.targetUsers).toEqual(['u2'])
  })

  it('a non-admin CHANGING a stored admin-only value is refused', async () => {
    await ctx.store.create(
      input({ ownerUserId: 'u1', actions: ACTIONS, targetUsers: ['u2'] }),
      'admin1',
    )
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { targetUsers: ['u2', 'u3'] } }, U1),
    ).rejects.toThrow("forbidden: 'targetUsers' requires admin")
    const changedActions = {
      onTrigger: [{ kind: 'do' as const, action: { kind: 'wait' as const, seconds: 2 } }],
    }
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { actions: changedActions } }, U1),
    ).rejects.toThrow("forbidden: 'actions' requires admin")
    expect(ctx.store.get('r1')?.targetUsers).toEqual(['u2'])
  })

  it('a non-admin may still clear a field that is not admin-only', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1', template: { title: 'old' } }), 'u1')
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: {}, clear: ['template'] },
      U1,
    )
    expect(res.rule.template).toBeUndefined()
  })

  it('an admin may author both, on create and on update', async () => {
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ targetUsers: ['u2'], actions: ACTIONS }) },
      ADMIN,
    )
    expect(res.rule.targetUsers).toEqual(['u2'])
    expect(res.rule.actions).toBeDefined()
    const upd = await ctx.handlers['nc.updateRule'](
      { ruleId: res.rule.id, patch: { targetUsers: ['u3'] }, clear: ['actions'] },
      ADMIN,
    )
    expect(upd.rule.targetUsers).toEqual(['u3'])
    expect(upd.rule.actions).toBeUndefined()
  })
})

describe('nc rule actions — a rule keeps at least one addressee', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('nc.createRule refuses a rule with no target and no user', async () => {
    await expect(
      ctx.handlers['nc.createRule']({ rule: input({ targets: [] }) }, ADMIN),
    ).rejects.toThrow('a rule needs at least one delivery target or user')
  })

  it('nc.updateRule refuses emptying the targets of a rule with no users', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { targets: [] } }, U1),
    ).rejects.toThrow('a rule needs at least one delivery target or user')
    expect(ctx.store.get('r1')?.targets).toEqual([{ targetId: 't-own' }])
  })

  it('nc.updateRule keeps a users-only rule valid when targets empty', async () => {
    await ctx.store.create(input({ targetUsers: ['u2'] }), 'admin1')
    const res = await ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { targets: [] } }, ADMIN)
    expect(res.rule.targets).toEqual([])
  })

  it('an edit that does not touch an addressee is not re-judged', async () => {
    // A legacy rule stored before the invariant: a rename must still land.
    await ctx.store.create(input({ ownerUserId: 'u1', targets: [] }), 'u1')
    const res = await ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'n' } }, U1)
    expect(res.rule.name).toBe('n')
  })

  it('nc.updateRule treats a CLEARED targetUsers as absent', async () => {
    await ctx.store.create(input({ targets: [], targetUsers: ['u2'] }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: {}, clear: ['targetUsers'] }, ADMIN),
    ).rejects.toThrow('a rule needs at least one delivery target or user')
    expect(ctx.store.get('r1')?.targetUsers).toEqual(['u2'])
  })
})

describe('nc rule actions — one family per system rule (D637)', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('refuses nc.createRule for kinds that span families, and stores nothing', async () => {
    await expect(
      ctx.handlers['nc.createRule'](
        {
          rule: input({
            delivery: 'system-event',
            conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
          }),
        },
        ADMIN,
      ),
    ).rejects.toThrow(/device-events \+ system/)
    expect(ctx.store.list()).toHaveLength(0)
  })

  it('accepts nc.createRule for one family with its own filters', async () => {
    const res = await ctx.handlers['nc.createRule'](
      {
        rule: input({
          delivery: 'system-event',
          conditions: { systemEvent: { kinds: ['device-offline'], deviceTypes: ['camera'] } },
        }),
      },
      ADMIN,
    )
    expect(res.rule.conditions.systemEvent?.deviceTypes).toEqual(['camera'])
  })

  it('refuses nc.updateRule that adds an out-of-family filter', async () => {
    await ctx.store.create(
      input({ delivery: 'system-event', conditions: { systemEvent: { kinds: ['node-offline'] } } }),
      'admin1',
    )
    await expect(
      ctx.handlers['nc.updateRule'](
        {
          ruleId: 'r1',
          patch: { conditions: { systemEvent: { kinds: ['node-offline'], deviceIds: [102] } } },
        },
        ADMIN,
      ),
    ).rejects.toThrow(/deviceIds/)
    expect(ctx.store.get('r1')?.conditions.systemEvent?.deviceIds).toBeUndefined()
  })

  it('refuses nc.updateRule that turns a camera rule into a system rule with no event kind', async () => {
    await ctx.store.create(input(), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { delivery: 'system-event' } }, ADMIN),
    ).rejects.toThrow(/at least one event kind/)
  })

  it('still lets an admin rename a STORED mixed rule (it keeps firing until recreated)', async () => {
    // `ctx.store.create` writes directly and bypasses the guard: that is how a
    // pre-D637 rule exists.
    await ctx.store.create(
      input({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-offline', 'alarm-armed'] } },
      }),
      'admin1',
    )
    const res = await ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'old' } }, ADMIN)
    expect(res.rule.name).toBe('old')
    const off = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { enabled: false } },
      ADMIN,
    )
    expect(off.rule.enabled).toBe(false)
  })

  it('lets an editor rename a STORED mixed rule with a full-form save', async () => {
    const seeded = input({
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['device-offline', 'node-offline'], deviceTypes: ['camera'] },
      },
    })
    await ctx.store.create(seeded, 'admin1')
    const res = await ctx.handlers['nc.updateRule'](
      {
        ruleId: 'r1',
        patch: {
          ...seeded,
          name: 'old',
          conditions: {
            systemEvent: { deviceTypes: ['camera'], kinds: ['device-offline', 'node-offline'] },
          },
        },
      },
      ADMIN,
    )
    expect(res.rule.name).toBe('old')
  })

  it('lets an editor re-sort the kinds of a STORED mixed rule (a set, not a list)', async () => {
    const seeded = input({
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline', 'device-offline'] } },
    })
    await ctx.store.create(seeded, 'admin1')
    const res = await ctx.handlers['nc.updateRule'](
      {
        ruleId: 'r1',
        patch: {
          ...seeded,
          name: 'old',
          conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
        },
      },
      ADMIN,
    )
    expect(res.rule.name).toBe('old')
  })

  it('refuses a full-form save that changes one kind of a STORED mixed rule', async () => {
    const seeded = input({
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
    })
    await ctx.store.create(seeded, 'admin1')
    await expect(
      ctx.handlers['nc.updateRule'](
        {
          ruleId: 'r1',
          patch: {
            ...seeded,
            conditions: { systemEvent: { kinds: ['device-offline', 'node-online'] } },
          },
        },
        ADMIN,
      ),
    ).rejects.toThrow(/device-events \+ system/)
  })

  it('never judges a device-event or detection rule by the system families', async () => {
    await ctx.store.create(input({ delivery: 'device-event' }), 'admin1')
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { name: 'Allagamento', conditions: {} } },
      ADMIN,
    )
    expect(res.rule.name).toBe('Allagamento')
  })
})

describe('nc rule actions — a device must be able to produce the rule KIND (operator ruling 2026-10-01)', () => {
  // The SAME guard the cap-provider route (`notificationRules.createRule/
  // updateRule`) enforces — `device-compat-guard.ts` — wired here too so the
  // rule-bridge route (the one the viewer and any programmatic caller use)
  // cannot save what the primary route would refuse.
  const CAMERA_ONLY = async (capNames: readonly string[]): Promise<readonly number[]> =>
    capNames.includes('detection-pipeline') ? [101] : []

  it('refuses nc.createRule naming an incompatible device, and stores nothing', async () => {
    const ctx = await makeCtx(CAMERA_ONLY)
    await expect(
      ctx.handlers['nc.createRule']({ rule: input({ conditions: { devices: [101, 42] } }) }, ADMIN),
    ).rejects.toThrow(/42/)
    expect(ctx.store.list()).toHaveLength(0)
  })

  it('accepts nc.createRule scoped to a compatible device', async () => {
    const ctx = await makeCtx(CAMERA_ONLY)
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ conditions: { devices: [101] } }) },
      ADMIN,
    )
    expect(res.rule.conditions.devices).toEqual([101])
  })

  it('refuses nc.updateRule that ADDS an incompatible device', async () => {
    const ctx = await makeCtx(CAMERA_ONLY)
    await ctx.store.create(input({ conditions: { devices: [101] } }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule'](
        { ruleId: 'r1', patch: { conditions: { devices: [101, 42] } } },
        ADMIN,
      ),
    ).rejects.toThrow(/42/)
    expect(ctx.store.get('r1')?.conditions.devices).toEqual([101])
  })

  it('never refuses when the capability read is not wired — fails open (the default `makeCtx()`)', async () => {
    const ctx = await makeCtx()
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ conditions: { devices: [101, 42] } }) },
      ADMIN,
    )
    expect(res.rule.conditions.devices).toEqual([101, 42])
  })

  it('a STORED incompatible rule still loads and lists — the guard never runs at read time', async () => {
    const ctx = await makeCtx(CAMERA_ONLY)
    await ctx.store.create(input({ conditions: { devices: [101, 42] } }), 'admin1')
    const res = await ctx.handlers['nc.listRules']({}, ADMIN)
    expect(res.rules).toHaveLength(1)
    expect(res.rules[0]?.conditions.devices).toEqual([101, 42])
  })
})

describe('nc rule actions — deleteRule', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('deletes a caller-owned rule', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    const res = await ctx.handlers['nc.deleteRule']({ ruleId: 'r1' }, U1)
    expect(res.success).toBe(true)
    expect(ctx.store.get('r1')).toBeNull()
  })

  it('rejects a rule the caller does not own', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't2' }] }), 'admin1')
    await expect(ctx.handlers['nc.deleteRule']({ ruleId: 'r1' }, U1)).rejects.toThrow(
      /forbidden|not owned/i,
    )
  })

  it('FAIL-CLOSED: rejects when the caller is absent', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    await expect(ctx.handlers['nc.deleteRule']({ ruleId: 'r1' }, undefined)).rejects.toThrow(
      /forbidden|caller/i,
    )
  })
})

describe('nc rule actions — setRuleTargetEnabled', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('opts the caller-owned target out of a GLOBAL rule (the viewer opt-out flow)', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't-own' }] }), 'admin1')
    const res = await ctx.handlers['nc.setRuleTargetEnabled'](
      { ruleId: 'r1', targetId: 't-own', enabled: false },
      U1,
    )
    expect(res.success).toBe(true)
    expect(ctx.store.isRuleTargetDisabled('r1', 't-own')).toBe(true)
  })

  it('rejects a target the caller does not own', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't-other' }] }), 'admin1')
    await expect(
      ctx.handlers['nc.setRuleTargetEnabled'](
        { ruleId: 'r1', targetId: 't-other', enabled: false },
        U1,
      ),
    ).rejects.toThrow(/forbidden|not owned/i)
  })

  it('rejects a rule the caller cannot see (another user’s personal rule)', async () => {
    await ctx.store.create(input({ ownerUserId: 'u2', targets: [{ targetId: 't-own' }] }), 'u2')
    await expect(
      ctx.handlers['nc.setRuleTargetEnabled'](
        { ruleId: 'r1', targetId: 't-own', enabled: false },
        U1,
      ),
    ).rejects.toThrow(/forbidden|not owned|not found/i)
  })

  it('an admin may opt any target out (target-ownership bypass)', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't-other' }] }), 'admin1')
    const res = await ctx.handlers['nc.setRuleTargetEnabled'](
      { ruleId: 'r1', targetId: 't-other', enabled: false },
      ADMIN,
    )
    expect(res.success).toBe(true)
  })

  it('FAIL-CLOSED: rejects when the caller is absent', async () => {
    await ctx.store.create(input({ targets: [{ targetId: 't-own' }] }), 'admin1')
    await expect(
      ctx.handlers['nc.setRuleTargetEnabled'](
        { ruleId: 'r1', targetId: 't-own', enabled: false },
        undefined,
      ),
    ).rejects.toThrow(/forbidden|caller/i)
  })
})

// ── Admin editing of GLOBAL rules (D2, 2026-07-30) ──────────────────────────
// A global/admin rule has `ownerUserId: undefined`, and ownership was compared
// with `rule.ownerUserId === caller.userId` — which is false for EVERY caller,
// admins included. The operator's report: "as an admin I cannot edit an admin
// rule from the viewer". Ownership still binds non-admins; admin is the
// documented bypass, exactly as it already is for target ownership.
describe('nc rule actions — admins administer global rules', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  /** A GLOBAL rule — no ownerUserId (what the admin UI creates). */
  const createGlobal = async (): Promise<void> => {
    await ctx.store.create(input({ targets: [{ targetId: 't-other' }] }), 'admin1')
  }

  it('an admin may update a global rule', async () => {
    await createGlobal()
    const res = await ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'x' } }, ADMIN)
    expect(res.rule.name).toBe('x')
    expect(res.rule.ownerUserId).toBeUndefined()
  })

  it('an admin may delete a global rule', async () => {
    await createGlobal()
    await expect(ctx.handlers['nc.deleteRule']({ ruleId: 'r1' }, ADMIN)).resolves.toEqual({
      success: true,
    })
  })

  it('an admin may update ANOTHER USER’s personal rule (support path)', async () => {
    await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    const res = await ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'y' } }, ADMIN)
    expect(res.rule.name).toBe('y')
    // Never re-owned by the administering admin.
    expect(res.rule.ownerUserId).toBe('u1')
  })

  it('a NON-admin still cannot touch a global rule', async () => {
    await createGlobal()
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { name: 'x' } }, U1),
    ).rejects.toThrow(/forbidden|not owned/i)
    await expect(ctx.handlers['nc.deleteRule']({ ruleId: 'r1' }, U1)).rejects.toThrow(
      /forbidden|not owned/i,
    )
  })

  it('listRules marks a global rule editable for an admin and read-only for a user', async () => {
    await createGlobal()
    const asAdmin = await ctx.handlers['nc.listRules']({}, ADMIN)
    expect(asAdmin.rules[0]?.readOnly).toBe(false)
    const asUser = await ctx.handlers['nc.listRules']({}, U1)
    expect(asUser.rules[0]?.readOnly).toBe(true)
  })
})

describe('nc snooze actions', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('rejects every snooze action when the caller is absent — fail closed', async () => {
    await expect(ctx.handlers['nc.listSnoozes']({}, undefined)).rejects.toThrow(/forbidden/)
    await expect(
      ctx.handlers['nc.createSnooze']({ snooze: { scope: 'all', durationMinutes: 60 } }, undefined),
    ).rejects.toThrow(/forbidden/)
    await expect(ctx.handlers['nc.cancelSnooze']({ snoozeId: 's1' }, undefined)).rejects.toThrow(
      /forbidden/,
    )
  })

  it('lists with the caller identity, so a user never sees a stranger private silence', async () => {
    await ctx.handlers['nc.listSnoozes']({}, U1)
    expect(ctx.snoozeCalls).toEqual([{ op: 'list', userId: 'u1', isAdmin: false }])
  })

  it('opens a window on a rule the caller can SEE', async () => {
    const rule = await ctx.store.create(input({ ownerUserId: 'u1' }), 'u1')
    const res = await ctx.handlers['nc.createSnooze'](
      { snooze: { scope: 'rule', ruleId: rule.id, durationMinutes: 30 } },
      U1,
    )
    expect(res.snooze.userId).toBe('u1')
    expect(ctx.snoozeCalls).toHaveLength(1)
  })

  it("refuses to snooze another person's private rule — otherwise its existence is discoverable", async () => {
    const rule = await ctx.store.create(input({ ownerUserId: 'u2' }), 'u2')
    await expect(
      ctx.handlers['nc.createSnooze'](
        { snooze: { scope: 'rule', ruleId: rule.id, durationMinutes: 30 } },
        U1,
      ),
    ).rejects.toThrow(/forbidden/)
    expect(ctx.snoozeCalls).toHaveLength(0)
  })

  it("passes the cancel through with the caller — ownership is the center's call", async () => {
    await ctx.handlers['nc.cancelSnooze']({ snoozeId: 's9' }, U1)
    expect(ctx.snoozeCalls).toEqual([{ op: 'cancel', snoozeId: 's9', caller: 'u1' }])
  })

  it('an admin may snooze a global rule', async () => {
    const rule = await ctx.store.create(input(), 'admin1')
    await ctx.handlers['nc.createSnooze'](
      { snooze: { scope: 'rule', ruleId: rule.id, durationMinutes: 30, global: true } },
      ADMIN,
    )
    expect(ctx.snoozeCalls).toHaveLength(1)
  })
})

describe('nc rule actions — a sensor edge belongs to a device-event rule (D640)', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('accepts nc.createRule for a flood rule that fires on the raise only', async () => {
    const res = await ctx.handlers['nc.createRule'](
      {
        rule: input({
          delivery: 'device-event',
          conditions: { sensorKinds: ['flood'], sensorTransition: 'raised' },
        }),
      },
      ADMIN,
    )
    expect(res.rule.conditions.sensorTransition).toBe('raised')
  })

  it('refuses nc.createRule that puts it on a detection rule, and stores nothing', async () => {
    await expect(
      ctx.handlers['nc.createRule'](
        { rule: input({ conditions: { classes: ['person'], sensorTransition: 'raised' } }) },
        ADMIN,
      ),
    ).rejects.toThrow(/sensorTransition/)
    expect(ctx.store.list()).toHaveLength(0)
  })

  it('refuses nc.updateRule that moves a sensor-edge rule off device-event', async () => {
    await ctx.store.create(
      input({
        delivery: 'device-event',
        conditions: { sensorKinds: ['flood'], sensorTransition: 'raised' },
      }),
      'admin1',
    )
    await expect(
      ctx.handlers['nc.updateRule']({ ruleId: 'r1', patch: { delivery: 'track-end' } }, ADMIN),
    ).rejects.toThrow(/sensorTransition/)
    expect(ctx.store.get('r1')?.delivery).toBe('device-event')
  })
})

describe('nc rule actions — a device exclusion belongs where `devices` does (D641)', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('accepts nc.createRule for a detection rule on every camera but one', async () => {
    const res = await ctx.handlers['nc.createRule'](
      { rule: input({ conditions: { devicesExclude: [104] } }) },
      ADMIN,
    )
    expect(res.rule.conditions.devicesExclude).toEqual([104])
  })

  it('refuses nc.createRule that puts it on a system rule, and stores nothing', async () => {
    await expect(
      ctx.handlers['nc.createRule'](
        {
          rule: input({
            delivery: 'system-event',
            conditions: { systemEvent: { kinds: ['device-offline'] }, devicesExclude: [104] },
          }),
        },
        ADMIN,
      ),
    ).rejects.toThrow(/devicesExclude/)
    expect(ctx.store.list()).toHaveLength(0)
  })

  it('refuses nc.updateRule that moves an excluding rule to system-event', async () => {
    await ctx.store.create(input({ conditions: { devicesExclude: [104] } }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule'](
        {
          ruleId: 'r1',
          patch: {
            delivery: 'system-event',
            conditions: { systemEvent: { kinds: ['device-offline'] }, devicesExclude: [104] },
          },
        },
        ADMIN,
      ),
    ).rejects.toThrow(/devicesExclude/)
    expect(ctx.store.get('r1')?.delivery).toBe('immediate')
  })
})

// ── D690: the bridge route refuses a detection rule naming a sound ──

describe('nc rule actions — a detection rule names no sound (D690, bridge route)', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('nc.createRule refuses an audio class, and stores nothing', async () => {
    await expect(
      ctx.handlers['nc.createRule'](
        { rule: input({ conditions: { classes: ['person', 'audio-scream'] } }) },
        ADMIN,
      ),
    ).rejects.toThrow(NcDetectionAudioRefusal)
    expect(ctx.store.list()).toHaveLength(0)
  })

  it('nc.updateRule refuses a sound the patch ADDS', async () => {
    await ctx.store.create(input({ conditions: { classes: ['person'] } }), 'admin1')
    await expect(
      ctx.handlers['nc.updateRule'](
        { ruleId: 'r1', patch: { conditions: { classes: ['person', 'audio-bark'] } } },
        ADMIN,
      ),
    ).rejects.toThrow(NcDetectionAudioRefusal)
  })

  it('nc.updateRule lets a legacy rule change something else', async () => {
    await ctx.store.create(input({ conditions: { classes: ['audio-bark'] } }), 'admin1')
    const res = await ctx.handlers['nc.updateRule'](
      { ruleId: 'r1', patch: { conditions: { classes: ['audio-bark'], minConfidence: 0.5 } } },
      ADMIN,
    )
    expect(res.rule.conditions.minConfidence).toBe(0.5)
  })
})
