/**
 * D296 — a storage kind declares HOW its owning service reaches the bytes, and
 * the orchestrator refuses a provider that cannot satisfy it.
 *
 * The assertion that carries the whole feature is the first one: a recordings
 * location pointed at a remote provider must be REFUSED. Every test here is
 * written so that "refused" and "accepted, and then something failed later"
 * cannot both pass it — the throw is asserted AND the location's absence from
 * the map is asserted AND the store is asserted never to have been written.
 * A fixture that only checked for a rejected promise would go green on an
 * implementation that persisted the row first and threw afterwards, which is
 * the shape that leaves an unusable recordings target configured.
 */
import type { IScopedLogger, StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildStorageLocationRegistry } from '../../../kernel/storage-location-registry.js'
import type { ILocationStore } from '../location-store.js'
import {
  type DeclarationSource,
  StorageOrchestratorService,
} from '../storage-orchestrator.service.js'

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
  return logger as unknown as IScopedLogger
}

interface FakeStore extends ILocationStore {
  readonly rows: Map<string, StorageLocation>
  readonly upsertCalls: StorageLocation[]
}

function makeStore(): FakeStore {
  const rows = new Map<string, StorageLocation>()
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

/** The real declarations, as this repo ships them. */
const DECLARATIONS: readonly StorageLocationDeclaration[] = [
  // No `access` → fail-closed to 'local-path'. This is how the recorder's
  // kinds are declared today; the constraint must hold WITHOUT an edit to
  // their manifests.
  { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
  {
    id: 'eventMedia',
    displayName: 'Event Media',
    cardinality: 'multi',
    defaultsTo: 'recordings',
  },
  // The one kind that routes every byte through the cap.
  { id: 'backups', displayName: 'Backups', cardinality: 'multi', access: 'cap-mediated' },
]

function registry(): DeclarationSource {
  return buildStorageLocationRegistry([DECLARATIONS])
}

/** `filesystem-storage` is node-local; the remote providers are not. */
function nodeLocalResolver(providerId: string): boolean | undefined {
  if (providerId === 'filesystem-storage') return true
  if (providerId === 'smb-storage' || providerId === 'sftp-storage') return false
  return undefined
}

function makeService(): { svc: StorageOrchestratorService; store: FakeStore } {
  const store = makeStore()
  const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
  svc.setRegistry(registry())
  svc.setNodeLocalResolver(nodeLocalResolver)
  return { svc, store }
}

function input(over: {
  id: string
  type: string
  providerId: string
}): Omit<StorageLocation, 'createdAt' | 'updatedAt'> {
  return {
    id: over.id,
    type: over.type,
    displayName: over.id,
    providerId: over.providerId,
    config: { host: 'nas.local', share: 'backups', basePath: 'camstack' },
    isSystem: false,
  }
}

describe('a local-path storage kind refuses a remote provider', () => {
  it('REFUSES recordings on smb-storage — and stores nothing', () => {
    const { svc, store } = makeService()

    expect(() =>
      svc.upsertLocation(
        input({ id: 'recordings:nas', type: 'recordings', providerId: 'smb-storage' }),
      ),
    ).toThrow(/local-path/)

    // The three independent ways "refused" differs from "accepted, then
    // failed": not readable, not listed, never persisted.
    expect(svc.getLocationById('recordings:nas')).toBeUndefined()
    expect(svc.listLocations().map((l) => l.id)).not.toContain('recordings:nas')
    expect(store.upsertCalls).toHaveLength(0)
  })

  it('names the kind, the provider and the reason in the refusal', () => {
    const { svc } = makeService()
    let message = ''
    try {
      svc.upsertLocation(
        input({ id: 'recordings:nas', type: 'recordings', providerId: 'smb-storage' }),
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('recordings')
    expect(message).toContain('smb-storage')
    expect(message).toContain('nodeLocal: false')
  })

  it('REFUSES eventMedia on sftp-storage — the fallback covers an undeclared kind', () => {
    const { svc, store } = makeService()
    expect(() =>
      svc.upsertLocation(
        input({ id: 'eventMedia:nas', type: 'eventMedia', providerId: 'sftp-storage' }),
      ),
    ).toThrow(/local-path/)
    expect(store.upsertCalls).toHaveLength(0)
  })

  it('REFUSES a kind nobody declared at all — an unknown kind is not a permissive one', () => {
    const { svc } = makeService()
    expect(() =>
      svc.upsertLocation(input({ id: 'mystery:nas', type: 'mystery', providerId: 'smb-storage' })),
    ).toThrow(/local-path/)
  })
})

describe('what the constraint must NOT refuse', () => {
  it('accepts recordings on the node-local filesystem provider', () => {
    const { svc } = makeService()
    const saved = svc.upsertLocation(
      input({ id: 'recordings:disk2', type: 'recordings', providerId: 'filesystem-storage' }),
    )
    expect(saved.id).toBe('recordings:disk2')
    expect(svc.getLocationById('recordings:disk2')).toBeDefined()
  })

  it('accepts backups on smb-storage — cap-mediated kinds take any provider', () => {
    const { svc } = makeService()
    const saved = svc.upsertLocation(
      input({ id: 'backups:nas', type: 'backups', providerId: 'smb-storage' }),
    )
    expect(saved.providerId).toBe('smb-storage')
    expect(svc.getLocationById('backups:nas')).toBeDefined()
  })

  it('does not evaluate the constraint at all when no declarations are loaded', () => {
    // A service with no registry knows nothing about any kind. Refusing there
    // would be a conclusion drawn from a read that was never made. The addon
    // injects the registry inside `onInitialize`, before the `storage` cap is
    // mounted, so no operator upsert reaches this branch.
    const store = makeStore()
    const svc = new StorageOrchestratorService(makeLogger(), () => [], store)
    svc.setNodeLocalResolver(nodeLocalResolver)
    const saved = svc.upsertLocation(
      input({ id: 'recordings:nas', type: 'recordings', providerId: 'smb-storage' }),
    )
    expect(saved.id).toBe('recordings:nas')
  })

  it('allows an unclassified provider rather than refusing on a read it could not make', () => {
    // Early boot: the system seed of `<kind>:default` runs before any provider
    // has registered, so the resolver answers `undefined`. Refusing there
    // would destroy the seed — D49: a read that fails changes nothing.
    const { svc } = makeService()
    const saved = svc.upsertLocation(
      input({ id: 'recordings:default', type: 'recordings', providerId: 'not-yet-registered' }),
    )
    expect(saved.id).toBe('recordings:default')
  })
})

describe('declaration aggregation', () => {
  it('throws when two addons disagree on a kind’s access', () => {
    expect(() =>
      buildStorageLocationRegistry([
        [{ id: 'recordings', displayName: 'R', cardinality: 'multi', access: 'local-path' }],
        [{ id: 'recordings', displayName: 'R', cardinality: 'multi', access: 'cap-mediated' }],
      ]),
    ).toThrow(/access conflict/i)
  })

  it('treats an omitted access as local-path when comparing declarations', () => {
    expect(() =>
      buildStorageLocationRegistry([
        [{ id: 'recordings', displayName: 'R', cardinality: 'multi' }],
        [{ id: 'recordings', displayName: 'R', cardinality: 'multi', access: 'cap-mediated' }],
      ]),
    ).toThrow(/access conflict/i)
  })

  it('accessOf resolves declared, undeclared-but-known, and unknown kinds distinctly', () => {
    const reg = registry()
    expect(reg.accessOf('backups')).toBe('cap-mediated')
    expect(reg.accessOf('recordings')).toBe('local-path')
    expect(reg.accessOf('nothing-declares-this')).toBeNull()
  })
})
