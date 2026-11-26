/**
 * The core-blocks migration that stamps the Customize kind (D1098), through the REAL records
 * engine. Old-shape fixtures carry MARKED fields (the switch source, an off time, the block
 * name and creator); the stamp must keep every one, leave an already-stamped entry and a
 * plain field override untouched, and a rerun must edit nothing.
 */
import {
  type Composition,
  type CompositionFeature,
  type CoreBlock,
  CoreBlockSchema,
  createRecordsAccess,
  defineAddonMigrations,
  isRunningOptOut,
  lockDoorLinkOfComposition,
  powerSourceLinkOfComposition,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds, type CoreBlockRowBody } from '../../record-kinds.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import {
  ADDON_MIGRATIONS,
  CUSTOMIZE_KIND_DISCRIMINANT_ID,
  coreBlocksMigrationPorts,
} from '../index.js'
import { NO_REMOTE_PORTS } from './no-remote-ports.js'

const DEVICE = { addonId: 'provider-x', stableId: 'lock-1' }
const PLUG = { addonId: 'provider-x', stableId: 'plug-MARK' }
const DOOR = { addonId: 'provider-x', stableId: 'door-MARK' }

const POWER_OLD: CompositionFeature = {
  kind: 'fields',
  cap: 'power-source',
  fields: {
    switchOn: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
    offSeconds: { kind: 'expression', expr: '42', bindings: {} },
  },
}
const LOCK_OLD: CompositionFeature = {
  kind: 'fields',
  cap: 'lock-control',
  fields: {
    state: {
      kind: 'expression',
      expr: 'x ? "unlocked" : native',
      bindings: {
        x: { kind: 'from', source: DOOR, cap: 'binary-sensor', fieldPath: 'on' },
        native: { kind: 'from', source: DEVICE, cap: 'lock-control', fieldPath: 'state' },
      },
    },
  },
}
const OPT_OUT_OLD: CompositionFeature = {
  kind: 'fields',
  cap: 'running-state',
  enabled: false,
  fields: {},
}
/** A plain field override: none of the three kinds. */
const OVERRIDE: CompositionFeature = {
  kind: 'fields',
  cap: 'battery',
  fields: { level: { kind: 'expression', expr: '7', bindings: {} } },
}
const STAMPED: CompositionFeature = { ...POWER_OLD, customizeKind: 'power-source' }

function compositionOf(features: readonly CompositionFeature[]): Composition {
  return { target: { kind: 'existing', device: DEVICE }, features: [...features] }
}

function blockOf(id: string, mark: string, composition: Composition): CoreBlock {
  return CoreBlockSchema.parse({
    id,
    name: `name-${mark}`,
    code: '',
    enabled: true,
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
    updatedAt: block.updatedAt,
    block,
  }
}

const NOW = 5_000
let lines: ReturnType<typeof recordingLogger>['lines'] = []
let records: ReturnType<typeof createRecordsAccess>

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
  for (const block of [
    blockOf('old', 'old', compositionOf([POWER_OLD, LOCK_OLD, OPT_OUT_OLD, OVERRIDE])),
    blockOf('done', 'done', compositionOf([STAMPED, OVERRIDE])),
    blockOf('plain', 'plain', compositionOf([OVERRIDE])),
  ]) {
    await handle.put({ id: block.id, data: rowBody(block) })
  }
})

async function runMigration(): Promise<string> {
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const { logger, lines: recorded } = recordingLogger()
  lines = recorded
  const ports = { ...coreBlocksMigrationPorts(handle, logger, () => NOW), ...NO_REMOTE_PORTS }
  const migration = defineAddonMigrations(ADDON_MIGRATIONS, ports).find(
    (m) => m.meta.id === CUSTOMIZE_KIND_DISCRIMINANT_ID,
  )
  if (migration === undefined) throw new Error('migration is not in the catalogue')
  const out = await migration.execute()
  if (out.kind !== 'procedure') throw new Error(`expected a procedure result, got ${out.kind}`)
  return out.result.outcome
}

async function storedBlock(id: string): Promise<CoreBlock> {
  const row = await records.kind(coreBlocksRecordKinds.blocks).get(id)
  if (row === null) throw new Error(`no row ${id}`)
  return CoreBlockSchema.parse(row.data.block)
}

function compositionOfBlock(block: CoreBlock): Composition {
  if (block.source?.kind !== 'composition') throw new Error('not a composition')
  return block.source.composition
}

describe('core-blocks migration: the Customize kind is stamped (D1098)', () => {
  it('the readers no longer accept the old shape', () => {
    const old = compositionOf([POWER_OLD, LOCK_OLD, OPT_OUT_OLD])
    expect(powerSourceLinkOfComposition(old)).toBeNull()
    expect(lockDoorLinkOfComposition(old)).toBeNull()
    expect(OPT_OUT_OLD.kind === 'fields' && isRunningOptOut(OPT_OUT_OLD)).toBe(false)
  })

  it('stamps each old shape and keeps every marked field', async () => {
    await expect(runMigration()).resolves.toBe('done')
    const block = await storedBlock('old')
    const composition = compositionOfBlock(block)
    expect(composition.features.map((f) => (f.kind === 'fields' ? f.customizeKind : null))).toEqual(
      ['power-source', 'lock-door-sensor', 'follow-switch', undefined],
    )
    // The marked source and off time survived the rewrite, and the readers now answer.
    const power = powerSourceLinkOfComposition(composition)
    expect(power?.switch).toEqual(PLUG)
    expect(power?.offSeconds).toBe(42)
    expect(lockDoorLinkOfComposition(composition)?.sensor).toEqual(DOOR)
    const optOut = composition.features[2]
    expect(optOut?.kind === 'fields' && isRunningOptOut(optOut)).toBe(true)
    expect(block).toMatchObject({ name: 'name-old', createdBy: 'marker-old', createdAt: 10 })
    expect(block.updatedAt).toBe(NOW)
    // The plain override is the same feature, byte for byte.
    expect(composition.features[3]).toEqual(OVERRIDE)
  })

  it('leaves an already-stamped block and a block with nothing to stamp untouched', async () => {
    const before = [await storedBlock('done'), await storedBlock('plain')]
    await runMigration()
    expect([await storedBlock('done'), await storedBlock('plain')]).toEqual(before)
  })

  it('a second run edits nothing and says so', async () => {
    await runMigration()
    const first = await storedBlock('old')
    await expect(runMigration()).resolves.toBe('already-done')
    expect(await storedBlock('old')).toEqual(first)
  })

  it('names a row that does not parse as a core block, and keeps going', async () => {
    const handle = records.kind(coreBlocksRecordKinds.blocks)
    await handle.put({
      id: 'broken',
      data: { ...rowBody(blockOf('x', 'x', compositionOf([OVERRIDE]))), block: { id: 'broken' } },
    })
    await expect(runMigration()).resolves.toBe('done')
    expect(
      lines.some((l) => l.level === 'warn' && JSON.stringify(l.extras).includes('broken')),
    ).toBe(true)
    expect(compositionOfBlock(await storedBlock('old')).features[0]).toMatchObject({
      customizeKind: 'power-source',
    })
  })
})
