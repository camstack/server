import { describe, expect, it } from 'vitest'
import { projectSourceInfo } from '../device-projection.js'

const STABLE_ID = 'enpal:int_0041:box-box-cpu-load'

describe('projectSourceInfo', () => {
  it('keeps the quantity a provider stored at adopt next to the identity read from the config', () => {
    const info = projectSourceInfo(
      { system: 'enpal', integrationId: 'int_0041' },
      STABLE_ID,
      'provider-enpal',
      { sourceInfo: { id: 'int_0041:box-cpu-load', system: 'enpal', quantity: 'percentage' } },
    )
    // Identity (the dispatch key) stays the config's; only the display hints are added.
    expect(info).toEqual({ id: STABLE_ID, system: 'enpal', quantity: 'percentage' })
  })

  it('keeps the date shape of a string reading', () => {
    const info = projectSourceInfo({ entityId: 'sensor.x', system: 'ha' }, STABLE_ID, 'a', {
      sourceInfo: { id: 'sensor.x', system: 'ha', dateTimeShape: 'date' },
    })
    expect(info).toEqual({ id: 'sensor.x', system: 'ha', dateTimeShape: 'date' })
  })

  it('stays identity-only when nothing was stored', () => {
    expect(projectSourceInfo({ entityId: 'sensor.x', system: 'ha' }, STABLE_ID, 'a', null)).toEqual(
      { id: 'sensor.x', system: 'ha' },
    )
  })

  it('stays absent when there is no identity and no stored hint', () => {
    expect(projectSourceInfo({ url: 'rtsp://cam' }, STABLE_ID, 'rtsp', {})).toBeUndefined()
  })

  it('gives a device with a stored quantity but no config identity the synthetic identity', () => {
    const info = projectSourceInfo({}, STABLE_ID, 'composer', {
      sourceInfo: { id: 'x', system: 'composer', quantity: 'power' },
    })
    expect(info).toEqual({ id: STABLE_ID, system: 'composer', quantity: 'power' })
  })
})
