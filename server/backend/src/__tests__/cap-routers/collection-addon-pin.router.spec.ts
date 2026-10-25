/**
 * Regression spec: an UNRESOLVABLE `{ addonId }` pin on a system-collection
 * cap must REFUSE, never silently answer from another provider.
 *
 * The bug (measured live on the hub, 2026-08-09):
 *
 *   deviceExport.getStatus { addonId: 'export-alexa' }        → linked   | 3
 *   deviceExport.getStatus { addonId: 'homeassistant-export' }→ unlinked | 0
 *   deviceExport.getStatus { addonId: 'questo-non-esiste' }   → linked   | 3  ← Alexa's answer
 *
 * `resolveCollectionProvider` returns `null` for an addonId no provider owns;
 * the router's `resolveProviderForCall` then treats that exactly like "the cap
 * lives in a forked hub worker" and falls through to `remoteProxy(cap, 'hub')`,
 * whose Moleculer prefix lookup lands on the FIRST hub-side provider. The pin
 * is dropped and the caller gets a plausible answer belonging to someone else.
 *
 * Why it matters: the Home Assistant custom component reads its exported-device
 * set pinned to `addonId: 'homeassistant-export'` precisely so it does NOT get
 * the unpinned aggregate (Alexa's 3 + HomeKit's 3). With this fallthrough, the
 * moment that addon is missing / renamed / crashed / not yet deployed the
 * component silently imports ALEXA's devices instead — the original operator
 * bug, resurrected, and looking exactly like success.
 *
 * This spec drives the REAL server resolution (`createCapRouterServices` over a
 * REAL `CapabilityRegistry`), not the harness stub — a stubbed
 * `getLocalProvider` is the very thing that would supply the fix the production
 * path forgot.
 */

import { ALL_CAPABILITY_DEFINITIONS, buildCapRouters, CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import {
  deviceExportCapability,
  expandCapMethods,
  isVoidInput,
  kebabToCamel,
  resolveCapMount,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type CapProxyProvider,
  createCapRouterPrimitives,
  createCapRouterServices,
} from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, invokeProcedure, makeCtx } from './harness.js'

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

/** Structural method bag — what the router actually calls on a provider. */
type MethodBag = Readonly<Record<string, (input?: unknown) => Promise<unknown>>>

/** A minimal `device-export` provider that answers only for its own addon. */
function makeExportProvider(addonId: string, exposed: number): MethodBag {
  const devices = Array.from({ length: exposed }, (_, i) => ({
    deviceId: `${addonId}-dev-${i}`,
  }))
  return {
    getStatus: async () => ({
      linkState: exposed > 0 ? 'linked' : 'unlinked',
      exposedDeviceCount: exposed,
      setup: { note: addonId },
    }),
    listSupportedDeviceKinds: async () => ['camera'],
    listExposedDevices: async () => devices,
    exposeDevice: async () => undefined,
    unexposeDevice: async () => undefined,
    getDeviceSettingsContribution: async () => null,
    getDeviceLiveContribution: async () => null,
    applyDeviceSettingsPatch: async () => undefined,
  }
}

/** A provider that answers every method of an arbitrary cap with `null`. */
function makeCapProvider(methodNames: readonly string[]): MethodBag {
  const bag: Record<string, (input?: unknown) => Promise<unknown>> = {}
  for (const name of methodNames) bag[name] = async () => null
  return bag
}

/**
 * Build the `device-export` router over a REAL registry holding the same three
 * providers the live hub has, in the same order. The Moleculer stub reproduces
 * the hub's prefix lookup: `remoteProxy('device-export', 'hub')` answers with
 * the FIRST provider (Alexa) — the exact mechanism that made a fabricated pin
 * look successful.
 */
function buildDeviceExportRouter(): {
  readonly router: CreateCallerCapableRouter
  readonly logger: IScopedLogger
} {
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(deviceExportCapability)
  const alexa = makeExportProvider('export-alexa', 3)
  registry.registerProvider('device-export', 'export-alexa', alexa)
  registry.registerProvider('device-export', 'export-hap', makeExportProvider('export-hap', 3))
  registry.registerProvider(
    'device-export',
    'homeassistant-export',
    makeExportProvider('homeassistant-export', 0),
  )
  const moleculer: CapProxyProvider = {
    createCapabilityProxy: (capabilityName, nodeId) =>
      capabilityName === 'device-export' && nodeId === 'hub' ? alexa : null,
  }
  const services = createCapRouterServices({
    capabilityRegistry: registry,
    moleculer,
    serverProviders: {},
    logger,
  })
  const routers = buildCapRouters(createCapRouterPrimitives(), services)
  const router = routers[kebabToCamel('device-export')]
  if (router === undefined) throw new Error('no device-export router built')
  return { router: router as CreateCallerCapableRouter, logger }
}

