import { afterEach, describe, expect, it } from 'vitest'
import { DeviceType, readErrorI18n } from '@camstack/types'
import { ESP_IR_MAX_TIMINGS, EspIrTransmitterDevice } from '../devices/esp-ir-transmitter-device.js'
import { espLinkHub } from '../esphome-link-hub.js'
import { FakeLink } from './fake-link.js'
import { makeCtx, type LogLine } from './fake-ctx.js'

const BROKER = 'esp_ir_test'
const TRAIN = [9000, -4500, 560, -560]

interface Setup {
  readonly device: EspIrTransmitterDevice
  readonly link: FakeLink
  readonly lines: LogLine[]
  readonly providers: Map<string, unknown>
}

function setup(config: Record<string, unknown> = {}, connected = true): Setup {
  const lines: LogLine[] = []
  const link = new FakeLink([])
  link.services = [
    {
      name: 'send_raw_command',
      key: 1,
      args: [
        { name: 'command', type: 'int[]' },
        ...(config['carrierArg'] === 'carrier_frequency'
          ? [{ name: 'carrier_frequency', type: 'int' as const }]
          : []),
      ],
    },
  ]
  if (connected) espLinkHub.attach(BROKER, link)
  const { ctx, providers } = makeCtx(
    {
      brokerId: BROKER,
      service: 'send_raw_command',
      timingsArg: 'command',
      media: ['ir'],
      ...config,
    },
    { type: DeviceType.Generic, logs: lines },
  )
  return { device: new EspIrTransmitterDevice(ctx), link, lines, providers }
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
  } catch (err: unknown) {
    return readErrorI18n(err)?.code ?? 'untyped'
  }
  return null
}

afterEach(() => espLinkHub.clear())

describe('EspIrTransmitterDevice', () => {
  it('registers the ir-transmitter cap', () => {
    expect(setup().providers.has('ir-transmitter')).toBe(true)
  })

  it('sends the pulse train through the board service', async () => {
    const { device, link } = setup()
    const result = await device.transmit(TRAIN)
    expect(result).toEqual({ ok: true, ignoredSettings: [] })
    expect(link.serviceCalls).toEqual([{ name: 'send_raw_command', args: { command: TRAIN } }])
  })

  it('passes the carrier when the service has a carrier argument', async () => {
    const { device, link } = setup({ carrierArg: 'carrier_frequency' })
    const result = await device.transmit(TRAIN, { carrierHz: 38000 })
    expect(result.ignoredSettings).toEqual([])
    expect(link.serviceCalls[0]?.args).toEqual({ command: TRAIN, carrier_frequency: 38000 })
  })

  it('still sends when a setting cannot be applied, and names it', async () => {
    const { device, link } = setup()
    const result = await device.transmit(TRAIN, { carrierHz: 36000, repeat: 2 })
    expect(link.serviceCalls).toHaveLength(1)
    expect(link.serviceCalls[0]?.args).toEqual({ command: TRAIN })
    expect([...result.ignoredSettings].sort()).toEqual(['carrierHz', 'repeat'])
  })

  it('warns once per (device, setting), tagged with the device id', async () => {
    const { device, lines } = setup()
    await device.transmit(TRAIN, { carrierHz: 36000 })
    await device.transmit(TRAIN, { carrierHz: 36000 })
    await device.transmit(TRAIN, { carrierHz: 36000, repeat: 1 })
    const warns = lines.filter((l) => l.level === 'warn' && l.message.includes('setting'))
    expect(warns).toHaveLength(2)
    for (const w of warns) expect(w.extras).toMatchObject({ tags: { deviceId: 7 } })
  })

  it('does not count an unset setting as ignored', async () => {
    const { device } = setup()
    const result = await device.transmit(TRAIN, { carrierHz: undefined })
    expect(result.ignoredSettings).toEqual([])
  })

  it('refuses by name when the board is not connected', async () => {
    const { device } = setup({}, false)
    expect(await codeOf(device.transmit(TRAIN))).toBe('ir-transmitter.offline')
  })

  it('refuses a train longer than the board accepts, sending nothing', async () => {
    const { device, link } = setup()
    const long = Array.from({ length: ESP_IR_MAX_TIMINGS + 2 }, (_, i) =>
      i % 2 === 0 ? 500 : -500,
    )
    expect(await codeOf(device.transmit(long))).toBe('ir-transmitter.too-long')
    expect(link.serviceCalls).toEqual([])
  })

  it('declares its medium, settable keys and bound', () => {
    expect(setup().device.describe()).toEqual({
      media: ['ir'],
      settable: [],
      maxTimings: ESP_IR_MAX_TIMINGS,
    })
    expect(setup({ carrierArg: 'carrier_frequency', media: ['rf'] }).device.describe()).toEqual({
      media: ['rf'],
      settable: ['carrierHz'],
      maxTimings: ESP_IR_MAX_TIMINGS,
    })
  })
})
