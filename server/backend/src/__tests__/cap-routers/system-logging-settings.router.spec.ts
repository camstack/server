/**
 * The logging settings document on the wire, driven through the CODEGEN'D
 * router.
 *
 * Pinned here, and nowhere a provider test can see it:
 *
 *  - **The routes exist at all.** A method added to `system.cap.ts` without
 *    `npm run codegen` compiles and is invisible on the wire.
 *  - **Both are ADMIN.** The document arms diagnostics and moves the level of
 *    every line the node emits.
 *  - **A patch really is a PARTIAL.** A patch carrying only `diagnostics`
 *    must survive the input schema — if `level` ever became required, arming a
 *    census would need an operator to restate a level they did not mean to
 *    touch, and the merge this document exists for would be defeated at the
 *    boundary before the provider ever ran.
 *
 * The router is a structural pass-through — it does not re-validate output —
 * so the payload shape is the provider's to own and this spec's to pin.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ISystemProvider, LoggingSettingsState } from '@camstack/types'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

const STATE: LoggingSettingsState = {
  scopeNodeId: 'hub',
  scopeComponent: null,
  channels: [],
  activeChannels: [],
  effective: { level: 'warn', levelSource: 'node' },
  explicit: {
    layers: [
      { scope: 'cluster', nodeId: null, component: null, level: 'info' },
      { scope: 'node', nodeId: 'hub', component: null, level: 'warn' },
    ],
  },
  activeWindows: [
    {
      id: 'request-census',
      armed: true,
      armedUntilMs: 1_000_120_000,
      remainingMs: 108_000,
      persisted: true,
    },
  ],
  persisted: true,
  opsLogRetentionDays: 30,
}

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeProvider(): {
  provider: Partial<ISystemProvider>
  setLoggingSettings: ReturnType<typeof vi.fn>
} {
  const setLoggingSettings = vi.fn(async () => STATE)
  const provider: Partial<ISystemProvider> = {
    info: async () => {
      throw new Error('not used')
    },
    health: async () => ({ status: 'ok' as const, uptime: 1 }),
    featureFlags: async () => {
      throw new Error('not used')
    },
    networkAddresses: async () => [],
    getRetentionConfig: async () => null,
    setRetentionConfig: async () => null,
    forceRetentionCleanup: async () => {},
    getSiteLocation: async () => ({
      location: null,
      derivationAttemptedAt: null,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }),
    setSiteLocation: async () => ({
      location: null,
      derivationAttemptedAt: null,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }),
    detectSiteLocation: async () => ({
      location: null,
      derivationAttemptedAt: null,
      timeZone: 'Europe/Rome',
      derivationError: null,
    }),
    getRequestCensus: async () => {
      throw new Error('not used')
    },
    getLoggingSettings: async () => STATE,
    setLoggingSettings,
  }
  return { provider, setLoggingSettings }
}

describe('system.getLoggingSettings / setLoggingSettings', () => {
  it('serves BOTH effective and explicit through the generated route', async () => {
    const { provider } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const outcome = await invokeProcedure(router, 'getLoggingSettings', makeCtx('admin'), {
      scopeNodeId: 'hub',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toEqual(STATE)
  })

  it('accepts a patch that names ONLY a diagnostic - a patch is a partial', async () => {
    const { provider, setLoggingSettings } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const outcome = await invokeProcedure(router, 'setLoggingSettings', makeCtx('admin'), {
      patch: { diagnostics: [{ id: 'request-census', armMs: 120_000 }] },
    })

    expect(outcome.ok).toBe(true)
    expect(setLoggingSettings).toHaveBeenCalledWith({
      patch: { diagnostics: [{ id: 'request-census', armMs: 120_000 }] },
    })
  })

  it('accepts a patch that names ONLY a level, and a null that CLEARS it', async () => {
    const { provider, setLoggingSettings } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    expect(
      (
        await invokeProcedure(router, 'setLoggingSettings', makeCtx('admin'), {
          scopeNodeId: 'hub',
          patch: { level: 'warn' },
        })
      ).ok,
    ).toBe(true)
    expect(
      (
        await invokeProcedure(router, 'setLoggingSettings', makeCtx('admin'), {
          scopeNodeId: 'hub',
          patch: { level: null },
        })
      ).ok,
    ).toBe(true)

    expect(setLoggingSettings).toHaveBeenNthCalledWith(1, {
      scopeNodeId: 'hub',
      patch: { level: 'warn' },
    })
    expect(setLoggingSettings).toHaveBeenNthCalledWith(2, {
      scopeNodeId: 'hub',
      patch: { level: null },
    })
  })

  it('refuses a non-admin caller on BOTH methods', async () => {
    const { provider } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    for (const [procedure, input] of [
      ['getLoggingSettings', {}],
      ['setLoggingSettings', { patch: {} }],
    ] as const) {
      const matrix = await checkAuthMatrix(router, procedure, 'admin', input)
      for (const row of matrix) {
        if (row.allowed) expect(row.outcome.ok).toBe(true)
        else
          expect(['UNAUTHORIZED', 'FORBIDDEN']).toContain(
            row.outcome.ok ? 'ALLOWED' : row.outcome.code,
          )
      }
      const asUser = await invokeProcedure(router, procedure, makeCtx('user'), input)
      expect(asUser.ok).toBe(false)
    }
  })

  it('rejects an unknown level and a negative window at the schema boundary', async () => {
    const { provider, setLoggingSettings } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const badLevel = await invokeProcedure(router, 'setLoggingSettings', makeCtx('admin'), {
      patch: { level: 'shout' },
    })
    const badWindow = await invokeProcedure(router, 'setLoggingSettings', makeCtx('admin'), {
      patch: { diagnostics: [{ id: 'request-census', armMs: -1 }] },
    })

    expect(badLevel.ok).toBe(false)
    expect(badWindow.ok).toBe(false)
    expect(setLoggingSettings).not.toHaveBeenCalled()
  })
})
