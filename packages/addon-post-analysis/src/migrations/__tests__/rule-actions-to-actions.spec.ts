/**
 * The rule-actions migration (D987, planning#473) over the REAL records engine on real SQLite,
 * driven the way the owner drives it. Legacy rows are seeded through a LOOSE handle on the same
 * kinds — the real kinds refuse the old shape on write, which is the point of the migration.
 */
import {
  type ActionInput,
  type AddonMigrationHost,
  defineAddonMigrations,
  type MigrationMeta,
  type MigrationOwnerResult,
  NcRuleActionsSchema,
  NcRuleInputSchema,
  type RecordsAccess,
  type RecordKindHandle,
  runAddonMigrations,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ncRecordKinds, type RuleBody } from '../../notification-center/record-kinds.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  ADDON_MIGRATIONS,
  type PipelineAnalyticsMigrationPorts,
  RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID,
} from '../index.js'
import type { MigratedAction } from '../rule-actions-to-actions.js'
import { makeNcWorld } from './support/nc-records-world.js'

const MARK_RULE = 'garage door rule, kept as written'
const MARK_LABEL = 'Open the gate, kept as written'

const CAP_STEP = { kind: 'cap', cap: 'switch', method: 'turnOn', deviceId: 7 }
const CAP_STEP_OFF = { kind: 'cap', cap: 'switch', method: 'turnOff', deviceId: 7 }
const WAIT_STEP = { kind: 'wait', seconds: 5 }

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

/** The Actions surface: a list in memory, the way the cap keeps internal Actions. */
class FakeActions {
  readonly rows: MigratedAction[] = []
  failNextCreate = false
  private next = 1

  readonly port = {
    list: async (): Promise<readonly MigratedAction[]> => [...this.rows],
    create: async (input: ActionInput): Promise<string> => {
      if (this.failNextCreate) {
        this.failNextCreate = false
        throw new Error('the Actions cap is not reachable')
      }
      const id = `internal:${String(this.next++).padStart(8, '0')}`
      this.rows.push({
        id,
        name: input.name,
        steps: input.steps,
        minDelaySec: input.minDelaySec,
      })
      return id
    },
  }
}

const LooseBody = z.looseObject({})

interface World {
  readonly records: RecordsAccess
  readonly ports: PipelineAnalyticsMigrationPorts
  readonly actions: FakeActions
  readonly looseRules: RecordKindHandle<Record<string, unknown>>
  readonly looseSequences: RecordKindHandle<Record<string, unknown>>
}

async function makeWorld(): Promise<World> {
  const { records, ncPorts } = await makeNcWorld()
  const actions = new FakeActions()
  return {
    records,
    actions,
    looseRules: records.kind({ ...ncRecordKinds['rules'], schema: LooseBody }),
    looseSequences: records.kind({ ...ncRecordKinds.sequences, schema: LooseBody }),
    ports: {
      ...ncPorts,
      actions: actions.port,
      readStored: async () => ({}),
      announceRetired: async () => undefined,
      listDeviceIds: async () => [],
      readDeviceField: async () => new Map(),
    },
  }
}

function baseRule(name: string): Record<string, unknown> {
  return {
    ...NcRuleInputSchema.parse({
      name,
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-1' }],
      conditions: { classes: ['person'] },
    }),
    disabledTargetIds: [],
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  }
}

function runMigration(world: World, host: AddonMigrationHost) {
  return runAddonMigrations(
    host,
    defineAddonMigrations(
      ADDON_MIGRATIONS.filter((entry) => entry.meta.id === RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID),
      world.ports,
    ),
    makeSilentLogger(),
  )
}

async function ruleAfter(world: World, id: string): Promise<RuleBody> {
  const row = await world.ports.rules.get(id)
  if (row === undefined || row === null) throw new Error(`rule ${id} missing`)
  return row.data
}

