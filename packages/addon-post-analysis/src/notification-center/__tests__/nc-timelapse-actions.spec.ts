/**
 * The `nc.*Timelapse*` bridge actions — same shape, same auth model and same
 * fail-closed caller check as `nc.createRule` / `nc.updateRule` /
 * `nc.deleteRule` / `nc.listRules`, over `TimelapseStore` instead of
 * `NcRuleStore`.
 *
 * The one rule that is NOT inherited from the detection-rule bridge is the
 * RECORDING guard: a post-hoc timelapse renders recorded footage, so a camera
 * that is not recording can never produce one. Refusing at SAVE time is the
 * only moment an operator is present to read the reason — at 06:05 the next
 * morning there is nobody to tell.
 */

import { NcRuleAiStore } from '../rule-ai-store.js'
import { ncRecordKinds } from '../record-kinds.js'
import type { RecordingConfig, TimelapseRuleInput } from '@camstack/types'
import { RecordingConfigSchema, TimelapseRuleInputSchema } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcActionHandlers, type NcActionHandlers, ncActions } from '../nc-actions.js'
import { NcRuleStore } from '../rule-store.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const SCHEDULE = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1320, endMinute: 360 }],
  timezone: 'UTC',
}

function input(overrides: Record<string, unknown> = {}): TimelapseRuleInput {
  return TimelapseRuleInputSchema.parse({
    name: 'Notte retro',
    deviceIds: [1441],
    schedule: SCHEDULE,
    targets: [{ targetId: 't-own' }],
    ...overrides,
  })
}

/** Recording ON for 101, OFF for 1441 (enabled but band-less = records nothing). */
const CONFIGS = new Map<number, RecordingConfig>([
  [
    101,
    RecordingConfigSchema.parse({
      enabled: true,
      bands: [{ mode: 'continuous', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }],
    }),
  ],
  [1441, RecordingConfigSchema.parse({ enabled: true, bands: [] })],
  [777, RecordingConfigSchema.parse({ enabled: false, bands: [] })],
])

interface Ctx {
  readonly timelapse: TimelapseStore
  readonly handlers: NcActionHandlers
  readonly fake: FakeSettingsStore
  readonly runNowCalls: Array<{ ruleId: string; deviceId: number }>
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
  const timelapse = new TimelapseStore({
    kind: world.records.kind(ncRecordKinds['timelapse-rules']),
    logger: makeSilentLogger(),
    newId: () => `tl${(n += 1)}`,
  })
  const runNowCalls: Array<{ ruleId: string; deviceId: number }> = []
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
    timelapse: {
      store: timelapse,
      getRecordingConfig: async (deviceId) => CONFIGS.get(deviceId) ?? null,
      runNow: async (i) => {
        runNowCalls.push(i)
        return { produced: 1, window: { startMs: 1, endMs: 2 }, exportId: 'exp-1' }
      },
    },
  })
  return { timelapse, handlers, fake, runNowCalls }
}

const ADMIN = { userId: 'admin-1', isAdmin: true }
const USER = { userId: 'u1', isAdmin: false }

