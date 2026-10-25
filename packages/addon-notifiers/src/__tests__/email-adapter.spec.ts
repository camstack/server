import { describe, expect, it, vi } from 'vitest'
import { buildEmailDescriptor, createEmailAdapter, type EmailSendInput } from '../adapters/email.js'
import { createNotificationOutputProvider } from '../provider.js'
import { makeNotifiersRecords } from './fake-records.js'
import { TargetStore } from '../target-store.js'
import { iconUrlFor } from '../icon-routes.js'

describe('email notifier adapter', () => {
  it('sendDirect calls smtp sendEmail with to + subject + text + smtpAddonId', async () => {
    const sendEmail = vi.fn(async (_input: EmailSendInput) => ({ messageId: 'm-1' }))
    const adapter = createEmailAdapter({ sendEmail })
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [adapter],
    })
    await provider.upsertTarget({
      target: {
        id: 'email-1',
        addonId: 'notifiers',
        name: 'Ops',
        kind: 'email',
        enabled: true,
        config: { to: 'ops@example.com', smtpAddonId: 'google-services' },
      },
    })
    const result = await provider.testTarget({
      targetId: 'email-1',
      sample: { body: 'Hello', title: 'CamStack', format: 'text', priority: 3 },
    })
    expect(result.success).toBe(true)
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ['ops@example.com'],
      subject: 'CamStack',
      text: expect.stringContaining('Hello') as string,
      addonId: 'google-services',
    })
  })

  it('fails clearly when smtp client refuses', async () => {
    const adapter = createEmailAdapter({
      async sendEmail() {
        throw new Error('No Google broker connected')
      },
    })
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({ store, adapters: [adapter] })
    await provider.upsertTarget({
      target: {
        id: 'email-2',
        addonId: 'notifiers',
        name: 'Ops',
        kind: 'email',
        enabled: true,
        config: { to: 'ops@example.com', smtpAddonId: 'smtp-nodemailer' },
      },
    })
    const result = await provider.send({
      targetId: 'email-2',
      notification: { body: 'x', format: 'text', priority: 3 },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('No Google broker connected')
  })

  it('hydrateDescriptor stamps ready smtp-provider entries into the select', async () => {
    const adapter = createEmailAdapter({
      async sendEmail() {
        return { messageId: 'x' }
      },
      async listProviders() {
        return [
          {
            value: 'google-services',
            label: 'Google Services — smtp.gmail.com (not verified)',
            ready: false,
          },
          { value: 'smtp-nodemailer', label: 'SMTP Email — mail.example.com', ready: true },
        ]
      },
    })
    const hydrated = await adapter.hydrateDescriptor!()
    const field = hydrated.configSchema.sections[0]?.fields.find(
      (f) => f.key === 'smtpAddonId' && f.type === 'select',
    )
    expect(field).toBeDefined()
    if (field === undefined || field.type !== 'select') throw new Error('expected select')
    expect(field.options).toEqual([
      {
        value: 'google-services',
        label: 'Google Services — smtp.gmail.com (not verified)',
      },
      { value: 'smtp-nodemailer', label: 'SMTP Email — mail.example.com' },
    ])
    expect(field.required).toBe(true)
  })

  it('listTargetKinds hydrates email select options and stamps iconUrl', async () => {
    const adapter = createEmailAdapter({
      async sendEmail() {
        return { messageId: 'x' }
      },
      async listProviders() {
        return [
          {
            value: 'google-services',
            label: 'Google Services — alice@example.com (not verified)',
            ready: false,
          },
        ]
      },
    })
    const store = TargetStore.of((await makeNotifiersRecords()).records)
    const provider = createNotificationOutputProvider({
      store,
      adapters: [adapter],
      iconUrlFor,
    })
    const kinds = await provider.listTargetKinds({})
    const email = kinds.find((k) => k.kind === 'email')
    expect(email).toBeDefined()
    if (email === undefined) throw new Error('expected email kind')
    expect(email.iconUrl).toBe('/addon/notifiers/icons/email')
    // Cap wire type leaves configSchema as unknown (TargetKindSchema passthrough).
    // Assert options through the adapter's typed hydrate, and that listTargetKinds
    // stamped the same schema object shape onto the wire kind.
    const hydrated = await adapter.hydrateDescriptor!()
    expect(email.configSchema).toEqual(hydrated.configSchema)
    const field = hydrated.configSchema.sections[0]?.fields.find(
      (f) => f.key === 'smtpAddonId' && f.type === 'select',
    )
    expect(field?.type === 'select' && field.options[0]?.value).toBe('google-services')
    expect(field?.type === 'select' && field.options[0]?.label).toMatch(/not verified/)
  })

  it('buildEmailDescriptor exposes an empty select when no providers are installed', () => {
    const d = buildEmailDescriptor()
    const field = d.configSchema.sections[0]?.fields.find(
      (f) => f.key === 'smtpAddonId' && f.type === 'select',
    )
    expect(field?.type).toBe('select')
    if (field === undefined || field.type !== 'select') throw new Error('expected select')
    expect(field.options).toEqual([])
    expect(field.description).toMatch(/No Email provider installed/)
  })
})
