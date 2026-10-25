import { describe, it, expect } from 'vitest'
import {
  HmBrokerEntrySchema,
  homematicAddonConfigSchema,
  migrateLegacyConfig,
  settingsToHmConfig,
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

describe('HmBrokerEntry schema', () => {
  it('parses a valid broker entry', () => {
    const entry = HmBrokerEntrySchema.parse({
      id: 'hm_001',
      name: 'Casa CCU',
      connection: CONN,
    })
    expect(entry.id).toBe('hm_001')
    expect(entry.connection.host).toBe('192.168.10.198')
    expect(entry.integrationId).toBeUndefined()
  })

  it('addon config defaults to an empty brokers list', () => {
    const cfg = homematicAddonConfigSchema.parse({})
    expect(cfg.brokers).toEqual([])
  })

  it('settingsToHmConfig coerces a loose settings blob through the connection schema', () => {
    const conn = settingsToHmConfig({ host: '10.0.0.5' })
    expect(conn.host).toBe('10.0.0.5')
    // Schema defaults: HmIP-RF and groups ON, the rest OFF.
    expect(conn.enableHmipRf).toBe(true)
    expect(conn.enableBidcosRf).toBe(false)
    expect(conn.enableGroups).toBe(true)
    expect(conn.enableBidcosWired).toBe(false)
    expect(conn.callbackPort).toBe(2128) // schema default
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

describe('migrateLegacyConfig', () => {
  it('migrates a legacy {connection} blob into brokers[hm_001] (applies boolean defaults)', () => {
    // A legacy blob with the old `interfaces` field — the schema drops it and applies boolean defaults.
    const migrated = migrateLegacyConfig({
      connection: { host: '192.168.10.198', interfaces: ['HmIP-RF'] },
    })
    expect(migrated.brokers).toHaveLength(1)
    const first = migrated.brokers[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(first.id).toBe('hm_001')
    expect(first.connection.host).toBe('192.168.10.198')
    expect(first.name.length).toBeGreaterThan(0)
    // Boolean defaults applied — legacy `interfaces` field dropped.
    expect(first.connection.enableHmipRf).toBe(true)
    expect(first.connection.enableGroups).toBe(true)
    expect(first.connection.enableBidcosRf).toBe(false)
    expect(first.connection.enableBidcosWired).toBe(false)
  })

  it('leaves an already-migrated {brokers} blob untouched', () => {
    const already = { brokers: [{ id: 'hm_007', name: 'X', connection: CONN }] }
    const first = migrateLegacyConfig(already).brokers[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(first.id).toBe('hm_007')
  })

  it('migrates an empty / legacy-null blob into an empty brokers list', () => {
    expect(migrateLegacyConfig({ connection: null }).brokers).toEqual([])
    expect(migrateLegacyConfig({}).brokers).toEqual([])
    expect(migrateLegacyConfig(undefined).brokers).toEqual([])
  })

  it('drops an invalid legacy connection rather than throwing', () => {
    expect(migrateLegacyConfig({ connection: { host: 123 } }).brokers).toEqual([])
  })
})
