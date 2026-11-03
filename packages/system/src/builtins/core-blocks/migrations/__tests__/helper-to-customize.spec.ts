/**
 * The core-blocks migration that rewrites the appliance and heater helper
 * compositions into the plain Customize format (D1004, planning#402 phase 4),
 * run through the REAL records engine (a real SQLite file, the real
 * `core_blocks` kind) with the migration driver the addon uses.
 *
 * The fixtures carry MARKED threshold, dwell, plug and offSeconds values: the
 * rewritten rows must carry exactly those, the block id and so the composed
 * device stableId must not move, an aggregator helper is byte-identical, and a
 * rerun edits nothing. A second describe proves the composer RUNTIME decides
 * running exactly as the old helper did, over one watts series.
 */
import {
  type Composition,
  CompositionSchema,
  compositionReadKey,
  compositionSliceKey,
  compileHelper,
  composedDeviceRef,
  composedDeviceStableId,
  type CompositionSourceRef,
  CoreBlockSchema,
  type CoreBlock,
  createRecordsAccess,
  decodeScalarOverride,
  defineAddonMigrations,
  planComposition,
  type SourceReading,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../../../composer/composition-runtime.js'
import {
  FakeTarget,
  FakeTimer,
  LOOKUP_CAP,
  recordingLogger as composerLogger,
} from '../../../composer/__tests__/fixtures.js'
import {
  legacyAppliance,
  legacyHeater,
  type LegacyApplianceSpec,
  type LegacyHeaterSpec,
  type LegacyHelperComposition,
} from './legacy-helper-fixtures.js'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds, type CoreBlockRowBody } from '../../record-kinds.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import { ADDON_MIGRATIONS, coreBlocksMigrationPorts, HELPER_TO_CUSTOMIZE_ID } from '../index.js'

const ref = (name: string): CompositionSourceRef => ({
  addonId: 'provider-homeassistant',
  stableId: `ha:b1:dev:${name}`,
})

const WASHER_METER = {
  source: ref('washer_power'),
  cap: 'power-meter',
  fieldPath: 'power',
}
const WASHER_PLUG = {
  source: ref('washer_plug'),
  cap: 'switch',
  fieldPath: 'on',
}
const HEATER_PLUG = {
  source: ref('heater_plug'),
  cap: 'switch',
  fieldPath: 'on',
}
const HEATER_METER = {
  source: ref('heater_power'),
  cap: 'power-meter',
  fieldPath: 'power',
}

// Marked values: none of them is a default of the old templates.
const WASHER: LegacyApplianceSpec = {
  kind: 'appliance',
  templateId: 'appliance',
  appliance: 'washer',
  thresholdWatts: 7,
  startDwellMs: 41_000,
  stopDwellMs: 437_000,
  member: WASHER_METER,
  powerSwitch: WASHER_PLUG,
  offSeconds: 23,
}
const DRYER: LegacyApplianceSpec = {
  kind: 'appliance',
  templateId: 'appliance',
  appliance: 'dryer',
  thresholdWatts: 9,
  startDwellMs: 12_000,
  stopDwellMs: 90_000,
  member: {
    source: ref('dryer_power'),
    cap: 'power-meter',
    fieldPath: 'power',
  },
}
const HEATER: LegacyHeaterSpec = {
  kind: 'heater',
  templateId: 'heater',
  plug: HEATER_PLUG,
  meter: HEATER_METER,
  thresholdWatts: 77,
  startDwellMs: 13_000,
  stopDwellMs: 71_000,
}
const HEATER_NO_METER: LegacyHeaterSpec = {
  kind: 'heater',
  templateId: 'heater',
  plug: { source: ref('bare_plug'), cap: 'switch', fieldPath: 'on' },
  thresholdWatts: 61,
  startDwellMs: 5_000,
  stopDwellMs: 6_000,
}

function compiled(spec: LegacyApplianceSpec | LegacyHeaterSpec): LegacyHelperComposition {
  return spec.kind === 'appliance' ? legacyAppliance(spec) : legacyHeater(spec)
}

