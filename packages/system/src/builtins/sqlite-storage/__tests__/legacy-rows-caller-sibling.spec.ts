/**
 * Who may read the legacy rows of an integration (planning#445). The rows are migration-only:
 * the owning addon, the runner that hosts it, or an addon of the SAME installed package (one trust
 * unit, whether or not it shares a runner) — never a foreign addon, not even one in the same runner.
 * Real SQLite, real installed manifests; the caller is stamped the way the transport stamps it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRecordsAccess } from '@camstack/types'
import type { ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { integrationRegistryRecordKinds } from '../integration-record-kinds.js'
import { IntegrationRegistry } from '../integration-registry.js'
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
import { makeRecordsWorld } from './support/records-world.js'

const OWNER = 'provider-homeassistant'
const SIBLING = 'homeassistant-export'
const FOREIGN_SAME_RUNNER = 'other-grouped-addon'

const noopStore = {
  declareCollection: async () => {},
  query: async () => [],
  insert: async () => {},
  updateWhere: async () => {},
  deleteWhere: async () => {},
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  update: async () => {},
}

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
  }> {
    const world = makeRecordsWorld()
    await world.provider.init()
    ensureLegacyIntegrationRowsTable(world.settings.db)
    const registryRecords = createRecordsAccess({
      owner: 'integration-registry',
      transport: world.transportFor('integration-registry'),
      secrets: null,
    })
    await registryRecords.declare(integrationRegistryRecordKinds)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a no-op legacy store; the records stores serve every call
    const store = noopStore as unknown as ISettingsStoreProvider
    const registry = new IntegrationRegistry(
      store,
      IntegrationRegistry.recordStoresOf(registryRecords),
    )
    await registry.initialize()
    const integration = await registry.createIntegration({
      addonId: OWNER,
      name: 'Home',
    })
    patchLegacyIntegrationRows(world.settings.db, integration.id, {
      url: 'http://ha.example.com',
    })
    const engine = new MigrationEngine({
      logger: recordingLogger([], 'Migrations'),
      catalogue: [],
      codeVersion: '1.0.0',
      snapshotterFor: () => ({
        writePreMigration: async () => ({ outcome: 'skipped' }) as never,
      }),
    })
    const provider = new MigrationsProvider(engine, {
      database: () => world.settings.db,
      runnerIdOf: installedRunnerResolver(addonsDir),
      areSiblings: installedSiblingResolver(addonsDir),
    })
    return {
      read: async (caller) =>
        provider.readLegacyIntegrationRows({
          integrationId: integration.id,
          ...(caller === null ? {} : { callerAddonId: caller }),
        }),
    }
  }

  it('lets the owner, and a sibling addon of the same package in another runner', async () => {
    const { read } = await boot()
    await expect(read(OWNER)).resolves.toEqual({
      url: 'http://ha.example.com',
    })
    await expect(read(SIBLING)).resolves.toEqual({
      url: 'http://ha.example.com',
    })
  })

  it('refuses a foreign addon, even one in the same runner as the sibling, and an unstamped call', async () => {
    const { read } = await boot()
    await expect(read(FOREIGN_SAME_RUNNER)).rejects.toThrow(/migration-only/)
    await expect(read('stranger')).rejects.toThrow(/migration-only/)
    await expect(read(null)).rejects.toThrow(/migration-only/)
  })
})
