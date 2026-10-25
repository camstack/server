/**
 * D692 §2.2: the grouping guard must be WIRED on both save routes. The unit
 * spec drives the guard itself; this boots the REAL addon and drives the REAL
 * providers it registers — the cap provider (`notificationRules.*Rule`) and the
 * rule bridge (`nc.*Rule`) — so a dropped call on one route cannot hide behind
 * a green unit suite.
 */
import {
  NcConfirmSchema,
  type NcRuleClearableKey,
  type NcRuleInput,
  NcRuleInputSchema,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NcGroupedConfirmRefusal,
  NcGroupingRefusal,
} from '../../notification-center/grouping-guard.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'

const CALLER = { userId: 'admin', isAdmin: true }
type RuleInput = NcRuleInput

function rule(
  delivery: 'immediate' | 'track-end',
  groupingSec?: number,
  confirmCount?: number,
): RuleInput {
  return NcRuleInputSchema.parse({
    name: 'Vialetto',
    delivery,
    conditions: {},
    targets: [{ targetId: 'target-1' }],
    ...(groupingSec !== undefined ? { groupingSec } : {}),
    ...(confirmCount !== undefined
      ? { confirm: { enabled: true, expect: { op: '>=', count: confirmCount } } }
      : {}),
  })
}

interface RuleSaver {
  readonly createRule: (input: { rule: RuleInput; caller: typeof CALLER }) => Promise<unknown>
  readonly updateRule: (input: {
    ruleId: string
    patch: Record<string, unknown>
    clear?: readonly NcRuleClearableKey[]
    caller: typeof CALLER
  }) => Promise<unknown>
}

function isRuleSaver(provider: object): provider is RuleSaver {
  return (
    'createRule' in provider &&
    typeof provider.createRule === 'function' &&
    'updateRule' in provider &&
    typeof provider.updateRule === 'function'
  )
}

function rulesProvider(booted: Booted): RuleSaver {
  const registration = booted.init?.providers?.find(
    (entry) => entry.capability.name === 'notification-rules',
  )
  if (registration === undefined || !isRuleSaver(registration.provider)) {
    throw new Error('notification-rules provider not registered')
  }
  return registration.provider
}

function bridge(booted: Booted): RuleSaver {
  const create = booted.init?.actionHandlers?.['nc.createRule']
  const update = booted.init?.actionHandlers?.['nc.updateRule']
  if (create === undefined || update === undefined) throw new Error('nc.*Rule not registered')
  return {
    createRule: ({ rule: r, caller }) => create({ rule: r }, caller),
    updateRule: ({ ruleId, patch, clear, caller }) =>
      update({ ruleId, patch, ...(clear !== undefined ? { clear } : {}) }, caller),
  }
}

/** The target catalog a cap-provider save checks `target-1` against. */
const NOTIFICATION_OUTPUT = {
  listTargets: {
    query: async () => [
      {
        id: 'target-1',
        addonId: 'notifiers',
        name: 'phone',
        kind: 'zentik',
        enabled: true,
        config: {},
      },
    ],
  },
  listTargetKinds: { query: async () => [] },
}

const booted: Booted[] = []

async function boot(): Promise<Booted> {
  const b = await bootAnalytics(101, async () => null, {
    notificationOutput: NOTIFICATION_OUTPUT,
  })
  booted.push(b)
  return b
}
afterEach(async () => {
  await Promise.all(booted.splice(0).map((b) => b.addon.shutdown()))
})

const routes: ReadonlyArray<readonly [string, (b: Booted) => RuleSaver]> = [
  ['notificationRules (cap provider)', rulesProvider],
  ['nc (bridge)', bridge],
]

describe.each(routes)('the grouping guard is WIRED on %s', (_name, route) => {
  it('createRule refuses a track-end rule with groupingSec', async () => {
    const b = await boot()
    await expect(
      route(b).createRule({ rule: rule('track-end', 20), caller: CALLER }),
    ).rejects.toThrow(NcGroupingRefusal)
  }, 20_000)

  it('createRule accepts the immediate one', async () => {
    const b = await boot()
    await expect(
      route(b).createRule({ rule: rule('immediate', 20), caller: CALLER }),
    ).resolves.toBeDefined()
  }, 20_000)

  it('updateRule refuses groupingSec on a track-end rule, accepts it on an immediate one', async () => {
    const b = await boot()
    const saver = route(b)
    const created = await saver.createRule({
      rule: rule('track-end'),
      caller: CALLER,
    })
    const trackEndId = idOf(created)
    await expect(
      saver.updateRule({
        ruleId: trackEndId,
        patch: { groupingSec: 20 },
        caller: CALLER,
      }),
    ).rejects.toThrow(NcGroupingRefusal)
    const immediate = idOf(await saver.createRule({ rule: rule('immediate'), caller: CALLER }))
    await expect(
      saver.updateRule({
        ruleId: immediate,
        patch: { groupingSec: 20 },
        caller: CALLER,
      }),
    ).resolves.toBeDefined()
  }, 20_000)
})

describe.each(routes)('the grouping guard honours `clear` on %s', (_name, route) => {
  it('leaving immediate with groupingSec stored is refused, unless the patch clears groupingSec', async () => {
    const b = await boot()
    const saver = route(b)
    const id = idOf(await saver.createRule({ rule: rule('immediate', 20), caller: CALLER }))
    await expect(
      saver.updateRule({ ruleId: id, patch: { delivery: 'track-end' }, caller: CALLER }),
    ).rejects.toThrow(NcGroupingRefusal)
    await expect(
      saver.updateRule({
        ruleId: id,
        patch: { delivery: 'track-end' },
        clear: ['groupingSec'],
        caller: CALLER,
      }),
    ).resolves.toBeDefined()
  }, 20_000)
})

describe.each(routes)('the grouped-confirm guard is WIRED on %s', (_name, route) => {
  it('createRule refuses a grouped rule expecting 2, accepts one expecting 1', async () => {
    const b = await boot()
    const saver = route(b)
    await expect(
      saver.createRule({ rule: rule('immediate', 20, 2), caller: CALLER }),
    ).rejects.toThrow(NcGroupedConfirmRefusal)
    await expect(
      saver.createRule({ rule: rule('immediate', 20, 1), caller: CALLER }),
    ).resolves.toBeDefined()
  }, 20_000)

  it('updateRule refuses a patch that adds the expectation to a grouped rule', async () => {
    const b = await boot()
    const saver = route(b)
    const id = idOf(await saver.createRule({ rule: rule('immediate', 20), caller: CALLER }))
    await expect(
      saver.updateRule({
        ruleId: id,
        patch: {
          confirm: NcConfirmSchema.parse({ enabled: true, expect: { op: '>=', count: 2 } }),
        },
        caller: CALLER,
      }),
    ).rejects.toThrow(NcGroupedConfirmRefusal)
  }, 20_000)
})

function idOf(created: unknown): string {
  if (
    typeof created === 'object' &&
    created !== null &&
    'rule' in created &&
    typeof created.rule === 'object' &&
    created.rule !== null &&
    'id' in created.rule &&
    typeof created.rule.id === 'string'
  ) {
    return created.rule.id
  }
  throw new Error('createRule returned no rule id')
}
