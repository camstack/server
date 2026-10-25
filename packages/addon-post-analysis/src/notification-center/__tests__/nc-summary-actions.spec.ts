/**
 * The `nc.*SummaryRule*` bridge actions — the digest half, authored from the
 * PHONE.
 *
 * ## What changed, and why the shape is not new
 *
 * `nc.upsertSummaryRule` and `nc.deleteSummaryRule` were `auth: 'admin'` in v1
 * (the vision-model cost had not been watched yet). The operator closed that
 * decision, so they now carry exactly the auth the two rule families beside
 * them already carry — `caller: 'required'`, ownership enforced in the handler,
 * `ownerUserId` STAMPED from the resolved caller and never read off the payload.
 * Nothing about the model is invented here: `NcSummaryStore` has had
 * `ownerUserId` / `listForOwner` since it was written, and this file asserts the
 * handlers now use them the way `nc.*TimelapseRule*` does.
 *
 * Three things stay admin, deliberately, and are asserted so a future relaxation
 * has to be a decision rather than a slip:
 *
 *  - `nc.testSummaryRule` DELIVERS, to every target the rule addresses, on other
 *    people's phones — the same argument as `nc.injectTestEvent`;
 *  - an admin still authors GLOBAL rules (no `ownerUserId`), which is the
 *    convention `nc.listRules` already encodes;
 *  - a personal rule may only deliver to targets the caller OWNS.
 *
 * And one thing an OLDER hub cannot say: `canAuthor` on the list response is the
 * capability probe the viewer degrades on. Absent (an old hub) means "this build
 * still refuses your upsert" and the app shows the list read-only; a hub that
 * carries the relaxation says so, once, instead of the app discovering it by
 * taking a 403 in front of the operator.
 */

import { NcRuleAiStore } from '../rule-ai-store.js'
import { ncRecordKinds } from '../record-kinds.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcActionHandlers, type NcActionHandlers, ncActions } from '../nc-actions.js'
import { NcRuleStore } from '../rule-store.js'
import { type NcSummaryRuleInput, NcSummaryRuleInputSchema } from '../summary/summary-rule.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

function input(overrides: Record<string, unknown> = {}): NcSummaryRuleInput {
  return NcSummaryRuleInputSchema.parse({
    name: 'Notte',
    deviceIds: [101],
    window: { kind: 'motion', quietSeconds: 120, maxWindowSeconds: 3600 },
    targets: [{ targetId: 't-own' }],
    ...overrides,
  })
}

interface Ctx {
  readonly summary: NcSummaryStore
  readonly handlers: NcActionHandlers
  readonly fake: FakeSettingsStore
  readonly runNowCalls: Array<{ ruleId: string }>
}

async function makeCtx(): Promise<Ctx> {
  const fake = makeFakeSettingsStore()
  const world = makeNcRecords()
  const ruleStore = new NcRuleStore({
    kind: world.records.kind(ncRecordKinds.rules),
    logger: makeSilentLogger(),
  })
  const ruleAiStore = NcRuleAiStore.of(world.records, makeSilentLogger())
  let n = 0
  const summary = new NcSummaryStore({
    kind: world.records.kind(ncRecordKinds['summary-rules']),
    logger: makeSilentLogger(),
    newId: () => `sum${(n += 1)}`,
  })
  const runNowCalls: Array<{ ruleId: string }> = []
  const handlers = makeNcActionHandlers({
    ruleStore,
    ruleAiStore,
    logger: makeSilentLogger(),
    // `u1` owns `t-own`; `u2` owns `t-other`. Admins bypass the limit.
    listCallerTargetIds: async (userId) =>
      userId === 'u1' ? ['t-own'] : userId === 'u2' ? ['t-other'] : [],
    snooze: {
      list: () => [],
      create: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
    },
    summary: {
      store: summary,
      runNow: async (i) => {
        runNowCalls.push({ ruleId: i.ruleId })
        return { produced: 1, window: null }
      },
    },
  })
  return { summary, handlers, fake, runNowCalls }
}

const ADMIN = { userId: 'admin-1', isAdmin: true }
const USER = { userId: 'u1', isAdmin: false }
const OTHER = { userId: 'u2', isAdmin: false }

