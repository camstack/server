/**
 * The core-blocks migration that splits the pump duty cycle out of `pet-fountain`
 * (planning#366), run through the REAL records engine (a real SQLite file, the
 * real `core_blocks` kind) with the migration driver the addon uses.
 *
 * A stored fountain built from the old preset carried `pumpIntervalEnabled` /
 * `pumpOnTime` / `pumpOffTime` and three forwards on `pet-fountain`. After the
 * migration those live on a `pump-cycle` feature, the block converges to what the
 * preset builds today, a MARKED neighbouring field of every row survives, rows
 * that are not pet-fountain compositions are byte-identical, and a rerun edits nothing.
 */
import {
  type Composition,
  CoreBlockSchema,
  type CoreBlock,
  type CompositionFieldSource,
  CompositionSchema,
  type CompositionSourceRef,
  createRecordsAccess,
  defineAddonMigrations,
  petFountainFromEntitiesComposition,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds, type CoreBlockRowBody } from '../../record-kinds.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import { ADDON_MIGRATIONS, PUMP_CYCLE_SPLIT_ID, coreBlocksMigrationPorts } from '../index.js'
import { NO_REMOTE_PORTS } from './no-remote-ports.js'

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
  lastDrink: ref('last_drink'),
  currentHourDrink: ref('hour_drink'),
  last24hDrink: ref('day_drink'),
  todayDrink: ref('day_drink'),
  clearDaily: ref('clear_daily'),
  filter: { daysRemaining: ref('filter_days'), changed: ref('filter_changed') },
}

const UNKNOWN: CompositionFieldSource = { kind: 'expression', expr: 'null', bindings: {} }
const minutes = { kind: 'numeric', value: { $input: 'minutes' } }

/** The composition as the PREVIOUS preset stored it: the cycle lives on `pet-fountain`. */
function legacyComposition(): Composition {
  const current = petFountainFromEntitiesComposition(SOURCES)
  const features = current.features
    .filter((f) => f.cap !== 'pump-cycle')
    .map((f) =>
      f.kind === 'fields' && f.cap === 'pet-fountain'
        ? {
            ...f,
            fields: {
              ...f.fields,
              pumpIntervalEnabled: {
                kind: 'from',
                source: SOURCES.pumpCycle.interval,
                cap: 'switch',
                fieldPath: 'on',
              },
              pumpOnTime: UNKNOWN,
              pumpOffTime: UNKNOWN,
            },
            commands: {
              ...f.commands,
              setPumpInterval: {
                kind: 'forward',
                source: SOURCES.pumpCycle.interval,
                cap: 'switch',
                method: 'setState',
              },
              setPumpOnMinutes: {
                kind: 'forward',
                source: SOURCES.pumpCycle.onMinutes,
                cap: 'control',
                method: 'setValue',
                args: { control: minutes },
              },
              setPumpOffMinutes: {
                kind: 'forward',
                source: SOURCES.pumpCycle.offMinutes,
                cap: 'control',
                method: 'setValue',
                args: { control: minutes },
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
  features: [{ kind: 'fields', cap: 'pet-fountain', fields: { pumpIntervalEnabled: UNKNOWN } }],
}

let records: ReturnType<typeof createRecordsAccess>
let lines: ReturnType<typeof recordingLogger>['lines']
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
    blockOf('fountain-live', 'Fontanella', legacyComposition(), 'live'),
    blockOf('fountain-off', 'Spare fountain', legacyComposition(), 'off'),
    blockOf('customize-1', 'customize:somewhere', OTHER_COMPOSITION, 'cust'),
    code,
  ]) {
    await handle.put({ id: block.id, data: rowBody(block) })
  }
  lines = recordingLogger().lines
})

async function runMigration(): Promise<string> {
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const { logger } = recordingLogger()
  const ports = { ...coreBlocksMigrationPorts(handle, logger, () => NOW), ...NO_REMOTE_PORTS }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const migration = bound.find((m) => m.meta.id === PUMP_CYCLE_SPLIT_ID)
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

function featureCaps(block: CoreBlock): readonly string[] {
  const composition = block.source?.kind === 'composition' ? block.source.composition : null
  return composition === null ? [] : composition.features.map((f) => f.cap)
}

describe('core-blocks migration: the pump cycle leaves pet-fountain', () => {
  it('converges a stored fountain to what the preset builds today, keeping every marked field', async () => {
    expect(lines).toEqual([])
    await expect(runMigration()).resolves.toBe('done')
    const row = await stored('fountain-live')
    const block = CoreBlockSchema.parse(row.data.block)
    expect(block.source).toEqual({
      kind: 'composition',
      composition: petFountainFromEntitiesComposition(SOURCES),
    })
    // The marked neighbours survive.
    expect(block).toMatchObject({
      name: 'Fontanella',
      createdBy: 'marker-live',
      createdAt: 10,
      enabled: true,
    })
    expect(row.data).toMatchObject({ name: 'Fontanella', enabled: true })
    // The version moves, so an editor holding the old one is refused.
    expect(block.updatedAt).toBe(NOW)
    expect(row.data.updatedAt).toBe(NOW)
    expect(featureCaps(block)).toEqual(['pet-fountain', 'pump-cycle', 'consumables'])
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
    const first = [await stored('fountain-live'), await stored('fountain-off')]
    await expect(runMigration()).resolves.toBe('already-done')
    expect([await stored('fountain-live'), await stored('fountain-off')]).toEqual(first)
  })
})
