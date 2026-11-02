/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger, ISmtpProvider } from '@camstack/types'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  makeInMemoryRecords,
  smtpProviderCapability,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smtpRelaysKind } from '../relay-record-kinds.js'
import { SmtpNodemailerAddon } from '../smtp.addon.js'
import { fakeFactory } from './support.js'

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const body = (name: string, host: string) => ({
  name,
  host,
  port: 587,
  secure: false,
  username: '',
  fromAddress: `${name}@example.com`,
  fromName: '',
})

async function boot() {
  const world = makeInMemoryRecords('smtp-nodemailer')
  await world.records.declare({ relays: smtpRelaysKind })
  const handle = world.records.kind(smtpRelaysKind)
  await handle.put({ id: 'int_0001', data: body('a', 'smtp.a.test') }, { ifRev: 0 })
  await handle.put({ id: 'int_0002', data: body('b', 'smtp.b.test') }, { ifRev: 0 })
  const ctx = {
    id: 'smtp-nodemailer',
    logger: logger(),
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      integrations: { getByAddonId: { query: vi.fn(async () => null) } },
      migrations: {
        declareOwner: { mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })) },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const { factory, built } = fakeFactory()
  const addon = new SmtpNodemailerAddon(factory)
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const smtp = registrations.find((r) => r.capability.name === smtpProviderCapability.name)
  const instances = registrations.find(
    (r) => r.capability.name === integrationInstancesCapability.name,
  )
  return {
    addon,
    built,
    registrations,
    smtp: smtp?.provider as ISmtpProvider,
    instances: instances?.provider as IIntegrationInstancesProvider,
  }
}

describe('SmtpNodemailerAddon — relays are integration instances (D996)', () => {
  const addons: SmtpNodemailerAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('offers integration-instances as a multiple-instance addon', async () => {
    const w = await boot()
    addons.push(w.addon)
    expect(w.instances).toBeDefined()
    await expect(w.instances.describe()).resolves.toMatchObject({
      instanceMode: 'multiple',
      kind: 'relays',
    })
    expect((await w.instances.listInstances()).map((i) => i.id)).toEqual(['int_0001', 'int_0002'])
  })

  it('sendEmail with instanceId reaches that relay; without it the first relay answers', async () => {
    const w = await boot()
    addons.push(w.addon)
    const mail = { to: 'ops@example.com', subject: 's', text: 't' }
    await w.smtp.sendEmail({ ...mail, instanceId: 'int_0002' })
    await w.smtp.sendEmail(mail)
    const byHost = Object.fromEntries(w.built.map((t) => [t.options.host, t.sent.length]))
    expect(byHost).toEqual({ 'smtp.a.test': 1, 'smtp.b.test': 1 })
  })

  it('a relay created on the Integrations page serves at once, a deleted one stops', async () => {
    const w = await boot()
    addons.push(w.addon)
    await w.instances.createInstance({ id: 'int_0003', name: 'c' })
    await w.instances.updateInstance({
      id: 'int_0003',
      values: { host: 'smtp.c.test', fromAddress: 'c@example.com' },
    })
    await w.smtp.sendEmail({
      to: 'ops@example.com',
      subject: 's',
      text: 't',
      instanceId: 'int_0003',
    })
    expect(w.built.find((t) => t.options.host === 'smtp.c.test')?.sent).toHaveLength(1)
    await w.instances.deleteInstance({ id: 'int_0003' })
    await expect(
      w.smtp.sendEmail({ to: 'ops@example.com', subject: 's', text: 't', instanceId: 'int_0003' }),
    ).rejects.toThrow('unknown relay')
  })

  it('the password never leaves the record through the instance view', async () => {
    const w = await boot()
    addons.push(w.addon)
    await w.instances.updateInstance({
      id: 'int_0001',
      values: { username: 'u', password: 'pw-SECRET' },
    })
    expect(JSON.stringify(await w.instances.getInstance({ id: 'int_0001' }))).not.toContain(
      'pw-SECRET',
    )
    await w.smtp.verify({ instanceId: 'int_0001' })
    expect(
      w.built.find((t) => t.options.host === 'smtp.a.test' && t.options.auth !== undefined)?.options
        .auth,
    ).toEqual({
      user: 'u',
      pass: 'pw-SECRET',
    })
  })
})
