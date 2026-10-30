import { describe, it, expect } from 'vitest'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  sameConnection,
  toHomematicOptions,
} from '../config.js'
import type { HomematicConfig } from '../config.js'

// Shared connection fixture with the boolean interface toggles.
const CONN: HomematicConfig = {
  host: '192.168.10.198',
  enableHmipRf: true,
  enableBidcosRf: false,
  enableGroups: true,
  enableBidcosWired: false,
  username: '',
  password: '',
  callbackHost: '192.168.10.10',
  callbackPort: 2128,
  tls: false,
}

describe('connectionFromSettings', () => {
  it('coerces a loose settings blob through the connection schema and trims strings', () => {
    const conn = connectionFromSettings({ host: '  10.0.0.5  ', username: ' admin ' })
    expect(conn?.host).toBe('10.0.0.5')
    expect(conn?.username).toBe('admin')
    // Schema defaults: HmIP-RF and groups ON, the rest OFF.
    expect(conn?.enableHmipRf).toBe(true)
    expect(conn?.enableBidcosRf).toBe(false)
    expect(conn?.enableGroups).toBe(true)
    expect(conn?.enableBidcosWired).toBe(false)
    expect(conn?.callbackPort).toBe(2128)
  })

  it('is null while the host is missing, blank or the settings are not an object', () => {
    expect(connectionFromSettings({})).toBeNull()
    expect(connectionFromSettings({ host: '   ' })).toBeNull()
    expect(connectionFromSettings(null)).toBeNull()
  })

  it('reads a blank callback port field as the default instead of rejecting the connection', () => {
    expect(connectionFromSettings({ host: 'h', callbackPort: '' })?.callbackPort).toBe(2128)
  })
})

describe('sameConnection', () => {
  it('is true for the same values and false when any live-connection field differs', () => {
    expect(sameConnection(CONN, { ...CONN })).toBe(true)
    expect(sameConnection(CONN, { ...CONN, password: 'x' })).toBe(false)
    expect(sameConnection(CONN, { ...CONN, tls: true })).toBe(false)
    expect(sameConnection(CONN, { ...CONN, enableBidcosRf: true })).toBe(false)
    expect(sameConnection(CONN, null)).toBe(false)
  })
})

describe('buildConnectionFormSchema', () => {
  it('offers the LAN scan picker first and keeps the password a keychain password field', () => {
    const fields = buildConnectionFormSchema().sections.flatMap((s) => s.fields)
    expect(fields[0]?.type).toBe('addon-action-select')
    expect(fields.find((f) => f.key === 'password')?.type).toBe('password')
  })
})

describe('toHomematicOptions', () => {
  it('uses callbackHost verbatim when explicitly set', () => {
    const opts = toHomematicOptions({ ...CONN, callbackHost: '1.2.3.4' })
    expect(opts.callback.host).toBe('1.2.3.4')
  })

  it('returns a non-empty callback host when callbackHost is blank (env-dependent, just checks type)', () => {
    const opts = toHomematicOptions({ ...CONN, callbackHost: '' })
    // The inferred value is OS-dependent — only assert it is a string.
    expect(typeof opts.callback.host).toBe('string')
  })

  it('derives interfaces from boolean toggles — HmIP-RF + groups on by default', () => {
    const opts = toHomematicOptions(CONN)
    expect(opts.interfaces).toEqual(['HmIP-RF', 'VirtualDevices'])
  })

  it('all toggles off → empty interfaces array', () => {
    const opts = toHomematicOptions({
      ...CONN,
      enableHmipRf: false,
      enableBidcosRf: false,
      enableGroups: false,
      enableBidcosWired: false,
    })
    expect(opts.interfaces).toEqual([])
  })

  it('BidCos-RF + BidCos-Wired on → includes both in interfaces', () => {
    const opts = toHomematicOptions({
      ...CONN,
      enableHmipRf: false,
      enableBidcosRf: true,
      enableGroups: false,
      enableBidcosWired: true,
    })
    expect(opts.interfaces).toContain('BidCos-RF')
    expect(opts.interfaces).toContain('BidCos-Wired')
    expect(opts.interfaces).not.toContain('HmIP-RF')
    expect(opts.interfaces).not.toContain('VirtualDevices')
  })

  it('all toggles on → all four interfaces in order', () => {
    const opts = toHomematicOptions({
      ...CONN,
      enableHmipRf: true,
      enableBidcosRf: true,
      enableGroups: true,
      enableBidcosWired: true,
    })
    expect(opts.interfaces).toEqual(['HmIP-RF', 'BidCos-RF', 'VirtualDevices', 'BidCos-Wired'])
  })
})
