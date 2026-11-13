/**
 * An email target names its sender with ONE link (`sendWith`). The fixture rows are stored the way the
 * release before stored them (`smtpAddonId` / `smtpInstanceId`); the relay row is switched off and its
 * recipients and owner carry a MARK that must survive. Driven the way the addon drives it: the catalogue
 * through `runAddonMigrations`, the records the real engine in memory.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  runAddonMigrations,
  targetRowPortsOver,
  legacyTargetsOver,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { notifierDescriptors, notifiersRecordKinds } from '../../record-kinds.js'
import { TargetStore } from '../../target-store.js'
import {
  LEGACY_EMAIL_OWNER,
  LEGACY_EMAIL_PROVIDER_TARGET,
  LEGACY_EMAIL_RECIPIENT,
  LEGACY_EMAIL_RELAY_TARGET,
} from '../__fixtures__/seed.js'
import {
  ADDON_MIGRATIONS,
  EMAIL_SEND_WITH_ID,
  type EmailSendWithPorts,
  OLD_TARGETS_KIND,
  oldTargetKinds,
} from '../index.js'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

function ledgerHost(): {
  host: AddonMigrationHost
  outcomes: Map<string, MigrationOwnerResult>
} {
  const outcomes = new Map<string, MigrationOwnerResult>()
  const host: AddonMigrationHost = {
    declareOwner: async (input) => ({
      bootId: 'boot',
      snapshot: 'none' as const,
      steps: input.metas.map((m) => ({
        id: m.id,
        action: 'run' as const,
        state: 'pending' as const,
      })),
    }),
    startMigration: async () => ({
      proceed: true,
      state: 'pending' as const,
      reason: null,
    }),
    finishMigration: async ({ id, result }) => {
      if (result.kind === 'failed')
        return {
          status: 'failed' as const,
          error: result.error,
          rowsChanged: 0,
        }
      outcomes.set(id, result)
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    },
  }
  return { host, outcomes }
}

/** Senders per provider; a provider listed in `unreadable` rejects. */
interface SenderWorld {
  readonly senders: Readonly<Record<string, readonly string[]>>
  readonly unreadable?: readonly string[]
}

async function world(senders: SenderWorld) {
  const memory = makeInMemoryRecords('notifiers')
  await memory.records.declare({ ...notifiersRecordKinds, ...oldTargetKinds })
  const legacy = legacyTargetsOver(
    memory.records.kind(oldTargetKinds[OLD_TARGETS_KIND]),
    silentLogger,
  )
  const store = TargetStore.of(memory.records, notifierDescriptors(), {
    logger: silentLogger,
    legacy,
  })
  const emailRows = store.handlesByKind().get('email')
  if (emailRows === undefined) throw new Error('expected the email record kind')
  const emailSenders: EmailSendWithPorts = {
    list: async () => (await emailRows.query({ limit: 100 })).records,
    replace: async (row) => {
      await emailRows.put({ id: row.id, data: { ...row.data } }, { ifRev: row.rev })
    },
    firstSenderOf: async (addonId) => {
      if (senders.unreadable?.includes(addonId) === true) throw new Error(`${addonId} unreadable`)
      return senders.senders[addonId]?.[0] ?? null
    },
  }
  const run = (host: AddonMigrationHost) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, {
        rows: targetRowPortsOver({ legacy, store, logger: silentLogger }),
        secretKeysOf: () => [],
        emailSenders,
      }),
      silentLogger,
    )
  const seed = async (...rows: readonly { id: string; data: Record<string, unknown> }[]) => {
    for (const row of rows) await emailRows.put({ id: row.id, data: { ...row.data } })
  }
  return { emailRows, store, run, seed }
}

describe('notifiers email-send-with', () => {
  it('links the relay a target pinned and keeps its recipients, switch and owner', async () => {
    const w = await world({ senders: {} })
    await w.seed(LEGACY_EMAIL_RELAY_TARGET)
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    const row = await w.emailRows.get('mail-relay')
    expect(row?.data).toEqual({
      name: 'Night shift',
      enabled: false,
      to: LEGACY_EMAIL_RECIPIENT,
      ownerUserId: LEGACY_EMAIL_OWNER,
      sendWith: 'relay-7',
    })
    expect(outcomes.get(EMAIL_SEND_WITH_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 1, unresolved: [] } },
    })
  })

  it("links a target that named only its provider to that provider's first sender", async () => {
    const w = await world({
      senders: { 'google-services': ['acct-1', 'acct-2'] },
    })
    await w.seed(LEGACY_EMAIL_PROVIDER_TARGET)
    expect((await w.run(ledgerHost().host)).failed).toEqual([])
    const target = await w.store.getById('mail-google')
    expect(target?.config['sendWith']).toBe('acct-1')
    expect(target?.config['smtpAddonId']).toBeUndefined()
  })

  it('leaves a target whose provider holds no sender as it was, named in the summary', async () => {
    const w = await world({ senders: {} })
    await w.seed(LEGACY_EMAIL_PROVIDER_TARGET)
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    expect((await w.emailRows.get('mail-google'))?.data['smtpAddonId']).toBe('google-services')
    expect(outcomes.get(EMAIL_SEND_WITH_ID)).toMatchObject({
      result: {
        outcome: 'already-done',
        summary: { converted: 0, unresolved: ['mail-google'] },
      },
    })
  })

  it('a provider that cannot be read fails the step (retried next boot) and changes nothing', async () => {
    const senders = {
      senders: { 'google-services': ['acct-1'] },
      unreadable: ['google-services'],
    }
    const w = await world(senders)
    await w.seed(LEGACY_EMAIL_PROVIDER_TARGET)
    const first = ledgerHost()
    expect((await w.run(first.host)).failed).toEqual([EMAIL_SEND_WITH_ID])
    expect(first.outcomes.has(EMAIL_SEND_WITH_ID)).toBe(false)
    expect((await w.emailRows.get('mail-google'))?.data['sendWith']).toBeUndefined()
  })

  it('a target already linked is not touched', async () => {
    const w = await world({ senders: {} })
    await w.seed({
      id: 'mail-new',
      data: { name: 'New', enabled: true, to: 'a@b.c', sendWith: 'acct-9' },
    })
    const before = (await w.emailRows.get('mail-new'))?.rev
    const { host, outcomes } = ledgerHost()
    await w.run(host)
    expect((await w.emailRows.get('mail-new'))?.rev).toBe(before)
    expect(outcomes.get(EMAIL_SEND_WITH_ID)).toMatchObject({
      result: { outcome: 'already-done', summary: { converted: 0 } },
    })
  })
})
