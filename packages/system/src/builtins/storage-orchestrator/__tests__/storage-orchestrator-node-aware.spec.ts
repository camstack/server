/**
 * Unit tests for the node-aware storage-location behaviour (SP1, Task 6):
 *   - `upsertLocation` rejects a node-local provider's location that
 *     carries no `nodeId`, accepts it when `nodeId` is present, and
 *     allows an absent `nodeId` for a node-agnostic provider.
 *   - `backfillNodeIds('hub')` stamps `nodeId: 'hub'` on persisted
 *     node-local locations missing it, leaves node-agnostic (remote)
 *     locations' null `nodeId` untouched, and is idempotent (never
 *     re-touches a location that already has a `nodeId`).
 *
 * Mirrors the fake-store + fake-provider harness of the sibling
 * `storage-orchestrator-persistence.spec.ts` / `storage-orchestrator.spec.ts`.
 */

import type { IScopedLogger, StorageLocation } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ILocationStore } from '../location-store.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

interface FakeLocationStore extends ILocationStore {
  readonly rows: Map<string, StorageLocation>
  readonly upsertCalls: StorageLocation[]
}

function makeFakeStore(seed: readonly StorageLocation[] = []): FakeLocationStore {
  const rows = new Map<string, StorageLocation>(seed.map((l) => [l.id, l]))
  const upsertCalls: StorageLocation[] = []
  return {
    rows,
    upsertCalls,
    async loadAll() {
      return [...rows.values()]
    },
    async upsert(loc) {
      upsertCalls.push(loc)
      rows.set(loc.id, loc)
    },
    async delete(id) {
      rows.delete(id)
    },
  }
}

function makeLocation(input: {
  id: string
  type: string
  providerId: string
  nodeId?: string
}): StorageLocation {
  const now = Date.now()
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: input.providerId,
    config: {},
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  }
}

