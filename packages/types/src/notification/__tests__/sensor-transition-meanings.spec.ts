import { describe, expect, it } from 'vitest'

import { NC_SENSOR_TRANSITION_KINDS } from '../sensor-raised'
import {
  NC_SENSOR_TRANSITION_MEANINGS,
  sensorTransitionMeaning,
} from '../sensor-transition-meanings'

describe('NC_SENSOR_TRANSITION_MEANINGS', () => {
  it.each(NC_SENSOR_TRANSITION_KINDS)('%s has starts and finishes in en and it', (kind) => {
    const meaning = NC_SENSOR_TRANSITION_MEANINGS[kind]
    expect(meaning).toBeDefined()
    for (const edge of [meaning?.starts, meaning?.finishes]) {
      expect(edge?.en.trim().length).toBeGreaterThan(0)
      expect(edge?.it.trim().length).toBeGreaterThan(0)
    }
  })

  it('has no entry for a kind that has no raise', () => {
    expect(Object.keys(NC_SENSOR_TRANSITION_MEANINGS).sort()).toEqual(
      [...NC_SENSOR_TRANSITION_KINDS].sort(),
    )
    expect(sensorTransitionMeaning('doorbell')).toBeUndefined()
    expect(sensorTransitionMeaning(' Flood ')?.finishes.en).toBe('dry again')
  })
})
