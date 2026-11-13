import { describe, expect, it, vi } from 'vitest'
import {
  buildEmailDescriptor,
  createEmailAdapter,
  type EmailSendInput,
  type EmailSender,
  type EmailSmtpClient,
  validateEmailConfig,
} from '../adapters/email.js'
import { iconUrlFor } from '../icon-routes.js'
import { createNotificationOutputProvider, createNotificationOutputRuntime } from '../provider.js'
import { TargetStore } from '../target-store.js'
import { makeNotifiersRecords } from './fake-records.js'

/** A provider over one email target with `config`, sending through `smtp`. */
async function emailTargetOver(smtp: EmailSmtpClient, config: Record<string, unknown>) {
  const adapter = createEmailAdapter(smtp)
  const store = TargetStore.of((await makeNotifiersRecords([adapter.descriptor])).records, [
    adapter.descriptor,
  ])
  const provider = createNotificationOutputProvider({
    store,
    adapters: [adapter],
    iconUrlFor,
  })
  await store.upsert({
    id: 'email-1',
    addonId: 'notifiers',
    name: 'Ops',
    kind: 'email',
    enabled: true,
    config,
  })
  return provider
}

const SAMPLE = {
  body: 'Hello',
  title: 'CamStack',
  format: 'text',
  priority: 3,
} as const

describe('email descriptor', () => {
  it('names its sender with ONE required link over smtp-provider, and nothing else', () => {
    const fields = buildEmailDescriptor().configSchema.sections.flatMap((section) => section.fields)
    expect(fields.find((f) => f.key === 'sendWith')).toMatchObject({
      type: 'instance-select',
      functionCap: 'smtp-provider',
    })
    expect(fields.map((f) => f.key)).toEqual(['to', 'sendWith', 'from'])
  })

  it('carries its brand icon through listTargetKinds', async () => {
    const provider = await emailTargetOver(
      { sendEmail: async () => ({ messageId: 'x' }) },
      { to: 'ops@example.com', sendWith: 'acct-1' },
    )
    const email = (await provider.listTargetKinds({})).find((k) => k.kind === 'email')
    expect(email?.iconUrl).toBe('/addon/notifiers/icons/email')
  })
})

describe('email save rule', () => {
  it('refuses a target without a sender', () => {
    expect(() => validateEmailConfig({ to: 'ops@example.com' })).toThrow(/Send with/)
    expect(() => validateEmailConfig({ to: 'ops@example.com', sendWith: '  ' })).toThrow(
      /Send with/,
    )
  })

  it('accepts a target that links a sender', () => {
    expect(() => validateEmailConfig({ to: 'ops@example.com', sendWith: 'acct-1' })).not.toThrow()
  })
})

describe('email send path', () => {
  it('sends through the provider that holds the linked sender, naming the instance', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({
      messageId: 'm-1',
    }))
    const resolveSender = vi.fn(
      async (instanceId: string): Promise<EmailSender | null> => ({
        addonId: 'google-services',
        instanceId,
      }),
    )
    const provider = await emailTargetOver(
      { sendEmail, resolveSender },
      { to: 'ops@example.com', sendWith: 'acct-1' },
    )
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: SAMPLE,
    })
    expect(result.success).toBe(true)
    expect(resolveSender).toHaveBeenCalledWith('acct-1')
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ['ops@example.com'],
      subject: 'CamStack',
      text: expect.stringContaining('Hello') as string,
      addonId: 'google-services',
      instanceId: 'acct-1',
    })
  })

  it('fails naming the sender when the linked instance no longer exists, and sends nothing', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({
      messageId: 'm-1',
    }))
    const provider = await emailTargetOver(
      { sendEmail, resolveSender: async () => null },
      { to: 'ops@example.com', sendWith: 'gone-1' },
    )
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: SAMPLE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/gone-1/)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('still sends a row the migration has not moved, through the provider and relay it pinned', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({
      messageId: 'm-1',
    }))
    const provider = await emailTargetOver(
      { sendEmail },
      {
        to: 'ops@example.com',
        smtpAddonId: 'smtp-nodemailer',
        smtpInstanceId: 'relay-1',
      },
    )
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: SAMPLE,
    })
    expect(result.success).toBe(true)
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      addonId: 'smtp-nodemailer',
      instanceId: 'relay-1',
    })
  })

  it('refuses to send a target with no sender at all', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({
      messageId: 'm-1',
    }))
    const provider = await emailTargetOver({ sendEmail }, { to: 'ops@example.com' })
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: SAMPLE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Send with/)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('fails clearly when the sender refuses', async () => {
    const provider = await emailTargetOver(
      {
        sendEmail: async () => {
          throw new Error('Gmail account not verified')
        },
        resolveSender: async (instanceId) => ({
          addonId: 'google-services',
          instanceId,
        }),
      },
      { to: 'ops@example.com', sendWith: 'acct-1' },
    )
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: SAMPLE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not verified/)
  })
})

describe('the editor test of an email target', () => {
  it('lays the edited values over the saved target, so an edit that changed only the recipient still names the sender', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({ messageId: 'm-1' }))
    const adapter = createEmailAdapter({
      sendEmail,
      resolveSender: async (instanceId) => ({ addonId: 'google-services', instanceId }),
    })
    const store = TargetStore.of((await makeNotifiersRecords([adapter.descriptor])).records, [
      adapter.descriptor,
    ])
    const runtime = createNotificationOutputRuntime({ store, adapters: [adapter] })
    await store.upsert({
      id: 'email-1',
      addonId: 'notifiers',
      name: 'Ops',
      kind: 'email',
      enabled: true,
      config: { to: 'ops@example.com', sendWith: 'acct-1' },
    })
    const result = await runtime.testDraft({
      kind: 'email',
      config: { to: 'night@example.com' },
      targetId: 'email-1',
    })
    expect(result.success).toBe(true)
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ['night@example.com'],
      instanceId: 'acct-1',
    })
  })

  it('tests an unsaved target with exactly the values typed', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({ messageId: 'm-1' }))
    const adapter = createEmailAdapter({
      sendEmail,
      resolveSender: async (instanceId) => ({ addonId: 'smtp-nodemailer', instanceId }),
    })
    const store = TargetStore.of((await makeNotifiersRecords([adapter.descriptor])).records, [
      adapter.descriptor,
    ])
    const runtime = createNotificationOutputRuntime({ store, adapters: [adapter] })
    const result = await runtime.testDraft({
      kind: 'email',
      config: { to: 'a@example.com', sendWith: 'relay-2' },
      targetId: undefined,
    })
    expect(result.success).toBe(true)
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ['a@example.com'],
      addonId: 'smtp-nodemailer',
      instanceId: 'relay-2',
    })
  })
})
