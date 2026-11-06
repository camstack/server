import type { Integration, IntegrationTestConnectionResult } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * Pre-creation credential validation for EVERY integration (D1016).
 *
 * The one test is `integration-instances.testInstance`; there is no second cap and no
 * `integrations.testConnection`. The contract these tests pin:
 *   - the test is DECLARED BY THE ADDON's instances (`describe().canTest`), never inferred
 *     from the shape of the settings;
 *   - `create` refuses when the instance REJECTED the settings;
 *   - "could not be validated" is a DIFFERENT answer from "validated", and from "rejected" — an
 *     unrunnable test never reports a failure it did not observe, and never silently passes
 *     for one it did not run;
 *   - `getAvailableTypes().canTest` follows `describe().canTest` per kind.
 */

const ADDON_ID = 'provider-fake-cloud'

// The fake provider behaves like a REAL one: exactly one credential set is
// accepted. A fake that returns `{outcome:'validated'}` unconditionally would
// make any gate look correct while gating on nothing.
const GOOD = { email: 'operator@example.com', password: 'correct-horse', region: 'us' } as const
const BAD = { email: 'operator@example.com', password: 'wrong-password', region: 'us' } as const

function makeIntegration(id = 'int_0099'): Integration {
  return {
    id,
    addonId: ADDON_ID,
    name: 'Fake Cloud',
    enabled: true,
    info: null,
    settings: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Integration
}

function makeIntegrationRegistry() {
  return {
    getIntegration: vi.fn(async () => makeIntegration()),
    deleteIntegration: vi.fn(),
    listIntegrations: vi.fn(async () => []),
    createIntegration: vi.fn(async () => makeIntegration()),
    updateIntegration: vi.fn(),
    getIntegrationByAddonId: vi.fn(),
  }
}

/** An instances provider whose test signs in for real (well, realistically). */
function makeInstances(opts: { canTest: boolean; mode?: 'real' | 'throws' }) {
  return {
    describe: vi.fn(async () => ({
      instanceMode: 'multiple',
      kind: 'account',
      canTest: opts.canTest,
    })),
    createInstance: vi.fn(async (input: { id: string }) => ({ id: input.id })),
    updateInstance: vi.fn(async () => ({ ok: true as const })),
    deleteInstance: vi.fn(async () => ({ ok: true as const })),
    getInstance: vi.fn(async () => null),
    listInstances: vi.fn(async () => []),
    testInstance: vi.fn(
      async ({
        values,
      }: {
        id: string | null
        values: Record<string, unknown>
      }): Promise<IntegrationTestConnectionResult> => {
        if (opts.mode === 'throws') throw new Error('socket hang up')
        if (values['password'] === GOOD.password && values['email'] === GOOD.email) {
          return { success: true, status: 'validated', latencyMs: 42 }
        }
        return {
          success: false,
          status: 'rejected',
          error: 'Fake Cloud rejected these credentials',
        }
      },
    ),
  }
}

interface HarnessOptions {
  /** Register an `integration-instances` provider for ADDON_ID. */
  readonly instances?: unknown
}

function makeHarness(opts: HarnessOptions = {}) {
  const integrationReg = makeIntegrationRegistry()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const addonReg = {
    getIntegrationRegistry: vi.fn(() => integrationReg),
    listAddons: vi.fn(() => [
      {
        manifest: { id: ADDON_ID, name: 'Fake Cloud', capabilities: [{ name: 'device-adoption' }] },
        declaration: undefined,
        process: { state: 'running' },
      },
    ]),
    restartAddon: vi.fn(async () => undefined),
    getCapabilityRegistry: vi.fn(() => ({
      getProviderByAddon: vi.fn((cap: string, addonId: string) =>
        cap === 'integration-instances' && addonId === ADDON_ID ? (opts.instances ?? null) : null,
      ),
      getSingleton: vi.fn(() => null),
    })),
  }
  const provider = buildIntegrationsProvider(
    addonReg as never,
    { emit: vi.fn() } as never,
    { createLogger: vi.fn(() => log) } as never,
    null,
  )
  return { provider, integrationReg, log }
}

describe('integrations.create is GATED on the instance test', () => {
  let h: ReturnType<typeof makeHarness>

  beforeEach(() => {
    h = makeHarness({ instances: makeInstances({ canTest: true }) })
  })

  it('REFUSES to create when the provider rejected the credentials', async () => {
    await expect(
      h.provider.create({ addonId: ADDON_ID, name: 'Dreo bad', settings: { ...BAD } }),
    ).rejects.toThrow(/rejected these credentials/)

    expect(h.integrationReg.createIntegration).not.toHaveBeenCalled()
    // The refusal is LOGGED, tagged with the addon (CLAUDE.md logging rule).
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected'),
      expect.objectContaining({ tags: expect.objectContaining({ addonId: ADDON_ID }) }),
    )
  })

  it('CREATES when the provider validated the credentials', async () => {
    const created = await h.provider.create({
      addonId: ADDON_ID,
      name: 'Dreo good',
      settings: { ...GOOD },
    })

    expect(created.id).toBe('int_0099')
    expect(h.integrationReg.createIntegration).toHaveBeenCalledOnce()
  })

  it('CREATES — and says so — when no test is declared', async () => {
    const bare = makeHarness({ instances: makeInstances({ canTest: false }) })

    await bare.provider.create({ addonId: ADDON_ID, name: 'Untestable', settings: { ...BAD } })

    expect(bare.integrationReg.createIntegration).toHaveBeenCalledOnce()
    // Silence would read as "validated". A create that could not be validated
    // must say so.
    expect(bare.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/not validated|unsupported|without validation/i),
      expect.objectContaining({ tags: expect.objectContaining({ addonId: ADDON_ID }) }),
    )
  })

  it('CREATES when a declared test could not complete — a timeout is not a refusal', async () => {
    const flaky = makeHarness({ instances: makeInstances({ canTest: true, mode: 'throws' }) })

    await flaky.provider.create({ addonId: ADDON_ID, name: 'Flaky', settings: { ...GOOD } })

    expect(flaky.integrationReg.createIntegration).toHaveBeenCalledOnce()
  })
})

