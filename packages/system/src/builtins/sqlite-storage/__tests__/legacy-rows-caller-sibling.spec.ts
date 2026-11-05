/**
 * Who may read the legacy rows of an integration (planning#445). The rows are migration-only:
 * the owning addon, the runner that hosts it, or an addon of the SAME installed package (one trust
 * unit, whether or not it shares a runner) — never a foreign addon, not even one in the same runner.
 * Real SQLite, real installed manifests; the caller is stamped the way the transport stamps it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installedRunnerResolver,
  installedSiblingResolver,
} from '../migrations/installed-runner-resolver.js'
import {
  ensureLegacyIntegrationRowsTable,
  patchLegacyIntegrationRows,
} from '../migrations/legacy-integration-rows-door.js'
import { MigrationsProvider } from '../migrations/migrations-provider.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import { recordingLogger } from './support/owned-files-harness.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeRecordsWorld } from './support/records-world.js'

const OWNER = 'provider-homeassistant'
const SIBLING = 'homeassistant-export'
const FOREIGN_SAME_RUNNER = 'other-grouped-addon'

const INTEGRATION = 'int_0006'

describe('legacy integration rows: who may read them', () => {
  let addonsDir: string
  beforeEach(() => {
    addonsDir = mkdtempSync(path.join(os.tmpdir(), 'legacy-caller-'))
    const write = (dir: string, addons: unknown[]): void => {
      mkdirSync(path.join(addonsDir, dir), { recursive: true })
      writeFileSync(
        path.join(addonsDir, dir, 'package.json'),
        JSON.stringify({ camstack: { addons } }),
      )
    }
    write('@camstack/provider-ha', [
      { id: OWNER, execution: { placement: 'hub-only' } },
      {
        id: SIBLING,
        execution: { placement: 'hub-only', group: 'integrations' },
      },
    ])
    write('@camstack/other', [
      {
        id: FOREIGN_SAME_RUNNER,
        execution: { placement: 'hub-only', group: 'integrations' },
      },
    ])
  })
  afterEach(() => rmSync(addonsDir, { recursive: true, force: true }))

  async function boot(): Promise<{
    read: (caller: string | null) => Promise<unknown>
    writes: Record<'patch' | 'deleteKeys' | 'clear', (caller: string | null) => Promise<unknown>>
  }> {
    const world = makeRecordsWorld()
    await world.provider.init()
    ensureLegacyIntegrationRowsTable(world.settings.db)
    const db = world.settings.db
    db.exec(
      'CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY NOT NULL, addon_id TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO integrations (id, addon_id) VALUES (?, ?)').run(INTEGRATION, OWNER)
    patchLegacyIntegrationRows(db, INTEGRATION, { url: 'http://ha.example.com', keep: 1 })
    const engine = new MigrationEngine({
      logger: recordingLogger([], 'Migrations'),
      catalogue: [],
      codeVersion: '1.0.0',
      snapshotterFor: (livePath) =>
        new SqliteSnapshotter({ livePath, logger: recordingLogger([], 'Snapshot') }),
    })
    const provider = new MigrationsProvider(engine, {
      database: () => world.settings.db,
      runnerIdOf: installedRunnerResolver(addonsDir),
      areSiblings: installedSiblingResolver(addonsDir),
    })
    const stamp = (caller: string | null): { callerAddonId?: string } =>
      caller === null ? {} : { callerAddonId: caller }
    return {
      read: async (caller) =>
        provider.readLegacyIntegrationRows({ integrationId: INTEGRATION, ...stamp(caller) }),
      writes: {
        patch: async (caller) =>
          provider.patchLegacyIntegrationRows({
            integrationId: INTEGRATION,
            patch: { touched: true },
            ...stamp(caller),
          }),
        deleteKeys: async (caller) =>
          provider.deleteLegacyIntegrationRowKeys({
            integrationId: INTEGRATION,
            keys: ['keep'],
            ...stamp(caller),
          }),
        clear: async (caller) =>
          provider.clearLegacyIntegrationRows({ integrationId: INTEGRATION, ...stamp(caller) }),
      },
    }
  }

  it('lets the owner, and a sibling addon of the same package in another runner', async () => {
    const { read } = await boot()
    await expect(read(OWNER)).resolves.toEqual({
      url: 'http://ha.example.com',
      keep: 1,
    })
    await expect(read(SIBLING)).resolves.toEqual({
      url: 'http://ha.example.com',
      keep: 1,
    })
  })

  it('refuses a foreign addon, even one in the same runner as the sibling, and an unstamped call', async () => {
    const { read } = await boot()
    await expect(read(FOREIGN_SAME_RUNNER)).rejects.toThrow(/migration-only/)
    await expect(read('stranger')).rejects.toThrow(/migration-only/)
    await expect(read(null)).rejects.toThrow(/migration-only/)
  })

  it.each([
    'patch',
    'deleteKeys',
    'clear',
  ] as const)('the write op %s: a sibling is allowed, a foreign addon and an unstamped call are refused', async (op) => {
    const { writes, read } = await boot()
    await expect(writes[op](FOREIGN_SAME_RUNNER)).rejects.toThrow(/migration-only/)
    await expect(writes[op]('stranger')).rejects.toThrow(/migration-only/)
    await expect(writes[op](null)).rejects.toThrow(/migration-only/)
    // refused means untouched
    await expect(read(OWNER)).resolves.toEqual({ url: 'http://ha.example.com', keep: 1 })
    await expect(writes[op](SIBLING)).resolves.toBeDefined()
    expect(await read(OWNER)).not.toEqual({ url: 'http://ha.example.com', keep: 1 })
  })
})
