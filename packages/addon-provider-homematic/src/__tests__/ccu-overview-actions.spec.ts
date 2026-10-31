import { describe, expect, it, vi } from 'vitest'
import { buildCcuOverviewHandlers } from '../ccu/ccu-overview-actions.js'
import type { CcuFacade } from '../ccu/ccu-facade.js'
import { RecordingLogger } from './recording-logger.js'

const INFO = {
  version: '3.75.7',
  product: 'raspberrymatic',
  productFamily: 'openccu' as const,
  platform: 'rpi4',
  serial: 'SER1',
  hostname: 'homematic',
}
const IFACE = {
  name: 'HmIP-RF',
  port: 2010,
  info: 'HmIP',
  connected: true,
  dutyCycle: 4,
  firmware: '2.8.6',
  type: 'HmIP',
  gateways: [],
}

function setup(facade: Partial<CcuFacade> | null) {
  const logger = new RecordingLogger()
  const handlers = buildCcuOverviewHandlers({
    facade: (id) => (id === 'hm_1' && facade !== null ? (facade as CcuFacade) : null),
    integrations: () => [
      { integrationId: 'hm_1', name: 'Casa', connected: true },
      { integrationId: 'hm_2', name: 'Cabin', connected: false },
    ],
    logger,
  })
  return { handlers, logger }
}

describe('listCcus', () => {
  it('lists every integration with its connection state', async () => {
    const { handlers } = setup(null)
    expect(await handlers.listCcus({})).toEqual([
      { integrationId: 'hm_1', name: 'Casa', connected: true },
      { integrationId: 'hm_2', name: 'Cabin', connected: false },
    ])
  })
})

describe('ccuOverview', () => {
  it('returns info and interfaces', async () => {
    const { handlers } = setup({
      ccuInfo: vi.fn().mockResolvedValue(INFO),
      listInterfaces: vi.fn().mockResolvedValue([IFACE]),
    })
    const out = await handlers.ccuOverview({ integrationId: 'hm_1' })
    expect(out.info).toEqual(INFO)
    expect(out.infoError).toBeNull()
    expect(out.interfaces).toEqual([IFACE])
  })

  it('keeps the interfaces when the info call fails and names why', async () => {
    const { handlers } = setup({
      ccuInfo: vi.fn().mockRejectedValue(new Error('credentials required')),
      listInterfaces: vi.fn().mockResolvedValue([IFACE]),
    })
    const out = await handlers.ccuOverview({ integrationId: 'hm_1' })
    expect(out.info).toBeNull()
    expect(out.infoError).toBe('credentials required')
    expect(out.interfaces).toHaveLength(1)
  })

  it('keeps the info when the interface call fails', async () => {
    const { handlers } = setup({
      ccuInfo: vi.fn().mockResolvedValue(INFO),
      listInterfaces: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const out = await handlers.ccuOverview({ integrationId: 'hm_1' })
    expect(out.interfaces).toEqual([])
    expect(out.interfacesError).toBe('boom')
    expect(out.info).toEqual(INFO)
  })

  it('refuses an integration that is not connected', async () => {
    const { handlers } = setup(null)
    await expect(handlers.ccuOverview({ integrationId: 'hm_2' })).rejects.toThrow(/not connected/i)
  })
})

describe('service messages', () => {
  const MSG = {
    id: '1234',
    name: 'Lamp',
    address: 'ABC',
    channel: 0,
    type: 'STICKY_UNREACH',
    timestamp: 1_700_000_000_000,
    acknowledgeable: true,
  }

  it('lists the messages', async () => {
    const { handlers } = setup({ serviceMessages: vi.fn().mockResolvedValue([MSG]) })
    expect(await handlers.listServiceMessages({ integrationId: 'hm_1' })).toEqual({
      messages: [MSG],
      error: null,
    })
  })

  it('reports why the list is empty when the CCU did not answer', async () => {
    const { handlers } = setup({
      serviceMessages: vi.fn().mockRejectedValue(new Error('needs WebUI credentials')),
    })
    expect(await handlers.listServiceMessages({ integrationId: 'hm_1' })).toEqual({
      messages: [],
      error: 'needs WebUI credentials',
    })
  })

  it('acknowledges a message and logs it', async () => {
    const acknowledgeServiceMessage = vi.fn().mockResolvedValue(undefined)
    const { handlers, logger } = setup({ acknowledgeServiceMessage })
    const out = await handlers.acknowledgeServiceMessage({
      integrationId: 'hm_1',
      id: '1234',
      confirmed: true,
    })
    expect(out).toEqual({ ok: true })
    expect(acknowledgeServiceMessage).toHaveBeenCalledWith('1234')
    expect(logger.lines.some((l) => /acknowledg/i.test(l.message))).toBe(true)
  })

  it('refuses to acknowledge without the operator confirmation', async () => {
    const acknowledgeServiceMessage = vi.fn()
    const { handlers } = setup({ acknowledgeServiceMessage })
    await expect(
      handlers.acknowledgeServiceMessage({ integrationId: 'hm_1', id: '1', confirmed: false }),
    ).rejects.toThrow(/confirm/i)
    expect(acknowledgeServiceMessage).not.toHaveBeenCalled()
  })
})
