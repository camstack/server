/**
 * The retired Echo volume and mode are removed from stored rows. Driven the way the addon
 * drives it: the catalogue run by `runAddonMigrations` against a ledger that records the
 * outcome. A marked field proves everything else survives; a rerun reports `already-done`.
 */

import {
  type AddonMigrationHost,
  type FlattenRowPorts,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationOwnerResult,
  runAddonMigrations,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ADDON_MIGRATIONS } from '../index.js'

const MIGRATION_ID = 'import-alexa/2026-11-01-strip-echo-target-volume-and-mode'
const NO_FLATTEN_PORTS: FlattenRowPorts = {
  listNested: async () => [],
  readResolved: async () => ({}),
  patch: async () => undefined,
}
const MARK = 'kitchen echo, kept as written'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

/** A ledger that offers every migration on every boot and keeps the last outcome per id. */
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

function storeWith(initial: readonly unknown[]) {
  const state = { rows: initial, writes: 0 }
  return {
    state,
    ports: {
      readRows: () => state.rows,
      writeRows: async (rows: readonly unknown[]) => {
        state.rows = rows
        state.writes += 1
      },
    },
  }
}

async function boot(store: ReturnType<typeof storeWith>, host: AddonMigrationHost) {
  return runAddonMigrations(
    host,
    defineAddonMigrations(
      ADDON_MIGRATIONS.filter((m) => m.meta.id === MIGRATION_ID),
      { ...store.ports, ...NO_FLATTEN_PORTS },
    ),
    silentLogger,
  )
}

const legacy = {
  id: 't1',
  name: MARK,
  enabled: true,
  brokerId: 'alexa_001',
  echoId: 'echo-k',
  mode: 'announce',
  volume: 63,
  respectDnd: false,
}

describe('strip-echo-target-volume-and-mode', () => {
  it('removes volume and mode and keeps every other field', async () => {
    const store = storeWith([legacy, { id: 't2', name: 'Hall', echoId: 'echo-h', volume: 10 }])
    const { host, outcomes } = ledgerHost()
    const report = await boot(store, host)
    expect(report.failed).toEqual([])
    expect(store.state.rows).toEqual([
      {
        id: 't1',
        name: MARK,
        enabled: true,
        brokerId: 'alexa_001',
        echoId: 'echo-k',
        respectDnd: false,
      },
      { id: 't2', name: 'Hall', echoId: 'echo-h' },
    ])
    expect(outcomes.get(MIGRATION_ID)).toMatchObject({
      result: { outcome: 'done', summary: { targets: 2, stripped: 2 } },
    })
  })

  it('a rerun reports already-done and writes nothing', async () => {
    const store = storeWith([legacy])
    await boot(store, ledgerHost().host)
    const writesAfterFirst = store.state.writes
    const second = ledgerHost()
    await boot(store, second.host)
    expect(store.state.writes).toBe(writesAfterFirst)
    expect(second.outcomes.get(MIGRATION_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(store.state.rows).toEqual([
      {
        id: 't1',
        name: MARK,
        enabled: true,
        brokerId: 'alexa_001',
        echoId: 'echo-k',
        respectDnd: false,
      },
    ])
  })

  it('no stored targets is already-done', async () => {
    const store = storeWith([])
    const { host, outcomes } = ledgerHost()
    await boot(store, host)
    expect(store.state.writes).toBe(0)
    expect(outcomes.get(MIGRATION_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
  })
})
