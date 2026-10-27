import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { AlexaProxyHostError, resolveProxyHost } from '../alexa-proxy-host.js'

function mkLogger() {
  const warn = vi.fn()
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn,
    error: () => undefined,
    child: () => logger,
  } as unknown as IScopedLogger
  return { logger, warn }
}

describe('resolveProxyHost', () => {
  it('an explicit override wins and the palette is not read', async () => {
    const { logger } = mkLogger()
    const read = vi.fn(async () => ['http://192.168.1.9:4480'])
    expect(await resolveProxyHost({ override: 'hub.lan', readAppConnections: read, logger })).toBe(
      'hub.lan',
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('picks the first LAN-host appConnections entry, hostname only', async () => {
    const { logger } = mkLogger()
    const host = await resolveProxyHost({
      override: '',
      readAppConnections: async () => [
        'https://camstack.example.top',
        'http://192.168.1.9:4480',
        'http://10.0.0.5:4480',
      ],
      logger,
    })
    expect(host).toBe('192.168.1.9')
  })

  it('no LAN entry gives a typed error naming the reason, logged', async () => {
    const { logger, warn } = mkLogger()
    const p = resolveProxyHost({
      override: '',
      readAppConnections: async () => ['https://camstack.example.top', 'http://127.0.0.1:4480'],
      logger,
    })
    await expect(p).rejects.toBeInstanceOf(AlexaProxyHostError)
    await expect(p).rejects.toMatchObject({ reason: 'no-lan-address' })
    expect(warn).toHaveBeenCalled()
  })

  it('a palette read failure gives a typed error, logged', async () => {
    const { logger, warn } = mkLogger()
    await expect(
      resolveProxyHost({
        override: '',
        readAppConnections: async () => {
          throw new Error('boom')
        },
        logger,
      }),
    ).rejects.toMatchObject({ reason: 'palette-unavailable' })
    expect(warn).toHaveBeenCalled()
  })
})
