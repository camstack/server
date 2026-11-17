import { describe, expect, it } from 'vitest'
import {
  DeviceIdentifiersSchema,
  identifierStrength,
  isEmptyIdentifiers,
  normaliseIdentifiers,
  normaliseMac,
} from '../device-identifiers.js'

const AT = 1_700_000_000_000

describe('normaliseIdentifiers', () => {
  it('lower-cases MACs with colons whatever the spelling, and de-duplicates them', () => {
    const { identifiers, rejected } = normaliseIdentifiers(
      { mac: ['AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', '001122334455', 'aa:bb:cc:dd:ee:ff'] },
      { readAt: AT },
    )
    expect(identifiers.mac?.map((m) => m.value)).toEqual(['aa:bb:cc:dd:ee:ff', '00:11:22:33:44:55'])
    expect(rejected).toEqual([])
  })

  it('accepts a single MAC string', () => {
    expect(normaliseIdentifiers({ mac: 'AA:BB:CC:DD:EE:01' }).identifiers.mac?.[0]?.value).toBe(
      'aa:bb:cc:dd:ee:01',
    )
  })

  it('refuses a malformed or placeholder MAC and names it', () => {
    const { identifiers, rejected } = normaliseIdentifiers({
      mac: ['zz:zz', '00:00:00:00:00:00', 'FF-FF-FF-FF-FF-FF'],
    })
    expect(identifiers.mac).toBeUndefined()
    expect(rejected.map((r) => r.reason)).toEqual([
      'not a 48-bit MAC',
      'placeholder MAC',
      'placeholder MAC',
    ])
    expect(rejected.every((r) => r.key === 'mac')).toBe(true)
  })

  it('prefixes a serial by its manufacturer as a slug', () => {
    const { identifiers } = normaliseIdentifiers({
      serial: { manufacturer: 'Hikvision Digital', serial: ' DS-2CD2143G0 20190101 ' },
    })
    expect(identifiers.serial?.value).toBe('hikvision-digital:ds-2cd2143g020190101')
  })

  it('refuses a placeholder serial and a serial with no manufacturer', () => {
    const { identifiers, rejected } = normaliseIdentifiers({
      serial: { manufacturer: 'Reolink', serial: 'unknown' },
      vendorUid: { vendor: '  ', id: 'abc' },
    })
    expect(identifiers.serial).toBeUndefined()
    expect(identifiers['vendor-uid']).toBeUndefined()
    expect(rejected.map((r) => [r.key, r.reason])).toEqual([
      ['serial', 'placeholder value'],
      ['vendor-uid', 'no vendor'],
    ])
  })

  it('prefixes a vendor uid by its vendor', () => {
    const { identifiers } = normaliseIdentifiers({
      vendorUid: { vendor: 'reolink', id: '95270000ABCDEFGH' },
    })
    expect(identifiers['vendor-uid']?.value).toBe('reolink:95270000abcdefgh')
  })

  it('strips the domain from a hostname and refuses an address in its place', () => {
    expect(
      normaliseIdentifiers({ hostname: 'NVR-01.lan.example.com.' }).identifiers.hostname?.value,
    ).toBe('nvr-01')
    const { identifiers, rejected } = normaliseIdentifiers({ hostname: '192.0.2.10' })
    expect(identifiers.hostname).toBeUndefined()
    expect(rejected[0]?.reason).toBe('an address, not a hostname')
  })

  it('validates an IP and refuses loopback', () => {
    expect(normaliseIdentifiers({ ip: ' 192.0.2.7 ' }).identifiers.ip?.value).toBe('192.0.2.7')
    expect(normaliseIdentifiers({ ip: '[2001:DB8::1]' }).identifiers.ip?.value).toBe('2001:db8::1')
    expect(normaliseIdentifiers({ ip: '192.0.2.999' }).identifiers.ip).toBeUndefined()
    expect(normaliseIdentifiers({ ip: '127.0.0.1' }).rejected[0]?.reason).toBe(
      'loopback or unspecified address',
    )
  })

  it('routes a connection host to ip or hostname, whichever it is', () => {
    expect(normaliseIdentifiers({ host: '192.0.2.20' }).identifiers).toEqual({
      ip: expect.objectContaining({ value: '192.0.2.20' }),
    })
    expect(normaliseIdentifiers({ host: 'HomePilot.local' }).identifiers).toEqual({
      hostname: expect.objectContaining({ value: 'homepilot' }),
    })
    expect(
      normaliseIdentifiers({ host: 'box.local', ip: '192.0.2.21' }).identifiers.ip?.value,
    ).toBe('192.0.2.21')
  })

  it('lower-cases a machine uuid and refuses the all-zero placeholder', () => {
    expect(
      normaliseIdentifiers({ machineUuid: '{4C4C4544-0042-3510-8051-B4C04F4D3732}' }).identifiers[
        'machine-uuid'
      ]?.value,
    ).toBe('4c4c4544-0042-3510-8051-b4c04f4d3732')
    expect(
      normaliseIdentifiers({ machineUuid: '00000000-0000-0000-0000-000000000000' }).identifiers[
        'machine-uuid'
      ],
    ).toBeUndefined()
  })

  it('treats null, absent and blank as unknown — not refused', () => {
    const { identifiers, rejected } = normaliseIdentifiers({
      mac: [' ', ''],
      serial: null,
      hostname: '   ',
      ip: null,
    })
    expect(isEmptyIdentifiers(identifiers)).toBe(true)
    expect(rejected).toEqual([])
  })

  it('stamps origin and readAt per key', () => {
    const { identifiers } = normaliseIdentifiers(
      { mac: 'aa:bb:cc:dd:ee:02', hostname: 'cam' },
      { readAt: AT, originByKey: { hostname: 'derived' } },
    )
    expect(identifiers.mac?.[0]).toEqual({ value: 'aa:bb:cc:dd:ee:02', origin: 'read', readAt: AT })
    expect(identifiers.hostname).toEqual({ value: 'cam', origin: 'derived', readAt: AT })
  })

  it('always yields a declaration the persisted schema accepts', () => {
    const { identifiers } = normaliseIdentifiers(
      {
        mac: ['AA:BB:CC:DD:EE:03'],
        serial: { manufacturer: 'Bosch', serial: 'X1' },
        vendorUid: { vendor: 'homematic', id: 'OEQ1234567' },
        machineUuid: '4c4c4544-0042-3510-8051-b4c04f4d3732',
        hostname: 'host',
        ip: '198.51.100.4',
      },
      { readAt: AT },
    )
    expect(DeviceIdentifiersSchema.safeParse(identifiers).success).toBe(true)
  })
})

