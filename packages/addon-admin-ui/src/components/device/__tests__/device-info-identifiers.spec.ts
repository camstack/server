import { describe, expect, it } from 'vitest'
import { identifierRows } from '../overview-adapters/DeviceInfoAdapter'

const at = { origin: 'read', readAt: 1 }

describe('Device Info — declared identifiers (D1059)', () => {
  it('lists every MAC, then the other keys in a fixed order, marking derived values', () => {
    expect(
      identifierRows({
        ip: { value: '192.0.2.4', origin: 'derived', readAt: 1 },
        mac: [
          { value: 'aa:bb:cc:dd:ee:01', ...at },
          { value: 'aa:bb:cc:dd:ee:02', ...at },
        ],
        serial: { value: 'acme:sn1', ...at },
      }),
    ).toEqual([
      { key: 'mac', value: 'aa:bb:cc:dd:ee:01', derived: false },
      { key: 'mac', value: 'aa:bb:cc:dd:ee:02', derived: false },
      { key: 'serial', value: 'acme:sn1', derived: false },
      { key: 'ip', value: '192.0.2.4', derived: true },
    ])
  })

  it('shows nothing for an absent or malformed declaration', () => {
    expect(identifierRows(undefined)).toEqual([])
    expect(identifierRows({ mac: 'not-a-list' })).toEqual([])
  })
})
