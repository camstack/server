/**
 * `{{device}}` -> `{{device}}` over the REAL records engine on real SQLite, driven the way the
 * owner drives it: the catalogue bound to the three kinds and run by `runAddonMigrations`
 * against a ledger that records what the engine would. Every assertion reads the rows back.
 */

import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type MigrationMeta,
  type MigrationOwnerResult,
  NcRuleInputSchema,
  type RecordsAccess,
  runAddonMigrations,
  type TimelapseRuleInput,
  TimelapseRuleInputSchema,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { RuleBodySchema } from '../../notification-center/record-kinds.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { renameDeviceVariable } from '../device-template-var.js'
import { ADDON_MIGRATIONS, type PipelineAnalyticsMigrationPorts } from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const MIGRATION_ID = 'pipeline-analytics/2026-11-01-template-camera-to-device'
const MARK = 'garage door, kept as written'

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
  readonly ports: PipelineAnalyticsMigrationPorts
}

async function makeWorld(): Promise<World> {
  const { records, ncPorts } = await makeNcWorld()
  return {
    records,
    ports: {
      ...ncPorts,
      // The settings migration of the same catalogue has nothing stored to move here.
      readStored: async () => ({}),
      announceRetired: async () => undefined,
      listDeviceIds: async () => [],
      readDeviceField: async () => new Map(),
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
    // Only the template migration: the settings migration of the catalogue has its own spec.
    defineAddonMigrations(
      ADDON_MIGRATIONS.filter((entry) => entry.meta.id === MIGRATION_ID),
      world.ports,
    ),
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