describe('nc.upsertSummaryRule — a personal digest rule, authored from the phone', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('lets a NON-admin create one, and stamps them as its owner', async () => {
    const out = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    expect(out.rule.ownerUserId).toBe('u1')
    expect(out.rule.createdBy).toBe('u1')
  })

  it('an ADMIN still authors a GLOBAL rule — no owner', async () => {
    const out = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, ADMIN)
    expect(out.rule.ownerUserId).toBeUndefined()
  })

  it('never takes ownership off the payload', async () => {
    // Zod strips unknown keys, and the store re-parses — but the assertion is
    // the point: a forged blob must not be able to re-own a rule.
    const forged = input()
    Object.assign(forged, { ownerUserId: 'someone-else', createdBy: 'someone-else' })
    const out = await ctx.handlers['nc.upsertSummaryRule']({ rule: forged }, USER)
    expect(out.rule.ownerUserId).toBe('u1')
    expect(out.rule.createdBy).toBe('u1')
  })

  it('refuses a target the caller does not own', async () => {
    await expect(
      ctx.handlers['nc.upsertSummaryRule'](
        { rule: input({ targets: [{ targetId: 't-other' }] }) },
        USER,
      ),
    ).rejects.toThrow(/target not owned/)
  })

  it('refuses an absent caller before any ownership decision', async () => {
    await expect(
      ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, undefined),
    ).rejects.toThrow(/authenticated caller required/)
  })

  it('lets the OWNER patch their own rule', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    const patched = await ctx.handlers['nc.upsertSummaryRule'](
      { ruleId: created.rule.id, patch: { name: 'Notte 2' } },
      USER,
    )
    expect(patched.rule.name).toBe('Notte 2')
    expect(patched.rule.ownerUserId).toBe('u1')
  })

  it('refuses to patch ANOTHER user’s personal rule', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    await expect(
      ctx.handlers['nc.upsertSummaryRule'](
        { ruleId: created.rule.id, patch: { name: 'mine now' } },
        OTHER,
      ),
    ).rejects.toThrow(/not owned/)
  })

  it('refuses a non-admin patching a GLOBAL rule — visible is not editable', async () => {
    const global = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, ADMIN)
    await expect(
      ctx.handlers['nc.upsertSummaryRule']({ ruleId: global.rule.id, patch: { name: 'x' } }, USER),
    ).rejects.toThrow(/not owned/)
    // …and the admin still can.
    const patched = await ctx.handlers['nc.upsertSummaryRule'](
      { ruleId: global.rule.id, patch: { name: 'x' } },
      ADMIN,
    )
    expect(patched.rule.name).toBe('x')
  })

  it('still checks the budget on the MERGED rule, not on the patch alone', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule'](
      { rule: input({ maxTiles: 8, maxAiImages: 8 }) },
      USER,
    )
    await expect(
      ctx.handlers['nc.upsertSummaryRule'](
        { ruleId: created.rule.id, patch: { maxTiles: 4 } },
        USER,
      ),
    ).rejects.toThrow(/maxAiImages/)
  })
})

describe('nc.listSummaryRules', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('scopes a user to their OWN rules plus the global ones', async () => {
    await ctx.handlers['nc.upsertSummaryRule']({ rule: input({ name: 'mine' }) }, USER)
    await ctx.handlers['nc.upsertSummaryRule']({ rule: input({ name: 'global' }) }, ADMIN)
    const mine = await ctx.handlers['nc.listSummaryRules']({}, USER)
    expect(mine.rules.map((r) => r.name).toSorted()).toEqual(['global', 'mine'])
    const other = await ctx.handlers['nc.listSummaryRules']({}, OTHER)
    expect(other.rules.map((r) => r.name)).toEqual(['global'])
  })

  it('marks a caller’s OWN rule editable and the global one read-only', async () => {
    await ctx.handlers['nc.upsertSummaryRule']({ rule: input({ name: 'mine' }) }, USER)
    await ctx.handlers['nc.upsertSummaryRule']({ rule: input({ name: 'global' }) }, ADMIN)
    const { rules } = await ctx.handlers['nc.listSummaryRules']({}, USER)
    const byName = new Map(rules.map((r) => [r.name, r.readOnly]))
    // This is the whole relaxation, seen from the list: before it, `readOnly`
    // was `!isAdmin` and a user's own rule came back locked.
    expect(byName.get('mine')).toBe(false)
    expect(byName.get('global')).toBe(true)
  })

  it('nothing is read-only to an admin', async () => {
    await ctx.handlers['nc.upsertSummaryRule']({ rule: input({ name: 'mine' }) }, USER)
    const { rules } = await ctx.handlers['nc.listSummaryRules']({}, ADMIN)
    expect(rules.every((r) => !r.readOnly)).toBe(true)
  })

  it('SAYS that this hub lets the caller author — the viewer degrades on it', async () => {
    const asUser = await ctx.handlers['nc.listSummaryRules']({}, USER)
    expect(asUser.canAuthor).toBe(true)
    const asAdmin = await ctx.handlers['nc.listSummaryRules']({}, ADMIN)
    expect(asAdmin.canAuthor).toBe(true)
  })

  it('refuses an absent caller', async () => {
    await expect(ctx.handlers['nc.listSummaryRules']({}, undefined)).rejects.toThrow(
      /authenticated caller required/,
    )
  })
})

