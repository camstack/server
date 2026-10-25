/**
 * AddonContext.getNativeProvider — in-process fast path via CapabilityRegistry.
 *
 * This test reinforces the registry-side contract that backs
 * `ctx.getNativeProvider(cap, deviceId)`. The factory integration path is
 * covered elsewhere (AddonContext-level); here we lock down the fast path:
 * a locally-registered native provider is returned by reference.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { method, type CapabilityDefinition, type IScopedLogger } from '@camstack/types'
import { CapabilityRegistry } from '../capability-registry.js'

const fooCap = {
  name: 'foo',
  scope: 'device',
  mode: 'singleton',
  methods: { ping: method(z.object({ deviceId: z.number() }), z.literal('pong')) },
} as const satisfies CapabilityDefinition

function createMockLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const CAM_01 = 1
const CAM_XX = 99

// ---------------------------------------------------------------------------
// Minimal cap definitions for the unified-resolver tests below.
// ---------------------------------------------------------------------------
const testCapDef = {
  name: 'test-cap',
  scope: 'device',
  mode: 'singleton',
  methods: {},
} as const satisfies CapabilityDefinition

const systemCapDef = {
  name: 'system-cap',
  scope: 'system',
  mode: 'singleton',
  methods: {},
} as const satisfies CapabilityDefinition

function makeLogger(): IScopedLogger {
  return createMockLogger()
}

describe('CapabilityRegistry.getProviderForDevice(capName, deviceId) — unified resolver', () => {
  it('resolves a native provider for a (cap, device) pair', () => {
    const registry = new CapabilityRegistry(makeLogger())
    registry.declareCapability(testCapDef)
    registry.ready()
    const impl = { ping: async () => 'pong' }
    registry.registerNativeProvider(testCapDef.name, 7, 'addon-a', impl)
    expect(registry.getProviderForDevice(testCapDef.name, 7)).toBe(impl)
  })

  it('falls back to a system provider bound to the device when no native exists', () => {
    const registry = new CapabilityRegistry(makeLogger())
    registry.declareCapability(systemCapDef)
    registry.ready()
    const impl = { ping: async () => 'pong' }
    registry.registerProvider(systemCapDef.name, 'addon-sys', impl)
    expect(registry.getProviderForDevice(systemCapDef.name, 99)).toBe(impl)
  })

  it('returns null when neither a native nor a system provider exists', () => {
    const registry = new CapabilityRegistry(makeLogger())
    registry.declareCapability(testCapDef)
    registry.ready()
    expect(registry.getProviderForDevice(testCapDef.name, 1)).toBeNull()
  })

  it('prefers the native provider over a same-named system provider', () => {
    const registry = new CapabilityRegistry(makeLogger())
    registry.declareCapability(testCapDef)
    registry.ready()
    const nativeImpl = { tag: 'native' }
    const sysImpl = { tag: 'system' }
    registry.registerProvider(testCapDef.name, 'addon-sys', sysImpl)
    registry.registerNativeProvider(testCapDef.name, 5, 'addon-a', nativeImpl)
    expect(registry.getProviderForDevice(testCapDef.name, 5)).toBe(nativeImpl)
  })
})

describe('AddonContext.getNativeProvider (via CapabilityRegistry.getNativeProvider)', () => {
  it('returns the registered native provider (in-process fast path)', async () => {
    const reg = new CapabilityRegistry(createMockLogger())
    const provider = { ping: async (_input: { deviceId: number }) => 'pong' as const }
    reg.registerNativeProvider(fooCap.name, CAM_01, 'addon-provider-onvif', provider)
    const resolved = reg.getNativeProvider<typeof provider>(fooCap.name, CAM_01)
    expect(resolved).toBe(provider)
    expect(await resolved?.ping({ deviceId: CAM_01 })).toBe('pong')
  })

  it('returns null when no native is registered', () => {
    const reg = new CapabilityRegistry(createMockLogger())
    expect(reg.getNativeProvider(fooCap.name, CAM_XX)).toBeNull()
  })
})
