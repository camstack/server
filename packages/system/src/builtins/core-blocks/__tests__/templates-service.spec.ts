import { createRecordsAccess, type TemplateUser } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { TemplatesService } from '../templates-service.js'
import { recordingLogger } from './fixtures.js'

const GRID = {
  columns: 4,
  rows: 2,
  buttons: [
    { id: 'p', role: 'power', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: 'v', role: 'volume_up', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ],
}

async function world(users: readonly TemplateUser[] = []) {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  let clock = 1_000
  let ids = 0
  const asked: string[] = []
  const service = new TemplatesService({
    templates: records.kind(coreBlocksRecordKinds.templates),
    usage: {
      devicesUsing: async (templateId) => {
        asked.push(templateId)
        return users
      },
    },
    logger: recordingLogger().logger,
    now: () => (clock += 1),
    newId: () => `t${(ids += 1)}`,
  })
  return { service, asked }
}

describe('TemplatesService', () => {
  it('creates, reads, lists by kind, updates and deletes a remote layout', async () => {
    const { service } = await world()
    const made = await service.create({ kind: 'remote', name: 'TV', payload: GRID })
    expect(made.status).toBe('saved')
    if (made.status !== 'saved') return
    expect(made.template).toMatchObject({ id: 't1', kind: 'remote', name: 'TV' })

    expect(await service.get({ id: 't1' })).toMatchObject({ name: 'TV' })
    expect((await service.list({ kind: 'remote' })).map((t) => t.id)).toEqual(['t1'])

    const renamed = await service.update({ id: 't1', name: 'Living room TV' })
    expect(renamed).toMatchObject({ status: 'saved', template: { name: 'Living room TV' } })
    expect(await service.delete({ id: 't1' })).toEqual({ status: 'deleted' })
    expect(await service.get({ id: 't1' })).toBeNull()
  })

  it('refuses a payload its kind does not accept, on create and on update', async () => {
    const { service } = await world()
    const bad = await service.create({ kind: 'remote', name: 'x', payload: { columns: 0 } })
    expect(bad).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    await service.create({ kind: 'remote', name: 'TV', payload: GRID })
    const bad2 = await service.update({ id: 't1', payload: { nope: true } })
    expect(bad2).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(await service.get({ id: 't1' })).toMatchObject({ payload: GRID })
  })

  it('refuses to update a template that does not exist', async () => {
    const { service } = await world()
    expect(await service.update({ id: 'ghost', name: 'x' })).toMatchObject({
      status: 'refused',
      reason: 'not-found',
    })
  })

  it('refuses a delete while a device uses the template, naming the devices', async () => {
    const { service, asked } = await world([{ deviceId: 7, name: 'Salotto TV' }])
    await service.create({ kind: 'remote', name: 'TV', payload: GRID })
    expect(await service.delete({ id: 't1' })).toEqual({
      status: 'in-use',
      devices: [{ deviceId: 7, name: 'Salotto TV' }],
    })
    expect(asked).toEqual(['t1'])
    expect(await service.get({ id: 't1' })).not.toBeNull()
  })

  it('answers not-found for a delete of an unknown id without asking the usage port', async () => {
    const { service, asked } = await world()
    expect(await service.delete({ id: 'ghost' })).toEqual({ status: 'not-found' })
    expect(asked).toEqual([])
  })
})