describe('nc.upsertTimelapseRule', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await makeCtx()
  })

  it('creates a rule and stamps ownership from the caller', async () => {
    const out = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    expect(out.rule.id).toBe('tl1')
    expect(out.rule.ownerUserId).toBe('u1')
    expect(out.rule.createdBy).toBe('u1')
  })

  it('updates in place when a ruleId is supplied', async () => {
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    const updated = await ctx.handlers['nc.upsertTimelapseRule'](
      { ruleId: created.rule.id, patch: { name: 'rinominata' } },
      USER,
    )
    expect(updated.rule.id).toBe(created.rule.id)
    expect(updated.rule.name).toBe('rinominata')
    expect(ctx.timelapse.list()).toHaveLength(1)
  })

  it('REFUSES a camera whose recording is not enabled, naming it', async () => {
    // 1441 is `enabled: true` with NO bands — which records nothing. The
    // authority is the same one camera-status reads: `RecordingConfig`
    // through `deriveRecordingMode`, never a second opinion.
    await expect(
      ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [1441] }) }, USER),
    ).rejects.toThrow(/1441/)
    await expect(
      ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [1441] }) }, USER),
    ).rejects.toThrow(/recording/i)
  })

  it('round-trips the preview caption through create AND patch', async () => {
    // The caption is a plain field on the rule schema — no cap, no codegen. It
    // must survive the upsert action unchanged, including being SET on a rule
    // that never had one (every rule created before the field existed).
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101], previewText: '{{camera}} — notte' }) },
      USER,
    )
    expect(created.rule.previewText).toBe('{{camera}} — notte')

    const bare = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101], name: 'Senza caption' }) },
      USER,
    )
    expect(bare.rule.previewText).toBeUndefined()
    const patched = await ctx.handlers['nc.upsertTimelapseRule'](
      { ruleId: bare.rule.id, patch: { previewText: 'Timelapse {{camera}}' } },
      USER,
    )
    expect(patched.rule.previewText).toBe('Timelapse {{camera}}')
    // A patch that does not mention it leaves it alone.
    const renamed = await ctx.handlers['nc.upsertTimelapseRule'](
      { ruleId: bare.rule.id, patch: { name: 'Rinominata' } },
      USER,
    )
    expect(renamed.rule.previewText).toBe('Timelapse {{camera}}')
  })

  describe('clear — removing an optional field on edit', () => {
    it('removes the keys it names and keeps the rest', async () => {
      const created = await ctx.handlers['nc.upsertTimelapseRule'](
        {
          rule: input({
            deviceIds: [101],
            previewText: 'Notte',
            reportClasses: ['person'],
            template: { title: 't' },
          }),
        },
        USER,
      )
      const updated = await ctx.handlers['nc.upsertTimelapseRule'](
        { ruleId: created.rule.id, patch: {}, clear: ['previewText', 'reportClasses'] },
        USER,
      )
      expect('previewText' in updated.rule).toBe(false)
      expect('reportClasses' in updated.rule).toBe(false)
      expect(updated.rule.template).toEqual({ title: 't' })
    })

    it('the action input REFUSES a key that is not clearable', () => {
      // A required field (`name`) can never be cleared into a valid rule, and an
      // unknown key would otherwise be a silent no-op the caller believes worked.
      const input = ncActions['nc.upsertTimelapseRule'].input
      expect(input.safeParse({ ruleId: 'tl1', patch: {}, clear: ['name'] }).success).toBe(false)
      expect(input.safeParse({ ruleId: 'tl1', patch: {}, clear: ['bogus'] }).success).toBe(false)
      expect(input.safeParse({ ruleId: 'tl1', patch: {}, clear: ['previewText'] }).success).toBe(
        true,
      )
    })

    it('refuses a clear on a CREATE — there is nothing stored to remove', async () => {
      await expect(
        ctx.handlers['nc.upsertTimelapseRule'](
          { rule: input({ deviceIds: [101] }), clear: ['previewText'] },
          USER,
        ),
      ).rejects.toThrow(/clear/)
      expect(ctx.timelapse.list()).toHaveLength(0)
    })
  })

  describe('density controls', () => {
    it('round-trips denseCadenceSec and minDwellSec through create AND patch', async () => {
      const created = await ctx.handlers['nc.upsertTimelapseRule'](
        { rule: input({ deviceIds: [101], denseCadenceSec: 0.5, minDwellSec: 1 }) },
        USER,
      )
      expect(created.rule.denseCadenceSec).toBe(0.5)
      expect(created.rule.minDwellSec).toBe(1)

      // A rule created WITHOUT them keeps them absent — that is what makes the
      // derivation, and not a stored number, the answer for every existing rule.
      const bare = await ctx.handlers['nc.upsertTimelapseRule'](
        { rule: input({ deviceIds: [101], name: 'Senza densità' }) },
        USER,
      )
      expect(bare.rule.denseCadenceSec).toBeUndefined()
      expect(bare.rule.minDwellSec).toBeUndefined()

      const patched = await ctx.handlers['nc.upsertTimelapseRule'](
        { ruleId: bare.rule.id, patch: { denseCadenceSec: 2, minDwellSec: 3 } },
        USER,
      )
      expect(patched.rule.denseCadenceSec).toBe(2)
      expect(patched.rule.minDwellSec).toBe(3)
    })

    it('REFUSES a dense cadence that is not denser than the base, at CREATE', async () => {
      // Refusing here is the point: the export cap would also refuse this pair,
      // but only at 06:05 the next morning, with the window closed and nobody
      // to tell.
      await expect(
        ctx.handlers['nc.upsertTimelapseRule'](
          { rule: input({ deviceIds: [101], cadenceSec: 30, denseCadenceSec: 30 }) },
          USER,
        ),
      ).rejects.toThrow(/strictly smaller/i)
      await expect(
        ctx.handlers['nc.upsertTimelapseRule'](
          { rule: input({ deviceIds: [101], cadenceSec: 30, denseCadenceSec: 60 }) },
          USER,
        ),
      ).rejects.toThrow(/denseCadenceSec/)
    })

    it('REFUSES a patch that makes the pair invalid from EITHER side', async () => {
      const created = await ctx.handlers['nc.upsertTimelapseRule'](
        { rule: input({ deviceIds: [101], cadenceSec: 30, denseCadenceSec: 3 }) },
        USER,
      )
      // Raising the dense cadence past the base.
      await expect(
        ctx.handlers['nc.upsertTimelapseRule'](
          { ruleId: created.rule.id, patch: { denseCadenceSec: 45 } },
          USER,
        ),
      ).rejects.toThrow(/strictly smaller/i)
      // ...and the direction a patch-only check would MISS: the patch touches
      // the BASE, and it is the rule's existing dense cadence that becomes
      // invalid.
      await expect(
        ctx.handlers['nc.upsertTimelapseRule'](
          { ruleId: created.rule.id, patch: { cadenceSec: 3 } },
          USER,
        ),
      ).rejects.toThrow(/strictly smaller/i)
      // The refused patches changed nothing.
      const after = ctx.timelapse.list().find((r) => r.id === created.rule.id)
      expect(after?.cadenceSec).toBe(30)
      expect(after?.denseCadenceSec).toBe(3)
    })

    it('a CLEARED dense cadence no longer constrains the base cadence', async () => {
      // The check runs on the MERGED pair — and a cleared key is absent from
      // the merge. Judging the stored `denseCadenceSec: 3` here would refuse
      // an edit that removes exactly the value it objects to.
      const created = await ctx.handlers['nc.upsertTimelapseRule'](
        { rule: input({ deviceIds: [101], cadenceSec: 30, denseCadenceSec: 3 }) },
        USER,
      )
      const updated = await ctx.handlers['nc.upsertTimelapseRule'](
        { ruleId: created.rule.id, patch: { cadenceSec: 3 }, clear: ['denseCadenceSec'] },
        USER,
      )
      expect(updated.rule.cadenceSec).toBe(3)
      expect('denseCadenceSec' in updated.rule).toBe(false)
    })

    it('refuses a dense cadence below the recording frame interval', async () => {
      // The floor is a SCHEMA bound, so it refuses at parse — before the
      // handler is ever entered. Asserted where it actually lives rather than
      // through a handler that never sees the value.
      expect(() => input({ deviceIds: [101], denseCadenceSec: 0.05 })).toThrow(/0\.1/)
      expect(() => input({ deviceIds: [101], denseCadenceSec: 0.1 })).not.toThrow()
    })
  })

  it('refuses a camera whose recording is switched off outright', async () => {
    await expect(
      ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [777] }) }, USER),
    ).rejects.toThrow(/777/)
  })

  it('refuses the WHOLE rule when only one of its cameras cannot record', async () => {
    await expect(
      ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [101, 1441] }) }, USER),
    ).rejects.toThrow(/1441/)
    expect(ctx.timelapse.list()).toHaveLength(0)
  })

  it('applies the same guard to a patch that ADDS a camera', async () => {
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    await expect(
      ctx.handlers['nc.upsertTimelapseRule'](
        { ruleId: created.rule.id, patch: { deviceIds: [101, 1441] } },
        USER,
      ),
    ).rejects.toThrow(/1441/)
  })

  it('refuses a target the caller does not own (admins bypass)', async () => {
    await expect(
      ctx.handlers['nc.upsertTimelapseRule'](
        { rule: input({ deviceIds: [101], targets: [{ targetId: 't-other' }] }) },
        USER,
      ),
    ).rejects.toThrow(/target not owned/)
    const asAdmin = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101], targets: [{ targetId: 't-other' }] }) },
      ADMIN,
    )
    expect(asAdmin.rule.id).toBeDefined()
  })

  it('is FAIL-CLOSED on an absent caller', async () => {
    await expect(
      ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [101] }) }, undefined),
    ).rejects.toThrow(/authenticated caller required/)
  })

  it('refuses to edit another user’s personal rule', async () => {
    const mine = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    await expect(
      ctx.handlers['nc.upsertTimelapseRule'](
        { ruleId: mine.rule.id, patch: { name: 'x' } },
        { userId: 'u2', isAdmin: false },
      ),
    ).rejects.toThrow(/not owned/)
  })

  it('cannot decide anything when the recording authority is unreachable', async () => {
    // A read that fails must never look like "recording is on": it would let a
    // rule be saved that can never produce a video.
    const out = ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [42] }) }, USER)
    await expect(out).rejects.toThrow(/42/)
  })
})

