import { describe, expect, it } from 'vitest'
import type { HmChannel, HmDataPoint, HmDevice, HmValue } from 'nodehomematic'
import { buildCcuFaultHandlers, faultSince } from '../ccu/ccu-faults-actions.js'
import { fakeDeps } from './ccu-fake.js'

function dp(parameter: string, value: HmValue): HmDataPoint {
  return {
    id: parameter.toLowerCase(),
    parameter,
    type: 'BOOL',
    value,
    readable: true,
    writable: false,
    hasEvents: true,
  }
}
function device(address: string, name: string | null, params: Record<string, HmValue>): HmDevice {
  const maintenance: HmChannel = {
    address: `${address}:0`,
    index: 0,
    name: null,
    type: 'MAINTENANCE',
    dataPoints: Object.entries(params).map(([k, v]) => dp(k, v)),
  }
  return { address, type: 'HmIP-eTRV-2', channels: [maintenance], name }
}

describe('listCcuFaults', () => {
  it('lists one row per faulty device, errors above warnings, with the principal fault', async () => {
    const { deps } = fakeDeps({
      devices: () => [
        device('WARN', 'Battery one', { LOW_BAT: true, UNREACH: false }),
        device('FINE', 'Healthy', { LOW_BAT: false, UNREACH: false }),
        device('ERR', 'Lost one', { LOW_BAT: true, UNREACH: true }),
      ],
      serviceMessages: async () => [],
    })
    const out = await buildCcuFaultHandlers(deps).listCcuFaults({
      integrationId: 'hm_1',
    })
    expect(out.faults.map((row) => [row.address, row.severity, row.code])).toEqual([
      ['ERR', 'error', 'UNREACH'],
      ['WARN', 'warning', 'LOW_BAT'],
    ])
    expect(out.faults[0]?.faults.map((fault) => fault.code)).toEqual(['UNREACH', 'LOW_BAT'])
  })

  it('names a device whose flags the CCU never reported instead of dropping it (unknown is not "fine")', async () => {
    const { deps } = fakeDeps({
      devices: () => [device('NEW', null, {})],
      serviceMessages: async () => [],
    })
    const out = await buildCcuFaultHandlers(deps).listCcuFaults({
      integrationId: 'hm_1',
    })
    expect(out.faults).toEqual([])
    expect(out.unreported).toEqual(['NEW'])
  })

  it('carries the adopted Dominevo device id and the since of the matching service message', async () => {
    const { deps } = fakeDeps({
      devices: () => [device('ABC', 'Lamp', { UNREACH: true })],
      serviceMessages: async () => [
        {
          id: 'm',
          name: 'Lamp',
          address: 'ABC:0',
          channel: 0,
          type: 'UNREACH',
          timestamp: 1700,
          acknowledgeable: false,
        },
      ],
    })
    const adopted = {
      ...deps,
      adoptedAddresses: async () => new Map([['ABC', 42]]),
    }
    const out = await buildCcuFaultHandlers(adopted).listCcuFaults({
      integrationId: 'hm_1',
    })
    expect(out.faults[0]).toMatchObject({ deviceId: 42, since: 1700 })
  })

  it('still answers when only the since lookup fails, and refuses a CCU that is not connected', async () => {
    const { deps, logger } = fakeDeps({
      devices: () => [device('ABC', 'Lamp', { UNREACH: true })],
      serviceMessages: async () => {
        throw new Error('no credentials')
      },
    })
    const handlers = buildCcuFaultHandlers(deps)
    const out = await handlers.listCcuFaults({ integrationId: 'hm_1' })
    expect(out.faults[0]?.since).toBeNull()
    expect(
      logger.lines.some((line) => line.level === 'warn' && /service messages/.test(line.message)),
    ).toBe(true)
    await expect(handlers.listCcuFaults({ integrationId: 'nope' })).rejects.toThrow(/not connected/)
  })
})

describe('faultSince', () => {
  it('needs the same code on the same device', () => {
    const messages = [
      { address: 'ABC:0', type: 'LOW_BAT', timestamp: 5 },
      { address: 'ABD:0', type: 'UNREACH', timestamp: 6 },
    ]
    expect(faultSince('ABC', 'UNREACH', messages)).toBeNull()
    expect(faultSince('ABC', 'LOW_BAT', messages)).toBe(5)
  })
})
