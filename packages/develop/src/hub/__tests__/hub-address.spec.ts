import { describe, expect, it } from 'vitest'
import { HubAddressError, normalizeHubAddress, validateHubAddress } from '../hub-address.js'
import { resolveHubUrl } from '../hub-url.js'

describe('normalizeHubAddress', () => {
  const accepted: readonly (readonly [string, string])[] = [
    ['192.0.2.20', 'https://192.0.2.20:4443'],
    ['192.0.2.20:4443', 'https://192.0.2.20:4443'],
    ['192.0.2.20:8443', 'https://192.0.2.20:8443'],
    ['hub.local', 'https://hub.local:4443'],
    ['HUB.Local:4443', 'https://hub.local:4443'],
    ['https://host', 'https://host:4443'],
    ['https://host:9000', 'https://host:9000'],
    ['https://host:443', 'https://host:443'],
    ['https://host:4443/', 'https://host:4443'],
    ['https://host/trpc/x?y=1', 'https://host:4443'],
    ['  192.0.2.20  ', 'https://192.0.2.20:4443'],
    ['[fe80::1]', 'https://[fe80::1]:4443'],
    ['[fe80::1]:9000', 'https://[fe80::1]:9000'],
    ['https://[::1]:4443', 'https://[::1]:4443'],
    ['::1', 'https://[::1]:4443'],
  ]
  it.each(accepted)('%s -> %s', (input, canonical) => {
    expect(normalizeHubAddress(input)).toBe(canonical)
  })

  const refused: readonly (readonly [string, RegExp])[] = [
    ['http://192.0.2.20:4443', /hub API is https/],
    ['HTTP://host', /hub API is https/],
    ['ws://host', /unsupported scheme/],
    ['', /empty/],
    ['   ', /empty/],
    ['host:99999', /out of range/],
    ['host:0', /out of range/],
    ['user@host', /not a hub address/],
    ['https://', /not a hub address/],
    ['bad host', /not a valid host/],
  ]
  it.each(refused)('refuses %j', (input, message) => {
    expect(() => normalizeHubAddress(input)).toThrow(HubAddressError)
    expect(() => normalizeHubAddress(input)).toThrow(message)
  })

  it('validateHubAddress returns the message or undefined', () => {
    expect(validateHubAddress('hub.local')).toBeUndefined()
    expect(validateHubAddress('http://hub.local')).toMatch(/https/)
  })
})

describe('resolveHubUrl normalises every typed source', () => {
  it('flag, then CAMSTACK_HUB_URL, then CAMSTACK_SERVER', () => {
    expect(resolveHubUrl({ explicit: '10.0.0.5', env: {} })).toEqual({
      url: 'https://10.0.0.5:4443',
      source: 'flag',
    })
    expect(resolveHubUrl({ env: { CAMSTACK_HUB_URL: 'hub.local' } })?.url).toBe(
      'https://hub.local:4443',
    )
    expect(resolveHubUrl({ env: { CAMSTACK_SERVER: '10.0.0.6:9000' } })?.url).toBe(
      'https://10.0.0.6:9000',
    )
  })
  it('keeps a saved session server as saved', () => {
    expect(resolveHubUrl({ env: {}, session: { server: 'https://saved:4443' } })?.url).toBe(
      'https://saved:4443',
    )
  })
})
