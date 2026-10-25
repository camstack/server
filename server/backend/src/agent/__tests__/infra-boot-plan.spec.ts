/**
 * The plan behind `bootCoreAddons` — resolution per capability,
 * initialization per ADDON. The dedupe is the load-bearing part: since D44
 * `storage-orchestrator` serves both `storage` and `settings-store`, and
 * initializing it once per capability re-registers the same provider — the
 * registry's double-registration throw, promoted to a boot abort by D87,
 * crash-looped both agents on 2026-08-08.
 */
import { describe, it, expect } from 'vitest'
import { planInfraBoot, planToResolutions } from '../infra-boot-plan.js'

const INFRA = [
  { name: 'storage-provider', required: true },
  { name: 'data-store-provider', required: true },
  { name: 'storage', required: true },
  { name: 'settings-store', required: true },
  { name: 'log-destination', required: false },
] as const

describe('planInfraBoot', () => {
  it('initializes an addon serving TWO capabilities exactly once — the D44×D87 crash', () => {
    const plan = planInfraBoot(
      [
        { id: 'filesystem-storage', capabilities: ['storage-provider'] },
        { id: 'sqlite-settings', capabilities: ['data-store-provider'] },
        { id: 'storage-orchestrator', capabilities: ['storage', 'settings-store'] },
      ],
      INFRA,
    )
    const orchestratorInits = plan.filter(
      (s) => s.addonId === 'storage-orchestrator' && s.initialize,
    )
    expect(orchestratorInits).toHaveLength(1)
    expect(orchestratorInits[0]?.capName).toBe('storage')
    // The second capability still RESOLVES — the guard must see it served.
    const settingsStep = plan.find((s) => s.capName === 'settings-store')
    expect(settingsStep).toEqual({
      capName: 'settings-store',
      required: true,
      addonId: 'storage-orchestrator',
      initialize: false,
    })
  })

  it('records a missing capability as unresolved, never as initializable', () => {
    const plan = planInfraBoot([], INFRA)
    expect(plan.every((s) => s.addonId === null && !s.initialize)).toBe(true)
    const resolutions = planToResolutions(plan)
    expect(resolutions.filter((r) => r.required && r.addonId === null)).toHaveLength(4)
  })

  it('prefers hub-forwarder for log-destination', () => {
    const plan = planInfraBoot(
      [
        { id: 'winston-logging', capabilities: ['log-destination'] },
        { id: 'hub-forwarder', capabilities: ['log-destination'] },
      ],
      [{ name: 'log-destination', required: false }],
    )
    expect(plan[0]?.addonId).toBe('hub-forwarder')
  })
})
