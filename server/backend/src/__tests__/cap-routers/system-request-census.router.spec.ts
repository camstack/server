/**
 * Spec for `system.getRequestCensus`, driven through the CODEGEN'D router.
 *
 * Two things are pinned here that a provider-level test cannot see:
 *
 *  - **The route exists at all.** A method added to `system.cap.ts` without
 *    `npm run codegen` compiles and is invisible on the wire. This spec fails
 *    if the router was never regenerated.
 *  - **It is ADMIN.** The rows carry source addresses and principal names; a
 *    `protected` census would hand every logged-in viewer the list of who else
 *    is connected and from where.
 *
 * The router is a structural pass-through - it does not re-validate output -
 * so the payload shape is the provider's to own and this spec's to pin.
 *
 * ## Where the WRITE went
 *
 * `system.setRequestCensus` was retired on 2026-08-27 (D245). Arming is now a
 * field of the logging settings document -
 * `system.setLoggingSettings({ patch: { diagnostics: [...] } })`, pinned in
 * `system-logging-settings.router.spec.ts` - because two writes that disagree
 * about the same window is the defect that document exists to remove. The
 * READ stays here: it returns the census RESULT (per-procedure and per-caller
 * counts), which is a measurement and not a setting.
 */

import { describe, expect, it } from 'vitest'
import type { ISystemProvider, RequestCensusStatus } from '@camstack/types'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

const STATUS: RequestCensusStatus = {
  armed: true,
  elapsedMs: 12_000,
  windowMs: 120_000,
  armedUntilMs: 1_000_120_000,
  httpRequests: 7,
  batchedRequests: 2,
  procedureCalls: 11,
  // The planes SUM to `procedureCalls`. A fixture that did not add up would
  // describe a snapshot the census cannot produce, and a test built on it
  // proves nothing about the one that can.
  planes: { http: 7, ws: 4, mesh: 0, unknown: 0 },
  planesExplainTotal: true,
  wsConnections: 37,
  wsMessages: 52,
  subscriptions: 2,
  subscriptionStops: 1,
  distinctGroups: 3,
  unattributedCalls: 0,
  procedures: [
    {
      procedure: 'deviceManager.listAll',
      calls: 8,
      planes: { http: 5, ws: 3, mesh: 0, unknown: 0 },
      subscriptions: 0,
      perMin: 40,
    },
  ],
  groups: [
    {
      plane: 'ws',
      procedure: 'deviceManager.listAll',
      userAgent: 'camstack-viewer/1.2.3',
      ip: '192.168.10.10',
      principal: 'apocaliss92 (admin)',
      calls: 8,
      subscriptions: 0,
      perMin: 40,
    },
  ],
  persisted: true,
}

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeProvider(): { provider: Partial<ISystemProvider> } {
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
      derivationError: null,
    }),
    setSiteLocation: async () => ({
      location: null,
      derivationAttemptedAt: null,
      derivationError: null,
    }),
    detectSiteLocation: async () => ({
      location: null,
      derivationAttemptedAt: null,
      derivationError: null,
    }),
    getRequestCensus: async () => STATUS,
    getLoggingSettings: async () => {
      throw new Error('not used')
    },
    setLoggingSettings: async () => {
      throw new Error('not used')
    },
  }
  return { provider }
}

describe('system.getRequestCensus', () => {
  it('serves the census through the generated route', async () => {
    const { provider } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const outcome = await invokeProcedure(router, 'getRequestCensus', makeCtx('admin'))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toEqual(STATUS)
  })

  it('refuses a non-admin caller', async () => {
    const { provider } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const matrix = await checkAuthMatrix(router, 'getRequestCensus', 'admin', undefined)
    for (const row of matrix) {
      if (row.allowed) expect(row.outcome.ok).toBe(true)
      else
        expect(['UNAUTHORIZED', 'FORBIDDEN']).toContain(
          row.outcome.ok ? 'ALLOWED' : row.outcome.code,
        )
    }
    // A non-admin session must be refused, not served.
    const asUser = await invokeProcedure(router, 'getRequestCensus', makeCtx('user'))
    expect(asUser.ok).toBe(false)
  })

  it('has NO setRequestCensus route - the write is the logging document (D245)', async () => {
    const { provider } = makeProvider()
    const router = buildCapRouterForTest('system', () => provider)

    const missing = await invokeProcedure(router, 'setRequestCensus', makeCtx('admin'), {})
    expect(missing).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // The control: a route that DOES exist is not answered NOT_FOUND, so the
    // assertion above is about the route, not about the harness.
    const present = await invokeProcedure(router, 'getRequestCensus', makeCtx('admin'))
    expect(present.ok).toBe(true)
  })
})
