/**
 * The system-event delivery migration (D987, D1019) over the REAL records engine on real
 * SQLite, driven the way the owner drives it. The fixture is the shape of every system rule of
 * the production hub, anonymised: each row is read back and judged on what the engine decides
 * from it (`instantKindsOf`, the summary schedule and its hash, the grouping), before and after.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  instantKindsOf,
  isSystemEventSummaryRule,
  type MigrationMeta,
  type MigrationOwnerResult,
  NcRuleInputSchema,
  NcSystemEventKindSchema,
  type RecordsAccess,
  runAddonMigrations,
  systemEventSummaryScheduleOf,
  systemEventSummarySplitOf,
} from '@camstack/types'
import { canonicalHash } from '@camstack/types/node'
import { beforeEach, describe, expect, it } from 'vitest'
import { type RuleBody, RuleBodySchema } from '../../notification-center/record-kinds.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { ADDON_MIGRATIONS, type PipelineAnalyticsMigrationPorts } from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const MIGRATION_ID = 'pipeline-analytics/2026-11-07-system-event-delivery-modes'

const EVENING = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1079, endMinute: 1080 }],
}
const NOON_AND_EVENING = {
  windows: [
    { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 719, endMinute: 720 },
    { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1199, endMinute: 1200 },
  ],
}

interface Fixture {
  readonly id: string
  readonly kinds: readonly string[]
  readonly delivery?: unknown
}

/** Every system rule of the production hub (names anonymised, shapes as stored). */
const FIXTURES: readonly Fixture[] = [
  {
    id: 'consumables',
    kinds: ['device-consumable-low', 'device-consumable-normal'],
    delivery: { mode: 'instant' },
  },
  {
    id: 'evening',
    kinds: ['device-offline', 'device-battery-low', 'device-consumable-low'],
    delivery: { mode: 'summary', schedule: EVENING, split: 'section' },
  },
  {
    id: 'devices-key-absent',
    kinds: [
      'stream-offline',
      'stream-online',
      'detection-blind',
      'recording-stalled',
      'recording-healthy',
    ],
  },
  {
    id: 'critical',
    kinds: [
      'alert-critical',
      'alert-critical-resolved',
      'storage-location-critical',
      'storage-location-ok',
    ],
    delivery: { mode: 'instant' },
  },
  { id: 'nodes', kinds: ['node-offline', 'node-online'], delivery: { mode: 'instant' } },
  {
    id: 'system-summary',
    kinds: [
      'node-offline',
      'node-online',
      'addon-update-available',
      'server-update-available',
      'addon-updated',
      'node-updating',
      'server-updated',
      'backup-completed',
    ],
    delivery: { mode: 'summary', schedule: NOON_AND_EVENING },
  },
  {
    id: 'alarm',
    kinds: ['alarm-armed', 'alarm-pending', 'alarm-triggered', 'alarm-disarmed'],
  },
  // Lonely bad edge, stored unwidened: the load widens it, so the migration must read it that way.
  { id: 'lonely-bad-edge', kinds: ['device-offline'], delivery: { mode: 'instant' } },
  // Single-edge kinds only: nothing clears, so deactivation must stay off.
  {
    id: 'single-edge',
    kinds: ['backup-completed', 'addon-updated'],
    delivery: { mode: 'instant' },
  },
]

const MARK = 'garage door, kept as written'

function ledgerHost(): { host: AddonMigrationHost; applied: Map<string, MigrationOwnerResult> } {
  const metas: MigrationMeta[] = []
  const applied = new Map<string, MigrationOwnerResult>()
  const host: AddonMigrationHost = {
    declareOwner: async (input) => {
      metas.push(...input.metas)
      return {
        bootId: 'boot-1',
        snapshot: 'none' as const,
        steps: input.metas.map((m) => ({
          id: m.id,
          action: applied.has(m.id) ? ('skip' as const) : ('run' as const),
          state: applied.has(m.id) ? ('applied' as const) : ('pending' as const),
        })),
      }
    },
    startMigration: async () => ({ proceed: true, state: 'pending' as const, reason: null }),
    finishMigration: async ({ id, result }) => {
      if (result.kind === 'failed') {
        return { status: 'failed' as const, error: result.error, rowsChanged: 0 }
      }
      applied.set(id, result)
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    },
  }
  return { host, applied }
}

interface World {
  readonly records: RecordsAccess
  readonly ports: PipelineAnalyticsMigrationPorts
}

async function makeWorld(): Promise<World> {
  const { records, ncPorts } = await makeNcWorld()
  return {
    records,
    ports: {
      ...ncPorts,
      readStored: async () => ({}),
      announceRetired: async () => undefined,
      listDeviceIds: async () => [],
      readDeviceField: async () => new Map(),
    },
  }
}

