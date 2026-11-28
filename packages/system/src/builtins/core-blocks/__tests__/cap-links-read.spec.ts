import { compositionSourceKey, type Composition } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  HOST_ID,
  HOST_REF,
  METER_ID,
  METER_REF,
  block,
  capLinksWorld,
} from './cap-links-fixtures.js'

const LINKED: Composition = {
  target: { kind: 'existing', device: HOST_REF },
  features: [{ kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: METER_REF }],
}

describe('CapLinksService.read (D1076)', () => {
  it('answers not-loaded until the compositions were read, never an empty list (D315)', async () => {
    const world = capLinksWorld(null)
    expect(await world.service.read(HOST_ID)).toEqual({ status: 'not-loaded' })
  })

  it('names each link with its source device and state', async () => {
    const world = capLinksWorld([block('b1', LINKED)])
    expect(await world.service.read(HOST_ID)).toEqual({
      status: 'ok',
      links: [
        {
          linkId: 'meter-device',
          cap: 'power-meter',
          slot: null,
          mode: 'project',
          source: { deviceId: METER_ID, cap: 'power-meter' },
          state: 'linked',
        },
      ],
    })
  })

  it('reports a disabled link as disabled', async () => {
    const [feature] = LINKED.features
    if (feature === undefined || feature.kind !== 'capLink') throw new Error('fixture')
    const world = capLinksWorld([
      block('b1', { ...LINKED, features: [{ ...feature, enabled: false }] }),
    ])
    const read = await world.service.read(HOST_ID)
    expect(read.status === 'ok' && read.links[0]?.state).toBe('disabled')
  })

  it('reports source-gone with a null device id and logs it once, tagged with the host', async () => {
    const world = capLinksWorld([block('b1', LINKED)])
    world.devices.delete(compositionSourceKey(METER_REF))
    const first = await world.service.read(HOST_ID)
    await world.service.read(HOST_ID)
    expect(first.status === 'ok' && first.links[0]).toMatchObject({
      state: 'source-gone',
      source: { deviceId: null },
    })
    expect(world.log.warn).toHaveBeenCalledTimes(1)
    expect(world.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('source device is gone'),
      expect.objectContaining({ tags: { deviceId: HOST_ID } }),
    )
  })

  it('an unlinked device has no links', async () => {
    const world = capLinksWorld([])
    expect(await world.service.read(HOST_ID)).toEqual({ status: 'ok', links: [] })
  })
})