describe('the rule-actions migration', () => {
  let world: World

  beforeEach(async () => {
    world = await makeWorld()
    await world.looseSequences.put({
      id: 'seq-gate',
      data: {
        name: 'Open the gate',
        minDelaySec: 30,
        actions: [CAP_STEP, WAIT_STEP, CAP_STEP_OFF],
        createdAt: 1,
        updatedAt: 1,
      },
    })
    await world.looseRules.put({
      id: 'rule-a',
      data: {
        ...baseRule(MARK_RULE),
        actions: {
          onTrigger: [
            { kind: 'sequence', sequenceId: 'seq-gate' },
            { kind: 'do', action: CAP_STEP },
            { kind: 'do', action: WAIT_STEP },
          ],
          onTriggerOff: [{ kind: 'do', action: CAP_STEP_OFF }],
          buttons: [
            { id: 'btn-open', label: MARK_LABEL, sequenceId: 'seq-gate', destructive: true },
            { id: 'btn-gone', label: 'points nowhere', sequenceId: 'seq-vanished' },
          ],
        },
      },
    })
    await world.looseRules.put({ id: 'rule-plain', data: baseRule('no actions at all') })
  })

  it('makes an Action of the sequence, rebinds the rule and its button, and keeps what it does not know', async () => {
    const { host, applied } = ledgerHost()
    await runMigration(world, host)
    expect(applied.get(RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID)).toMatchObject({ kind: 'procedure' })

    const gate = world.actions.rows.find((a) => a.name === 'Open the gate')
    expect(gate).toMatchObject({ minDelaySec: 30 })
    expect(gate?.steps).toHaveLength(3)

    const rule = await ruleAfter(world, 'rule-a')
    // The mark: nothing the migration does not know about moved.
    expect(rule.name).toBe(MARK_RULE)
    expect(rule.conditions).toEqual({ classes: ['person'] })
    expect(NcRuleActionsSchema.safeParse(rule.actions).success).toBe(true)

    const inline = world.actions.rows.find((a) => a.name === MARK_RULE)
    expect(inline?.steps).toHaveLength(2)
    const cleared = world.actions.rows.find((a) => a.name === `${MARK_RULE} (cleared)`)
    expect(rule.actions?.onTrigger).toEqual([gate?.id, inline?.id])
    expect(rule.actions?.onTriggerOff).toEqual([cleared?.id])
    // A button keeps every field it had, and names the Action now; one that pointed at a
    // sequence that no longer exists is dropped, not rewritten to an Action that does not.
    expect(rule.actions?.buttons).toEqual([
      { id: 'btn-open', label: MARK_LABEL, actionId: gate?.id, destructive: true },
    ])
    // The old keys are gone only after the verified read.
    expect(await world.ports.legacySequences.get('seq-gate')).toBeNull()
    expect((await ruleAfter(world, 'rule-plain')).actions).toBeUndefined()
  })

  it('is idempotent: a second run finds nothing to do and makes no twin', async () => {
    const { host, applied } = ledgerHost()
    await runMigration(world, host)
    const made = world.actions.rows.length
    const snapshot = await ruleAfter(world, 'rule-a')
    applied.clear()
    await runMigration(world, host)
    expect(applied.get(RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID)).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'already-done' },
    })
    expect(world.actions.rows).toHaveLength(made)
    expect(await ruleAfter(world, 'rule-a')).toEqual(snapshot)
  })

  it('a pass that died before the rules were rewritten reuses the Action it had made', async () => {
    // First pass: the Actions cap fails on the inline Action, after the sequence one was made.
    const first = ledgerHost()
    world.actions.failNextCreate = false
    const originalCreate = world.actions.port.create
    let calls = 0
    world.actions.port.create = async (input) => {
      calls += 1
      if (calls === 2) throw new Error('the Actions cap went away')
      return originalCreate(input)
    }
    await runMigration(world, first.host)
    expect(first.applied.get(RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID)).toBeUndefined()
    // Nothing was destroyed: the sequence row and the legacy rule are still there.
    expect(await world.ports.legacySequences.get('seq-gate')).not.toBeNull()
    expect(world.actions.rows).toHaveLength(1)

    world.actions.port.create = originalCreate
    await runMigration(world, ledgerHost().host)
    expect(world.actions.rows.filter((a) => a.name === 'Open the gate')).toHaveLength(1)
    expect(await world.ports.legacySequences.get('seq-gate')).toBeNull()
  })

  it('keeps a sequence row whose steps the Actions schema refuses, and names it', async () => {
    await world.looseSequences.put({
      id: 'seq-broken',
      data: { name: 'broken', actions: [{ kind: 'teleport' }], createdAt: 1, updatedAt: 1 },
    })
    const { host, applied } = ledgerHost()
    await runMigration(world, host)
    expect(applied.get(RULE_ACTIONS_TO_ACTIONS_MIGRATION_ID)).toMatchObject({
      result: { summary: { unparsableSequences: 1, sequenceRowsKept: 1 } },
    })
    expect(await world.ports.legacySequences.get('seq-broken')).not.toBeNull()
  })

  it('leaves a rule already in the new shape untouched while it rebinds the old one beside it', async () => {
    await world.looseRules.put({
      id: 'rule-new',
      data: {
        ...baseRule('already moved'),
        actions: {
          onTrigger: ['internal:keep-me'],
          buttons: [{ id: 'b1', label: 'Go', actionId: 'internal:keep-me' }],
        },
      },
    })
    await runMigration(world, ledgerHost().host)
    const moved = await ruleAfter(world, 'rule-new')
    expect(moved.actions).toEqual({
      onTrigger: ['internal:keep-me'],
      buttons: [{ id: 'b1', label: 'Go', actionId: 'internal:keep-me' }],
    })
    expect(NcRuleActionsSchema.safeParse((await ruleAfter(world, 'rule-a')).actions).success).toBe(
      true,
    )
  })
})
