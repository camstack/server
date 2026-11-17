import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { declareDeviceIdentifiers, type SetIdentifiersInput } from '../declare-identifiers.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

describe('declareDeviceIdentifiers', () => {
  it('sends the normalised declaration and logs every refused value with the device tag', async () => {
    const logger = makeLogger()
    const sent: SetIdentifiersInput[] = []
    const result = await declareDeviceIdentifiers(
      { deviceId: 9, logger, writer: { mutate: async (input) => void sent.push(input) } },
      { mac: ['AA-BB-CC-DD-EE-FF', 'garbage'], ip: '192.0.2.1' },
      { readAt: 5 },
    )
    expect(result.outcome).toBe('declared')
    expect(sent).toEqual([
      {
        deviceId: 9,
        identifiers: {
          mac: [{ value: 'aa:bb:cc:dd:ee:ff', origin: 'read', readAt: 5 }],
          ip: { value: '192.0.2.1', origin: 'read', readAt: 5 },
        },
      },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      'identifier refused — not declared',
      expect.objectContaining({ tags: { deviceId: 9 } }),
    )
  })

  it('sends the kinds whose read failed as unread, and omits an empty list', async () => {
    const sent: SetIdentifiersInput[] = []
    const writer = { mutate: async (input: SetIdentifiersInput) => void sent.push(input) }
    const deps = { deviceId: 9, logger: makeLogger(), writer }
    await declareDeviceIdentifiers(
      deps,
      { serial: { manufacturer: 'acme', serial: 'SN1' } },
      {
        readAt: 5,
        unread: ['mac', 'ip'],
      },
    )
    await declareDeviceIdentifiers(
      deps,
      { serial: { manufacturer: 'acme', serial: 'SN1' } },
      {
        readAt: 5,
        unread: [],
      },
    )
    expect(sent.map((s) => s.unread)).toEqual([['mac', 'ip'], undefined])
    expect(sent[0]?.identifiers).toEqual({
      serial: { value: 'acme:sn1', origin: 'read', readAt: 5 },
    })
  })

  it('writes nothing when no value survives, so an empty probe never erases a declaration', async () => {
    const mutate = vi.fn(async () => {})
    const result = await declareDeviceIdentifiers(
      { deviceId: 9, logger: makeLogger(), writer: { mutate } },
      { mac: 'not-a-mac', serial: { manufacturer: 'acme', serial: 'unknown' } },
    )
    expect(result.outcome).toBe('nothing-to-declare')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('answers failed, never throws, when the write is refused', async () => {
    const logger = makeLogger()
    const result = await declareDeviceIdentifiers(
      {
        deviceId: 3,
        logger,
        writer: {
          mutate: async () => {
            throw new Error('not-owner')
          },
        },
      },
      { hostname: 'cam' },
    )
    expect(result.outcome).toBe('failed')
    expect(logger.warn).toHaveBeenCalledWith(
      'identifiers not declared — setIdentifiers failed',
      expect.objectContaining({ tags: { deviceId: 3 } }),
    )
  })

  it('answers unavailable without a device-manager', async () => {
    const result = await declareDeviceIdentifiers(
      { deviceId: 3, logger: makeLogger(), writer: undefined },
      { hostname: 'cam' },
    )
    expect(result.outcome).toBe('unavailable')
  })
})
