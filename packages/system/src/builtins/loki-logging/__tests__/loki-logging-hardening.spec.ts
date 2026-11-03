/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
import { LokiDestination } from '../loki-destination.js'
import type { AddonContext, IIntegrationInstancesProvider, IScopedLogger } from '@camstack/types'
import {
  integrationInstancesCapability,
  makeInMemoryRecords,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LokiLoggingAddon, stripUserinfo } from '../loki-logging.addon.js'
import { lokiDestinationsKind } from '../loki-record-kinds.js'

/**
 * Review findings on the Loki pilot: a locked keychain changes nothing (D49), an agent boots
 * while the hub is unreachable, and the connection test sends the destination's own auth
 * without ever echoing a credential.
 */

function logger() {
  const warn = vi.fn()
  const log = {
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return { log: log as unknown as IScopedLogger, warn }
}

const SEED = {
  name: 'Loki',
  url: 'http://loki:3100',
  level: 'warn' as const,
  job: 'cam',
  extraLabels: '',
  tenantId: 't1',
  username: 'u',
  password: 'pw-secret',
  batchIntervalMs: 5000,
  batchSize: 200,
  timeoutMs: 10000,
}

interface BootOptions {
  readonly declareFails?: boolean
  readonly lockKeychain?: { locked: boolean }
}

async function boot(localNodeId: string, options: BootOptions = {}) {
  const world = makeInMemoryRecords('loki-logging')
  await world.records.declare({ destinations: lokiDestinationsKind })
  const real = world.records.kind(lokiDestinationsKind)
  await real.put({ id: 'int_0001', data: SEED }, { ifRev: 0 })
  const lock = options.lockKeychain
  const records = {
    ...world.records,
    declare: options.declareFails
      ? vi.fn(async () => {
          throw new Error('hub unreachable')
        })
      : world.records.declare,
    kind: () =>
      Object.create(real, {
        getResolved: {
          value: async (id: string) => {
            if (lock?.locked) throw new RecordSecretUnavailableError('locked')
            return real.getResolved(id)
          },
        },
      }),
  }
  const { log, warn } = logger()
  const ctx = {
    id: 'loki-logging',
    logger: log,
    records,
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({
        kind: 'value' as const,
        value: {},
      })),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId },
    api: {
      addons: {
        setCapabilityProviderEnabled: {
          mutate: vi.fn(async () => ({ success: true })),
        },
      },
      migrations: {
        declareOwner: {
          mutate: vi.fn(async () => ({
            bootId: 'b',
            snapshot: 'none',
            steps: [],
          })),
        },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
    },
  } as unknown as AddonContext
  const addon = new LokiLoggingAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  return { addon, registrations, warn }
}

function instancesOf(
  registrations: readonly { capability: { name: string }; provider: unknown }[],
): IIntegrationInstancesProvider {
  const found = registrations.find((r) => r.capability.name === integrationInstancesCapability.name)
  if (found === undefined) throw new Error('no integration-instances provider')
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the registration carries the provider the capability names
  return found.provider as IIntegrationInstancesProvider
}

describe('LokiLoggingAddon — review hardening', () => {
  const addons: LokiLoggingAddon[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise((resolve) => setTimeout(resolve, 25))
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('a locked keychain keeps the destination config and warns once', async () => {
    const lockKeychain = { locked: false }
    const { addon, registrations, warn } = await boot('hub', { lockKeychain })
    addons.push(addon)
    const reconfigure = vi.spyOn(LokiDestination.prototype, 'reconfigure')
    lockKeychain.locked = true
    const provider = instancesOf(registrations)
    await provider.updateInstance({ id: 'int_0001', values: { job: 'a' } })
    await provider.updateInstance({ id: 'int_0001', values: { job: 'b' } })
    expect(reconfigure).not.toHaveBeenCalled()
    const lockWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('keychain is locked'))
    expect(lockWarnings).toHaveLength(1)
    lockKeychain.locked = false
    await provider.updateInstance({ id: 'int_0001', values: { job: 'c' } })
    expect(reconfigure).toHaveBeenCalledTimes(1)
  })

  it('an agent boots while the hub is unreachable (declare refused)', async () => {
    const { addon, registrations, warn } = await boot('agent-1', {
      declareFails: true,
    })
    addons.push(addon)
    expect(registrations.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
  })

  it('the connection test sends the destination auth and never echoes a credential', async () => {
    const { addon, registrations } = await boot('hub')
    addons.push(addon)
    const seen: Record<string, string>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers ?? {})
        return { ok: true, status: 200 }
      }),
    )
    const provider = instancesOf(registrations)
    const ok = await provider.testInstance?.({
      id: 'int_0001',
      values: { url: 'http://loki:3100' },
    })
    expect(ok?.success).toBe(true)
    const expected = `Basic ${Buffer.from('u:pw-secret').toString('base64')}`
    expect(seen[0]).toMatchObject({
      authorization: expected,
      'X-Scope-OrgID': 't1',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED http://bob:hunter2@loki:3100/ready')
      }),
    )
    const failed = await provider.testInstance?.({
      id: null,
      values: { url: 'http://bob:hunter2@loki:3100' },
    })
    expect(failed?.error).toBeDefined()
    expect(failed?.error).not.toContain('hunter2')
    expect(failed?.error).not.toContain('bob')
  })

  it('stripUserinfo removes userinfo and the typed url credentials', () => {
    expect(stripUserinfo('x https://a:b@h/p', 'https://h')).toBe('x https://h/p')
    expect(stripUserinfo('bad password hunter2', 'http://bob:hunter2@h')).not.toContain('hunter2')
  })
})
