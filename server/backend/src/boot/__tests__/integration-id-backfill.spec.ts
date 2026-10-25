import { describe, it, expect } from 'vitest'
import {
  planIntegrationIdBackfill,
  planDeleteTimeStamps,
  runIntegrationIdBackfill,
} from '../integration-id-backfill'

describe('planDeleteTimeStamps', () => {
  it("claims an untagged top-level device of the deleted integration's single-integration addon", () => {
    const stamps = planDeleteTimeStamps(
      'int_rtsp',
      [{ id: 'int_rtsp', addonId: 'provider-rtsp' }],
      [
        { id: 4, addonId: 'provider-rtsp', parentDeviceId: null },
        { id: 6, addonId: 'provider-rtsp', parentDeviceId: null },
      ],
    )
    expect(stamps).toEqual([
      { deviceId: 4, integrationId: 'int_rtsp' },
      { deviceId: 6, integrationId: 'int_rtsp' },
    ])
  })

  it('returns no stamps for a multi-integration addon (ambiguous — never auto-claim)', () => {
    const stamps = planDeleteTimeStamps(
      'int_a',
      [
        { id: 'int_a', addonId: 'provider-ha' },
        { id: 'int_b', addonId: 'provider-ha' },
      ],
      [{ id: 11, addonId: 'provider-ha', parentDeviceId: null }],
    )
    expect(stamps).toEqual([])
  })

  it('only returns stamps for the integration being deleted, not siblings of other addons', () => {
    const stamps = planDeleteTimeStamps(
      'int_rtsp',
      [
        { id: 'int_rtsp', addonId: 'provider-rtsp' },
        { id: 'int_onvif', addonId: 'provider-onvif' },
      ],
      [
        { id: 4, addonId: 'provider-rtsp', parentDeviceId: null },
        { id: 5, addonId: 'provider-onvif', parentDeviceId: null },
      ],
    )
    expect(stamps).toEqual([{ deviceId: 4, integrationId: 'int_rtsp' }])
  })

  it('skips devices already tagged with the deleted integration', () => {
    const stamps = planDeleteTimeStamps(
      'int_rtsp',
      [{ id: 'int_rtsp', addonId: 'provider-rtsp' }],
      [{ id: 4, addonId: 'provider-rtsp', parentDeviceId: null, integrationId: 'int_rtsp' }],
    )
    expect(stamps).toEqual([])
  })
})

describe('planIntegrationIdBackfill', () => {
  it('stamps a top-level untagged device whose addon has exactly one integration', () => {
    const stamps = planIntegrationIdBackfill(
      [{ id: 'int_1', addonId: 'provider-rtsp' }],
      [{ id: 10, addonId: 'provider-rtsp', parentDeviceId: null }],
    )
    expect(stamps).toEqual([{ deviceId: 10, integrationId: 'int_1' }])
  })

  it('skips devices whose addon hosts multiple integrations (ambiguous)', () => {
    const stamps = planIntegrationIdBackfill(
      [
        { id: 'int_a', addonId: 'provider-ha' },
        { id: 'int_b', addonId: 'provider-ha' },
      ],
      [{ id: 11, addonId: 'provider-ha', parentDeviceId: null }],
    )
    expect(stamps).toEqual([])
  })

  it('skips already-tagged devices and child devices', () => {
    const stamps = planIntegrationIdBackfill(
      [{ id: 'int_1', addonId: 'provider-rtsp' }],
      [
        { id: 12, addonId: 'provider-rtsp', parentDeviceId: null, integrationId: 'int_1' },
        { id: 13, addonId: 'provider-rtsp', parentDeviceId: 12 },
      ],
    )
    expect(stamps).toEqual([])
  })

  it('skips devices whose addon has no integration', () => {
    const stamps = planIntegrationIdBackfill(
      [{ id: 'int_1', addonId: 'provider-rtsp' }],
      [{ id: 14, addonId: 'provider-onvif', parentDeviceId: null }],
    )
    expect(stamps).toEqual([])
  })
})

describe('runIntegrationIdBackfill', () => {
  it('applies stamps and reports the count, skipping failures', async () => {
    const stamped: Array<{ deviceId: number; integrationId: string }> = []
    const result = await runIntegrationIdBackfill({
      listIntegrations: async () => [{ id: 'int_1', addonId: 'provider-rtsp' }],
      listDevices: async () => [
        { id: 10, addonId: 'provider-rtsp', parentDeviceId: null },
        { id: 11, addonId: 'provider-rtsp', parentDeviceId: null },
      ],
      setIntegrationId: async (deviceId, integrationId) => {
        if (deviceId === 11) throw new Error('boom')
        stamped.push({ deviceId, integrationId })
      },
      logger: { info: () => {}, warn: () => {} },
    })
    expect(result).toEqual({ stamped: 1 })
    expect(stamped).toEqual([{ deviceId: 10, integrationId: 'int_1' }])
  })

  it('does nothing when there is nothing to stamp', async () => {
    const result = await runIntegrationIdBackfill({
      listIntegrations: async () => [],
      listDevices: async () => [],
      setIntegrationId: async () => {
        throw new Error('should not be called')
      },
      logger: { info: () => {}, warn: () => {} },
    })
    expect(result).toEqual({ stamped: 0 })
  })
})