describe('nc.deleteSummaryRule', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('lets the owner delete their own rule', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    await ctx.handlers['nc.deleteSummaryRule']({ ruleId: created.rule.id }, USER)
    expect(ctx.summary.get(created.rule.id)).toBeNull()
  })

  it('refuses to delete another user’s rule, and refuses a GLOBAL one', async () => {
    const mine = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    const global = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, ADMIN)
    await expect(
      ctx.handlers['nc.deleteSummaryRule']({ ruleId: mine.rule.id }, OTHER),
    ).rejects.toThrow(/not owned/)
    await expect(
      ctx.handlers['nc.deleteSummaryRule']({ ruleId: global.rule.id }, USER),
    ).rejects.toThrow(/not owned/)
    expect(ctx.summary.get(mine.rule.id)).not.toBeNull()
    expect(ctx.summary.get(global.rule.id)).not.toBeNull()
  })

  it('refuses an unknown id rather than reporting a success it did not perform', async () => {
    await expect(ctx.handlers['nc.deleteSummaryRule']({ ruleId: 'nope' }, USER)).rejects.toThrow(
      /not found/,
    )
  })
})

describe('nc.testSummaryRule stays ADMIN — it DELIVERS', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('refuses a non-admin even on a rule they own', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, USER)
    await expect(
      ctx.handlers['nc.testSummaryRule']({ ruleId: created.rule.id }, USER),
    ).rejects.toThrow(/admin required/)
    expect(ctx.runNowCalls).toEqual([])
  })

  it('runs for an admin', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule']({ rule: input() }, ADMIN)
    await ctx.handlers['nc.testSummaryRule']({ ruleId: created.rule.id }, ADMIN)
    expect(ctx.runNowCalls).toEqual([{ ruleId: created.rule.id }])
  })
})

describe('a node that hosts no producer REFUSES rather than answering empty', () => {
  it('says so, so an operator does not read it as "my rule is gone"', async () => {
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
    await expect(handlers['nc.listSummaryRules']({}, USER)).rejects.toThrow(/hub/)
  })
})

describe('nc.upsertSummaryRule clear — removing the mosaic caption on edit (Plan D, Task 13)', () => {
  // The upsert MERGES, and `captionText` is the one optional field the patch
  // cannot remove (`template` / `filters` / `ai` take `null`): an editor that
  // emptied the caption found it back after a reload.
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('removes captionText and keeps everything else', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule'](
      { rule: input({ captionText: 'Notte {{from}}', template: { title: 't' } }) },
      USER,
    )
    const updated = await ctx.handlers['nc.upsertSummaryRule'](
      { ruleId: created.rule.id, patch: {}, clear: ['captionText'] },
      USER,
    )
    expect('captionText' in updated.rule).toBe(false)
    expect(updated.rule.template).toEqual({ title: 't' })
    expect(ctx.summary.get(created.rule.id)).not.toHaveProperty('captionText')
  })

  it('the action input REFUSES a key that is not clearable', () => {
    const schema = ncActions['nc.upsertSummaryRule'].input
    expect(schema.safeParse({ ruleId: 's1', patch: {}, clear: ['name'] }).success).toBe(false)
    expect(schema.safeParse({ ruleId: 's1', patch: {}, clear: ['bogus'] }).success).toBe(false)
    expect(schema.safeParse({ ruleId: 's1', patch: {}, clear: ['captionText'] }).success).toBe(true)
  })

  it('refuses a clear on a CREATE — there is nothing stored to remove', async () => {
    await expect(
      ctx.handlers['nc.upsertSummaryRule']({ rule: input(), clear: ['captionText'] }, USER),
    ).rejects.toThrow(/clear/)
    expect(ctx.summary.list()).toHaveLength(0)
  })

  it('refuses a patch that both SETS and clears the caption, writing nothing', async () => {
    const created = await ctx.handlers['nc.upsertSummaryRule'](
      { rule: input({ captionText: 'x' }) },
      USER,
    )
    await expect(
      ctx.handlers['nc.upsertSummaryRule'](
        { ruleId: created.rule.id, patch: { captionText: '' }, clear: ['captionText'] },
        USER,
      ),
    ).rejects.toThrow(/both sets and clears 'captionText'/)
    expect(ctx.summary.get(created.rule.id)?.captionText).toBe('x')
  })
})
