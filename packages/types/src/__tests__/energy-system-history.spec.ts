import { describe, expect, it } from 'vitest'
import { energySystemCapability } from '../capabilities/energy-system.cap'
import { HISTORY_CATALOG } from '../generated/history-catalog'

describe('energy-system history', () => {
  it('records every storage reading the slice carries that is not a derived day total', () => {
    const keys = Object.keys(energySystemCapability.history.fields)
    for (const key of [
      'storage.stateOfChargePct',
      'storage.storedKwh',
      'storage.capacityKwh',
      'storage.powerW',
      'storage.chargedKwh',
      'storage.dischargedKwh',
      'storage.healthPct',
    ]) {
      expect(keys).toContain(key)
    }
  })

  it('projects the storage capacity into the generated catalog as a gauge in kWh', () => {
    expect(HISTORY_CATALOG['energy-system']?.['storage.capacityKwh']).toMatchObject({
      kind: 'gauge',
      unit: 'kWh',
    })
  })
})