function body(fixture: Fixture): RuleBody {
  const input = NcRuleInputSchema.parse({
    name: `${MARK} ${fixture.id}`,
    delivery: 'system-event',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { systemEvent: { kinds: fixture.kinds } },
    ...(fixture.delivery !== undefined ? { systemEventDelivery: fixture.delivery } : {}),
  })
  return RuleBodySchema.parse({
    ...input,
    disabledTargetIds: [],
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
}

async function run(world: World, host: AddonMigrationHost) {
  return runAddonMigrations(
    host,
    defineAddonMigrations(
      ADDON_MIGRATIONS.filter((entry) => entry.meta.id === MIGRATION_ID),
      world.ports,
    ),
    makeSilentLogger(),
  )
}

const ALL_KINDS = NcSystemEventKindSchema.options

describe('the system-event delivery modes migration', () => {
  let world: World
  const before = new Map<string, RuleBody>()

  beforeEach(async () => {
    world = await makeWorld()
    before.clear()
    for (const fixture of FIXTURES) {
      const data = body(fixture)
      before.set(fixture.id, data)
      await world.ports.rules.put({ id: fixture.id, data })
    }
    await world.ports.rules.put({
      id: 'motion',
      data: RuleBodySchema.parse({
        ...NcRuleInputSchema.parse({
          name: 'person at the door',
          delivery: 'immediate',
          targets: [{ targetId: 'tgt-1' }],
          conditions: { classes: ['person'] },
        }),
        disabledTargetIds: [],
        createdBy: 'admin',
        createdAt: 1,
        updatedAt: 1,
      }),
    })
  })

  async function after(id: string): Promise<RuleBody> {
    const row = await world.ports.rules.get(id)
    if (row === undefined || row === null) throw new Error(`row ${id} missing`)
    return row.data
  }

  it('keeps what every production rule decides, and leaves name and kinds as written', async () => {
    const { host, applied } = ledgerHost()
    await run(world, host)
    expect(applied.get(MIGRATION_ID)).toMatchObject({ kind: 'procedure' })

    for (const fixture of FIXTURES) {
      const was = before.get(fixture.id)
      const now = await after(fixture.id)
      if (was === undefined) throw new Error('fixture')
      // The mark: nothing the migration does not know about moved.
      expect(now.name).toBe(was.name)
      expect(now.conditions).toEqual(was.conditions)
      // What the engine decides from the row, kind by kind, is unchanged.
      const heardBefore = instantKindsOf(was)
      const heardAfter = instantKindsOf(now)
      for (const kind of ALL_KINDS) {
        expect(heardAfter.has(kind), `${fixture.id}: ${kind}`).toBe(heardBefore.has(kind))
      }
      expect(isSystemEventSummaryRule(now)).toBe(isSystemEventSummaryRule(was))
      expect(systemEventSummarySplitOf(now)).toBe(systemEventSummarySplitOf(was))
      expect(canonicalHash(systemEventSummaryScheduleOf(now))).toBe(
        canonicalHash(systemEventSummaryScheduleOf(was)),
      )
    }
  })

  it('writes the expected shape per rule', async () => {
    await run(world, ledgerHost().host)
    const both = { mode: 'modes', onActivation: true, onDeactivation: true }
    expect((await after('consumables')).systemEventDelivery).toEqual(both)
    expect((await after('nodes')).systemEventDelivery).toEqual(both)
    expect((await after('critical')).systemEventDelivery).toEqual(both)
    expect((await after('devices-key-absent')).systemEventDelivery).toEqual(both)
    expect((await after('lonely-bad-edge')).systemEventDelivery).toEqual(both)
    expect((await after('single-edge')).systemEventDelivery).toEqual({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
    })
    expect((await after('evening')).systemEventDelivery).toEqual({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
      onSchedule: { schedule: EVENING, grouping: 'section' },
    })
    expect((await after('system-summary')).systemEventDelivery).toEqual({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
      onSchedule: { schedule: NOON_AND_EVENING, grouping: 'rule' },
    })
    // An alarm and a rule that is not a system rule are not touched.
    expect((await after('alarm')).systemEventDelivery).toBeUndefined()
    expect((await after('motion')).systemEventDelivery).toBeUndefined()
  })

  it('is idempotent: a second run finds nothing to do', async () => {
    const { host, applied } = ledgerHost()
    await run(world, host)
    const snapshot = await after('nodes')
    applied.clear()
    await run(world, host)
    expect(applied.get(MIGRATION_ID)).toEqual({
      kind: 'procedure',
      result: { outcome: 'already-done', summary: { rules: 0 } },
    })
    expect(await after('nodes')).toEqual(snapshot)
  })
})