describe('DeviceIdentifiersSchema', () => {
  it('refuses a value that is not in its stored form', () => {
    const entry = { origin: 'read', readAt: AT }
    expect(
      DeviceIdentifiersSchema.safeParse({ mac: [{ value: 'AA:BB:CC:DD:EE:FF', ...entry }] })
        .success,
    ).toBe(false)
    expect(
      DeviceIdentifiersSchema.safeParse({ serial: { value: 'no-prefix', ...entry } }).success,
    ).toBe(false)
    expect(
      DeviceIdentifiersSchema.safeParse({ hostname: { value: 'a.b', ...entry } }).success,
    ).toBe(false)
    expect(DeviceIdentifiersSchema.safeParse({ ip: { value: 'nope', ...entry } }).success).toBe(
      false,
    )
  })

  it('refuses an unknown key', () => {
    expect(
      DeviceIdentifiersSchema.safeParse({ imei: { value: '1', origin: 'read', readAt: AT } })
        .success,
    ).toBe(false)
  })
})

describe('identifierStrength', () => {
  it('is strong for hardware identity and weak for network names', () => {
    expect(identifierStrength('mac')).toBe('strong')
    expect(identifierStrength('serial')).toBe('strong')
    expect(identifierStrength('machine-uuid')).toBe('strong')
    expect(identifierStrength('vendor-uid')).toBe('strong')
    expect(identifierStrength('hostname')).toBe('weak')
    expect(identifierStrength('ip')).toBe('weak')
  })
})

describe('normaliseMac', () => {
  it('answers the normalised form', () => {
    expect(normaliseMac('AABBCCDDEE04')).toEqual({ ok: true, value: 'aa:bb:cc:dd:ee:04' })
  })
})
