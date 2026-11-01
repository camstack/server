/**
 * `{{device}}` -> `{{device}}` over the REAL records engine on real SQLite, driven the way the
 * owner drives it: the catalogue bound to the three kinds and run by `runAddonMigrations`
 * against a ledger that records what the engine would. Every assertion reads the rows back.
 */

import { RecordsEngine } from '@camstack/server/system'
import {
  type AddonMigrationHost,
  createRecordsAccess,
  defineAddonMigrations,
  type MigrationMeta,
  type MigrationOwnerResult,
  NcRuleInputSchema,
  type RecordsAccess,
  type RecordsTransport,
  runAddonMigrations,
  type TimelapseRuleInput,
  TimelapseRuleInputSchema,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { ncRecordKinds, RuleBodySchema } from '../../notification-center/record-kinds.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { renameDeviceVariable } from '../device-template-var.js'
import { ADDON_MIGRATIONS, type NcTemplateMigrationPorts } from '../index.js'

const OWNER = 'pipeline-analytics'
const MIGRATION_ID = 'pipeline-analytics/2026-11-01-template-camera-to-device'
const MARK = 'garage door, kept as written'

function engineTransport(engine: RecordsEngine): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly owner: string } =>
    Object.assign({}, input, { owner: OWNER })
  return {
    declareKinds: (i) => engine.declareKinds(as(i)),
    get: (i) => engine.get(as(i)),
    getMany: (i) => engine.getMany(as(i)),
    secretRefs: (i) => engine.secretRefs(as(i)),
    put: (i) => engine.put(as(i)),
    putMany: (i) => engine.putMany(as(i)),
    patch: (i) => engine.patch(as(i)),
    delete: (i) => engine.delete(as(i)),
    deleteMany: (i) => engine.deleteMany(as(i)),
    query: (i) => engine.query(as(i)),
    count: (i) => engine.count(as(i)),
    histogram: (i) => engine.histogram(as(i)),
    aggregate: (i) => engine.aggregate(as(i)),
    deleteWhere: (i) => engine.deleteWhere(as(i)),
    transact: (i) => engine.transact(as(i)),
    deleteDevice: (i) => engine.deleteDevice(as(i)),
    allocateId: (i) => engine.allocateId(as(i)),
  }
}

/** The ledger the engine keeps for an owner: declared metas, then one outcome per id. */
function ledgerHost(): {
  host: AddonMigrationHost
  applied: Map<string, MigrationOwnerResult>
} {
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
    startMigration: async () => ({
      proceed: true,
      state: 'pending' as const,
      reason: null,
    }),
    finishMigration: async ({ id, result }) => {
      if (result.kind === 'failed') {
        return {
          status: 'failed' as const,
          error: result.error,
          rowsChanged: 0,
        }
      }
      applied.set(id, result)
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    },
  }
  return { host, applied }
}

interface World {
  readonly records: RecordsAccess
  readonly ports: NcTemplateMigrationPorts
}

async function makeWorld(): Promise<World> {
  const engine = new RecordsEngine(new Database(':memory:'), {
    databaseId: 'settings',
    logger: makeSilentLogger(),
  })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: engineTransport(engine),
    secrets: null,
  })
  await records.declare(ncRecordKinds)
  return {
    records,
    ports: {
      rules: records.kind(ncRecordKinds['rules']),
      timelapseRules: records.kind(ncRecordKinds['timelapse-rules']),
      texts: records.kind(ncRecordKinds.texts),
    },
  }
}

function ruleBody(name: string, template?: { title?: string; body?: string }) {
  const input = NcRuleInputSchema.parse({
    name,
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    ...(template !== undefined ? { template } : {}),
  })
  return RuleBodySchema.parse({
    ...input,
    disabledTargetIds: [],
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
}

function timelapseBody(extra: Partial<TimelapseRuleInput>) {
  const input = TimelapseRuleInputSchema.parse({
    name: 'night timelapse',
    targets: [{ targetId: 'tgt-1' }],
    deviceIds: [101],
    schedule: {
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 }],
    },
    ...extra,
  })
  return { ...input, createdBy: 'admin', createdAt: 1, updatedAt: 1 }
}

