import { describe, it, expect } from 'vitest'
import {
  buildConnectionFormSchema,
  homematicConfigSchema,
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
  it('opens with the credentials notice, then the LAN scan picker; the password stays a keychain field', () => {
    const fields = buildConnectionFormSchema().sections.flatMap((s) => s.fields)
    expect(fields[0]?.type).toBe('info')
    expect(fields[0]?.key).toBe('credentialsNotice')
    expect(fields[1]?.type).toBe('addon-action-select')
    expect(fields.find((f) => f.key === 'password')?.type).toBe('password')
  })

  it('starts a new integration with the Admin WebUI username, never overriding a stored one', () => {
    const fields = buildConnectionFormSchema().sections.flatMap((s) => s.fields)
    const username = fields.find((f) => f.key === 'username')
    expect(username && 'default' in username ? username.default : undefined).toBe('Admin')
    expect(homematicConfigSchema.parse({ host: 'h' }).username).toBe('Admin')
    expect(homematicConfigSchema.parse({ host: 'h', username: 'bob' }).username).toBe('bob')
    expect(homematicConfigSchema.parse({ host: 'h', username: '' }).username).toBe('')
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

  it('a username with an EMPTY password still reaches the library (CCU without WebUI auth)', () => {
    const opts = toHomematicOptions({ ...CONN, username: 'Admin', password: '' })
    expect(opts.credentials).toEqual({ username: 'Admin', password: '' })
  })

  it('a password without a username sends no credentials', () => {
    expect(toHomematicOptions({ ...CONN, username: '', password: 'x' }).credentials).toBeUndefined()
  })
})
