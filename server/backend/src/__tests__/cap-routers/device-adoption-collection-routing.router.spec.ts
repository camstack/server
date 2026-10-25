/**
 * Regression: `device-adoption` is a system-scoped COLLECTION cap — each
 * integration addon registers its own provider. Unpinned singleton routing
 * sent every `deviceAdoption.*` call to the active/first provider, so parallel
 * adoption (HA + Dreame + …) collided silently.
 *
 * The admin UI already pins via `deviceManager.adoption*` + `addonId`; this
 * spec proves the DIRECT `deviceAdoption.*` router honours `{ addonId }` the
 * same way `connectionTest` / `broker` do.
 */

import { buildCapRouters, CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { deviceAdoptionCapability, kebabToCamel } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type CapProxyProvider,
  createCapRouterPrimitives,
  createCapRouterServices,
  type CapRouterRuntimeDeps,
} from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, invokeProcedure, makeCtx } from './harness.js'

const ADDON_A = 'addon-a'
const ADDON_B = 'addon-b'
const INT_A = 'int-a'
const INT_B = 'int-b'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeAdoptionProvider(tag: string) {
  return {
    listCandidateFilters: async () => ({ filters: [{ id: tag, label: tag, isDefault: true }] }),
    listCandidates: async () => ({
      candidates: [],
      totalCount: 0,
      page: 1,
      pageSize: 50,
      _providerTag: tag,
    }),
    getCandidate: async () => null,
    refresh: async () => ({
      lastDiscoveryAt: null,
      candidateCount: 0,
      adoptedCount: 0,
      lastError: null,
      _providerTag: tag,
    }),
    adopt: async () => ({ adopted: [], _providerTag: tag }),
    release: async () => undefined,
    resync: async () => ({ changed: false, rebuiltChildren: 0, _providerTag: tag }),
    getStatus: async () => ({
      lastDiscoveryAt: null,
      candidateCount: 0,
      adoptedCount: 0,
      lastError: null,
      _providerTag: tag,
    }),
  }
}

function buildRouter(deps: Partial<CapRouterRuntimeDeps> = {}): CreateCallerCapableRouter {
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(deviceAdoptionCapability)
  registry.registerProvider('device-adoption', ADDON_A, makeAdoptionProvider('A'))
  registry.registerProvider('device-adoption', ADDON_B, makeAdoptionProvider('B'))

  const moleculer: CapProxyProvider = {
    createCapabilityProxy: (capName, nodeId) =>
      capName === 'device-adoption' && nodeId === 'hub'
        ? makeAdoptionProvider('FIRST-PROXY')
        : null,
  }

  const services = createCapRouterServices({
    capabilityRegistry: registry,
    moleculer,
    serverProviders: {},
    logger,
    ...deps,
  })
  const routers = buildCapRouters(createCapRouterPrimitives(), services)
  const router = routers[kebabToCamel('device-adoption')]
  if (router === undefined) throw new Error('no device-adoption router')
  return router as CreateCallerCapableRouter
}

describe('device-adoption collection routing', () => {
  it('routes listCandidates to the pinned addon provider', async () => {
    const router = buildRouter()
    const ctx = makeCtx('admin')

    const a = await invokeProcedure(router, 'listCandidates', ctx, {
      addonId: ADDON_A,
      integrationId: INT_A,
    })
    expect(a.ok).toBe(true)
    expect(a.ok === true && (a.value as { _providerTag?: string })._providerTag).toBe('A')

    const b = await invokeProcedure(router, 'listCandidates', ctx, {
      addonId: ADDON_B,
      integrationId: INT_B,
    })
    expect(b.ok).toBe(true)
    expect(b.ok === true && (b.value as { _providerTag?: string })._providerTag).toBe('B')
  })

  it('REFUSES an unresolvable addonId pin (never the first provider)', async () => {
    const router = buildRouter()
    const out = await invokeProcedure(router, 'listCandidates', makeCtx('admin'), {
      addonId: 'no-such-addon',
      integrationId: INT_A,
    })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('BAD_REQUEST')
    expect(out.ok === false && out.message).toContain('no-such-addon')
    expect(out.ok === false && out.message).toContain(ADDON_A)
  })

  it('without addonId, resolves via integrationId when the hub can map it', async () => {
    const router = buildRouter({
      resolveIntegrationAddonId: async (integrationId) =>
        integrationId === INT_A ? ADDON_A : integrationId === INT_B ? ADDON_B : null,
    })
    const out = await invokeProcedure(router, 'listCandidates', makeCtx('admin'), {
      integrationId: INT_B,
    })
    expect(out.ok).toBe(true)
    expect(out.ok === true && (out.value as { _providerTag?: string })._providerTag).toBe('B')
  })

  it('without addonId or integrationId mapping, REFUSES instead of first-provider fallback', async () => {
    const router = buildRouter()
    const out = await invokeProcedure(router, 'listCandidates', makeCtx('admin'), {
      integrationId: INT_A,
    })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('BAD_REQUEST')
    expect(out.ok === false && out.message.toLowerCase()).toMatch(/addonid|integrationid/)
  })

  it('inferred addonId whose provider is NOT registered REFUSES (never first-provider)', async () => {
    // Only ADDON_A is local; integrationId maps to ADDON_B which is absent.
    // Without refuse-on-inferred-pin, getLocal(null) would fall through to
    // remoteProxy → FIRST-PROXY.
    const logger = makeLogger()
    const registry = new CapabilityRegistry(logger)
    registry.declareCapability(deviceAdoptionCapability)
    registry.registerProvider('device-adoption', ADDON_A, makeAdoptionProvider('A'))

    const moleculer: CapProxyProvider = {
      createCapabilityProxy: (capName, nodeId) =>
        capName === 'device-adoption' && nodeId === 'hub'
          ? makeAdoptionProvider('FIRST-PROXY')
          : null,
    }
    const services = createCapRouterServices({
      capabilityRegistry: registry,
      moleculer,
      serverProviders: {},
      logger,
      resolveIntegrationAddonId: async (integrationId) =>
        integrationId === INT_B ? ADDON_B : null,
    })
    const routers = buildCapRouters(createCapRouterPrimitives(), services)
    const router = routers[kebabToCamel('device-adoption')] as CreateCallerCapableRouter

    const out = await invokeProcedure(router, 'listCandidates', makeCtx('admin'), {
      integrationId: INT_B,
    })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('BAD_REQUEST')
    expect(out.ok === false && out.message).toContain(ADDON_B)
    expect(out.ok === false && out.message).not.toContain('FIRST-PROXY')
  })

  it('without addonId, resync pins via camDeviceId → owning addon', async () => {
    const router = buildRouter({
      resolveDeviceAddonId: (camDeviceId) => (camDeviceId === 42 ? ADDON_B : null),
    })
    const out = await invokeProcedure(router, 'resync', makeCtx('admin'), {
      camDeviceId: 42,
    })
    expect(out.ok).toBe(true)
    expect(out.ok === true && (out.value as { _providerTag?: string })._providerTag).toBe('B')
  })
})
