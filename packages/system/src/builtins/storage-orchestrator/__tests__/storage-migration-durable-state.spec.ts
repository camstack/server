/**
 * `storageMigration.start` against the REAL persistence seam, in the boot order
 * production actually uses.
 *
 * Why this exists: every other coordinator test injects a `MigrationState`
 * backed by a closure, so `start` persisted to a variable and the suite was
 * green while the method failed on first contact with the hub —
 * `[ConfigManager] SettingsStore not initialized` from `setAddonConfig`, on the
 * one line that writes the durable job.
 *
 * The cause is an ORDER, so only a test that reproduces the order can catch it.
 * `settings-store` is owned by `storage-orchestrator`, so
 * `createAddonContext()` builds that addon's `ctx.settings` BEFORE
 * `initialize()` returns the registration that wires the door. The door's own
 * owner can never see it any other way. Bind the backend when the view is
 * built and the owner is left holding the sync-`ISettingsStore` backend — which
 * on hub-main is never wired at all since `sqlite-settings` runs isolated
 * (D181), so its writes throw for the life of the process and its reads answer
 * `{}` in silence.
 *
 * So the chain under test is real from `StorageMigrationCoordinator.start`
 * down: real `createDurableState` (the body of `BaseAddon.state`), real
 * `ConfigManager.createSettingsView`, real `createDoorSettingsView`. Only the
 * SQLite engine behind the door and the mover participants are fakes.
 */

import * as path from 'node:path'
import type {
  IScopedLogger,
  ISettingsStoreProvider,
  RelocateJob,
  StorageLocation,
  StorageMigrationJob,
} from '@camstack/types'
import { createDurableState, type DurableState, StorageMigrationJobSchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { AddonSettingsView } from '../../../kernel/config-manager.js'
import { ConfigManager } from '../../../kernel/config-manager.js'
import {
  type MigrationState,
  StorageMigrationCoordinator,
} from '../storage-migration-coordinator.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
} as unknown as IScopedLogger

/** A path that deliberately does not exist — `ConfigManager` falls back to
 *  bootstrap defaults, which is what a test wants and what a fresh install is. */
const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')

interface StoredRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * An in-memory stand-in for the isolated `sqlite-settings` engine behind the
 * `settings-store` door. It STORES — a fake that accepts a write and then
 * reports empty is indistinguishable from the bug this file exists to catch.
 *
 * Only the five methods `createDoorSettingsView` uses are implemented; the rest
 * of the cap throws rather than answering a plausible-looking nothing.
 */
class InMemoryDataDoor implements ISettingsStoreProvider {
  private readonly collections: Map<string, Map<string, Record<string, unknown>>> = new Map()

  rows(collection: string): readonly StoredRow[] {
    const rows = this.collections.get(collection)
    if (!rows) return []
    return [...rows.entries()].map(([id, data]) => ({ id, data }))
  }

  private collection(name: string): Map<string, Record<string, unknown>> {
    const existing = this.collections.get(name)
    if (existing) return existing
    const created = new Map<string, Record<string, unknown>>()
    this.collections.set(name, created)
    return created
  }

  async get(input: { collection: string; key: string }): Promise<unknown> {
    return this.collection(input.collection).get(input.key) ?? null
  }

  async set(input: { collection: string; key: string; value: unknown }): Promise<void> {
    if (!isRecord(input.value)) {
      throw new Error(`InMemoryDataDoor: non-record value for ${input.collection}/${input.key}`)
    }
    this.collection(input.collection).set(input.key, input.value)
  }

  async delete(input: { collection: string; key: string }): Promise<void> {
    this.collection(input.collection).delete(input.key)
  }

  async query(input: {
    collection: string
    filter?: { whereBetween?: Record<string, readonly [unknown, unknown]> }
  }): Promise<readonly StoredRow[]> {
    const all = this.rows(input.collection)
    const between = input.filter?.whereBetween?.['id']
    if (between === undefined) return all
    const [lo, hi] = between
    if (typeof lo !== 'string' || typeof hi !== 'string') return all
    // Half-open, exactly like `prefixRange` — the view re-filters anyway.
    return all.filter((row) => row.id >= lo && row.id < hi)
  }

  async deleteWhere(input: {
    collection: string
    filter: { whereBetween?: Record<string, readonly [unknown, unknown]> }
  }): Promise<{ deleted: number }> {
    const victims = await this.query(input)
    const rows = this.collection(input.collection)
    for (const victim of victims) rows.delete(victim.id)
    return { deleted: victims.length }
  }

