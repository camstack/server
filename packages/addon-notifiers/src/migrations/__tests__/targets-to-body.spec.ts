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
  targetRowPortsOver,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { notifierDescriptors, notifiersRecordKinds } from '../../record-kinds.js'
import { TargetStore } from '../../target-store.js'
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

const TOKEN = 'tg-token-MARK-8f31'

async function world() {
  const memory = makeInMemoryRecords('notifiers')
  await memory.records.declare({ ...notifiersRecordKinds, ...oldTargetKinds })
  const store = TargetStore.of(memory.records)
  const oldKind = memory.records.kind(oldTargetKinds[OLD_TARGETS_KIND])
  const descriptors = notifierDescriptors()
  const run = (host: AddonMigrationHost) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, {
        rows: targetRowPortsOver({ oldKind, store }),
        secretKeysOf: (kind) => {
          const descriptor = descriptors.find((candidate) => candidate.kind === kind)
          return descriptor === undefined ? [] : secretKeysOf(descriptor)
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
      id: 'tg-1',
      data: {
        name: 'Phone',
        kind: 'telegram',
        addonId: 'notifiers',
        enabled: false,
        config: { botToken: TOKEN, chatId: '42' },
      },
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
      id: 'x-1',
      data: {
        name: 'Other',
        kind: 'unknown-kind',
        addonId: 'notifiers',
        enabled: true,
        config: {},
      },
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
})