describe('nc.listTimelapseRules', () => {
  it('scopes a user to his own plus the global rules and stamps readOnly', async () => {
    const ctx = await makeCtx()
    await ctx.handlers['nc.upsertTimelapseRule']({ rule: input({ deviceIds: [101] }) }, USER)
    await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ name: 'globale', deviceIds: [101] }) },
      ADMIN,
    )
    const mine = await ctx.handlers['nc.listTimelapseRules']({}, USER)
    expect(mine.rules).toHaveLength(2)
    expect(mine.rules.find((r) => r.name === 'globale')?.readOnly).toBe(true)
    expect(mine.rules.find((r) => r.name === 'Notte retro')?.readOnly).toBe(false)

    const other = await ctx.handlers['nc.listTimelapseRules']({}, { userId: 'u2', isAdmin: false })
    expect(other.rules.map((r) => r.name)).toEqual(['globale'])
  })

  it('is FAIL-CLOSED on an absent caller', async () => {
    const ctx = await makeCtx()
    await expect(ctx.handlers['nc.listTimelapseRules']({}, undefined)).rejects.toThrow(
      /authenticated caller required/,
    )
  })
})

describe('nc.deleteTimelapseRule', () => {
  it('deletes a rule the caller owns', async () => {
    const ctx = await makeCtx()
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    await ctx.handlers['nc.deleteTimelapseRule']({ ruleId: created.rule.id }, USER)
    expect(ctx.timelapse.list()).toHaveLength(0)
  })

  it('refuses to delete another user’s rule', async () => {
    const ctx = await makeCtx()
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      USER,
    )
    await expect(
      ctx.handlers['nc.deleteTimelapseRule'](
        { ruleId: created.rule.id },
        { userId: 'u2', isAdmin: false },
      ),
    ).rejects.toThrow(/not owned/)
  })
})

describe('nc.testTimelapseRule', () => {
  it('produces the last closed window for one camera, admin only', async () => {
    const ctx = await makeCtx()
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      ADMIN,
    )
    const out = await ctx.handlers['nc.testTimelapseRule'](
      { ruleId: created.rule.id, deviceId: 101 },
      ADMIN,
    )
    expect(out.produced).toBe(1)
    expect(ctx.runNowCalls).toEqual([{ ruleId: created.rule.id, deviceId: 101 }])
  })

  it('refuses a non-admin — a test DELIVERS to other people’s phones', async () => {
    const ctx = await makeCtx()
    const created = await ctx.handlers['nc.upsertTimelapseRule'](
      { rule: input({ deviceIds: [101] }) },
      ADMIN,
    )
    await expect(
      ctx.handlers['nc.testTimelapseRule']({ ruleId: created.rule.id, deviceId: 101 }, USER),
    ).rejects.toThrow(/admin/)
  })
})

describe('the timelapse bridge on a node that hosts no producer', () => {
  it('refuses honestly instead of answering as if nothing existed', async () => {
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
    await expect(handlers['nc.listTimelapseRules']({}, ADMIN)).rejects.toThrow(/hub/)
  })
})
