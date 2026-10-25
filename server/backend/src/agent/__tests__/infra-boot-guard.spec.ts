/**
 * The agent must refuse to boot when a REQUIRED infrastructure capability
 * resolved to no addon at all.
 *
 * Regression: 2026-08-07. `/data/addons/@camstack/system` on `agent-a`
 * was renamed away; on an agent that directory is the ONLY source of the
 * builtins, so the next boot came up with zero infra addons — no storage, no
 * settings-store, no `platform-probe`, and no `hub-forwarder` (which is what
 * ships an agent's logs to the hub, so the failure could not even be seen
 * remotely). The node reported healthy for five hours; the only symptom was
 * `getNodeInferenceDevices → reachable:false` on the hub, because the node's
 * manifest legitimately no longer carried `platform-probe`.
 */
import { describe, expect, it } from 'vitest'
import { assertRequiredInfraResolved } from '../infra-boot-guard.js'
import type { InfraResolution } from '../infra-boot-guard.js'

const ADDONS_DIR = '/data/addons'

describe('assertRequiredInfraResolved', () => {
  it('passes when every required capability resolved to an addon', () => {
    const resolutions: readonly InfraResolution[] = [
      { name: 'storage-provider', required: true, addonId: 'filesystem-storage' },
      { name: 'data-store-provider', required: true, addonId: 'sqlite-settings' },
      { name: 'storage', required: true, addonId: 'storage-orchestrator' },
      { name: 'settings-store', required: true, addonId: 'storage-orchestrator' },
      { name: 'log-destination', required: false, addonId: 'hub-forwarder' },
      { name: 'metrics-provider', required: false, addonId: 'metrics-native' },
      { name: 'platform-probe', required: false, addonId: 'platform-probe' },
    ]
    expect(() => assertRequiredInfraResolved(resolutions, ADDONS_DIR)).not.toThrow()
  })

  it('tolerates a missing OPTIONAL capability — those nodes are legitimate', () => {
    const resolutions: readonly InfraResolution[] = [
      { name: 'storage-provider', required: true, addonId: 'filesystem-storage' },
      { name: 'platform-probe', required: false, addonId: null },
    ]
    expect(() => assertRequiredInfraResolved(resolutions, ADDONS_DIR)).not.toThrow()
  })

  it('throws when a required capability resolved to nothing', () => {
    const resolutions: readonly InfraResolution[] = [
      { name: 'storage-provider', required: true, addonId: null },
      { name: 'log-destination', required: false, addonId: 'hub-forwarder' },
    ]
    expect(() => assertRequiredInfraResolved(resolutions, ADDONS_DIR)).toThrow(/storage-provider/)
  })

  it('names EVERY missing required capability in one throw, not just the first', () => {
    // The exact shape agent-a booted with on 2026-08-07T18:57:58Z: the
    // four required infra caps vanished together, for one single reason.
    const resolutions: readonly InfraResolution[] = [
      { name: 'storage-provider', required: true, addonId: null },
      { name: 'data-store-provider', required: true, addonId: null },
      { name: 'storage', required: true, addonId: null },
      { name: 'settings-store', required: true, addonId: null },
      { name: 'log-destination', required: false, addonId: null },
      { name: 'metrics-provider', required: false, addonId: null },
      { name: 'platform-probe', required: false, addonId: null },
    ]
    let message = ''
    try {
      assertRequiredInfraResolved(resolutions, ADDONS_DIR)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('storage-provider')
    expect(message).toContain('data-store-provider')
    expect(message).toContain('storage')
    expect(message).toContain('settings-store')
    // The operator needs to know WHERE we looked — the whole failure was one
    // renamed directory.
    expect(message).toContain(ADDONS_DIR)
    // Optional misses must not be named as the reason for the abort.
    expect(message).not.toContain('platform-probe')
  })
})
