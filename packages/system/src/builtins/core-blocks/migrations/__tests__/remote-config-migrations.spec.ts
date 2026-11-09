/**
 * The two stored-remote migrations, through the migration driver the addon uses
 * and the real `templates` kind (a real SQLite file). The seed is a Samsung
 * remote as the previous release stored it: `power.mode`, the lettered colour
 * keys bound and listed as custom buttons, a sequence source pressing one of them,
 * and a layout template whose lettered buttons carry no tone.
 *
 * Every marked field of the seed (the default transmitter, the binding action of
 * each key, the operator's button name, the template name) must come out
 * unchanged: a migration that rebuilt the config instead of renaming would lose them.
 */
import {
  createRecordsAccess,
  defineAddonMigrations,
  RemoteConfigSchema,
  RemoteLayoutPayloadSchema,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import { coreBlocksRecordKinds } from '../../record-kinds.js'
import {
  ADDON_MIGRATIONS,
  coreBlocksMigrationPorts,
  REMOTE_COLOUR_ROLES_ID,
  REMOTE_POWER_DROP_ID,
  remoteMigrationPortsOver,
} from '../index.js'

const NOW = 9_000
const TV = 5478

function action(deviceId: number, tag: string) {
  return {
    action: {
      kind: 'cap',
      deviceId,
      cap: 'ir-transmitter',
      method: 'send',
      args: { timings: [9000, -4500], tag },
    },
  }
}

function seedRemote(): Record<string, unknown> {
  return {
    layoutTemplateId: 'tpl-samsung',
    defaultTransmitterId: 77,
    stepDelayMs: 650,
    bindings: {
      power: action(77, 'pwr-marker'),
      ok: action(77, 'ok-marker'),
      'custom:color_a': action(77, 'a-marker'),
      'custom:color_b': action(77, 'b-marker'),
      'custom:color_c': action(77, 'c-marker'),
      'custom:color_d': action(77, 'd-marker'),
      'custom:ch_list': action(77, 'ch-marker'),
    },
    customButtons: [
      { key: 'color_a', name: 'Rosso marker' },
      { key: 'color_b', name: 'B' },
      { key: 'color_c', name: 'C' },
      { key: 'color_d', name: 'D' },
      { key: 'ch_list', name: 'CH LIST' },
    ],
    sources: [
      { id: 'blue-seq', name: 'Blue marker', kind: 'sequence', steps: ['custom:color_d', 'ok'] },
    ],
  }
}

const seedLayout = {
  columns: 12,
  rows: 2,
  buttons: [
    { id: 'power', row: 0, col: 0, rowSpan: 1, colSpan: 3, role: 'power' },
    { id: 'color_a', row: 1, col: 0, rowSpan: 1, colSpan: 3, role: 'custom:color_a', label: 'A' },
    { id: 'color_b', row: 1, col: 3, rowSpan: 1, colSpan: 3, role: 'custom:color_b', label: 'B' },
  ],
}

let records: ReturnType<typeof createRecordsAccess>
let deviceStore: Map<number, Record<string, unknown>>

beforeEach(async () => {
  const world = makeRecordsWorld()
  await world.provider.init()
  records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  deviceStore = new Map([
    [TV, { remote: seedRemote(), unrelated: { marker: 1 } }],
    [9, { other: true }],
  ])
  const templates = records.kind(coreBlocksRecordKinds.templates)
  await templates.put({
    id: 'tpl-samsung',
    data: {
      kind: 'remote',
      name: 'Samsung marker',
      payload: seedLayout,
      createdAt: 1,
      updatedAt: 2,
    },
  })
})

async function run(id: string): Promise<string> {
  const { logger } = recordingLogger()
  const stores = {
    listDeviceStoreIds: async () => [...deviceStore.keys()],
    readDeviceStoreBatch: async (ids: readonly number[]) =>
      new Map(ids.map((storeId) => [storeId, deviceStore.get(storeId) ?? {}] as const)),
    writeDeviceStore: async (deviceId: number, patch: Record<string, unknown>) => {
      deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
    },
  }
  const ports = {
    ...coreBlocksMigrationPorts(records.kind(coreBlocksRecordKinds.blocks), logger, () => NOW),
    ...remoteMigrationPortsOver(stores, records.kind(coreBlocksRecordKinds.templates), logger),
  }
  const migration = defineAddonMigrations(ADDON_MIGRATIONS, ports).find((m) => m.meta.id === id)
  if (migration === undefined) throw new Error(`${id} is not in the catalogue`)
  const out = await migration.execute()
  if (out.kind !== 'procedure') throw new Error(`expected a procedure result, got ${out.kind}`)
  return out.result.outcome
}

const remoteOf = (): Record<string, unknown> => {
  const stored = deviceStore.get(TV)?.['remote']
  if (typeof stored !== 'object' || stored === null) throw new Error('no remote')
  return Object.fromEntries(Object.entries(stored))
}

describe('core-blocks migration: the remote power mode is dropped', () => {
  it('removes power and keeps every other marked field and key', async () => {
    expect(remoteOf()['power']).toEqual({ mode: 'toggle' })
    await expect(run(REMOTE_POWER_DROP_ID)).resolves.toBe('done')
    const { power: _gone, ...expected } = seedRemote()
    expect(remoteOf()).toEqual(expected)
    expect(deviceStore.get(TV)?.['unrelated']).toEqual({ marker: 1 })
    expect(deviceStore.get(9)).toEqual({ other: true })
  })

  it('a second run edits nothing', async () => {
    await run(REMOTE_POWER_DROP_ID)
    const first = structuredClone(remoteOf())
    await expect(run(REMOTE_POWER_DROP_ID)).resolves.toBe('already-done')
    expect(remoteOf()).toEqual(first)
  })

  it('the migrated config parses with the schema that has no power', async () => {
    await run(REMOTE_POWER_DROP_ID)
    expect(RemoteConfigSchema.safeParse(remoteOf()).success).toBe(true)
  })
})

describe('core-blocks migration: the lettered colour keys take the colour roles', () => {
  it('renames bindings, custom buttons and sequence steps, keeping each action and name', async () => {
    await expect(run(REMOTE_COLOUR_ROLES_ID)).resolves.toBe('done')
    const remote = remoteOf()
    expect(remote['bindings']).toEqual({
      power: action(77, 'pwr-marker'),
      ok: action(77, 'ok-marker'),
      'custom:color_red': action(77, 'a-marker'),
      'custom:color_green': action(77, 'b-marker'),
      'custom:color_yellow': action(77, 'c-marker'),
      'custom:color_blue': action(77, 'd-marker'),
      'custom:ch_list': action(77, 'ch-marker'),
    })
    expect(remote['customButtons']).toEqual([
      { key: 'color_red', name: 'Rosso marker' },
      { key: 'color_green', name: 'B' },
      { key: 'color_yellow', name: 'C' },
      { key: 'color_blue', name: 'D' },
      { key: 'ch_list', name: 'CH LIST' },
    ])
    expect(remote['sources']).toEqual([
      { id: 'blue-seq', name: 'Blue marker', kind: 'sequence', steps: ['custom:color_blue', 'ok'] },
    ])
    expect(remote['defaultTransmitterId']).toBe(77)
    expect(remote['stepDelayMs']).toBe(650)
  })

  it('gives the layout buttons the tone and keeps the letter on the key', async () => {
    await run(REMOTE_COLOUR_ROLES_ID)
    const row = await records.kind(coreBlocksRecordKinds.templates).get('tpl-samsung')
    expect(row?.data.name).toBe('Samsung marker')
    expect(row?.data.updatedAt).toBe(NOW)
    const layout = RemoteLayoutPayloadSchema.parse(row?.data.payload)
    expect(layout.buttons.find((b) => b.id === 'color_a')).toMatchObject({
      role: 'custom:color_red',
      tone: 'red',
      label: 'A',
      showLegend: true,
    })
    expect(layout.buttons.find((b) => b.id === 'color_b')).toMatchObject({
      role: 'custom:color_green',
      tone: 'green',
    })
    expect(layout.buttons.find((b) => b.id === 'power')).toEqual(seedLayout.buttons[0])
  })

  it('a binding already on the colour role wins over the lettered one', async () => {
    const seeded = seedRemote()
    deviceStore.set(TV, {
      remote: {
        ...seeded,
        bindings: {
          ...Object.fromEntries(Object.entries(seeded['bindings'] ?? {})),
          'custom:color_red': action(1, 'newer'),
        },
      },
    })
    await run(REMOTE_COLOUR_ROLES_ID)
    expect(remoteOf()['bindings']).toMatchObject({ 'custom:color_red': action(1, 'newer') })
  })

  it('a second run edits nothing and says so', async () => {
    await run(REMOTE_COLOUR_ROLES_ID)
    const remote = structuredClone(remoteOf())
    const template = await records.kind(coreBlocksRecordKinds.templates).get('tpl-samsung')
    await expect(run(REMOTE_COLOUR_ROLES_ID)).resolves.toBe('already-done')
    expect(remoteOf()).toEqual(remote)
    expect(await records.kind(coreBlocksRecordKinds.templates).get('tpl-samsung')).toEqual(template)
  })
})
