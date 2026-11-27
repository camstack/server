/**
 * `node-removal-hook` implementer (#265): forgetting a node DISABLES the storage
 * locations that live on it — never removes them. The bytes and the index stay;
 * the operator deletes the rows by hand later.
 */
import { resolveLocationMode, type IScopedLogger, type StorageLocation } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ILocationStore } from '../location-store.js'
import { createNodeRemovalHook } from '../node-removal.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  // Documented type boundary: the hook reaches only these.
  return logger as unknown as IScopedLogger
}

type LocationInput = Omit<StorageLocation, 'createdAt' | 'updatedAt'>

function loc(id: string, nodeId: string | undefined, type = 'recordings'): LocationInput {
  return {
    id,
    type,
    displayName: id,
    providerId: 'fake-fs',
    config: {},
    isSystem: false,
    ...(nodeId !== undefined ? { nodeId } : {}),
  }
}

function setup() {
  const logger = makeLogger()
  const persisted = new Map<string, StorageLocation>()
  const store: ILocationStore = {
    loadAll: async () => [...persisted.values()],
    upsert: async (row) => {
      persisted.set(row.id, row)
    },
    delete: async (id) => {
      persisted.delete(id)
    },
  }
  const service = new StorageOrchestratorService(logger, () => [], store, 'hub')
  // Two recordings locations per node so no type is ever left without a write target.
  service.upsertLocation({ ...loc('rec-hub', 'hub'), mode: 'active' })
  service.upsertLocation({ ...loc('rec-agent-a', 'agent-a'), mode: 'active' })
  service.upsertLocation({ ...loc('ev-agent-a', 'agent-a', 'event-media'), mode: 'active' })
  service.upsertLocation({ ...loc('rec-agent-b', 'agent-b'), mode: 'active' })
  service.upsertLocation({ ...loc('s3-anywhere', undefined, 'backups'), mode: 'active' })
  const hook = createNodeRemovalHook({ service, logger })
  const mode = (id: string) => resolveLocationMode(service.getLocationById(id)!)
  return { service, hook, logger, mode, persisted }
}

describe('storage-orchestrator node-removal-hook', () => {
  it('disables every location of the forgotten node and leaves the others active', async () => {
    const { hook, mode, service, persisted } = setup()
    const result = await hook.onNodeRemoved({ nodeId: 'agent-a', removedAt: 1 })
    expect(mode('rec-agent-a')).toBe('disabled')
    expect(mode('ev-agent-a')).toBe('disabled')
    expect(mode('rec-hub')).toBe('active')
    expect(mode('rec-agent-b')).toBe('active')
    expect(mode('s3-anywhere')).toBe('active')
    expect(result).toEqual({ counts: { 'storage-locations': 2 } })
    // Never removed: data and index stay.
    expect(service.getLocationById('rec-agent-a')).toBeDefined()
    expect(resolveLocationMode(persisted.get('rec-agent-a')!)).toBe('disabled')
  })

  it('disables even the last write target of a type — a forgotten node cannot serve it', async () => {
    const { hook, mode } = setup()
    await hook.onNodeRemoved({ nodeId: 'agent-a', removedAt: 1 })
    expect(mode('ev-agent-a')).toBe('disabled')
  })

  it('is idempotent: a second call changes nothing and answers zero', async () => {
    const { hook, logger } = setup()
    await hook.onNodeRemoved({ nodeId: 'agent-a', removedAt: 1 })
    const infoCalls = vi.mocked(logger.info).mock.calls.length
    const second = await hook.onNodeRemoved({ nodeId: 'agent-a', removedAt: 1 })
    expect(second).toEqual({ counts: { 'storage-locations': 0 } })
    expect(vi.mocked(logger.info).mock.calls.length).toBe(infoCalls)
  })

  it('logs every disabled location with its id and node', async () => {
    const { hook, logger } = setup()
    await hook.onNodeRemoved({ nodeId: 'agent-a', removedAt: 1 })
    const metas = vi.mocked(logger.info).mock.calls.map((c) => c[1])
    expect(metas).toContainEqual({ meta: { nodeId: 'agent-a', locationId: 'rec-agent-a' } })
    expect(metas).toContainEqual({ meta: { nodeId: 'agent-a', locationId: 'ev-agent-a' } })
  })
})
