/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- AddonContext stub crosses typed boundaries. */
import {
  type AddonContext,
  type IScopedLogger,
  SMTP_INBOUND_DEFAULT_ID,
  brokerCapability,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ListenerFactory } from '../inbound-listener.js'
import { mailboxesKind } from '../mailbox-record-kinds.js'
import { relayRecordsFor } from './addon-records.js'
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

async function boot(seedMailbox: boolean) {
  const world = makeInMemoryRecords('smtp-nodemailer')
  await relayRecordsFor(world.records)
  if (seedMailbox) {
    await world.records.kind(mailboxesKind).put(
      {
        id: SMTP_INBOUND_DEFAULT_ID,
        data: {
          name: 'm',
          port: 2525,
          bindHost: '0.0.0.0',
          domain: 'camstack.local',
          requireAuth: true,
          username: 'u',
          password: 'p',
          starttls: false,
          maxMessageBytes: 1000,
        },
      },
      { ifRev: 0 },
    )
  }
  const bound: number[] = []
  const listeners: ListenerFactory = (spec) => ({
    start: async () => {
      bound.push(spec.port)
    },
    stop: async () => undefined,
  })
  const emitted: unknown[] = []
  const ctx = {
    id: 'smtp-nodemailer',
    logger: logger(),
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({
        kind: 'value' as const,
        value: {},
      })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: {
      emit: vi.fn((e: unknown) => emitted.push(e)),
      subscribe: vi.fn(() => () => undefined),
    },
    kernel: { localNodeId: 'hub' },
    api: {
      migrations: {
        declareOwner: {
          mutate: vi.fn(async () => ({
            bootId: 'b',
            snapshot: 'none',
            steps: [],
          })),
        },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new SmtpNodemailerAddon(fakeFactory().factory, listeners)
  const result = await addon.initialize(ctx)
  const regs = result && 'providers' in result && result.providers ? result.providers : []
  return { addon, bound, regs, emitted }
}

describe('smtp-nodemailer as the smtp-inbound broker provider', () => {
  it('registers the broker cap and binds nothing while no mailbox record exists', async () => {
    const { regs, bound, addon } = await boot(false)
    expect(regs.some((r) => r.capability.name === brokerCapability.name)).toBe(true)
    expect(bound).toEqual([])
    await addon.shutdown()
  })

  it('binds the mailbox record at boot and announces it on the bus', async () => {
    const { bound, emitted, addon } = await boot(true)
    expect(bound).toEqual([2525])
    expect(JSON.stringify(emitted)).toContain('broker.status-changed')
    await addon.shutdown()
  })
})