  private unsupported(method: string): never {
    throw new Error(`InMemoryDataDoor: ${method} is not part of the settings-view surface`)
  }

  async insert(): Promise<{ readonly id: string | number }> {
    return this.unsupported('insert')
  }
  async upsert(): Promise<{ readonly id: string | number }> {
    return this.unsupported('upsert')
  }
  async upsertMany(): Promise<{ upserted: number }> {
    return this.unsupported('upsertMany')
  }
  async insertMany(): Promise<{ inserted: number }> {
    return this.unsupported('insertMany')
  }
  /** Only the two ops a settings merge uses: removals by id, then upserts. */
  async transact(input: {
    ops: readonly {
      op: string
      collection: string
      filter?: { whereIn?: Record<string, readonly unknown[]> }
      records?: readonly { id?: string; data: Record<string, unknown> }[]
    }[]
  }): Promise<{ applied: boolean }> {
    for (const op of input.ops) {
      const rows = this.collection(op.collection)
      if (op.op === 'deleteWhere') {
        for (const id of op.filter?.whereIn?.['id'] ?? []) rows.delete(String(id))
      } else if (op.op === 'upsertMany') {
        for (const r of op.records ?? []) if (r.id !== undefined) rows.set(r.id, r.data)
      } else this.unsupported(`transact ${op.op}`)
    }
    return { applied: true }
  }
  async update(): Promise<void> {
    return this.unsupported('update')
  }
  async updateWhere(): Promise<{ updated: number }> {
    return this.unsupported('updateWhere')
  }
  async count(): Promise<number> {
    return this.unsupported('count')
  }
  async aggregate(): Promise<{ count: number; values: Record<string, number | null> }> {
    return this.unsupported('aggregate')
  }
  async histogram(): Promise<readonly { bucket: number; count: number }[]> {
    return this.unsupported('histogram')
  }
  async isEmpty(): Promise<boolean> {
    return this.unsupported('isEmpty')
  }
  async declareCollection(): Promise<void> {
    return this.unsupported('declareCollection')
  }
}

/** The `settings-store` cap key `BaseAddon.state('storage-migration', …)` lands
 *  under, for the addon that owns the door. */
const MIGRATION_ROW_ID = 'storage-orchestrator.storage-migration'

/**
 * `ctx.settings` for `storage-orchestrator`, wired in the order the hub wires
 * it: the view first, the door second.
 */
function viewThenDoor(): { view: AddonSettingsView; door: InMemoryDataDoor } {
  const door = new InMemoryDataDoor()
  const config = new ConfigManager(NO_CONFIG_FILE)
  const view = config.createSettingsView('storage-orchestrator')
  config.setSettingsDoor(door)
  return { view, door }
}

/** Verbatim `BaseAddon.state(...)` — the primitive the coordinator is given. */
function durableMigrationState(view: AddonSettingsView): DurableState<StorageMigrationJob | null> {
  return createDurableState<StorageMigrationJob | null>({
    key: 'storage-migration',
    schema: StorageMigrationJobSchema.nullable(),
    fallback: null,
    read: () => view.readAddonStore(),
    write: (patch) => view.writeAddonStore(patch),
  })
}

/** `enabled` is the whole write model (D383): the third argument used to be the
 *  class default flag and means exactly the same thing here — is this location
 *  written to. */
function location(
  id: string,
  type: string,
  enabled: boolean,
): Omit<StorageLocation, 'createdAt' | 'updatedAt'> {
  return { id, type, displayName: id, providerId: 'fs', config: {}, enabled, isSystem: false }
}

function doneJob(jobId: string): RelocateJob {
  return {
    jobId,
    state: 'done',
    fromLocationId: 'from',
    toLocationId: 'to',
    deviceId: null,
    entities: ['segments'],
    filesMoved: 1,
    bytesMoved: 1,
    filesTotal: 1,
    startedAt: 1,
    finishedAt: 2,
    error: null,
  }
}

