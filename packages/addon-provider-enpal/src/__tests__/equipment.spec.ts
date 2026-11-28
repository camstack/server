import { DeviceType } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ENPAL_SPECS } from '../enpal-catalog.js'
import { ENPAL_EQUIPMENT, accessoryChildSpecs } from '../enpal-equipment.js'

describe('Enpal equipment', () => {
  it('every catalog entry belongs to exactly one equipment', () => {
    const claimed = ENPAL_EQUIPMENT.flatMap((e) => e.specIds)
    expect([...claimed].sort()).toEqual(ENPAL_SPECS.map((s) => s.id).sort())
  })

  it('adopting a container spawns exactly the children it was adopted with', () => {
    const specs = accessoryChildSpecs({
      equipment: 'heatpump',
      specIds: ['heatpump-hot-water', 'heatpump-outside'],
      integrationId: 'int-1',
    })
    expect(specs.map((s) => s.stableIdSuffix)).toEqual(['heatpump-hot-water', 'heatpump-outside'])
    for (const s of specs) {
      expect(s.meta.type).toBe(DeviceType.Sensor)
      expect(s.meta.integrationId).toBe('int-1')
      expect(s.config).toMatchObject({
        integrationId: 'int-1',
        system: 'enpal',
      })
    }
    expect(specs[1]?.config['specId']).toBe('heatpump-outside')
  })

  it('a persisted spec id the catalog no longer knows is skipped, not thrown', () => {
    const specs = accessoryChildSpecs({
      equipment: 'heatpump',
      specIds: ['heatpump-outside', 'gone'],
      integrationId: 'int-1',
    })
    expect(specs.map((s) => s.stableIdSuffix)).toEqual(['heatpump-outside'])
  })
})
