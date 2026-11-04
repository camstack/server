/**
 * The framework step of planning#416: a device-bringing addon's records are owned by the registry
 * for the on/off switch, tell the addon WHAT changed, and may carry a map of secrets.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { IntegrationInstanceDescriptionSchema } from '../../capabilities/integration-instances.cap.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { REDACTED_SECRET } from '../../interfaces/config-ui-secrets.js'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { type InstanceChange, RecordIntegrationInstances } from '../record-integration-instances.js'

const EMPTY_FORM: ConfigUISchema = { sections: [] }

const AccountSchema = z.object({
  name: z.string().min(1),
  password: z.string().optional().meta({ secret: true }),
  applianceSecrets: z.record(z.string(), z.string().meta({ secret: true })).optional(),
})
type Account = z.infer<typeof AccountSchema>
const accountKind = defineEntryKind('spec-accounts', {
  title: 'Spec accounts',
  nameField: 'name',
  schema: AccountSchema,
})

async function setupAccounts(role: 'devices' | 'services') {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-accounts': accountKind })
  const changes: Array<readonly [string, InstanceChange]> = []
  const instances = new RecordIntegrationInstances<Account>(world.records, accountKind, {
    description: { role, instanceMode: 'multiple', kind: 'account', canTest: false },
    formSchema: () => EMPTY_FORM,
    initialBody: (name) => ({ name }),
    configured: () => true,
    onChanged: (id, change) => {
      changes.push([id, change])
    },
  })
  return { instances, changes }
}

describe('describe(): role and discovery', () => {
  it('requires a role and accepts a discovery that names its scope', () => {
    const base = { instanceMode: 'multiple', kind: 'account', canTest: true }
    expect(IntegrationInstanceDescriptionSchema.safeParse(base).success).toBe(false)
    expect(
      IntegrationInstanceDescriptionSchema.safeParse({
        ...base,
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
      }).success,
    ).toBe(true)
    expect(IntegrationInstanceDescriptionSchema.safeParse({ ...base, role: 'nope' }).success).toBe(
      false,
    )
    expect(
      IntegrationInstanceDescriptionSchema.safeParse({
        ...base,
        role: 'both',
        discovery: { mode: 'sometimes', scopedToInstance: true },
      }).success,
    ).toBe(false)
  })
})

describe('onChanged says what happened', () => {
  it('create, update, enable and delete each report their change', async () => {
    const { instances, changes } = await setupAccounts('services')
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({ id: 'int_1', values: { password: 'pw' } })
    await instances.setInstanceEnabled({ id: 'int_1', enabled: false })
    await instances.deleteInstance({ id: 'int_1' })
    expect(changes).toEqual([
      ['int_1', 'created'],
      ['int_1', 'updated'],
      ['int_1', 'enabled'],
      ['int_1', 'deleted'],
    ])
  })
})

describe('the registry owns the switch of a role "devices" addon', () => {
  it('serves no enabled flag and refuses setInstanceEnabled, naming the owner', async () => {
    const { instances, changes } = await setupAccounts('devices')
    await instances.createInstance({ id: 'int_1', name: 'A' })
    const view = await instances.getInstance({ id: 'int_1' })
    expect(view).not.toBeNull()
    expect(view).not.toHaveProperty('enabled')
    await expect(instances.setInstanceEnabled({ id: 'int_1', enabled: false })).rejects.toThrow(
      /integrations\.update/,
    )
    expect(changes).toEqual([['int_1', 'created']])
  })

  it('refuses a body that declares its own enabled', () => {
    const withEnabled = defineEntryKind('spec-with-enabled', {
      title: 'x',
      nameField: 'name',
      schema: z.object({ name: z.string(), enabled: z.boolean().optional() }),
    })
    const world = makeInMemoryRecords('spec-addon')
    expect(
      () =>
        new RecordIntegrationInstances(world.records, withEnabled, {
          description: { role: 'devices', instanceMode: 'multiple', kind: 'a', canTest: false },
          formSchema: () => EMPTY_FORM,
          initialBody: (name) => ({ name }),
          configured: () => true,
        }),
    ).toThrow(/registry owns/)
  })
})

describe('a map of secrets through the instance patch', () => {
  it('replaces one entry, keeps the others on an empty or redacted value, removes on clear', async () => {
    const { instances } = await setupAccounts('devices')
    await instances.createInstance({ id: 'int_1', name: 'A' })
    await instances.updateInstance({
      id: 'int_1',
      values: { applianceSecrets: { fridge: 'k1', oven: 'k2' } },
    })
    expect((await instances.getResolved('int_1'))?.applianceSecrets).toEqual({
      fridge: 'k1',
      oven: 'k2',
    })
    await instances.updateInstance({
      id: 'int_1',
      values: { applianceSecrets: { fridge: REDACTED_SECRET, oven: 'k2b' } },
    })
    expect((await instances.getResolved('int_1'))?.applianceSecrets).toEqual({
      fridge: 'k1',
      oven: 'k2b',
    })
    await instances.updateInstance({
      id: 'int_1',
      values: { applianceSecrets: { fridge: { $secretClear: true } } },
    })
    expect((await instances.getResolved('int_1'))?.applianceSecrets).toEqual({ oven: 'k2b' })
    const view = await instances.getInstance({ id: 'int_1' })
    expect(JSON.stringify(view?.formValues['applianceSecrets'])).not.toContain('k2b')
  })
})
