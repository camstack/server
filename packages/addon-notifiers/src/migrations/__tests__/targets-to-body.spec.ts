/**
 * The notification targets move from one record kind with a free-form `config` blob to one record kind
 * per target kind (epic #440, step 6). The fixture is a Telegram target that carries a token and is
 * SWITCHED OFF: the token must read back equal from the keychain, the switch must stay off, and the id
 * must stay the id a notification rule names. Driven the way the addon drives it: the catalogue through
 * `runAddonMigrations`, the records the real engine in memory.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  runAddonMigrations,
  secretKeysOf,
  legacyTargetsOver,
  targetRowPortsOver,
  type TargetRowPorts,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { notifierDescriptors, notifiersRecordKinds } from '../../record-kinds.js'
import { TargetStore } from '../../target-store.js'
import {
  LEGACY_FOREIGN_TARGET,
  LEGACY_TARGET_TOKEN,
  LEGACY_TELEGRAM_TARGET,
} from '../__fixtures__/seed.js'
import { ADDON_MIGRATIONS, oldTargetKinds, OLD_TARGETS_KIND, TARGETS_TO_BODY_ID } from '../index.js'

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

const TOKEN = LEGACY_TARGET_TOKEN

async function world() {
  const memory = makeInMemoryRecords('notifiers')
  await memory.records.declare({ ...notifiersRecordKinds, ...oldTargetKinds })
  const oldKind = memory.records.kind(oldTargetKinds[OLD_TARGETS_KIND])
  const legacy = legacyTargetsOver(oldKind, silentLogger)
  const store = TargetStore.of(memory.records, notifierDescriptors(), {
    logger: silentLogger,
    legacy,
  })
  const descriptors = notifierDescriptors()
  const run = (
    host: AddonMigrationHost,
    wrap: (rows: TargetRowPorts) => TargetRowPorts = (rows) => rows,
  ) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, {
        rows: wrap(targetRowPortsOver({ legacy, store, logger: silentLogger })),
        secretKeysOf: (kind) => {
          const descriptor = descriptors.find((candidate) => candidate.kind === kind)
          return descriptor === undefined ? [] : secretKeysOf(descriptor)
        },
        emailSenders: {
          list: async () => [],
          replace: async () => undefined,
          sendersOf: async () => [],
        },
      }),
      silentLogger,
    )
  return { memory, store, oldKind, run }
}

describe('notifiers targets-to-body', () => {
  it('moves a switched-off Telegram target: token reads back equal, stays off, keeps its id', async () => {
    const w = await world()
    await w.oldKind.put({
      id: LEGACY_TELEGRAM_TARGET.id,
      data: LEGACY_TELEGRAM_TARGET.data,
    })
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    const moved = await w.store.getById('tg-1')
    expect(moved).toMatchObject({
      id: 'tg-1',
      kind: 'telegram',
      enabled: false,
      name: 'Phone',
    })
    expect(moved?.config['botToken']).toBe(TOKEN)
    expect(moved?.config['chatId']).toBe('42')
    expect(await w.oldKind.get('tg-1')).toBeNull()
    expect(outcomes.get(TARGETS_TO_BODY_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 1 } },
    })
  })

  it('a rerun is already-done and a row of a kind this addon does not serve stays', async () => {
    const w = await world()
    await w.oldKind.put({
      id: LEGACY_FOREIGN_TARGET.id,
      data: LEGACY_FOREIGN_TARGET.data,
    })
    const first = ledgerHost()
    await w.run(first.host)
    expect(first.outcomes.get(TARGETS_TO_BODY_ID)).toMatchObject({
      result: {
        outcome: 'already-done',
        summary: { converted: 0, skipped: 1 },
      },
    })
    expect(await w.oldKind.get('x-1')).not.toBeNull()
  })

  it('a target whose token will not read back is NOT recorded applied: it stays served from the retired kind and moves on the rerun, marked field intact', async () => {
    const w = await world()
    await w.oldKind.put({
      id: 'tg-bad',
      data: {
        name: 'Broken',
        kind: 'telegram',
        addonId: 'notifiers',
        enabled: false,
        config: { botToken: TOKEN, chatId: '1' },
      },
    })
    await w.oldKind.put({
      id: 'tg-good',
      data: {
        name: 'Fine',
        kind: 'telegram',
        addonId: 'notifiers',
        enabled: true,
        config: { botToken: `${TOKEN}-2`, chatId: '2' },
      },
    })
    const first = ledgerHost()
    const failedRun = await w.run(first.host, (rows) => ({
      ...rows,
      readNew: async (kind, id) =>
        id === 'tg-bad' ? { name: 'Broken', botToken: 'unreadable' } : rows.readNew(kind, id),
    }))
    // The ledger does not say applied: the next boot runs it again.
    expect(failedRun.failed).toEqual([TARGETS_TO_BODY_ID])
    expect(first.outcomes.has(TARGETS_TO_BODY_ID)).toBe(false)
    // The good one moved; the bad one is untouched and still SERVED from the retired kind.
    expect(await w.oldKind.get('tg-good')).toBeNull()
    expect(await w.oldKind.get('tg-bad')).not.toBeNull()
    expect((await w.store.getById('tg-bad'))?.config['botToken']).toBe(TOKEN)

    // The rerun (the read-back works now) moves it, the switch and the token intact.
    const second = ledgerHost()
    expect((await w.run(second.host)).failed).toEqual([])
    expect(second.outcomes.get(TARGETS_TO_BODY_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 1 } },
    })
    expect(await w.oldKind.get('tg-bad')).toBeNull()
    const moved = await w.store.getById('tg-bad')
    expect(moved).toMatchObject({ name: 'Broken', enabled: false })
    expect(moved?.config['botToken']).toBe(TOKEN)
    expect((await w.store.list()).map((t) => t.id).sort()).toEqual(['tg-bad', 'tg-good'])
  })
})
