/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import type { AddonContext, IScopedLogger, MigrationMeta } from '@camstack/types'
import { makeInMemoryRecords } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LokiLoggingAddon } from '../loki-logging.addon.js'
import { lokiDestinationsKind } from '../loki-record-kinds.js'
import { REGISTRY_TOGGLE_TO_RECORD_ID } from '../migrations/index.js'
import { RETIREMENT_MARKER_KEY } from '../retire-enabled-flag.js'

/**
 * The id SHAPES the hub really hands out: a hub-resident addon's `ctx.id` is `addon:loki-logging`
 * (addon-registry.service), while `listCapabilityProviders` and `setCapabilityProviderEnabled`
 * speak the bare manifest id `loki-logging`. A fake that supplies the bare id on both sides hid it.
 */
const CTX_ID = 'addon:loki-logging'
const BARE_ID = 'loki-logging'

function logger(): IScopedLogger & { info: ReturnType<typeof vi.fn> } {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger & { info: ReturnType<typeof vi.fn> }
}

interface Options {
  readonly registry: 'active' | 'inactive' | 'unregistered'
  readonly stored?: Record<string, unknown>
}

async function boot(options: Options) {
  const world = makeInMemoryRecords('loki-logging')
  await world.records.declare({ destinations: lokiDestinationsKind })
  const handle = world.records.kind(lokiDestinationsKind)
  await handle.put(
    {
      id: 'int_0001',
      data: {
        name: 'Loki',
        url: 'http://loki:3100',
        level: 'warn',
        job: 'cam',
        extraLabels: '',
        tenantId: '',
        username: '',
        batchIntervalMs: 5000,
        batchSize: 200,
        timeoutMs: 10000,
      },
    },
    { ifRev: 0 },
  )
  let store: Record<string, unknown> = { ...options.stored }
  const offered: string[][] = []
  const finished: { id: string; kind: string }[] = []
  const enabledCalls: { addonId: string; enabled: boolean }[] = []
  const log = logger()
  const ctx = {
    id: CTX_ID,
    logger: log,
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({ ...store })),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: { ...store } })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        store = JSON.parse(JSON.stringify({ ...store, ...patch })) as Record<string, unknown>
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      addons: {
        listCapabilityProviders: {
          query: vi.fn(async () =>
            options.registry === 'unregistered'
              ? []
              : [{ addonId: BARE_ID, isActive: options.registry === 'active' }],
          ),
        },
        setCapabilityProviderEnabled: {
          mutate: vi.fn(async (input: { addonId: string; enabled: boolean }) => {
            if (input.addonId !== BARE_ID) {
              throw new Error(`Provider "${input.addonId}" is not registered for "log-destination"`)
            }
            enabledCalls.push({ addonId: input.addonId, enabled: input.enabled })
            return { success: true }
          }),
        },
      },
      integrations: {
        getByAddonId: { query: vi.fn(async () => ({ id: 'int_0001' })) },
      },
      migrations: {
        declareOwner: {
          mutate: vi.fn(async (input: { metas: readonly MigrationMeta[] }) => {
            offered.push(input.metas.map((m) => m.id))
            return {
              bootId: 'b',
              snapshot: 'none',
              // seq 1 and 2 are already applied; only the registry toggle is pending.
              steps: input.metas.map((m) => ({
                id: m.id,
                action: m.id === REGISTRY_TOGGLE_TO_RECORD_ID ? 'run' : 'skip',
                state: 'pending',
              })),
            }
          }),
        },
        startMigration: {
          mutate: vi.fn(async () => ({ proceed: true, state: 'pending', reason: null })),
        },
        finishMigration: {
          mutate: vi.fn(async (input: { id: string; result: { kind: string } }) => {
            finished.push({ id: input.id, kind: input.result.kind })
            return input.result.kind === 'failed'
              ? { status: 'failed', error: 'x' }
              : { status: 'applied', rowsChanged: 0 }
          }),
        },
      },
    },
  } as unknown as AddonContext
  const addon = new LokiLoggingAddon()
  await addon.initialize(ctx)
  return { addon, handle, offered, finished, enabledCalls, log, getStore: () => store }
}

describe('LokiLoggingAddon — the registry id is the bare manifest id', () => {
  const addons: LokiLoggingAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('does not offer the registry-toggle migration before the provider is registered', async () => {
    const w = await boot({ registry: 'active', stored: { [RETIREMENT_MARKER_KEY]: true } })
    addons.push(w.addon)
    expect(w.offered).toHaveLength(1)
    expect(w.offered[0]).not.toContain(REGISTRY_TOGGLE_TO_RECORD_ID)
    expect(w.finished.find((f) => f.id === REGISTRY_TOGGLE_TO_RECORD_ID)).toBeUndefined()
  })

  it('an ACTIVE provider seen under the bare id after registration is already-done, not a failure', async () => {
    const w = await boot({ registry: 'active', stored: { [RETIREMENT_MARKER_KEY]: true } })
    addons.push(w.addon)
    w.addon.postBrokerStart()
    await vi.waitFor(() =>
      expect(w.finished).toContainEqual({ id: REGISTRY_TOGGLE_TO_RECORD_ID, kind: 'procedure' }),
    )
    expect(w.enabledCalls).toEqual([])
    expect((await w.handle.get('int_0001'))?.data.enabled).toBeUndefined()
  })

  it('an INACTIVE provider is carried to the record and re-enabled under the bare id', async () => {
    const w = await boot({ registry: 'inactive', stored: { [RETIREMENT_MARKER_KEY]: true } })
    addons.push(w.addon)
    w.addon.postBrokerStart()
    await vi.waitFor(() => expect(w.enabledCalls).toEqual([{ addonId: BARE_ID, enabled: true }]))
    expect((await w.handle.get('int_0001'))?.data.enabled).toBe(false)
  })

  it('an UNREGISTERED provider after registration is a real fault and fails', async () => {
    const w = await boot({ registry: 'unregistered', stored: { [RETIREMENT_MARKER_KEY]: true } })
    addons.push(w.addon)
    w.addon.postBrokerStart()
    await vi.waitFor(() =>
      expect(w.finished).toContainEqual({ id: REGISTRY_TOGGLE_TO_RECORD_ID, kind: 'failed' }),
    )
  })
})

describe('LokiLoggingAddon — the retired enabled flag disables nothing (D777)', () => {
  const addons: LokiLoggingAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('a stored enabled:false is stripped, the marker set, and the record stays enabled', async () => {
    const w = await boot({ registry: 'active', stored: { enabled: false } })
    addons.push(w.addon)
    await vi.waitFor(() => expect(w.getStore()[RETIREMENT_MARKER_KEY]).toBe(true))
    expect('enabled' in w.getStore()).toBe(false)
    expect((await w.handle.get('int_0001'))?.data.enabled).toBeUndefined()
    expect(w.enabledCalls).toEqual([])
    expect(w.log.info).toHaveBeenCalledWith(expect.stringContaining('enabled: false'))
  })
})