interface StoredFixture {
  readonly id: string
  readonly body: CoreBlockRowBody
}

/** A row as the old code stored it: `stored` is the composition WITH its helper spec. */
function blockOf(id: string, composition: LegacyHelperComposition, mark: string): StoredFixture {
  const base = CoreBlockSchema.parse({
    id,
    name: `name-${id}`,
    code: '',
    enabled: mark !== 'off',
    placement: 'hub',
    source: { kind: 'composition', composition: composition.plain },
    createdBy: `marker-${mark}`,
    createdAt: 10,
    updatedAt: 20,
    status: 'stopped',
    lastChangedAt: 20,
  })
  return {
    id,
    body: {
      name: base.name,
      enabled: base.enabled,
      placement: base.placement,
      updatedAt: base.updatedAt,
      block: { ...base, source: { kind: 'composition', composition: composition.stored } },
    },
  }
}

function groupComposition(): Composition {
  const out = compileHelper({
    kind: 'group',
    templateId: 'temperature',
    aggregate: 'mean',
    members: [
      {
        source: ref('t1'),
        cap: 'temperature-sensor',
        fieldPath: 'temperature',
      },
    ],
  })
  if (!out.ok) throw new Error(out.problems.map((p) => p.message).join('; '))
  return CompositionSchema.parse(out.composition)
}

function plainOnly(composition: Composition): LegacyHelperComposition {
  return { plain: composition, stored: { ...composition } }
}

function failFixture(): never {
  throw new Error('no fixture')
}

let records: ReturnType<typeof createRecordsAccess>
const NOW = 5_000

const BLOCKS: readonly StoredFixture[] = [
  blockOf('washer-1', compiled(WASHER), 'washer'),
  blockOf('dryer-1', compiled(DRYER), 'dryer'),
  blockOf('heater-1', compiled(HEATER), 'heater'),
  blockOf('heater-bare', compiled(HEATER_NO_METER), 'bare'),
  blockOf('group-1', plainOnly(groupComposition()), 'group'),
]

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
  for (const block of BLOCKS) await handle.put({ id: block.id, data: block.body })
})

async function execute() {
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const { logger } = recordingLogger()
  const ports = coreBlocksMigrationPorts(handle, logger, () => NOW)
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const migration = bound.find((m) => m.meta.id === HELPER_TO_CUSTOMIZE_ID)
  if (migration === undefined) throw new Error('migration is not in the catalogue')
  return migration.execute()
}

async function runMigration(): Promise<string> {
  const out = await execute()
  if (out.kind !== 'procedure') throw new Error(`expected a procedure result, got ${out.kind}`)
  return out.result.outcome
}

async function storedBlock(id: string): Promise<CoreBlock> {
  const row = await records.kind(coreBlocksRecordKinds.blocks).get(id)
  if (row === null) throw new Error(`no row ${id}`)
  return CoreBlockSchema.parse(row.data.block)
}

function compositionOf(block: CoreBlock): Composition {
  if (block.source?.kind !== 'composition') throw new Error('not a composition block')
  return block.source.composition
}

function featureOf(composition: Composition, cap: string) {
  const feature = composition.features.find((f) => f.cap === cap)
  if (feature === undefined || feature.kind !== 'fields')
    throw new Error(`no fields feature ${cap}`)
  return feature
}

function runningOf(id: string, block: CoreBlock) {
  const decoded = decodeScalarOverride({
    feature: featureOf(compositionOf(block), 'running-state'),
    device: composedDeviceRef(id),
    cap: 'running-state',
    targetId: 'running',
  })
  if (decoded === null) throw new Error('running-state does not decode as a Customize assignment')
  return decoded
}

