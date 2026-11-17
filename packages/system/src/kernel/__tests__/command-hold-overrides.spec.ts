/**
 * A provider's command-hold options reach the hub (D1061): by the child's cap
 * descriptors on the UDS road, replaced whole per register frame, dropped with
 * the child.
 */
import { describe, expect, it } from 'vitest'
import {
  childCommandHoldEntries,
  childHoldSource,
  CommandHoldOverrideRegistry,
  IN_PROCESS_HOLD_SOURCE,
} from '../command-hold-overrides.js'
import { buildChildCapDescriptors } from '../moleculer/child-cap-descriptors.js'

describe('command-hold options (D1061)', () => {
  it("travel on a forked child's device descriptors and only on those that stated any", () => {
    const caps = buildChildCapDescriptors(
      [],
      [
        {
          capName: 'switch',
          addonId: 'provider-x',
          deviceIds: [1, 2],
          commandHolds: new Map([[2, { setState: { hold: 'never' } }]]),
        },
      ],
    )
    expect(caps).toEqual([
      { capName: 'switch', mode: 'collection', deviceId: 1, addonId: 'provider-x' },
      {
        capName: 'switch',
        mode: 'collection',
        deviceId: 2,
        addonId: 'provider-x',
        commandHolds: { setState: { hold: 'never' } },
      },
    ])
    expect(childCommandHoldEntries(caps)).toEqual([
      { deviceId: 2, capName: 'switch', commands: { setState: { hold: 'never' } } },
    ])
  })

  it("replaces a child's whole set on every register frame and forgets it when the child goes", () => {
    const registry = new CommandHoldOverrideRegistry()
    const source = childHoldSource('runner-a')
    registry.replaceSource(source, [
      { deviceId: 1, capName: 'switch', commands: { setState: { holdMs: 5_000 } } },
      { deviceId: 2, capName: 'switch', commands: { setState: { hold: 'never' } } },
    ])
    expect(registry.get(2, 'switch')).toEqual({ setState: { hold: 'never' } })
    registry.replaceSource(source, [
      { deviceId: 1, capName: 'switch', commands: { setState: { holdMs: 5_000 } } },
    ])
    expect(registry.get(2, 'switch')).toBeUndefined()
    expect(registry.get(1, 'switch')).toEqual({ setState: { holdMs: 5_000 } })
    registry.replaceSource(source, [])
    expect(registry.get(1, 'switch')).toBeUndefined()
  })

  it('keeps an in-process registration apart from a child, and forgets it on delete', () => {
    const registry = new CommandHoldOverrideRegistry()
    registry.set(IN_PROCESS_HOLD_SOURCE, {
      deviceId: 3,
      capName: 'fan-control',
      commands: { setPercentage: { holdMs: 60_000 } },
    })
    registry.replaceSource(childHoldSource('runner-a'), [])
    expect(registry.get(3, 'fan-control')).toEqual({ setPercentage: { holdMs: 60_000 } })
    registry.delete(IN_PROCESS_HOLD_SOURCE, 3, 'fan-control')
    expect(registry.get(3, 'fan-control')).toBeUndefined()
  })
})
