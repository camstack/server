import { describe, expect, it } from 'vitest'
import { deriveHubUrlForExport, deriveHubUrlFromHubAddress } from '../derive-hub-url.js'

describe('deriveHubUrlFromHubAddress', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['192.168.1.20', 'https://192.168.1.20:4443'],
    ['192.168.1.20:6000', 'https://192.168.1.20:4443'],
    ['hub@192.168.1.20:6000', 'https://192.168.1.20:4443'],
    ['hub@192.168.1.20', 'https://192.168.1.20:4443'],
    ['192.168.1.20:6000/hub', 'https://192.168.1.20:4443'],
    ['192.168.1.20/hub', 'https://192.168.1.20:4443'],
    ['hub.local', 'https://hub.local:4443'],
    ['[::1]:6000', 'https://[::1]:4443'],
    ['[fe80::1]', 'https://[fe80::1]:4443'],
    ['  192.168.1.20  ', 'https://192.168.1.20:4443'],
    ['', undefined],
    ['   ', undefined],
  ]

  for (const [input, expected] of cases) {
    it(`derives ${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(deriveHubUrlFromHubAddress(input)).toBe(expected)
    })
  }
})

describe('deriveHubUrlForExport', () => {
  it('derives when no explicit value is set', () => {
    expect(deriveHubUrlForExport(false, '192.168.1.20')).toBe('https://192.168.1.20:4443')
  })

  it('never clobbers an explicit operator value', () => {
    expect(deriveHubUrlForExport(true, '192.168.1.20')).toBeUndefined()
  })

  it('returns undefined without a hub address', () => {
    expect(deriveHubUrlForExport(false, undefined)).toBeUndefined()
  })

  it('returns undefined for a blank hub address', () => {
    expect(deriveHubUrlForExport(false, '   ')).toBeUndefined()
  })
})