function coordinatorOver(state: MigrationState): StorageMigrationCoordinator {
  const locations = new StorageOrchestratorService(logger, () => [])
  locations.upsertLocation(location('recordingsLow:old', 'recordingsLow', true))
  locations.upsertLocation(location('recordingsLow:new', 'recordingsLow', false))
  const jobs = new Map<string, RelocateJob>()
  let next = 0
  const startMove = async () => {
    const jobId = `mover-${next++}`
    jobs.set(jobId, doneJob(jobId))
    return { jobId }
  }
  const noop = async (): Promise<void> => undefined
  const lease = { pause: noop, resume: noop }
  return new StorageMigrationCoordinator({
    locations,
    state,
    participants: {
      pipeline: lease,
      recorder: {
        ...lease,
        startMove,
        startDrain: startMove,
        getMove: async (jobId) => jobs.get(jobId) ?? null,
        cancelMove: async () => true,
        refresh: noop,
        listMovers: async () => [...jobs.values()],
        residue: async () => ({ segments: 0, bytes: 0 }),
      },
      analytics: {
        ...lease,
        startMove,
        startDrain: startMove,
        countUnstamped: async () => ({
          media: { present: false, rows: 0 },
          retrainFrames: { present: false, rows: 0 },
          anyPresent: false,
          total: 0,
        }),
        getMove: async (jobId) => jobs.get(jobId) ?? null,
        cancelMove: async () => true,
        refresh: noop,
        listMovers: async () => [],
        residue: async () => ({ rows: 0 }),
      },
    },
    now: () => 1,
    newId: () => 'migration-1',
    pollMs: 0,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
  })
}

describe('ConfigManager settings view — the door is wired after the view exists', () => {
  it('writes through the door the owner registers after its own view was built', async () => {
    const { view, door } = viewThenDoor()

    await view.writeAddonStore({ 'storage-migration': { jobId: 'migration-1' } })

    expect(door.rows('addon-settings').map((row) => row.id)).toEqual([MIGRATION_ROW_ID])
    expect(await view.readAddonStore()).toEqual({
      'storage-migration': { jobId: 'migration-1' },
    })
  })

  it('reads back what the door holds instead of answering {} in silence', async () => {
    const { view, door } = viewThenDoor()
    await door.set({
      collection: 'addon-settings',
      key: MIGRATION_ROW_ID,
      value: { addonId: 'storage-orchestrator', key: 'storage-migration', value: { jobId: 'j' } },
    })

    expect(await view.readAddonStore()).toEqual({ 'storage-migration': { jobId: 'j' } })
  })
})

describe('storageMigration.start — durable job through the real settings seam', () => {
  it('persists the job on start, through the door wired after the view', async () => {
    const { view, door } = viewThenDoor()
    const state = durableMigrationState(view)

    const jobId = await coordinatorOver(state).start({
      destinations: { recordingsLow: 'recordingsLow:new' },
      mode: 'nonBlocking',
      throttleMbps: 10,
    })

    // The row is in the store, not merely in the coordinator's RAM: on the live
    // hub `status` answered from `this.active` while `persist` had thrown, so a
    // job that never landed still looked like a running migration.
    expect(door.rows('addon-settings').map((row) => row.id)).toEqual([MIGRATION_ROW_ID])
    const persisted = await state.get()
    expect(persisted?.jobId).toBe(jobId)
    expect(persisted?.mode).toBe('nonBlocking')
  })

  it('stays startable when the durable write fails', async () => {
    // The live hub's second failure: `start` published `this.active` before the
    // persist, so a write that threw left a job nobody could see in the store,
    // could not cancel (cancel persists too) and could not replace ("already
    // active"). A restart was the only exit.
    let failing = true
    const state: MigrationState = {
      get: async () => null,
      set: async () => {
        if (failing) throw new Error('settings store is down')
      },
    }
    const input = { destinations: { recordingsLow: 'recordingsLow:new' } } as const
    const coordinator = coordinatorOver(state)

    await expect(coordinator.start(input)).rejects.toThrow('settings store is down')
    expect(await coordinator.status()).toBeNull()

    failing = false
    await expect(coordinator.start(input)).resolves.toBe('migration-1')
  })

  it('hands the persisted job to a coordinator that did not start it', async () => {
    const { view } = viewThenDoor()
    const state = durableMigrationState(view)
    await coordinatorOver(state).start({
      destinations: { recordingsLow: 'recordingsLow:new' },
      mode: 'nonBlocking',
    })

    // A second coordinator over the same durable state — the boot-recovery
    // shape. It has no `active` job, so anything it reports came off the store.
    const recovered = await coordinatorOver(state).status()

    expect(recovered?.jobId).toBe('migration-1')
    expect(recovered?.destinations).toEqual({ recordingsLow: 'recordingsLow:new' })
  })
})
