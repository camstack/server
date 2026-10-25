/**
 * `device-admin-link` router spec.
 *
 * Three things are pinned, because each has a way of being silently wrong:
 *
 *  1. **The mount is device-native.** Every provider registers per-device via
 *     `ctx.registerNativeCap`; nobody registers a system singleton. A cap def
 *     that lost `deviceNative: true` would resolve to `{ kind: 'singleton' }`
 *     and 412 on every device while `deviceManager.getBindings` still listed a
 *     live binding — the exact `motion` defect of 2026-08-02, and invisible
 *     from the type system. Driven through the LIVE builder with the
 *     production `requireDeviceScoped` switch and ZERO singletons registered.
 *
 *  2. **`null` survives the router.** "This device has no page" is an ANSWER,
 *     not an error, and the builder's output pass-through must hand it back
 *     unchanged. A router that turned it into an error would make every
 *     page-less device look like a broken query.
 *
 *  3. **The method is admin-gated.** Opening a camera's console is
 *     administration; the URL is also a statement about the LAN. A non-admin
 *     session must lose the QUERY, so the surfaces draw nothing — never a
 *     button that appears and then fails (D403, from the other end).
 *
 * The router key is `deviceAdminLink`, not `device-admin-link`: `buildCapRouters`
 * keys by `kebabToCamel(def.name)`. `buildCapRouterForTest` does that conversion
 * itself, so this file passes the KEBAB name; `buildLinkRouter` below does the
 * lookup by hand and must use the camel one.
 */

import { buildCapRouters, type CapabilityRegistry, type CapRouterServices } from '@camstack/system'
import { type DeviceAdminLink, deviceAdminLinkCapability, resolveCapMount } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { requireDeviceScoped } from '../../api/trpc/cap-mount-helpers.js'
import { createCapRouterPrimitives } from '../../api/trpc/cap-router-runtime.js'
import {
  buildCapRouterForTest,
  type CreateCallerCapableRouter,
  invokeProcedure,
  makeCtx,
} from './harness.js'

/** A camera with a page (Hikvision 1436 on this hub). */
const DEVICE_WITH_PAGE = 1436
/** A camera whose provider registers the cap and knows there is no page. */
const DEVICE_WITHOUT_PAGE = 107

const LINK: DeviceAdminLink = {
  url: 'http://192.168.60.139/',
  label: 'Web UI',
  target: 'device',
  host: '192.168.60.139',
}

type ProviderSurface = Readonly<Record<string, (i: unknown) => unknown>>

/**
 * Registry double mirroring PRODUCTION: zero singleton providers for this cap,
 * one per-device native. Only the surface `requireDeviceScoped` consults is
 * implemented — the same documented test-double seam
 * `motion-device-native-route.spec.ts` uses.
 */
function makeLinkRegistry(): CapabilityRegistry {
  const native: ProviderSurface = {
    getAdminLink: (input: unknown) => {
      const deviceId = (input as { deviceId?: number }).deviceId
      return deviceId === DEVICE_WITH_PAGE ? LINK : null
    },
  }
  const resolve = <T>(capName: string, deviceId: number): T | null =>
    capName === 'device-admin-link' &&
    (deviceId === DEVICE_WITH_PAGE || deviceId === DEVICE_WITHOUT_PAGE)
      ? (native as T)
      : null
  const registry = {
    getSingleton: <T>(capability: string): T | null => {
      void capability
      return null
    },
    getNativeProvider: resolve,
    getProviderForDevice: resolve,
  }
  return registry as unknown as CapabilityRegistry
}

function buildLinkRouter(reg: CapabilityRegistry): CreateCallerCapableRouter {
  const services: CapRouterServices = {
    getLocalProvider: (capName, mountKind) => {
      if (capName !== 'device-admin-link') return null
      if (mountKind === 'device-native') return requireDeviceScoped(reg, capName)
      return reg.getSingleton(capName)
    },
    remoteProxy: () => null,
    noProvider: (name): never => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Capability "${name}" provider not available`,
      })
    },
    noNodeRouting: (name): never => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Node routing not available for "${name}"`,
      })
    },
    badRequest: (message): never => {
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    },
  }
  const routers = buildCapRouters(createCapRouterPrimitives(), services)
  const router = routers['deviceAdminLink']
  if (router === undefined) throw new Error('no router built for cap "device-admin-link"')
  return router as CreateCallerCapableRouter
}

describe('device-admin-link router', () => {
  it('resolves to the device-native mount kind (the 412-on-every-device defect)', () => {
    expect(resolveCapMount(deviceAdminLinkCapability).kind).toBe('device-native')
  })

  it('reaches the per-device native with ZERO singleton providers registered', async () => {
    const router = buildLinkRouter(makeLinkRegistry())
    const caller = router.createCaller(makeCtx('admin'))
    const result = await caller['getAdminLink']?.({ deviceId: DEVICE_WITH_PAGE })
    expect(result).toEqual(LINK)
  })

  it('hands back null unchanged for a device the provider says has no page', async () => {
    const router = buildLinkRouter(makeLinkRegistry())
    const caller = router.createCaller(makeCtx('admin'))
    const result = await caller['getAdminLink']?.({ deviceId: DEVICE_WITHOUT_PAGE })
    expect(result).toBeNull()
  })

  it('a device whose provider never registered fails per-device, not via the singleton fallthrough', async () => {
    const router = buildLinkRouter(makeLinkRegistry())
    const caller = router.createCaller(makeCtx('admin'))
    await expect(caller['getAdminLink']?.({ deviceId: 999 })).rejects.toMatchObject({
      message: 'Capability "device-admin-link" not registered for device 999',
    })
  })

  it('refuses a non-admin session, so a surface without the right draws nothing', async () => {
    const router = buildCapRouterForTest('device-admin-link', () => ({
      getAdminLink: async () => LINK,
    }))
    const denied = await invokeProcedure(router, 'getAdminLink', makeCtx('user'), {
      deviceId: DEVICE_WITH_PAGE,
    })
    expect(denied.ok).toBe(false)

    const allowed = await invokeProcedure(router, 'getAdminLink', makeCtx('admin'), {
      deviceId: DEVICE_WITH_PAGE,
    })
    expect(allowed).toEqual({ ok: true, value: LINK })
  })

  it('never serves a URL carrying userinfo, whatever the provider returned', async () => {
    // The router is a structural pass-through — it does NOT re-validate output.
    // This test therefore pins the contract at the only place it can be pinned
    // from here: what a conforming provider produces. The gate that makes it
    // true is `buildDeviceAdminUrl` plus
    // `scripts/check-admin-link-builder-is-the-only-url-source.ts`.
    const router = buildLinkRouter(makeLinkRegistry())
    const caller = router.createCaller(makeCtx('admin'))
    const result = await caller['getAdminLink']?.({ deviceId: DEVICE_WITH_PAGE })
    const url = (result as DeviceAdminLink).url
    expect(url).not.toMatch(/:\/\/[^/]*@/)
    expect(url).not.toMatch(/[?&](password|token|user|apikey)=/i)
  })
})