describe('integrations.getAvailableTypes().canTest follows describe().canTest per kind', () => {
  it('is true for an instance kind that declares a test', async () => {
    const h = makeHarness({ instances: makeInstances({ canTest: true }) })
    expect((await h.provider.getAvailableTypes())[0]).toMatchObject({
      addonId: ADDON_ID,
      canTest: true,
    })
  })

  it('is false for an instance kind that declares none', async () => {
    const h = makeHarness({ instances: makeInstances({ canTest: false }) })
    expect((await h.provider.getAvailableTypes())[0]).toMatchObject({
      addonId: ADDON_ID,
      canTest: false,
    })
  })

  it('is false for an addon with no instances provider (a registered probe elsewhere changes nothing)', async () => {
    const h = makeHarness()
    expect((await h.provider.getAvailableTypes())[0]).toMatchObject({
      addonId: ADDON_ID,
      canTest: false,
    })
  })
})

describe('integrations.create over a settings blob that NAMES a broker', () => {
  it('tests the broker through integration-instances.testInstance by id', async () => {
    const instances = makeInstances({ canTest: false })
    instances.testInstance.mockResolvedValueOnce({ success: false, error: 'bridge unreachable' })
    const h = makeHarness({ instances })

    await expect(
      h.provider.create({ addonId: ADDON_ID, name: 'Broker', settings: { brokerId: 'brk_1' } }),
    ).rejects.toThrow(/bridge unreachable/)

    expect(instances.testInstance).toHaveBeenCalledWith({ id: 'brk_1', values: {} })
    expect(h.integrationReg.createIntegration).not.toHaveBeenCalled()
  })
})
