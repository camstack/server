import { describe, expect, it, vi } from 'vitest'
import type { HmConfigParam, HmDevice } from 'nodehomematic'
import { buildCcuConfigHandlers } from '../ccu/ccu-config-actions.js'
import type { CcuFacade } from '../ccu/ccu-facade.js'
import { fakeDeps } from './ccu-fake.js'

const DEVICE: HmDevice = {
  address: 'TRV1',
  type: 'HmIP-eTRV-2',
  channels: [
    { address: 'TRV1:0', index: 0, type: 'MAINTENANCE', dataPoints: [] },
    { address: 'TRV1:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', dataPoints: [] },
  ],
}
const PARAMS: Record<string, HmConfigParam[]> = {
  'TRV1:0': [],
  'TRV1:1': [
    {
      parameter: 'TEMPERATURE_OFFSET',
      type: 'FLOAT',
      min: -3.5,
      max: 3.5,
      unit: '°C',
      flags: 1,
      writable: true,
    },
    { parameter: 'MODE', type: 'ENUM', valueList: ['A', 'B'], flags: 1, writable: true },
    { parameter: 'FIRMWARE', type: 'STRING', flags: 1, writable: false },
  ],
}

function setup(facade: Partial<CcuFacade> = {}) {
  const { deps, logger } = fakeDeps({
    devices: () => [DEVICE],
    getConfigParams: (channel) => PARAMS[channel] ?? [],
    getConfig: async () => ({ TEMPERATURE_OFFSET: 0.5, MODE: 'B' }),
    ...facade,
  })
  return { handlers: buildCcuConfigHandlers(deps), logger }
}

describe('getCcuDeviceConfig', () => {
  it('lists only channels with parameters, with current values and writability', async () => {
    const { handlers } = setup()
    const out = await handlers.getCcuDeviceConfig({ integrationId: 'hm_1', address: 'TRV1' })
    expect(out.channels.map((c) => c.channel)).toEqual(['TRV1:1'])
    const params = out.channels[0]?.params ?? []
    expect(params[0]).toMatchObject({
      parameter: 'TEMPERATURE_OFFSET',
      value: 0.5,
      min: -3.5,
      unit: '°C',
      writable: true,
    })
    expect(params[1]).toMatchObject({ valueList: ['A', 'B'], value: 'B' })
    expect(params[2]).toMatchObject({ writable: false, value: null })
  })

  it('keeps the specs and says why when the values cannot be read', async () => {
    const { handlers, logger } = setup({
      getConfig: async () => {
        throw new Error('CCU timeout')
      },
    })
    const out = await handlers.getCcuDeviceConfig({ integrationId: 'hm_1', address: 'TRV1' })
    expect(out.channels[0]?.error).toBe('CCU timeout')
    expect(out.channels[0]?.params.every((p) => p.value === null)).toBe(true)
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('refuses a device the CCU does not know', async () => {
    const { handlers } = setup()
    await expect(
      handlers.getCcuDeviceConfig({ integrationId: 'hm_1', address: 'NOPE' }),
    ).rejects.toThrow(/not known/)
  })
})

describe('setCcuChannelConfig', () => {
  it('refuses without the operator confirmation and writes nothing', async () => {
    const setConfig = vi.fn()
    const { handlers } = setup({ setConfig })
    await expect(
      handlers.setCcuChannelConfig({
        integrationId: 'hm_1',
        channel: 'TRV1:1',
        values: { MODE: 'A' },
        confirmed: false,
      }),
    ).rejects.toThrow(/confirmation/)
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('writes the edited parameters to the channel in one call', async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined)
    const { handlers } = setup({ setConfig })
    await handlers.setCcuChannelConfig({
      integrationId: 'hm_1',
      channel: 'TRV1:1',
      values: { TEMPERATURE_OFFSET: 1, MODE: 'A' },
      confirmed: true,
    })
    expect(setConfig).toHaveBeenCalledWith('TRV1:1', { TEMPERATURE_OFFSET: 1, MODE: 'A' })
  })

  it('refuses a read-only or unknown parameter before any write', async () => {
    const setConfig = vi.fn()
    const { handlers } = setup({ setConfig })
    await expect(
      handlers.setCcuChannelConfig({
        integrationId: 'hm_1',
        channel: 'TRV1:1',
        values: { FIRMWARE: 'x', GHOST: 1 },
        confirmed: true,
      }),
    ).rejects.toThrow(/FIRMWARE, GHOST/)
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('refuses an empty change', async () => {
    const { handlers } = setup({ setConfig: vi.fn() })
    await expect(
      handlers.setCcuChannelConfig({
        integrationId: 'hm_1',
        channel: 'TRV1:1',
        values: {},
        confirmed: true,
      }),
    ).rejects.toThrow(/Nothing to change/)
  })
})
