/**
 * Power and energy: two sensors feed ONE device (D951). The two assignments
 * share one stored feature, so the second must not replace the first, and
 * removing one must leave the other.
 */
import {
  type CompositionSourceRef,
  compileScalarOverride,
  decodeScalarOverride,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { featureOf, withoutScalarTarget, withScalarTarget } from '../customization-save'

const HOST: CompositionSourceRef = { addonId: 'provider-x', stableId: 'plug-1' }

function feature(targetId: string, stableId: string, unit: string) {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'power-meter',
      targetId,
      source: { addonId: 'provider-x', stableId, cap: 'power-meter', fieldPath: targetId },
      transform: { kind: 'identity' },
    },
    device: HOST,
    apply: 'add',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: unit,
  })
  if (!out.ok) throw new Error(out.reason)
  return out.value
}

describe('assigning two readings to one device', () => {
  const power = feature('power', 'plug-1-power', 'W')
  const energy = feature('energy', 'plug-1-energy', 'kWh')

  it('keeps the first assignment when the second is added', () => {
    const first = withScalarTarget(null, HOST, power, 'power-meter', 'power')
    const both = withScalarTarget(first, HOST, energy, 'power-meter', 'energy')
    expect(both.features).toHaveLength(1)
    for (const [targetId, stableId] of [
      ['power', 'plug-1-power'],
      ['energy', 'plug-1-energy'],
    ] as const) {
      const stored = featureOf(both, 'power-meter')
      expect(stored).not.toBeNull()
      const decoded =
        stored === null
          ? null
          : decodeScalarOverride({ feature: stored, device: HOST, cap: 'power-meter', targetId })
      expect(decoded?.draft.source.stableId).toBe(stableId)
    }
  })

  it('removes one reading and keeps the other, then the feature when none is left', () => {
    const both = withScalarTarget(
      withScalarTarget(null, HOST, power, 'power-meter', 'power'),
      HOST,
      energy,
      'power-meter',
      'energy',
    )
    const onlyEnergy = withoutScalarTarget(both, 'power-meter', 'power')
    expect(featureOf(onlyEnergy, 'power-meter')?.fields['power']).toBeUndefined()
    expect(featureOf(onlyEnergy, 'power-meter')?.fields['energy']).toBeDefined()
    expect(
      onlyEnergy === null ? null : withoutScalarTarget(onlyEnergy, 'power-meter', 'energy'),
    ).toBeNull()
  })
})
