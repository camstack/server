/**
 * The stored VeSync session follows its integration's lifecycle, driven through the real addon
 * `initialize` with only the hub, the settings store and the event bus faked:
 *   - a deleted integration forgets its session (the delete event);
 *   - a disabled one keeps it (a re-enable must not sign in again);
 *   - a reconcile drops the rows of integrations that no longer exist — the delete event is
 *     telemetry and may be lost (D8/D11), and a sign-in in flight can save after the delete.
 */
import {
  type AddonContext,
  type AppRouter,
  EventCategory,
  type EventFilter,
  type IIntegrationInstancesProvider,
  makeInMemoryRecords,
  type MigrationApiV1,
  type SystemEvent,
} from '@dominevo/types'
import { fakeAddonContext } from '@dominevo/types/testing'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { describe, expect, it } from 'vitest'
import { VeSyncProviderAddon } from '../addon.js'
import { type VeSyncStoredSession, vesyncStoredSessionsSchema } from '../vesync-session-store.js'

const ADDON = 'provider-vesync'

function none(): Promise<never> {
  return Promise.reject(new Error('not part of this test'))
}

function migrationApi(): MigrationApiV1 {
  return {
    version: 1,
    ledger: { declare: none, start: none, finish: none },
    legacyRows: { read: none, clear: none, patch: none, deleteKeys: none },
    records: {
      kind: () => ({
        get: none,
        getResolved: none,
        put: none,
        putMany: none,
        patch: none,
        delete: none,
        query: none,
        deleteWhere: none,
      }),
    },
    settings: { read: none, write: none, deleteKeys: none },
    deviceSettings: { listIds: none, read: none },
    secrets: { resolve: none, put: none, delete: none },
    integrations: { list: async () => ({ integrations: [] }), get: none },
    devices: { list: none, get: none, aliases: none, setIntegrationId: none },
    node: { localNodeId: none },
    log: { info: none, warn: none },
  }
}

interface ListedIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
}

/** A hub that runs every migration step and lists `integrations`. */
function hub(integrations: readonly ListedIntegration[]): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const metas = metasOf(op.input)
        const answer =
          op.path === 'migrations.declareOwner'
            ? {
                bootId: 'b1',
                snapshot: 'written',
                steps: metas.map((id) => ({ id, action: 'run', state: 'pending' })),
              }
            : op.path === 'migrations.startMigration'
              ? { proceed: true, state: 'pending', reason: null }
              : op.path === 'migrations.finishMigration'
                ? { status: 'applied', error: null, rowsChanged: 0 }
                : op.path === 'integrations.list'
                  ? integrations
                  : null
        if (answer === null) {
          observer.error(TRPCClientError.from(new Error(`unscripted ${op.path}`)))
          return
        }
        observer.next({ result: { data: answer } })
        observer.complete()
      })
}

function metasOf(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || !('metas' in input)) return []
  const metas: unknown = input.metas
  if (!Array.isArray(metas)) return []
  return metas.flatMap((m: unknown) =>
    typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string' ? [m.id] : [],
  )
}

function isInstancesProvider(value: unknown): value is IIntegrationInstancesProvider {
  return typeof value === 'object' && value !== null && 'setInstanceEnabled' in value
}

function row(integrationId: string): VeSyncStoredSession {
  return {
    integrationId,
    fingerprint: `fp-${integrationId}`,
    token: `tok-${integrationId}`,
    accountId: 'acct',
    countryCode: 'IT',
    region: 'EU',
    apiBaseUrl: 'https://smartapi.vesync.eu',
    authFlowUsed: 'new',
    terminalId: null,
    issuedAt: null,
    expiresAt: null,
  }
}

type Handler = (event: SystemEvent) => void

async function world(integrations: readonly ListedIntegration[], rows: VeSyncStoredSession[]) {
  let blob: Record<string, unknown> = { vesyncSessions: rows }
  const handlers: { readonly category: string; readonly handler: Handler }[] = []
  const base = fakeAddonContext({
    id: ADDON,
    migrationApi: migrationApi(),
    api: createTRPCClient<AppRouter>({ links: [hub(integrations)] }),
    settings: {
      readAddonStore: async () => blob,
      writeAddonStore: async (patch) => {
        blob = { ...blob, ...patch }
      },
    },
  })
  const ctx: AddonContext = {
    ...base,
    records: makeInMemoryRecords(ADDON).records,
    kernel: { ...base.kernel, deviceRegistry: undefined },
    eventBus: {
      ...base.eventBus,
      subscribe(filter: EventFilter, handler: Handler): () => void {
        handlers.push({ category: String(filter.category ?? ''), handler })
        return () => undefined
      },
    },
  }
  const addon = new VeSyncProviderAddon()
  const result = await addon.initialize(ctx)
  const provider = result?.providers?.map((p) => p.provider).find(isInstancesProvider)
  if (provider === undefined) throw new Error('no integration-instances provider')
  const stored = (): string[] =>
    vesyncStoredSessionsSchema.parse(blob['vesyncSessions'] ?? []).map((r) => r.integrationId)
  const emitDeleted = (integrationId: string): void => {
    for (const h of handlers) {
      if (h.category !== EventCategory.IntegrationDeleted) continue
      h.handler({
        id: 'e1',
        timestamp: new Date(),
        source: { type: 'core', id: 'hub' },
        category: EventCategory.IntegrationDeleted,
        data: { addonId: ADDON, integrationId },
      })
    }
  }
  return { provider, stored, emitDeleted }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

const HOME: ListedIntegration = { id: 'int_1', addonId: ADDON, name: 'Home', enabled: true }
const OFFICE: ListedIntegration = { id: 'int_2', addonId: ADDON, name: 'Office', enabled: false }

describe('the stored VeSync session follows its integration', () => {
  it('a reconcile drops the session of an integration that no longer exists, keeps a disabled one', async () => {
    const w = await world([HOME, OFFICE], [row('int_1'), row('int_2'), row('int_gone')])
    expect(w.stored().toSorted()).toEqual(['int_1', 'int_2'])
  })

  it('a deleted integration forgets its session', async () => {
    const w = await world([HOME], [row('int_1')])
    w.emitDeleted('int_1')
    await settle()
    expect(w.stored()).toEqual([])
  })

  it('a disabled integration keeps its session', async () => {
    const w = await world([HOME], [row('int_1')])
    await w.provider.setInstanceEnabled({ id: 'int_1', enabled: false })
    await settle()
    expect(w.stored()).toEqual(['int_1'])
  })
})