describe('core-blocks migration: appliance and heater helpers become plain Customize features', () => {
  it('carries the appliance threshold, both dwells, the meter and the plug exactly', async () => {
    await expect(runMigration()).resolves.toBe('done')
    const block = await storedBlock('washer-1')
    const composition = compositionOf(block)
    expect(composition.helper).toBeUndefined()
    expect(composition.target).toEqual({ kind: 'new', type: 'washer' })

    const running = runningOf('washer-1', block)
    expect(running.draft.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 7,
      startDwellMs: 41_000,
      stopDwellMs: 437_000,
    })
    expect(running.draft.source).toMatchObject({
      ...WASHER_METER.source,
      cap: 'power-meter',
      fieldPath: 'power',
    })

    const power = featureOf(composition, 'power-meter')
    expect(power.fields['power']).toEqual({
      kind: 'from',
      source: WASHER_METER.source,
      cap: 'power-meter',
      fieldPath: 'power',
    })
    const powerSource = featureOf(composition, 'power-source')
    expect(powerSource.fields['switchOn']).toEqual({
      kind: 'from',
      source: WASHER_PLUG.source,
      cap: 'switch',
      fieldPath: 'on',
    })
    expect(powerSource.fields['offSeconds']).toEqual(
      featureOf(compiled(WASHER).plain, 'power-source').fields['offSeconds'],
    )
  })

  it('a dryer without a plug gets no power-source and keeps its own dwells', async () => {
    await runMigration()
    const block = await storedBlock('dryer-1')
    expect(compositionOf(block).features.map((f) => f.cap)).toEqual([
      'running-state',
      'power-meter',
    ])
    expect(runningOf('dryer-1', block).draft.transform).toMatchObject({
      threshold: 9,
      startDwellMs: 12_000,
      stopDwellMs: 90_000,
    })
  })

  it('a heater keeps its on/off forward to the plug and moves its running onto the meter', async () => {
    await runMigration()
    const block = await storedBlock('heater-1')
    const composition = compositionOf(block)
    expect(composition.helper).toBeUndefined()
    expect(composition.target).toEqual({ kind: 'new', type: 'heater' })
    expect(featureOf(composition, 'switch')).toEqual(featureOf(compiled(HEATER).plain, 'switch'))
    expect(featureOf(composition, 'switch').commands?.['setState']).toEqual({
      kind: 'forward',
      source: HEATER_PLUG.source,
      cap: 'switch',
      method: 'setState',
    })
    expect(runningOf('heater-1', block).draft.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 77,
      startDwellMs: 13_000,
      stopDwellMs: 71_000,
    })
    expect(featureOf(composition, 'power-meter').fields['power']).toMatchObject({
      source: HEATER_METER.source,
    })
  })

  it('a heater without a meter keeps running = the plug being on', async () => {
    await runMigration()
    const block = await storedBlock('heater-bare')
    const running = runningOf('heater-bare', block)
    expect(running.draft.transform).toEqual({ kind: 'identity' })
    expect(running.draft.source).toMatchObject({
      stableId: 'ha:b1:dev:bare_plug',
      cap: 'switch',
    })
    expect(compositionOf(block).features.map((f) => f.cap)).toEqual(['switch', 'running-state'])
  })

  it('keeps the block id, so the composed device stableId, and every marked neighbour', async () => {
    await runMigration()
    const row = await records.kind(coreBlocksRecordKinds.blocks).get('washer-1')
    expect(row?.id).toBe('washer-1')
    const block = await storedBlock('washer-1')
    expect(block).toMatchObject({
      id: 'washer-1',
      name: 'name-washer-1',
      createdBy: 'marker-washer',
      createdAt: 10,
      enabled: true,
    })
    expect(composedDeviceStableId(block.id)).toBe(composedDeviceStableId('washer-1'))
    expect(block.updatedAt).toBe(NOW)
    expect(row?.data.updatedAt).toBe(NOW)
    expect((await storedBlock('heater-1')).enabled).toBe(true)
  })

  it('the rewritten compositions plan cleanly for a new device', async () => {
    await runMigration()
    for (const id of ['washer-1', 'dryer-1', 'heater-1', 'heater-bare']) {
      const planned = planComposition(compositionOf(await storedBlock(id)), LOOKUP_CAP)
      expect(planned.problems).toEqual([])
    }
  })

  it('leaves an aggregator helper byte-identical', async () => {
    const before = await records.kind(coreBlocksRecordKinds.blocks).get('group-1')
    await runMigration()
    expect(await records.kind(coreBlocksRecordKinds.blocks).get('group-1')).toEqual(before)
  })

  it('a second run edits nothing and says so', async () => {
    await runMigration()
    const first = await Promise.all(
      BLOCKS.map((b) => records.kind(coreBlocksRecordKinds.blocks).get(b.id)),
    )
    await expect(runMigration()).resolves.toBe('already-done')
    const second = await Promise.all(
      BLOCKS.map((b) => records.kind(coreBlocksRecordKinds.blocks).get(b.id)),
    )
    expect(second).toEqual(first)
  })

  it('throws on a malformed helper block instead of guessing, and writes nothing', async () => {
    const handle = records.kind(coreBlocksRecordKinds.blocks)
    const broken = {
      ...(BLOCKS[0] ?? failFixture()).body,
      block: {
        id: 'broken',
        helper: 'x',
        source: {
          kind: 'composition',
          composition: { helper: { kind: 'appliance' } },
        },
      },
    }
    await handle.put({ id: 'broken', data: broken })
    const before = await handle.get('washer-1')
    const out = await execute()
    expect(out).toMatchObject({ kind: 'failed' })
    expect(out.kind === 'failed' ? out.error : '').toMatch(/block broken is not rewritten/)
    expect(await handle.get('washer-1')).toEqual(before)
  })
})