async function runCatalogue(world: World, host: AddonMigrationHost) {
  return runAddonMigrations(
    host,
    defineAddonMigrations(ADDON_MIGRATIONS, world.ports),
    makeSilentLogger(),
  )
}

describe('renameDeviceVariable', () => {
  it('renames the variable with or without inner whitespace and nothing else', () => {
    expect(renameDeviceVariable('{{device}} / {{ camera }} / {{camera }}')).toBe(
      '{{device}} / {{ device }} / {{device }}',
    )
    expect(renameDeviceVariable('{{cameraName}} camera {{deviceName}}')).toBe(
      '{{cameraName}} camera {{deviceName}}',
    )
  })
})

describe('the camera -> device template migration', () => {
  let world: World
  beforeEach(async () => {
    world = await makeWorld()
    await world.ports.rules.put({
      id: 'r-old',
      data: ruleBody(MARK, {
        title: '{{ camera }} alert',
        body: '{{class}} on {{camera}}',
      }),
    })
    await world.ports.rules.put({
      id: 'r-new',
      data: ruleBody('no variable', { body: '{{class}}' }),
    })
    await world.ports.rules.put({
      id: 'r-bare',
      data: ruleBody('no template'),
    })
    await world.ports.timelapseRules.put({
      id: 't-old',
      data: timelapseBody({
        template: { title: 'Timelapse {{camera}}' },
        previewText: '{{camera}} {{from}}',
      }),
    })
    await world.ports.texts.put({
      id: 'texts',
      data: {
        language: 'en',
        overrides: {
          en: {
            'detection.body': '{{subject}} at {{camera}}',
            'x.keep': 'plain',
          },
        },
      },
    })
  })

  it('rewrites every stored template, leaves every other field intact, and records one applied row', async () => {
    const { host, applied } = ledgerHost()
    const report = await runCatalogue(world, host)
    expect(report.applied).toEqual([MIGRATION_ID])
    expect(applied.get(MIGRATION_ID)).toEqual({
      kind: 'procedure',
      result: {
        outcome: 'done',
        summary: { rules: 1, timelapseRules: 1, texts: 1 },
      },
    })

    const old = (await world.ports.rules.get('r-old'))?.data
    expect(old?.template).toEqual({
      title: '{{ device }} alert',
      body: '{{class}} on {{device}}',
    })
    expect(old?.name).toBe(MARK)
    expect(old?.conditions).toEqual({ classes: ['person'] })
    expect((await world.ports.rules.get('r-new'))?.data.template).toEqual({
      body: '{{class}}',
    })
    expect((await world.ports.rules.get('r-bare'))?.data.template).toBeUndefined()

    const lapse = (await world.ports.timelapseRules.get('t-old'))?.data
    expect(lapse?.template).toEqual({ title: 'Timelapse {{device}}' })
    expect(lapse?.previewText).toBe('{{device}} {{from}}')
    expect(lapse?.name).toBe('night timelapse')

    const texts = (await world.ports.texts.get('texts'))?.data
    expect(texts?.overrides).toEqual({
      en: { 'detection.body': '{{subject}} at {{device}}', 'x.keep': 'plain' },
    })
  })

  it('a second run changes nothing: rows keep their revision and the outcome is already-done', async () => {
    await runCatalogue(world, ledgerHost().host)
    const revs = async () => [
      (await world.ports.rules.get('r-old'))?.rev,
      (await world.ports.timelapseRules.get('t-old'))?.rev,
      (await world.ports.texts.get('texts'))?.rev,
    ]
    const before = await revs()
    const second = ledgerHost()
    await runCatalogue(world, second.host)
    expect(await revs()).toEqual(before)
    expect(second.applied.get(MIGRATION_ID)).toEqual({
      kind: 'procedure',
      result: {
        outcome: 'already-done',
        summary: { rules: 0, timelapseRules: 0, texts: 0 },
      },
    })
  })
})