/** `node-local` for `filesystem`, node-agnostic for everything else. */
function nodeLocalResolver(providerId: string): boolean | undefined {
  if (providerId === 'filesystem-storage') return true
  if (providerId === 'sftp' || providerId === 's3') return false
  return undefined // unknown provider
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('upsertLocation node-local validation', () => {
  it('defaults a node-local provider location with no nodeId to the hub', async () => {
    const svc = new StorageOrchestratorService(makeLogger(), () => [], null)
    svc.setNodeLocalResolver(nodeLocalResolver)
    const out = await svc.upsertLocation({
      id: 'recordings:disk',
      type: 'recordings',
      displayName: 'Disk',
      providerId: 'filesystem-storage',
      config: {},
      isSystem: false,
    })
    // The system seed of `*:default` locations runs through upsertLocation
    // BEFORE the backfill and is node-blind; a node-local location with no
    // explicit node defaults to the hub (single-node default) rather than
    // throwing — which would otherwise break bootstrap.
    expect(out.nodeId).toBe('hub')
  })

  it('accepts a node-local provider location when nodeId is present', () => {
    const svc = new StorageOrchestratorService(makeLogger(), () => [], null)
    svc.setNodeLocalResolver(nodeLocalResolver)
    const out = svc.upsertLocation({
      id: 'recordings:disk',
      type: 'recordings',
      displayName: 'Disk',
      providerId: 'filesystem-storage',
      config: {},
      nodeId: 'hub',
      isSystem: false,
    })
    expect(out.nodeId).toBe('hub')
  })

  it('allows an absent nodeId for a node-agnostic (remote) provider', () => {
    const svc = new StorageOrchestratorService(makeLogger(), () => [], null)
    svc.setNodeLocalResolver(nodeLocalResolver)
    const out = svc.upsertLocation({
      id: 'backups:nas',
      type: 'backups',
      displayName: 'NAS',
      providerId: 'sftp',
      config: { host: 'nas.local' },
      isSystem: false,
    })
    expect(out.nodeId).toBeUndefined()
  })

  it('allows an absent nodeId when the resolver cannot classify the provider', () => {
    const svc = new StorageOrchestratorService(makeLogger(), () => [], null)
    svc.setNodeLocalResolver(nodeLocalResolver)
    expect(() =>
      svc.upsertLocation({
        id: 'misc:thing',
        type: 'misc',
        displayName: 'Thing',
        providerId: 'unknown-provider',
        config: {},
        isSystem: false,
      }),
    ).not.toThrow()
  })

  it('carries nodeId through to the persisted row', async () => {
    const store = makeFakeStore()
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    svc.upsertLocation({
      id: 'recordings:disk',
      type: 'recordings',
      displayName: 'Disk',
      providerId: 'filesystem-storage',
      config: {},
      nodeId: 'hub',
      isSystem: false,
    })
    await flushAsync()
    expect(store.rows.get('recordings:disk')?.nodeId).toBe('hub')
  })
})

describe('backfillNodeIds', () => {
  it("stamps nodeId='hub' on a node-local location that lacks it", async () => {
    const store = makeFakeStore([
      makeLocation({
        id: 'recordings:default',
        type: 'recordings',
        providerId: 'filesystem-storage',
      }),
    ])
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    await svc.initialize()

    await svc.backfillNodeIds('hub')

    expect(svc.getLocationById('recordings:default')?.nodeId).toBe('hub')
    // persisted too
    expect(store.rows.get('recordings:default')?.nodeId).toBe('hub')
  })

  it('leaves a node-agnostic (remote) location with null nodeId untouched', async () => {
    const store = makeFakeStore([
      makeLocation({ id: 'backups:nas', type: 'backups', providerId: 'sftp' }),
    ])
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    await svc.initialize()
    // `initialize()` runs the D383 write-set migration, which stamps every
    // flagless row `enabled: true` and persists it — an upsert unrelated to
    // the backfill this test asserts on. Clear it so only backfillNodeIds's
    // own writes are visible below.
    store.upsertCalls.length = 0

    await svc.backfillNodeIds('hub')

    expect(svc.getLocationById('backups:nas')?.nodeId).toBeUndefined()
    expect(store.upsertCalls.find((c) => c.id === 'backups:nas')).toBeUndefined()
  })

  it('is idempotent — does not re-touch a location that already has a nodeId', async () => {
    const store = makeFakeStore([
      makeLocation({
        id: 'recordings:disk',
        type: 'recordings',
        providerId: 'filesystem-storage',
        nodeId: 'node-2',
      }),
    ])
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    await svc.initialize()
    // Same D383 migration noise as above — cleared before the assertion.
    store.upsertCalls.length = 0

    await svc.backfillNodeIds('hub')

    // existing nodeId preserved, never overwritten to 'hub'
    expect(svc.getLocationById('recordings:disk')?.nodeId).toBe('node-2')
    // no persist write for the already-stamped row
    expect(store.upsertCalls.find((c) => c.id === 'recordings:disk')).toBeUndefined()
  })

  it('only touches the rows missing nodeId on a mixed set', async () => {
    const store = makeFakeStore([
      makeLocation({
        id: 'recordings:default',
        type: 'recordings',
        providerId: 'filesystem-storage',
      }),
      makeLocation({
        id: 'logs:default',
        type: 'logs',
        providerId: 'filesystem-storage',
        nodeId: 'hub',
      }),
      makeLocation({ id: 'backups:nas', type: 'backups', providerId: 'sftp' }),
    ])
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    await svc.initialize()
    // `initialize()` used to emit an `isSystem` upgrade persist; that upgrade
    // is gone. Clear any incidental writes so we assert ONLY the backfill.
    store.upsertCalls.length = 0

    await svc.backfillNodeIds('hub')

    expect(svc.getLocationById('recordings:default')?.nodeId).toBe('hub') // stamped
    expect(svc.getLocationById('logs:default')?.nodeId).toBe('hub') // already set, kept
    expect(svc.getLocationById('backups:nas')?.nodeId).toBeUndefined() // remote, untouched
    // exactly one persist write — the recordings:default stamp
    expect(store.upsertCalls.map((c) => c.id)).toEqual(['recordings:default'])
  })
})
