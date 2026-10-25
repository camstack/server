/**
 * Smoke tests for `CapabilityRegistry` — declare a singleton capability,
 * register providers, and verify the first-registered provider becomes
 * the default when no user preference is set.
 *
 * Previously lived under `server/backend/src/core/detection-wiring/__tests__/`
 * as "detection-wiring-consumer.test.ts", which misrepresented the actual
 * subject (CapabilityRegistry, not DetectionWiringService). Moved here
 * alongside the kernel module it exercises so the file name matches the
 * code under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CapabilityRegistry } from '../capability-registry.js'
import type { IScopedLogger } from '@camstack/types'

function createMockLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

describe('CapabilityRegistry — singleton provider resolution', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.ready()
  })

  it('returns the registered provider for a declared singleton capability', () => {
    registry.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    const mockPipeline = { processFrame: vi.fn() }
    registry.registerProvider('analysis-pipeline', 'analysis', mockPipeline)

    expect(registry.getSingleton('analysis-pipeline')).toBe(mockPipeline)
  })

  it('defaults to the first-registered provider when no user preference is set', () => {
    registry.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    const pipeline1 = { processFrame: vi.fn(), name: 'builtin' }
    const pipeline2 = { processFrame: vi.fn(), name: 'custom' }
    registry.registerProvider('analysis-pipeline', 'analysis', pipeline1)
    registry.registerProvider('analysis-pipeline', 'custom-analysis', pipeline2)

    expect(registry.getSingleton('analysis-pipeline')).toBe(pipeline1)
  })

  // Phase 12 (settings redesign) regression:
  // `analysis-pipeline` was previously being registered three times
  // during boot — twice by the `analytics` addon and once by the
  // `analysis-pipeline` addon — and the third call silently replaced
  // the second. The registry now throws on duplicate
  // `(capabilityName, addonId)` pairs so the bug surfaces at boot
  // instead of manifesting as a hard-to-trace "wrong provider" issue
  // at runtime.
  it('throws when the same (capability, addonId) pair registers twice', () => {
    registry.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    const first = { processFrame: vi.fn() }
    registry.registerProvider('analysis-pipeline', 'analysis', first)

    const second = { processFrame: vi.fn() }
    expect(() => registry.registerProvider('analysis-pipeline', 'analysis', second)).toThrow(
      /already registered/,
    )

    // The original provider is preserved — no partial overwrite.
    expect(registry.getSingleton('analysis-pipeline')).toBe(first)
  })

  it('hasProvider reflects the exact (capability, addonId) pair and enables idempotent re-register', () => {
    registry.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    // Unknown cap / unknown addon → false (never throws).
    expect(registry.hasProvider('nonexistent', 'x')).toBe(false)
    expect(registry.hasProvider('analysis-pipeline', 'analysis')).toBe(false)

    registry.registerProvider('analysis-pipeline', 'analysis', { processFrame: vi.fn() })
    expect(registry.hasProvider('analysis-pipeline', 'analysis')).toBe(true)
    // A different addonId on the same cap is independent.
    expect(registry.hasProvider('analysis-pipeline', 'other')).toBe(false)

    // Drop-then-register (the in-place reload pattern) must not throw.
    registry.unregisterProvider('analysis-pipeline', 'analysis')
    expect(registry.hasProvider('analysis-pipeline', 'analysis')).toBe(false)
    expect(() =>
      registry.registerProvider('analysis-pipeline', 'analysis', { processFrame: vi.fn() }),
    ).not.toThrow()
    expect(registry.hasProvider('analysis-pipeline', 'analysis')).toBe(true)
  })

  it('allows two distinct addons to register for the same singleton cap', () => {
    registry.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })

    const pipelineA = { processFrame: vi.fn() }
    const pipelineB = { processFrame: vi.fn() }
    registry.registerProvider('analysis-pipeline', 'analysis', pipelineA)
    // Different addonId → legitimate alternative provider, NOT a
    // programmer error. First-registered stays active without a user
    // preference configured.
    expect(() =>
      registry.registerProvider('analysis-pipeline', 'custom-analysis', pipelineB),
    ).not.toThrow()
    expect(registry.getSingleton('analysis-pipeline')).toBe(pipelineA)
  })
})

// `preferredProvider` makes the default active provider deterministic when no
// operator preference is persisted — instead of depending on registration
// order. Operator choice (configReader) still beats the declared default.
describe('CapabilityRegistry — singleton preferredProvider default', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.ready()
  })

  function declarePreferred(): void {
    registry.declareCapability({
      name: 'webrtc-session',
      scope: 'system',
      mode: 'singleton',
      methods: {},
      preferredProvider: 'B',
    })
  }

  it('preferred provider overrides registration order (A first, then B)', () => {
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    registry.registerProvider('webrtc-session', 'A', provA)
    // A serves until the preferred provider registers.
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('A')
    registry.registerProvider('webrtc-session', 'B', provB)
    // B (preferred) takes over even though A registered first.
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
    expect(registry.getSingleton('webrtc-session')).toBe(provB)
  })

  it('preferred provider stays active when it registers first (B then A)', () => {
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    registry.registerProvider('webrtc-session', 'B', provB)
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
    registry.registerProvider('webrtc-session', 'A', provA)
    // A is non-preferred and B already holds the slot → no change.
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
  })

  it('operator preference beats preferredProvider, regardless of order', () => {
    registry.setConfigReader((cap) => (cap === 'webrtc-session' ? 'A' : undefined))
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    // Register the preferred provider first; operator chose A. Because the
    // operator's choice is set but the registering provider (B) is not it,
    // nothing activates yet — B does NOT claim the slot ahead of the chosen A.
    registry.registerProvider('webrtc-session', 'B', provB)
    expect(registry.getSingletonAddonId('webrtc-session')).toBeNull()
    registry.registerProvider('webrtc-session', 'A', provA)
    // A arrives and matches the operator choice → A becomes active, beating
    // the preferred default B which is already registered.
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('A')
  })

  it('no preferredProvider declared → first-registered wins (unchanged)', () => {
    registry.declareCapability({
      name: 'plain-singleton',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    registry.registerProvider('plain-singleton', 'A', provA)
    registry.registerProvider('plain-singleton', 'B', provB)
    expect(registry.getSingletonAddonId('plain-singleton')).toBe('A')
  })

  it('unregistering the active preferred provider falls back to a remaining one', () => {
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    registry.registerProvider('webrtc-session', 'A', provA)
    registry.registerProvider('webrtc-session', 'B', provB)
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
    // Preferred provider leaves; non-preferred A remains → A becomes active.
    registry.unregisterProvider('webrtc-session', 'B')
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('A')
    expect(registry.getSingleton('webrtc-session')).toBe(provA)
  })

  it('re-applies preferredProvider on unregister when a non-preferred active leaves', () => {
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    // Force A active first (it registers before B), then B overrides.
    registry.registerProvider('webrtc-session', 'A', provA)
    registry.registerProvider('webrtc-session', 'B', provB)
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
    // Now manually re-point active to A to simulate a non-preferred active,
    // then unregister A: B (preferred) should be re-selected over any order.
    registry.setSingletonActiveAddon('webrtc-session', 'A')
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('A')
    registry.unregisterProvider('webrtc-session', 'A')
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
  })

  it('falls back to preferredProvider (not first-remaining) when the operator-chosen active is unregistered', () => {
    // Operator persisted choice = 'A'; cap-declared preferred = 'B'. A third
    // provider C is registered first to seed insertion order — so if the
    // fallback wrongly used first-remaining it would pick C, not B.
    registry.setConfigReader((cap) => (cap === 'webrtc-session' ? 'A' : undefined))
    declarePreferred()
    const provA = { id: 'a' }
    const provB = { id: 'b' }
    const provC = { id: 'c' }
    registry.registerProvider('webrtc-session', 'C', provC)
    registry.registerProvider('webrtc-session', 'B', provB)
    registry.registerProvider('webrtc-session', 'A', provA)
    // Operator choice A wins on arrival.
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('A')
    // The operator's chosen provider leaves: userChoice is set but its addon
    // is no longer registered → must fall back to preferred B, NOT C.
    registry.unregisterProvider('webrtc-session', 'A')
    expect(registry.getSingletonAddonId('webrtc-session')).toBe('B')
    expect(registry.getSingleton('webrtc-session')).toBe(provB)
  })
})

// Collection-provider enable/disable persistence. The `disabledProviders`
// set is in-memory only; the `CollectionConfigReader` hook lets the server
// layer feed back the operator's persisted choice so a provider disabled in
// a previous session comes back disabled after a hub reboot.
describe('CapabilityRegistry — collection provider enable/disable persistence', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
  })

  it('disable then enable mutates the disabled-set, getCollection filters accordingly', () => {
    registry.declareCapability({
      name: 'turn-relay',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })
    registry.ready()

    const provA = { id: 'a' }
    const provB = { id: 'b' }
    registry.registerProvider('turn-relay', 'addon-a', provA)
    registry.registerProvider('turn-relay', 'addon-b', provB)

    expect(registry.getCollection('turn-relay')).toEqual([provA, provB])

    registry.disableCollectionProvider('turn-relay', 'addon-a')
    expect(registry.getCollection('turn-relay')).toEqual([provB])

    registry.enableCollectionProvider('turn-relay', 'addon-a')
    expect(registry.getCollection('turn-relay')).toEqual([provA, provB])
  })

  it('restores a persisted-disabled provider as disabled on a fresh registry boot', () => {
    // Simulate a previous session: the operator disabled `addon-a`, which
    // the server layer persisted. A fresh registry boot reads it back
    // through the CollectionConfigReader hook.
    const persistedDisabled: Record<string, readonly string[]> = {
      'turn-relay': ['addon-a'],
    }
    const fresh = new CapabilityRegistry(createMockLogger())
    fresh.setCollectionConfigReader((cap) => persistedDisabled[cap])

    fresh.declareCapability({
      name: 'turn-relay',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })
    fresh.ready()

    const provA = { id: 'a' }
    const provB = { id: 'b' }
    // Registration order is irrelevant — restore happens per-provider.
    fresh.registerProvider('turn-relay', 'addon-a', provA)
    fresh.registerProvider('turn-relay', 'addon-b', provB)

    // `addon-a` comes back disabled; `addon-b` stays enabled.
    expect(fresh.getCollection('turn-relay')).toEqual([provB])
    expect(
      fresh.listCapabilities().find((c) => c.name === 'turn-relay')?.disabledProviders,
    ).toEqual(['addon-a'])
  })

  it('leaves all providers enabled when the reader returns nothing persisted', () => {
    const fresh = new CapabilityRegistry(createMockLogger())
    fresh.setCollectionConfigReader(() => undefined)

    fresh.declareCapability({
      name: 'turn-relay',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })
    fresh.ready()

    const provA = { id: 'a' }
    fresh.registerProvider('turn-relay', 'addon-a', provA)

    expect(fresh.getCollection('turn-relay')).toEqual([provA])
  })

  it('does not consult the collection reader for singleton capabilities', () => {
    const reader = vi.fn().mockReturnValue(['addon-a'])
    const fresh = new CapabilityRegistry(createMockLogger())
    fresh.setCollectionConfigReader(reader)

    fresh.declareCapability({
      name: 'analysis-pipeline',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    fresh.ready()
    fresh.registerProvider('analysis-pipeline', 'addon-a', { processFrame: vi.fn() })

    expect(reader).not.toHaveBeenCalled()
  })
})

// Event-driven wait for forked provider readiness. Used by
// `device-management.router.ts` to close the race between
// `$process.spawn` and the child's first NODE_INFO packet without a
// polling loop. See `[WAIT-EVENT]` in the 2026-04-12 handover.
describe('CapabilityRegistry — waitForProvider', () => {
  let registry: CapabilityRegistry

  beforeEach(() => {
    registry = new CapabilityRegistry(createMockLogger())
    registry.declareCapability({
      name: 'device-provider',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })
    registry.ready()
  })

  it('resolves immediately with the current provider on the happy path', async () => {
    const provider = { id: 'rtsp' }
    registry.registerProvider('device-provider', 'provider-rtsp', provider)

    const result = await registry.waitForProvider('device-provider', 'provider-rtsp', 5_000)
    expect(result).toBe(provider)
  })

  it('resolves when the matching provider registers after the wait starts', async () => {
    // Start waiting BEFORE the provider is registered.
    const waitPromise = registry.waitForProvider('device-provider', 'provider-rtsp', 5_000)

    // Simulate the child NODE_INFO arriving ~50ms later.
    const provider = { id: 'rtsp' }
    setTimeout(() => {
      registry.registerProvider('device-provider', 'provider-rtsp', provider)
    }, 10)

    const result = await waitPromise
    expect(result).toBe(provider)
  })

  it('does not resolve when a DIFFERENT addon registers', async () => {
    let resolved = false
    const waitPromise = registry
      .waitForProvider('device-provider', 'provider-rtsp', 200)
      .then((p) => {
        resolved = true
        return p
      })

    // Wrong addonId — must not unblock the wait.
    registry.registerProvider('device-provider', 'provider-onvif', { id: 'onvif' })

    const result = await waitPromise
    expect(resolved).toBe(true)
    expect(result).toBeNull() // timed out instead of resolving to the wrong provider
  })

  it('resolves to null after the timeout elapses with no matching provider', async () => {
    const start = Date.now()
    const result = await registry.waitForProvider('device-provider', 'provider-rtsp', 50)
    const elapsed = Date.now() - start

    expect(result).toBeNull()
    // Should take roughly timeoutMs — generous bounds to avoid flaky CI.
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(500)
  })

  it('supports multiple concurrent waits for the same (cap, addonId)', async () => {
    const waiter1 = registry.waitForProvider('device-provider', 'provider-rtsp', 5_000)
    const waiter2 = registry.waitForProvider('device-provider', 'provider-rtsp', 5_000)

    const provider = { id: 'rtsp' }
    registry.registerProvider('device-provider', 'provider-rtsp', provider)

    const [r1, r2] = await Promise.all([waiter1, waiter2])
    expect(r1).toBe(provider)
    expect(r2).toBe(provider)
  })
})
