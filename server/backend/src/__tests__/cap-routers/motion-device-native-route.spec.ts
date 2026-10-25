/**
 * Regression guard — `motion` must mount DEVICE-NATIVE, not singleton.
 *
 * 2026-08-02: `motion.cap.ts` lacked `deviceNative: true`, so `resolveCapMount`
 * derived `{ kind: 'singleton' }` and the runtime cap-router resolved
 * `registry.getSingleton('motion')`. No addon registers a system singleton for
 * `motion` — every provider (Hikvision, Reolink, Amcrest, Wyze, HA, Homematic,
 * Alexa-import, Matter) registers a PER-DEVICE native via
 * `ctx.registerNativeCap` — so `motion.getStatus`/`isDetected` 412'd
 * "provider not available" on every camera while `deviceManager.getBindings`
 * listed a live `motion` native binding. The viewer's `useMotion` poll arm
 * swallowed the error, leaving live motion state event-driven only (a client
 * opened mid-motion saw nothing until the next transition), and
 * `addon-export-alexa`'s `report-state` silently lost motion state the same
 * way.
 *
 * Two layers are pinned here:
 *  1. The cap def resolves to the `device-native` mount kind.
 *  2. Driven through the LIVE runtime router builder with the production
 *     `getLocalProvider` switch, a `motion.getStatus` call reaches a
 *     per-device provider resolved via `requireDeviceScoped` (native-first,
 *     D13 fallback) — with ZERO singleton providers registered, exactly the
 *     production registry state.
 */

import { buildCapRouters, type CapabilityRegistry, type CapRouterServices } from '@camstack/system'
import { type MotionStatus, motionCapability, resolveCapMount } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { requireDeviceScoped } from '../../api/trpc/cap-mount-helpers.js'
import { createCapRouterPrimitives } from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, makeCtx } from './harness.js'

const DEVICE_ID = 101

const NATIVE_STATUS: MotionStatus = {
  detected: true,
  lastDetectedAt: 1_754_000_000_000,
  autoClearAfterMs: 30_000,
}

type ProviderSurface = Readonly<Record<string, (i: unknown) => unknown>>

/**
 * Registry double mirroring the PRODUCTION state for `motion`: zero singleton
 * providers, one per-device native. Only the surface `requireDeviceScoped` and
 * the singleton fallthrough consult is implemented; the boundary cast is the
 * same documented test-double seam `wrapper-provider-dispatch.spec.ts` uses.
 */
function makeMotionRegistry(): CapabilityRegistry {
  const native: ProviderSurface = {
    getStatus: async (input: unknown) => {
      const deviceId = (input as { deviceId?: number }).deviceId
      return deviceId === DEVICE_ID ? NATIVE_STATUS : null
    },
    isDetected: async () => NATIVE_STATUS.detected,
  }
  const registry = {
    // The production defect: no singleton provider is ever registered.
    getSingleton: <T>(capability: string): T | null => {
      void capability
      return null
    },
    getNativeProvider: <T>(capName: string, deviceId: number): T | null =>
      capName === 'motion' && deviceId === DEVICE_ID ? (native as T) : null,
    getProviderForDevice: <T>(capName: string, deviceId: number): T | null =>
      capName === 'motion' && deviceId === DEVICE_ID ? (native as T) : null,
  }
  return registry as unknown as CapabilityRegistry
}

/**
 * Build the `motion` router through the LIVE builder with a `getLocalProvider`
 * that reproduces the production switch in `cap-router-runtime.ts`: the
 * `device-native` mount kind goes through `requireDeviceScoped`; anything else
 * falls through to `getSingleton` — so this spec FAILS (PRECONDITION_FAILED)
 * whenever `motion` stops resolving as device-native.
 */
function buildMotionRouter(reg: CapabilityRegistry): CreateCallerCapableRouter {
  const services: CapRouterServices = {
    getLocalProvider: (capName, mountKind) => {
      if (capName !== 'motion') return null
      // Widened back to `string`: production resolves by a DYNAMIC name (it
      // iterates the cap definitions), which selects the untyped overload.
      const name: string = capName
      if (mountKind === 'device-native') {
        return requireDeviceScoped(reg, name)
      }
      return reg.getSingleton(name)
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
  const router = routers['motion']
  if (router === undefined) throw new Error('no router built for cap "motion"')
  return router as CreateCallerCapableRouter
}

describe('motion cap — device-native mount regression guard', () => {
  it('resolveCapMount(motionCapability) is device-native (the 412-on-every-camera defect)', () => {
    expect(resolveCapMount(motionCapability).kind).toBe('device-native')
  })

  it('motion.getStatus reaches the per-device native with ZERO singleton providers registered', async () => {
    const router = buildMotionRouter(makeMotionRegistry())
    const caller = router.createCaller(makeCtx('user'))
    const result = await caller['getStatus']?.({ deviceId: DEVICE_ID })
    expect(result).toEqual(NATIVE_STATUS)
  })

  it('motion.isDetected reaches the per-device native the same way', async () => {
    const router = buildMotionRouter(makeMotionRegistry())
    const caller = router.createCaller(makeCtx('user'))
    const result = await caller['isDetected']?.({ deviceId: DEVICE_ID })
    expect(result).toBe(true)
  })

  it('an unknown device still fails with the device-specific error, not the singleton fallthrough', async () => {
    const router = buildMotionRouter(makeMotionRegistry())
    const caller = router.createCaller(makeCtx('user'))
    await expect(caller['isDetected']?.({ deviceId: 999 })).rejects.toMatchObject({
      message: 'Capability "motion" not registered for device 999',
    })
  })
})
