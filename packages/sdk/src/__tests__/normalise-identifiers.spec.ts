import { describe, expect, it } from 'vitest'
import { identifierStrength, normaliseIdentifiers } from '../index.js'

describe('sdk normaliseIdentifiers (D1059)', () => {
  it('is the same normaliser providers use', () => {
    const { identifiers, rejected } = normaliseIdentifiers(
      {
        mac: 'AA-BB-CC-DD-EE-10',
        serial: { manufacturer: 'ACME Corp', serial: 'SN 42' },
        hostname: 'Box.example.com',
        ip: 'not-an-ip',
      },
      { readAt: 1 },
    )
    expect(identifiers.mac?.[0]?.value).toBe('aa:bb:cc:dd:ee:10')
    expect(identifiers.serial?.value).toBe('acme-corp:sn42')
    expect(identifiers.hostname?.value).toBe('box')
    expect(rejected).toEqual([{ key: 'ip', value: 'not-an-ip', reason: 'not an IP address' }])
    expect(identifierStrength('ip')).toBe('weak')
  })
})