/* ---------- the composer runtime decides running as the old helper did ---------- */

const fresh = (value: string | boolean | number): SourceReading => ({
  state: 'fresh',
  value,
})

/** (t seconds, watts): below, over the line, a dip shorter than the stop dwell, a long drop. */
const SERIES: readonly (readonly [number, number])[] = [
  [0, 2],
  [10, 90],
  [30, 90],
  [60, 90],
  [100, 3],
  [300, 3],
  [350, 80],
  [400, 80],
  [900, 1],
  [1_300, 1],
  [1_400, 1],
]

function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function decisions(composition: Composition): readonly (boolean | undefined)[] {
  const planned = planComposition(composition, LOOKUP_CAP)
  if (planned.problems.length > 0)
    throw new Error(planned.problems.map((p) => p.message).join('; '))
  const key = compositionReadKey({
    source: WASHER_METER.source,
    cap: 'power-meter',
    fieldPath: 'power',
  })
  const readings = new Map<string, SourceReading>()
  const target = new FakeTarget(5)
  const timer = new FakeTimer()
  let clock = 0
  const runtime = new CompositionRuntime({
    blockId: 'washer-1',
    fields: planned.fields,
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? {
        state: 'unavailable',
        reason: 'none',
        fatal: false,
      },
    now: () => clock,
    timer,
    logger: composerLogger().logger,
  })
  const last = () =>
    target.writes
      .filter((w) => w.cap === 'running-state')
      .map((w) => w.values['running'])
      .filter((v) => v !== undefined)
      .at(-1)
  const out: (boolean | undefined)[] = []
  readings.set(key, fresh(SERIES[0]?.[1] ?? 0))
  runtime.start()
  out.push(boolOf(last()))
  for (const [seconds, watts] of SERIES.slice(1)) {
    const at = seconds * 1_000
    while (timer.armedAt !== null && timer.armedAt <= at) {
      clock = timer.armedAt
      timer.trigger()
    }
    clock = at
    readings.set(key, fresh(watts))
    runtime.onSourcesChanged(new Set([compositionSliceKey(WASHER_METER.source, 'power-meter')]))
    out.push(boolOf(last()))
  }
  return out
}

describe('the composer runtime decides running as the old helper did', () => {
  it('the same watts series gives the same running decisions, with the marked dwells', async () => {
    await runMigration()
    const migrated = compositionOf(await storedBlock('washer-1'))
    const old = decisions(compiled(WASHER).plain)
    const now = decisions(migrated)
    expect(now).toEqual(old)
    // The series really crosses both dwells, so the equality is not two empty arrays.
    expect(old).toContain(true)
    expect(old).toContain(false)
  })
})