describe('system-collection cap: { addonId } pin resolution', () => {
  it('honours a VALID pin — each provider answers for itself, never the aggregate', async () => {
    const { router } = buildDeviceExportRouter()
    const ctx = makeCtx('admin')

    const alexa = await invokeProcedure(router, 'getStatus', ctx, { addonId: 'export-alexa' })
    expect(alexa).toMatchObject({ ok: true, value: { linkState: 'linked', exposedDeviceCount: 3 } })

    const ha = await invokeProcedure(router, 'getStatus', ctx, {
      addonId: 'homeassistant-export',
    })
    expect(ha).toMatchObject({ ok: true, value: { linkState: 'unlinked', exposedDeviceCount: 0 } })

    // The pinned list is that provider's OWN devices — not the 6-device merge.
    const haDevices = await invokeProcedure(router, 'listExposedDevices', ctx, {
      addonId: 'homeassistant-export',
    })
    expect(haDevices).toEqual({ ok: true, value: [] })
  })

  it('still aggregates when NO pin is supplied', async () => {
    const { router } = buildDeviceExportRouter()
    const all = await invokeProcedure(router, 'listExposedDevices', makeCtx('admin'))
    expect(all.ok).toBe(true)
    expect(all.ok === true && (all.value as readonly unknown[]).length).toBe(6)
  })

  it('REFUSES an unresolvable pin instead of answering from another provider', async () => {
    const { router } = buildDeviceExportRouter()
    const out = await invokeProcedure(router, 'getStatus', makeCtx('admin'), {
      addonId: 'questo-non-esiste-affatto',
    })

    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('BAD_REQUEST')
    // Self-explaining: names the id that could not be resolved AND enumerates
    // the valid ones (the `addons.custom` unknown-id posture).
    expect(out.ok === false && out.message).toContain('questo-non-esiste-affatto')
    expect(out.ok === false && out.message).toContain('export-alexa')
    expect(out.ok === false && out.message).toContain('homeassistant-export')
  })

  it('REFUSES an unresolvable pin on an array method too (no silent empty list)', async () => {
    const { router } = buildDeviceExportRouter()
    const out = await invokeProcedure(router, 'listExposedDevices', makeCtx('admin'), {
      addonId: 'questo-non-esiste-affatto',
    })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.code).toBe('BAD_REQUEST')
  })

  it('LOGS the refusal — a dropped call is never silent', async () => {
    const { router, logger } = buildDeviceExportRouter()
    await invokeProcedure(router, 'getStatus', makeCtx('admin'), { addonId: 'nope-not-here' })
    expect(logger.warn).toHaveBeenCalled()
    const warned = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => JSON.stringify(c))
      .join('\n')
    expect(warned).toContain('nope-not-here')
    expect(warned).toContain('device-export')
  })
})

/**
 * Blast radius: `device-export` is one of 24 `mode:'collection'` caps and they
 * all resolve through the SAME `resolveCollectionProvider`, so they all shared
 * the fallthrough. This sweep proves the fix is at the shared seam and not
 * device-export-shaped — every collection cap with a void-input method refuses
 * a fabricated pin.
 */
describe('system-collection caps: the pin refusal covers every collection cap', () => {
  // `skip`-mount caps are never mounted as routers at all (legacy provider
  // shapes) — there is no pin path to protect.
  const collectionCaps = ALL_CAPABILITY_DEFINITIONS.filter(
    (d) => d.mode === 'collection' && resolveCapMount(d).kind !== 'skip',
  )

  // A floor, not an exact count: caps come and go, but a filter that silently
  // matched nothing would turn this whole sweep into a no-op that reads green.
  it('actually sweeps a fleet of caps, not zero', () => {
    expect(collectionCaps.length).toBeGreaterThanOrEqual(15)
  })

  for (const def of collectionCaps) {
    const methods = expandCapMethods(def)
    const voidMethod = Object.entries(methods).find(
      ([, m]) => m.kind !== 'subscription' && isVoidInput(m.input),
    )
    if (voidMethod === undefined) continue
    const [methodName] = voidMethod

    it(`${def.name}.${methodName} refuses a fabricated addonId`, async () => {
      const logger = makeLogger()
      const registry = new CapabilityRegistry(logger)
      registry.declareCapability(def)
      const provider = makeCapProvider(Object.keys(methods))
      registry.registerProvider(def.name, 'real-owner', provider)
      const services = createCapRouterServices({
        capabilityRegistry: registry,
        moleculer: { createCapabilityProxy: () => provider },
        serverProviders: {},
        logger,
      })
      const routers = buildCapRouters(createCapRouterPrimitives(), services)
      const router = routers[kebabToCamel(def.name)] as CreateCallerCapableRouter | undefined
      if (router === undefined) throw new Error(`no router built for "${def.name}"`)

      const out = await invokeProcedure(router, methodName, makeCtx('admin'), {
        addonId: 'fabricated-addon-id',
      })
      expect(out.ok).toBe(false)
      expect(out.ok === false && out.code).toBe('BAD_REQUEST')
      expect(out.ok === false && out.message).toContain('fabricated-addon-id')
      expect(out.ok === false && out.message).toContain('real-owner')
    })
  }
})
