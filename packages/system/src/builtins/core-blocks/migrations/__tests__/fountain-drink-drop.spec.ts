/**
 * The core-blocks migration that removes the drink counters from a stored
 * pet-fountain composition, run through the REAL records engine (a real SQLite
 * file, the real `core_blocks` kind) with the migration driver the addon uses.
 *
 * The seed is the live block 08e03869 as the previous preset stored it:
 * `lastDrink`, `currentHourDrink`, `last24hDrink` and `todayDrink` are fields of
 * `pet-fountain` and `resetDailyConsumption` forwards to a button. After the
 * migration the block converges to what the preset builds today, a MARKED
 * neighbouring field survives, rows that are not pet-fountain compositions are
 * byte-identical, and a rerun edits nothing.
 */
import {
  type Composition,
  CompositionSchema,
  type CompositionFieldSource,
  type CompositionSourceRef,
  type CoreBlock,
  CoreBlockSchema,
  createRecordsAccess,
  defineAddonMigrations,
  petFountainFromEntitiesComposition,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { type CoreBlockRowBody, coreBlocksRecordKinds } from '../../record-kinds.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import { ADDON_MIGRATIONS, FOUNTAIN_DRINK_DROP_ID, coreBlocksMigrationPorts } from '../index.js'

const ref = (entity: string): CompositionSourceRef => ({
  addonId: 'provider-homeassistant',
  stableId: `ha:b1:dev:fountain-${entity}`,
})

const SOURCES = {
  waterLevel: ref('water_level'),
  waterVolume: ref('water_volume'),
  pump: ref('pump'),
  pumpCycle: {
    interval: ref('interval'),
    onMinutes: ref('on_minutes'),
    offMinutes: ref('off_minutes'),
  },
  filter: { daysRemaining: ref('filter_days'), changed: ref('filter_changed') },
}

function litresOf(entity: string): CompositionFieldSource {
  return {
    kind: 'expression',
    expr: 'number(v) == null ? null : number(v) / 1000',
    bindings: { v: { kind: 'from', source: ref(entity), cap: 'enum-sensor', fieldPath: 'value' } },
  }
}

/** The composition as the PREVIOUS preset stored it: the four counters and the reset forward. */
function legacyComposition(): Composition {
  const current = petFountainFromEntitiesComposition(SOURCES)
  const features = current.features.map((f) =>
    f.kind === 'fields' && f.cap === 'pet-fountain'
      ? {
          ...f,
          fields: {
            ...f.fields,
            lastDrink: litresOf('last_drink'),
            currentHourDrink: litresOf('hour_drink'),
            last24hDrink: litresOf('day_drink'),
            todayDrink: litresOf('today_drink'),
          },
          commands: {
            ...f.commands,
            resetDailyConsumption: {
              kind: 'forward',
              source: ref('clear_daily'),
              cap: 'button',
              method: 'press',
            },
          },
        }
      : f,
  )
  return CompositionSchema.parse({ ...current, features })
}

function blockOf(id: string, name: string, composition: Composition, mark: string): CoreBlock {
  return CoreBlockSchema.parse({
    id,
    name,
    code: '',
    enabled: mark !== 'off',
    placement: 'hub',
    source: { kind: 'composition', composition },
    createdBy: `marker-${mark}`,
    createdAt: 10,
    updatedAt: 20,
    status: 'stopped',
    lastChangedAt: 20,
  })
}

function rowBody(block: CoreBlock): CoreBlockRowBody {
  return {
    name: block.name,
    enabled: block.enabled,
    placement: block.placement,
    updatedAt: block.updatedAt,
    block,
  }
}

const OTHER_COMPOSITION: Composition = {
  target: { kind: 'existing', device: ref('somewhere') },
  features: [{ kind: 'fields', cap: 'pet-fountain', fields: { lastDrink: litresOf('x') } }],
}

let records: ReturnType<typeof createRecordsAccess>
const NOW = 5_000

beforeEach(async () => {
  const world = makeRecordsWorld()
  await world.provider.init()
  records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const code = CoreBlockSchema.parse({
    id: 'code-1',
    name: 'Plain code',
    code: 'export default () => {}',
    enabled: true,
    placement: 'hub',
    createdBy: 'marker-code',
    createdAt: 1,
    updatedAt: 2,
    status: 'stopped',
    lastChangedAt: 2,
  })
  for (const block of [
    blockOf('08e03869', 'Fontanella', legacyComposition(), 'live'),
    blockOf('fountain-off', 'Spare fountain', legacyComposition(), 'off'),
    blockOf('customize-1', 'customize:somewhere', OTHER_COMPOSITION, 'cust'),
    code,
  ]) {
    await handle.put({ id: block.id, data: rowBody(block) })
  }
})

async function runMigration(): Promise<string> {
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const { logger } = recordingLogger()
  const ports = coreBlocksMigrationPorts(handle, logger, () => NOW)
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const migration = bound.find((m) => m.meta.id === FOUNTAIN_DRINK_DROP_ID)
  if (migration === undefined) throw new Error('migration is not in the catalogue')
  const out = await migration.execute()
  if (out.kind !== 'procedure') throw new Error(`expected a procedure result, got ${out.kind}`)
  return out.result.outcome
}

async function stored(id: string) {
  const row = await records.kind(coreBlocksRecordKinds.blocks).get(id)
  if (row === null) throw new Error(`no row ${id}`)
  return row
}

describe('core-blocks migration: the drink counters leave pet-fountain', () => {
  it('the seed really carries the counters (the spec would otherwise prove nothing)', async () => {
    const block = CoreBlockSchema.parse((await stored('08e03869')).data.block)
    const feature =
      block.source?.kind === 'composition'
        ? block.source.composition.features.find(
            (f) => f.kind === 'fields' && f.cap === 'pet-fountain',
          )
        : undefined
    expect(Object.keys(feature?.kind === 'fields' ? feature.fields : {})).toEqual(
      expect.arrayContaining(['lastDrink', 'currentHourDrink', 'last24hDrink', 'todayDrink']),
    )
  })

  it('converges the live block to what the preset builds today, keeping every marked field', async () => {
    await expect(runMigration()).resolves.toBe('done')
    const row = await stored('08e03869')
    const block = CoreBlockSchema.parse(row.data.block)
    expect(block.source).toEqual({
      kind: 'composition',
      composition: petFountainFromEntitiesComposition(SOURCES),
    })
    expect(block).toMatchObject({
      name: 'Fontanella',
      createdBy: 'marker-live',
      createdAt: 10,
      enabled: true,
    })
    expect(row.data).toMatchObject({ name: 'Fontanella', enabled: true })
    expect(block.updatedAt).toBe(NOW)
    expect(row.data.updatedAt).toBe(NOW)
  })

  it('keeps a disabled fountain disabled', async () => {
    await runMigration()
    const row = await stored('fountain-off')
    expect(row.data.enabled).toBe(false)
    expect(CoreBlockSchema.parse(row.data.block).createdBy).toBe('marker-off')
  })

  it('leaves a code block and a customization byte-identical', async () => {
    const before = [await stored('code-1'), await stored('customize-1')]
    await runMigration()
    expect([await stored('code-1'), await stored('customize-1')]).toEqual(before)
  })

  it('a second run edits nothing and says so', async () => {
    await runMigration()
    const first = [await stored('08e03869'), await stored('fountain-off')]
    await expect(runMigration()).resolves.toBe('already-done')
    expect([await stored('08e03869'), await stored('fountain-off')]).toEqual(first)
  })
})
