import { describe, expect, it } from 'vitest'
import type { AlexaBrokerEntry } from '../config.js'
import { alexaConnectionSchema } from '../config.js'
import { DEFAULT_DEVICE_APP_NAME, readBrokerSeed, regionOfDomain } from '../speak/broker-seed.js'

function entry(connection: Record<string, unknown>): AlexaBrokerEntry {
  return {
    id: 'alexa_001',
    name: 'Home',
    connection: alexaConnectionSchema.parse(connection),
  }
}

describe('the refresh token a broker shares with Echo speech', () => {
  it('reads the registration the broker keeps on its record', () => {
    expect(
      readBrokerSeed(
        entry({
          cookie: JSON.stringify({ refreshToken: 'from-blob', deviceAppName: 'Registered' }),
        }),
      ),
    ).toEqual({ refreshToken: 'from-blob', deviceAppName: 'Registered' })
  })

  it('names the default app when the blob does not, and falls back to a bare refresh token', () => {
    expect(
      readBrokerSeed(entry({ cookie: JSON.stringify({ refreshToken: 'from-blob' }) })),
    ).toEqual({
      refreshToken: 'from-blob',
      deviceAppName: DEFAULT_DEVICE_APP_NAME,
    })
    expect(readBrokerSeed(entry({ refreshToken: 'bare-token' }))).toEqual({
      refreshToken: 'bare-token',
      deviceAppName: DEFAULT_DEVICE_APP_NAME,
    })
  })

  it('gives no seed for a raw cookie string or an empty broker', () => {
    expect(readBrokerSeed(entry({ cookie: 'session-id=1; csrf=2' }))).toBeNull()
    expect(readBrokerSeed(entry({}))).toBeNull()
  })

  it('maps the Amazon domain to a region', () => {
    expect(regionOfDomain('amazon.com')).toBe('NA')
    expect(regionOfDomain('amazon.it')).toBe('EU')
    expect(regionOfDomain('amazon.co.jp')).toBe('FE')
  })
})
