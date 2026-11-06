/**
 * The export targets as `integration-instances`: ids are minted, the form carries the connection
 * as an `instance-select` of the Home Assistant kind (D1013 link), and a target without an existing connection is
 * UNCONFIGURED, not removed. Disarm: drop `mintId` from the hooks and "mints hae_001" fails;
 * make `configured` answer true for an empty connection and "unconfigured" fails; have
 * `deleteInstance` skip `onChanged` and "reloads" fails.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildTargetForm } from '../target-form.js'
import { openTargetInstances, type TargetChange } from '../target-instances.js'
import { ExportTargets, haExportTargetsKind } from '../target-records.js'

async function harness(connections: readonly string[] = ['ha_001']) {
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-targets': haExportTargetsKind })
  const handle = memory.records.kind(haExportTargetsKind)
  const book = await ExportTargets.load(handle)
  const changes: string[] = []
  const instances = openTargetInstances(memory.records, {
    book: () => book,
    connectionExists: (id) => connections.includes(id),
    health: () => ({ state: 'unknown' }),
    onChanged: async (id, change: TargetChange) => {
      await book.reload()
      changes.push(`${id}:${change}`)
    },
  })
  return { handle, book, changes, instances, provider: instances.toProvider() }
}

describe('export target instances', () => {
  it('describes a multiple, id-minting services provider of the ha-target kind', async () => {
    const { provider } = await harness()
    expect(await provider.describe()).toMatchObject({
      role: 'services',
      instanceMode: 'multiple',
      mintsId: true,
      kinds: [{ id: 'ha-target' }],
    })
  })

  it('mints hae_001, hae_002 and several targets may share one connection', async () => {
    const { provider, handle, book } = await harness()
    const a = await provider.createInstance({ name: 'Home' })
    const b = await provider.createInstance({ name: 'Home again' })
    expect([a.id, b.id]).toEqual(['hae_001', 'hae_002'])
    await provider.updateInstance({
      id: a.id,
      values: { connectionId: 'ha_001' },
    })
    await provider.updateInstance({
      id: b.id,
      values: { connectionId: 'ha_001' },
    })
    expect((await handle.get('hae_002'))?.data.connectionId).toBe('ha_001')
    expect(book.connectionId('hae_001')).toBe('ha_001')
    expect(book.connectionId('hae_002')).toBe('ha_001')
  })

  it('starts on, public endpoint, five minutes, no connection, no device', async () => {
    const { provider } = await harness()
    const { id } = await provider.createInstance({ name: 'New' })
    const view = await provider.getInstance({ id })
    expect(view).toMatchObject({
      enabled: true,
      configured: false,
      kind: 'ha-target',
      formValues: {
        connectionId: '',
        mediaRole: 'publicEndpoint',
        reconcileIntervalSec: 300,
        devices: [],
      },
    })
  })

  it('is configured only while its connection exists, and keeps its devices either way', async () => {
    const { provider, handle } = await harness(['ha_001'])
    const { id } = await provider.createInstance({ name: 'Home' })
    await handle.patch(id, { devices: ['7'], connectionId: 'ha_gone' })
    const view = await provider.getInstance({ id })
    expect(view?.configured).toBe(false)
    expect((await handle.get(id))?.data.devices).toEqual(['7'])
    await provider.updateInstance({ id, values: { connectionId: 'ha_001' } })
    expect((await provider.getInstance({ id }))?.configured).toBe(true)
  })

  it('switches a target off through the record and reloads after every change', async () => {
    const { provider, handle, book, changes } = await harness()
    const { id } = await provider.createInstance({ name: 'Home' })
    await provider.setInstanceEnabled({ id, enabled: false })
    expect((await handle.get(id))?.data.enabled).toBe(false)
    expect(book.isEnabled(id)).toBe(false)
    await provider.deleteInstance({ id })
    expect(book.ids()).toEqual([])
    expect(changes).toEqual([`${id}:created`, `${id}:enabled`, `${id}:deleted`])
  })

  it('edits the role and the cadence without touching the devices', async () => {
    const { provider, handle } = await harness()
    const { id } = await provider.createInstance({ name: 'Home' })
    await handle.patch(id, { devices: ['7', '9'] })
    await provider.updateInstance({
      id,
      values: { mediaRole: 'internal', reconcileIntervalSec: 90 },
    })
    expect((await handle.get(id))?.data).toMatchObject({
      mediaRole: 'internal',
      reconcileIntervalSec: 90,
      devices: ['7', '9'],
    })
  })
})

describe('the target form', () => {
  it('picks the Home Assistant connection with an instance-select and keeps the cadence in Advanced', () => {
    const form = buildTargetForm()
    const fields = form.sections.flatMap((section) => section.fields)
    expect(fields.find((f) => 'key' in f && f.key === 'connectionId')).toMatchObject({
      type: 'instance-select',
      functionCap: 'broker',
      kind: 'home-assistant',
    })
    expect(fields.map((f) => ('key' in f ? f.key : null))).toEqual([
      'name',
      'connectionId',
      'mediaRole',
      'reconcileIntervalSec',
    ])
    const advanced = form.sections.find((section) => section.id === 'ha-export-advanced')
    expect(advanced).toMatchObject({
      style: 'accordion',
      defaultCollapsed: true,
    })
    expect(advanced?.fields.map((f) => ('key' in f ? f.key : null))).toEqual([
      'reconcileIntervalSec',
    ])
    const role = fields.find((f) => 'key' in f && f.key === 'mediaRole')
    expect(role?.type === 'select' ? role.default : null).toBe('publicEndpoint')
  })
})

describe('the connection link (D1013)', () => {
  it('declares connectionId as a link to a Home Assistant broker, for the hub delete guard', async () => {
    const { provider } = await harness()
    expect((await provider.describe()).links).toEqual([
      {
        kind: 'ha-export-targets',
        field: 'connectionId',
        to: { cap: 'broker', kind: 'home-assistant' },
      },
    ])
  })

  it('keeps a target shaped like the live hae_001: link intact, marked field survives, configured', async () => {
    const { handle, provider } = await harness(['ha_001'])
    await handle.put({
      id: 'hae_001',
      data: {
        name: 'Home',
        connectionId: 'ha_001',
        mediaRole: 'internal',
        reconcileIntervalSec: 120,
        devices: ['cam-1', 'cam-2'],
        enabled: true,
      },
    })
    const view = await provider.getInstance({ id: 'hae_001' })
    expect(view).toMatchObject({
      configured: true,
      formValues: { connectionId: 'ha_001', mediaRole: 'internal', reconcileIntervalSec: 120 },
    })
    expect((await handle.get('hae_001'))?.data.devices).toEqual(['cam-1', 'cam-2'])
  })
})
