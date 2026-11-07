import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ConfigService } from './config.service'

/** The bootstrap config is the environment over built-in defaults (D1018). */
describe('ConfigService', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    // `ConfigManager` reads `ENV_VAR_MAP`; a sibling suite (or the parent nx
    // process) must not leak those variables in. Snapshot and clear them.
    const envKeys = ['CAMSTACK_PORT', 'CAMSTACK_HOST', 'CAMSTACK_DATA', 'CONFIG_PATH'] as const
    originalEnv = {}
    for (const key of envKeys) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('reads port and host from the environment', () => {
    process.env['CAMSTACK_PORT'] = '5000'
    process.env['CAMSTACK_HOST'] = '127.0.0.1'

    const service = new ConfigService()

    expect(service.getBootstrap<number>('server.port')).toBe(5000)
    expect(service.getBootstrap<string>('server.host')).toBe('127.0.0.1')
    expect(service.getBootstrap('auth')).toBeUndefined()
  })

  it('throws on an invalid port', () => {
    process.env['CAMSTACK_PORT'] = 'not-a-number'

    expect(() => new ConfigService()).toThrow()
  })

  it('dot-path access works for bootstrap keys', () => {
    process.env['CAMSTACK_PORT'] = '9090'

    const service = new ConfigService()

    expect(service.get<number>('server.port')).toBe(9090)
    expect(service.get<string>('auth.adminPassword')).toBeUndefined()
  })

  it('dot-path access returns runtime defaults for the keys that are read', () => {
    const service = new ConfigService()

    expect(service.get<boolean>('features.objectDetection')).toBe(false)
    expect(service.get<string>('auth.tokenExpiry')).toBe('30d')
    // Defaults nothing read were deleted (#342).
    for (const dead of ['logging.level', 'retention.detectionEventsDays', 'storage.provider']) {
      expect(service.get(dead)).toBeUndefined()
    }
  })

  it('uses the built-in defaults when the environment names nothing', () => {
    const service = new ConfigService()

    expect(service.getBootstrap<number>('server.port')).toBe(4443)
    expect(service.getBootstrap<string>('server.host')).toBe('0.0.0.0')
    expect(service.getBootstrap<string>('server.dataPath')).toBe('camstack-data')
  })

  it('returns features via features getter with runtime defaults', () => {
    const features = new ConfigService().features

    expect(features.streaming).toBe(true)
    expect(features.objectDetection).toBe(false)
    expect(features.notifications).toBe(true)
  })

  it('getBootstrap returns bootstrap-only values', () => {
    process.env['CAMSTACK_PORT'] = '7777'
    process.env['CAMSTACK_DATA'] = '/custom/data'

    const service = new ConfigService()

    expect(service.getBootstrap<number>('server.port')).toBe(7777)
    expect(service.getBootstrap<string>('server.dataPath')).toBe('/custom/data')
    // The session signing key is the keychain's, never a bootstrap key (D797).
    expect(service.getBootstrap<string>('auth.jwtSecret')).toBeUndefined()
  })
})
