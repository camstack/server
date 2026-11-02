import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { REDACTED_SECRET } from '../../interfaces/config-ui-secrets.js'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { RecordSecretUnavailableError } from '../../records/errors.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({
  name: z.string().min(1),
  url: z.string(),
  username: z.string(),
  password: z.string().optional().meta({ secret: true }),
})
type Body = z.infer<typeof BodySchema>

const kind = defineEntryKind('spec-destinations', {
  title: 'Spec destinations',
  nameField: 'name',
  schema: BodySchema,
})

const EMPTY_FORM: ConfigUISchema = { sections: [] }

async function setup() {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-destinations': kind })
  const changed: string[] = []
  const instances = new RecordIntegrationInstances<Body>(world.records, kind, {
    description: { instanceMode: 'multiple', kind: 'destination', canTest: false },
    formSchema: () => EMPTY_FORM,
    initialBody: (name) => ({ name, url: '', username: '' }),
    configured: (body) => body.url.length > 0,
    onChanged: (id) => {
      changed.push(id)
    },
  })
  return { world, instances, changed }
}

describe('RecordIntegrationInstances', () => {
  it('keeps two instances apart: a value written on A is invisible on B', async () => {
    const { instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.createInstance({ id: 'int_2', name: 'B' })
    await instances.updateInstance({ id: 'int_1', values: { url: 'http://a', password: 'pw-a' } })
    const b = await instances.getInstance({ id: 'int_2' })
    expect(b?.formValues['url']).toBe('')
    expect(b?.formValues['password']).toBeUndefined()
    expect(b?.configured).toBe(false)
    const a = await instances.getInstance({ id: 'int_1' })
    expect(a?.formValues['url']).toBe('http://a')
    expect(a?.configured).toBe(true)
    expect(await instances.getResolved('int_1')).toMatchObject({ password: 'pw-a' })
    expect(await instances.getResolved('int_2')).not.toHaveProperty('password')
  })

  it('shows a secret as a view, never as text', async () => {
    const { instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', values: { password: 'pw-a' } })
    const view = (await instances.getInstance({ id: 'int_1' }))?.formValues['password']
    expect(view).toMatchObject({ set: true })
    expect(JSON.stringify(view)).not.toContain('pw-a')
  })

  it('keeps an omitted, empty or redacted secret; $secretClear clears it', async () => {
    const { instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', values: { password: 'pw-a' } })
    await instances.updateInstance({ id: 'int_1', values: { url: 'http://a' } })
    expect(await instances.getResolved('int_1')).toMatchObject({ password: 'pw-a' })
    await instances.updateInstance({ id: 'int_1', values: { password: '' } })
    expect(await instances.getResolved('int_1')).toMatchObject({ password: 'pw-a' })
    await instances.updateInstance({ id: 'int_1', values: { password: REDACTED_SECRET } })
    expect(await instances.getResolved('int_1')).toMatchObject({ password: 'pw-a' })
    const view = (await instances.getInstance({ id: 'int_1' }))?.formValues['password']
    await instances.updateInstance({ id: 'int_1', values: { password: view } })
    expect(await instances.getResolved('int_1')).toMatchObject({ password: 'pw-a' })
    await instances.updateInstance({ id: 'int_1', values: { password: { $secretClear: true } } })
    expect(await instances.getResolved('int_1')).not.toHaveProperty('password')
  })

  it('renames through the kind name field', async () => {
    const { instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', name: 'Renamed', values: {} })
    expect((await instances.getInstance({ id: 'int_1' }))?.name).toBe('Renamed')
  })

  it('refuses a second create of the same id and lists every instance', async () => {
    const { instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await expect(instances.createInstance({ id: 'int_1', name: 'again' })).rejects.toThrow()
    await instances.createInstance({ id: 'int_2', name: 'B' })
    expect((await instances.listInstances()).map((i) => i.id).sort()).toEqual(['int_1', 'int_2'])
  })

  it('delete removes the row and its secret together', async () => {
    const { world, instances } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', values: { password: 'pw-a' } })
    await instances.deleteInstance({ id: 'int_1' })
    expect(await instances.getInstance({ id: 'int_1' })).toBeNull()
    expect(world.tables.get('spec-destinations')?.size ?? 0).toBe(0)
  })

  it('tells the addon after a write', async () => {
    const { instances, changed } = await setup()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', values: { url: 'http://a' } })
    await instances.deleteInstance({ id: 'int_1' })
    expect(changed).toEqual(['int_1', 'int_1', 'int_1'])
  })

  it('serves the row without its secret when the keychain is locked', async () => {
    const world = makeInMemoryRecords('spec-addon')
    await world.records.declare({ 'spec-destinations': kind })
    const real = world.records.kind(kind)
    await real.put({
      id: 'int_1',
      data: { name: 'A', url: 'http://a', username: 'u', password: 'pw' },
    })
    const locked = {
      ...world.records,
      kind: () =>
        Object.create(real, {
          getResolved: {
            value: async () => {
              throw new RecordSecretUnavailableError('locked')
            },
          },
        }),
    }
    const instances = new RecordIntegrationInstances<Body>(locked, kind, {
      description: { instanceMode: 'single', kind: 'destination', canTest: false },
      formSchema: () => EMPTY_FORM,
      initialBody: (name) => ({ name, url: '', username: '' }),
      configured: (body) => body.url.length > 0,
    })
    const body = await instances.getResolved('int_1')
    expect(body).toMatchObject({ url: 'http://a' })
    expect(body).not.toHaveProperty('password')
    // The caller can tell a locked keychain from a row that simply has no secret (D49).
    const read = await instances.readResolved('int_1')
    expect(read?.secrets).toBe('unavailable')
    const [listed] = await instances.listResolved()
    expect(listed?.secrets).toBe('unavailable')
  })
})
