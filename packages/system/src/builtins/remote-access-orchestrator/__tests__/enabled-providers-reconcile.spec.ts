/**
 * D8 delivery-rule fix — unit tests for the durable `enabledProviders`
 * RPC-driven reconcile core.
 *
 * The reconcile is ADD-ONLY (see enabled-providers-reconcile.ts module
 * doc). The key invariant: `connected: true` from an acked RPC is the
 * only signal that causes a write — `connected: false` is ambiguous
 * (registered-not-yet-started vs transiently-down vs operator-stopped)
 * and must never evict a provider. Removal stays event-driven
 * (`NetworkTunnelStopped`).
 *
 * Each test either:
 *   - simulates a dropped `NetworkTunnelStarted` event and asserts that
 *     the reconcile recovers it (add path), or
 *   - asserts that `connected: false` / failed RPC / absent probe leaves
 *     the set UNCHANGED (no false eviction).
 */
import { describe, it, expect } from 'vitest'
import {
  reconcileEnabledProviders,
  type ProviderProbeResult,
} from '../enabled-providers-reconcile.js'

describe('reconcileEnabledProviders', () => {
  it('dropped NetworkTunnelStarted: connected provider missing from set is ADDED', () => {
    // Event lost → tunnel is running but not recorded.
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: true },
    ]
    const result = reconcileEnabledProviders([], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel'])
    expect(result.added).toEqual(['cloudflare-tunnel'])
    expect(result.removed).toEqual([])
    expect(result.changed).toBe(true)
  })

  it('a registered-but-not-yet-started provider (connected:false) is NOT evicted — operator intent survives a hub restart', () => {
    // This is the core bug scenario:
    // 1. cloudflare-tunnel re-registers (~15-20 s after boot) → onReady fires.
    // 2. autoStartEnabledProviders → reconcileAndPersist runs FIRST.
    // 3. getStatus() returns connected:false (registered, not started yet).
    // OLD (buggy) behaviour: reconcile REMOVED cloudflare-tunnel from
    //   enabledProviders → autostart then found an empty list → nothing started.
    // CORRECT behaviour: connected:false is ambiguous — leave set unchanged.
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: false },
    ]
    const result = reconcileEnabledProviders(['cloudflare-tunnel'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel'])
    expect(result.removed).toEqual([])
    expect(result.added).toEqual([])
    expect(result.changed).toBe(false)
  })

  it('connected:false for a provider NOT in the enabled-set also leaves the set unchanged', () => {
    // Verify the add-only invariant from the other direction:
    // a disconnected provider that was never enabled must not be added or
    // cause any other mutation.
    const probes: ProviderProbeResult[] = [
      { addonId: 'tailscale-ingress', ok: true, connected: false },
    ]
    const result = reconcileEnabledProviders(['cloudflare-tunnel'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel'])
    expect(result.changed).toBe(false)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('no-op when the already-enabled provider is confirmed connected (idempotent add)', () => {
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: true },
    ]
    const result = reconcileEnabledProviders(['cloudflare-tunnel'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel'])
    expect(result.changed).toBe(false)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('a FAILED RPC probe leaves the provider membership untouched (no lossy write)', () => {
    // Provider transiently unreachable — its state is unknown, so an
    // enabled-but-currently-unreachable provider must NOT be evicted.
    const probes: ProviderProbeResult[] = [{ addonId: 'cloudflare-tunnel', ok: false }]
    const result = reconcileEnabledProviders(['cloudflare-tunnel'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel'])
    expect(result.changed).toBe(false)
  })

  it('a provider absent from the probe set is left enabled (not-yet-booted is not eviction)', () => {
    // tailscale-ingress hasn't registered yet this pass — only
    // cloudflare-tunnel was probed. tailscale-ingress must survive.
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: true },
    ]
    const result = reconcileEnabledProviders(['cloudflare-tunnel', 'tailscale-ingress'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel', 'tailscale-ingress'])
    expect(result.changed).toBe(false)
  })

  it('adds a newly-connected provider while leaving a disconnected one in the set', () => {
    // Mixed probe: cloudflare-tunnel just connected (dropped Started event),
    // tailscale-ingress is disconnected (registered-not-yet-started or blip)
    // — only the add fires, tailscale-ingress stays in.
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: true }, // dropped Started
      { addonId: 'tailscale-ingress', ok: true, connected: false }, // ambiguous — leave
    ]
    const result = reconcileEnabledProviders(['tailscale-ingress'], probes)

    expect(result.nextEnabled).toEqual(['cloudflare-tunnel', 'tailscale-ingress'])
    expect(result.added).toEqual(['cloudflare-tunnel'])
    expect(result.removed).toEqual([])
    expect(result.changed).toBe(true)
  })

  it('result is idempotent — re-running on the corrected set is a no-op', () => {
    const probes: ProviderProbeResult[] = [
      { addonId: 'cloudflare-tunnel', ok: true, connected: true },
      { addonId: 'tailscale-ingress', ok: true, connected: false },
    ]
    const first = reconcileEnabledProviders(['tailscale-ingress'], probes)
    const second = reconcileEnabledProviders(first.nextEnabled, probes)

    expect(second.nextEnabled).toEqual(first.nextEnabled)
    expect(second.changed).toBe(false)
  })

  it('output is sorted for stable persistence regardless of probe order', () => {
    const probes: ProviderProbeResult[] = [
      { addonId: 'ngrok', ok: true, connected: true },
      { addonId: 'cloudflare-tunnel', ok: true, connected: true },
    ]
    const result = reconcileEnabledProviders([], probes)
    expect(result.nextEnabled).toEqual(['cloudflare-tunnel', 'ngrok'])
  })
})
