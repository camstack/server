/**
 * Node-aware provider ROUTING for the `storage-orchestrator` builtin.
 *
 * Sibling of `storage-orchestrator-node-aware.spec.ts`, which covers the
 * *authoring* half (`upsertLocation` stamps a `nodeId`, `backfillNodeIds`
 * migrates legacy rows). This file covers the *dispatch* half: given a
 * location that carries a `nodeId`, which `storage-provider` actually
 * executes the I/O.
 *
 * The bug being pinned: `providerId` alone cannot discriminate — every
 * node's FilesystemStorageProvider registers as the SAME providerId — so a
 * location created for an agent used to run its write / read / resolve
 * against the HUB's filesystem. The two rules asserted here:
 *   1. a location pinned to another node resolves THAT node's provider,
 *      and the local provider list is never consulted;
 *   2. an unreachable target node FAILS LOUDLY (logged + thrown) and never
 *      silently degrades to this node's disk.
 *
 * Chunked sessions get the same treatment: `beginUpload` on an agent
 * location must pin every later `writeChunk` / `finalizeUpload` to that
 * agent (the session id means nothing on the hub's provider).
 */

import type {
  IScopedLogger,
  IStorageProviderImpl,
  StorageLocation,
  StorageProviderInfoSchema,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

type ProviderInfo = z.infer<typeof StorageProviderInfoSchema>

interface FakeLogger extends IScopedLogger {
  readonly errorMock: ReturnType<typeof vi.fn>
}

function makeLogger(): FakeLogger {
  const errorMock = vi.fn()
  const logger: FakeLogger = {
    errorMock,
    error: errorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  return logger
}

interface FakeProvider extends IStorageProviderImpl {
  /** Identity marker so a test can assert WHICH provider ran the call. */
  readonly tag: string
}

/**
 * `filesystem-storage` on purpose: every node's filesystem provider shares
 * the providerId, which is exactly why `providerId` alone cannot route.
 */
function makeFakeProvider(tag: string, providerId = 'filesystem-storage'): FakeProvider {
  return {
    tag,
    getProviderInfo: vi.fn(
      async (): Promise<ProviderInfo> => ({
        providerId,
        displayName: `Fake ${tag}`,
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: false,
        minFreePercent: null,
      }),
    ),
    testLocation: vi.fn(async () => ({ ok: true })),
    resolve: vi.fn(async () => `/${tag}`),
    write: vi.fn(async () => undefined),
    read: vi.fn(async () => new Uint8Array()),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => [] as readonly string[]),
    delete: vi.fn(async () => undefined),
    getAvailableSpace: vi.fn(async () => null),
    beginUpload: vi.fn(async () => ({ uploadId: 'u-1' })),
    writeChunk: vi.fn(async () => undefined),
    finalizeUpload: vi.fn(async () => undefined),
    abortUpload: vi.fn(async () => undefined),
    beginDownload: vi.fn(async () => ({ downloadId: 'd-1', sizeBytes: 0 })),
    readChunk: vi.fn(async () => new Uint8Array()),
    endDownload: vi.fn(async () => undefined),
  }
}

function makeLocation(input: {
  readonly id: string
  readonly providerId?: string
  readonly nodeId?: string
}): StorageLocation {
  return {
    id: input.id,
    type: 'recordings',
    displayName: input.id,
    providerId: input.providerId ?? 'filesystem-storage',
    config: {},
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    isSystem: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

interface Harness {
  readonly service: StorageOrchestratorService
  readonly logger: FakeLogger
  readonly local: FakeProvider
  readonly remoteByNode: Map<string, FakeProvider>
  readonly remoteLookups: string[]
}

function makeHarness(opts?: {
  readonly localNodeId?: string
  readonly remoteNodes?: readonly string[]
  /** Omit the cross-node resolver entirely (a node that cannot route). */
  readonly withoutRemoteResolver?: boolean
}): Harness {
  const logger = makeLogger()
  const local = makeFakeProvider('local')
  const remoteByNode = new Map<string, FakeProvider>(
    (opts?.remoteNodes ?? []).map((n) => [n, makeFakeProvider(`remote:${n}`)]),
  )
  const remoteLookups: string[] = []
  const resolveRemote = (nodeId: string): IStorageProviderImpl | null => {
    remoteLookups.push(nodeId)
    return remoteByNode.get(nodeId) ?? null
  }
  const service = new StorageOrchestratorService(
    logger,
    () => [local],
    null,
    opts?.localNodeId ?? 'hub',
    opts?.withoutRemoteResolver ? undefined : resolveRemote,
  )
  return { service, logger, local, remoteByNode, remoteLookups }
}

describe('getProviderFor — node routing', () => {
  it('resolves a hub-local location against the local provider list', async () => {
    const h = makeHarness()
    const p = await h.service.getProviderFor(makeLocation({ id: 'recordings:disk', nodeId: 'hub' }))
    expect(p).toBe(h.local)
    expect(h.remoteLookups).toEqual([])
  })

  it('resolves a location with NO nodeId locally (node-agnostic provider)', async () => {
    const h = makeHarness()
    const p = await h.service.getProviderFor(makeLocation({ id: 'backups:nas' }))
    expect(p).toBe(h.local)
    expect(h.remoteLookups).toEqual([])
  })

  it("routes an agent location to THAT node's provider, never the local list", async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    const p = await h.service.getProviderFor(
      makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' }),
    )
    expect(p).toBe(h.remoteByNode.get('agent-1'))
    expect(h.remoteLookups).toEqual(['agent-1'])
    // The hub's own provider must not even be probed — the bug was that it
    // matched on providerId and executed the I/O here.
    expect(h.local.getProviderInfo).not.toHaveBeenCalled()
  })

  it('picks the provider of the RIGHT agent when several nodes are reachable', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1', 'agent-2'] })
    const p = await h.service.getProviderFor(
      makeLocation({ id: 'recordings:two', nodeId: 'agent-2' }),
    )
    expect(p).toBe(h.remoteByNode.get('agent-2'))
  })

  it('is symmetric — running ON an agent, that agent’s locations are local', async () => {
    const h = makeHarness({ localNodeId: 'agent-1', remoteNodes: ['hub'] })
    const own = await h.service.getProviderFor(
      makeLocation({ id: 'recordings:own', nodeId: 'agent-1' }),
    )
    expect(own).toBe(h.local)
    const hub = await h.service.getProviderFor(
      makeLocation({ id: 'recordings:hub', nodeId: 'hub' }),
    )
    expect(hub).toBe(h.remoteByNode.get('hub'))
  })

  it('treats a forked-child node id (`hub/child`) as the bare node', async () => {
    const h = makeHarness({ localNodeId: 'hub/storage-orchestrator', remoteNodes: ['agent-1'] })
    const p = await h.service.getProviderFor(makeLocation({ id: 'recordings:disk', nodeId: 'hub' }))
    expect(p).toBe(h.local)
    expect(h.remoteLookups).toEqual([])
  })

  it('FAILS LOUDLY when the target node is unreachable — no hub fallback', async () => {
    const h = makeHarness({ remoteNodes: [] })
    const loc = makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-offline' })
    await expect(h.service.getProviderFor(loc)).rejects.toThrow(/agent-offline/)
    // never silently executed against this node's filesystem
    expect(h.local.getProviderInfo).not.toHaveBeenCalled()
    expect(h.logger.errorMock).toHaveBeenCalledTimes(1)
    const [message, extras] = h.logger.errorMock.mock.calls[0] ?? []
    expect(String(message)).toMatch(/storage/i)
    const meta: Record<string, unknown> = (extras as { meta?: Record<string, unknown> })?.meta ?? {}
    expect(meta['nodeId']).toBe('agent-offline')
    expect(meta['locationId']).toBe('recordings:agent-disk')
  })

  it('FAILS LOUDLY when no cross-node resolver is wired at all', async () => {
    const h = makeHarness({ withoutRemoteResolver: true })
    await expect(
      h.service.getProviderFor(makeLocation({ id: 'recordings:x', nodeId: 'agent-1' })),
    ).rejects.toThrow(/agent-1/)
    expect(h.local.getProviderInfo).not.toHaveBeenCalled()
    expect(h.logger.errorMock).toHaveBeenCalledTimes(1)
  })

  it('logs when no LOCAL provider matches the providerId', async () => {
    const h = makeHarness()
    await expect(
      h.service.getProviderFor(makeLocation({ id: 'backups:nas', providerId: 'sftp' })),
    ).rejects.toThrow(/sftp/)
    expect(h.logger.errorMock).toHaveBeenCalledTimes(1)
    const [, extras] = h.logger.errorMock.mock.calls[0] ?? []
    const meta: Record<string, unknown> = (extras as { meta?: Record<string, unknown> })?.meta ?? {}
    expect(meta['providerId']).toBe('sftp')
    expect(meta['locationId']).toBe('backups:nas')
  })
})

describe('chunked sessions follow the location’s node', () => {
  it('routes writeChunk/finalize to the node that opened the upload', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    const loc = makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' })

    h.service.rememberSession('upload', 'up-42', loc)
    const p = await h.service.getProviderForSession('upload', 'up-42')

    expect(p).toBe(h.remoteByNode.get('agent-1'))
    expect(h.local.getProviderInfo).not.toHaveBeenCalled()
  })

  it('routes readChunk/end to the node that opened the download', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    h.service.rememberSession(
      'download',
      'dl-7',
      makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' }),
    )
    const p = await h.service.getProviderForSession('download', 'dl-7')
    expect(p).toBe(h.remoteByNode.get('agent-1'))
  })

  it('keeps hub-local sessions on the local provider', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    h.service.rememberSession(
      'upload',
      'up-hub',
      makeLocation({ id: 'recordings:disk', nodeId: 'hub' }),
    )
    const p = await h.service.getProviderForSession('upload', 'up-hub')
    expect(p).toBe(h.local)
    expect(h.remoteLookups).toEqual([])
  })

  it('keeps upload and download id spaces separate', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    h.service.rememberSession(
      'upload',
      'same-id',
      makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' }),
    )
    await expect(h.service.getProviderForSession('download', 'same-id')).rejects.toThrow(
      /downloadId "same-id"/,
    )
  })

  it('rejects an unknown session id with an actionable message', async () => {
    const h = makeHarness()
    await expect(h.service.getProviderForSession('upload', 'ghost')).rejects.toThrow(
      /Unknown uploadId "ghost"/,
    )
  })

  it('forgets a session once it is finalized', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    const loc = makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' })
    h.service.rememberSession('upload', 'up-1', loc)
    h.service.forgetSession('upload', 'up-1')
    await expect(h.service.getProviderForSession('upload', 'up-1')).rejects.toThrow(/Unknown/)
  })

  it('clearSessions drops every tracked session (addon shutdown)', async () => {
    const h = makeHarness({ remoteNodes: ['agent-1'] })
    const loc = makeLocation({ id: 'recordings:agent-disk', nodeId: 'agent-1' })
    h.service.rememberSession('upload', 'up-1', loc)
    h.service.rememberSession('download', 'dl-1', loc)
    h.service.clearSessions()
    await expect(h.service.getProviderForSession('upload', 'up-1')).rejects.toThrow(/Unknown/)
    await expect(h.service.getProviderForSession('download', 'dl-1')).rejects.toThrow(/Unknown/)
  })
})
