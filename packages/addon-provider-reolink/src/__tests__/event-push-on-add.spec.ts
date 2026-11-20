import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  autoConfigureEventPushOnce,
  type EventPushOnAddOutcome,
  type EventPushOnAddPorts,
} from '../event-push-on-add.js'

interface Harness {
  readonly ports: EventPushOnAddPorts
  readonly webhook: ReturnType<typeof vi.fn>
  readonly email: ReturnType<typeof vi.fn>
  readonly logged: EventPushOnAddOutcome[]
  readonly store: { recorded: string | undefined }
}

function harness(over: Partial<EventPushOnAddPorts> = {}): Harness {
  const webhook = vi.fn(async () => {})
  const email = vi.fn(async () => {})
  const logged: EventPushOnAddOutcome[] = []
  const store: { recorded: string | undefined } = { recorded: undefined }
  const ports: EventPushOnAddPorts = {
    enabled: () => true,
    recordedOutcome: () => store.recorded,
    isEligible: () => true,
    isBattery: () => false,
    method: () => 'auto',
    configureWebhook: webhook,
    configureEmail: email,
    record: async (o) => {
      store.recorded = o.status
    },
    log: (o) => {
      logged.push(o)
    },
    ...over,
  }
  return { ports, webhook, email, logged, store }
}

describe('auto-configure event push on add', () => {
  it('a created mains camera arms the mailbox once and logs it', async () => {
    const h = harness()
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toEqual({ status: 'configured', mechanism: 'email' })
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.webhook).not.toHaveBeenCalled()
    expect(h.logged).toEqual([{ status: 'configured', mechanism: 'email' }])
  })

  it('a standalone battery camera prefers the webhook and arms only that path', async () => {
    const h = harness({ isBattery: () => true })
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toEqual({ status: 'configured', mechanism: 'webhook' })
    expect(h.email).not.toHaveBeenCalled()
  })

  it('a battery camera whose firmware refuses the webhook falls back to the mailbox', async () => {
    const h = harness({ isBattery: () => true })
    h.webhook.mockRejectedValueOnce(new Error('unsupported'))
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toEqual({ status: 'configured', mechanism: 'email' })
  })

  it('option off: nothing is written, the skip is logged with its reason', async () => {
    const h = harness({ enabled: () => false })
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toMatchObject({ status: 'skipped' })
    expect(h.email).not.toHaveBeenCalled()
    expect(h.webhook).not.toHaveBeenCalled()
    expect(h.logged).toHaveLength(1)
    expect(h.logged[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('off') })
  })

  it('a hub-attached camera is skipped and nothing is written', async () => {
    const h = harness({ isEligible: () => false, isBattery: () => true })
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toMatchObject({ status: 'skipped' })
    expect(h.email).not.toHaveBeenCalled()
    expect(h.webhook).not.toHaveBeenCalled()
  })

  it('a second boot does not write the camera again', async () => {
    const h = harness()
    await autoConfigureEventPushOnce(h.ports)
    const again = await autoConfigureEventPushOnce(h.ports)
    expect(again).toBe('already-ran')
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.logged).toHaveLength(1)
  })

  it('a failure is logged and recorded, and never throws (the add succeeds)', async () => {
    const h = harness()
    h.email.mockRejectedValueOnce(new Error('camera refused'))
    const out = await autoConfigureEventPushOnce(h.ports)
    expect(out).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('camera refused'),
    })
    expect(h.logged[0]).toMatchObject({ status: 'failed' })
    expect(h.store.recorded).toBe('failed')
  })

  it('a record failure still does not throw', async () => {
    const h = harness({
      record: async () => {
        throw new Error('disk full')
      },
    })
    await expect(autoConfigureEventPushOnce(h.ports)).resolves.toMatchObject({
      status: 'configured',
    })
  })
})

describe('the add path is wired', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const addonSrc = readFileSync(resolve(here, '../addon.ts'), 'utf8')
  const afterCreate = addonSrc.slice(addonSrc.indexOf('onAfterCreate: async'))

  it('onAfterCreate runs the one-time auto-configure, and nothing else on boot does', () => {
    expect(afterCreate.slice(0, 2500)).toMatch(/autoConfigureEventPushOnAdd\(\)/)
    expect(addonSrc.match(/autoConfigureEventPushOnAdd\(\)/g)).toHaveLength(1)
  })
})
