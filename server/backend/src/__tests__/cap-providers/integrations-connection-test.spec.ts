import type { Integration } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationsProvider } from '../../api/core/cap-providers'

/**
 * Pre-creation credential validation for EVERY integration.
 *
 * The defect this pins: `integrations.testConnection` had a broker branch and
 * then a DEFAULT branch that probed `settings.main_stream_url ?? settings.url`.
 * Every account-based integration (Dreo, Dreame, Tuya, …) fell into that
 * default and got back `{"success":false,"error":"No stream URL provided"}` —
 * nonsense that neither validated nor refused anything. `integrations.create`
 * had nothing to gate on, so an integration with a WRONG PASSWORD was created
 * happily and only failed later, invisibly, at reconcile time.
 *
 * The contract these tests pin:
 *   - the test is DECLARED BY THE PROVIDER (`connection-test` cap), never
 *     inferred from the shape of the settings;
 *   - `create` refuses when the provider REJECTED the settings;
 *   - "could not be validated" is a DIFFERENT answer from "validated", and
 *     from "rejected" — an unrunnable test never reports a failure it did not
 *     observe, and never silently passes for one it did not run.
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
    getIntegrationSettings: vi.fn(),
    setIntegrationSettings: vi.fn(),
  }
}

type Outcome =
  | { outcome: 'validated'; latencyMs?: number; detail?: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'inconclusive'; error: string }

/** A `connection-test` provider that signs in for real (well — realistically). */
function makeConnectionTestProvider(mode: 'real' | 'throws' = 'real') {
  return {
    testSettings: vi.fn(
      async ({ settings }: { settings: Record<string, unknown> }): Promise<Outcome> => {
        if (mode === 'throws') throw new Error('socket hang up')
        if (settings['password'] === GOOD.password && settings['email'] === GOOD.email) {
          return { outcome: 'validated', latencyMs: 42 }
        }
        return { outcome: 'rejected', error: 'Fake Cloud rejected these credentials' }
      },
    ),
  }
}

interface HarnessOptions {
  /** Register a `connection-test` provider for ADDON_ID. */
  readonly connectionTest?: ReturnType<typeof makeConnectionTestProvider> | null
}

function makeHarness(opts: HarnessOptions = {}) {
  const integrationReg = makeIntegrationRegistry()
  const connectionTest = opts.connectionTest ?? null
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
        cap === 'connection-test' && addonId === ADDON_ID ? connectionTest : null,
      ),
      getProviderByAddonId: vi.fn((cap: string, addonId: string) =>
        cap === 'connection-test' && addonId === ADDON_ID ? connectionTest : null,
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
  return { provider, integrationReg, log, connectionTest }
}

describe('integrations.testConnection routes to the provider-DECLARED test', () => {
  it('REJECTS wrong credentials with the provider message — never "No stream URL provided"', async () => {
    const h = makeHarness({ connectionTest: makeConnectionTestProvider() })

    const result = await h.provider.testConnection({ addonId: ADDON_ID, settings: { ...BAD } })

    expect(result.success).toBe(false)
    expect(result.status).toBe('rejected')
    expect(result.error).toContain('rejected these credentials')
    expect(result.error).not.toContain('stream URL')
  })

  it('VALIDATES correct credentials', async () => {
    const h = makeHarness({ connectionTest: makeConnectionTestProvider() })

    const result = await h.provider.testConnection({ addonId: ADDON_ID, settings: { ...GOOD } })

    expect(result.success).toBe(true)
    expect(result.status).toBe('validated')
  })

  it('says UNSUPPORTED — not failed — when the provider declares no test', async () => {
    const h = makeHarness({ connectionTest: null })

    const result = await h.provider.testConnection({ addonId: ADDON_ID, settings: { ...BAD } })

    // Never reports a failure it did not observe.
    expect(result.status).toBe('unsupported')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot be tested|no connection test/i)
  })

  it('says INCONCLUSIVE — not rejected — when a declared test cannot complete', async () => {
    const h = makeHarness({ connectionTest: makeConnectionTestProvider('throws') })

    const result = await h.provider.testConnection({ addonId: ADDON_ID, settings: { ...BAD } })

    expect(result.status).toBe('inconclusive')
    expect(result.success).toBe(false)
    expect(result.error).toContain('socket hang up')
  })
})

describe('integrations.create is GATED on the declared test', () => {
  let h: ReturnType<typeof makeHarness>

  beforeEach(() => {
    h = makeHarness({ connectionTest: makeConnectionTestProvider() })
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
    const bare = makeHarness({ connectionTest: null })

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
    const flaky = makeHarness({ connectionTest: makeConnectionTestProvider('throws') })

    await flaky.provider.create({ addonId: ADDON_ID, name: 'Flaky', settings: { ...GOOD } })

    expect(flaky.integrationReg.createIntegration).toHaveBeenCalledOnce()
  })
})
