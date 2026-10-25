import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as yaml from 'js-yaml'
import { ConfigService } from './config.service'

describe('ConfigService', () => {
  let tmpDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    // Phase 13 (settings redesign test fix): `ConfigManager` applies
    // `ENV_VAR_MAP` overrides on top of YAML values. When this suite
    // runs in parallel with others under `nx run-many`, environment
    // variables set by sibling tests (or the parent nx process) leak
    // in and override our carefully seeded YAML fixtures — making
    // `auth.adminPassword` come back as `'admin'` instead of
    // `'secret123'` and `server.dataPath` come back as the default
    // `'camstack-data'` instead of `'/custom/data'`.
    //
    // Snapshot and clear every env var that `ENV_VAR_MAP` consults.
    // Admin credentials are set ONLY via the canonical CAMSTACK_ADMIN_*
    // keys (no legacy ADMIN_USERNAME/ADMIN_PASSWORD back-compat); the
    // schema default for adminPassword is the literal 'changeme'.
    const envKeys = [
      'CAMSTACK_PORT',
      'CAMSTACK_HOST',
      'CAMSTACK_DATA',
      'CAMSTACK_JWT_SECRET',
      'CAMSTACK_ADMIN_USER',
      'CAMSTACK_ADMIN_PASS',
    ] as const
    originalEnv = {}
    for (const key of envKeys) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-config-'))
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createConfigFile = (config: Record<string, unknown>): string => {
    const filePath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(filePath, yaml.dump(config), 'utf-8')
    return filePath
  }

  const createService = async (configPath: string): Promise<ConfigService> => {
    return new ConfigService(configPath)
  }

  it('loads and validates a minimal config.yaml', async () => {
    const configPath = createConfigFile({
      server: { port: 5000, host: '127.0.0.1' },
      auth: { adminPassword: 'secret123' },
    })

    const service = await createService(configPath)
    const raw = service.raw

    expect(raw.server.port).toBe(5000)
    expect(raw.server.host).toBe('127.0.0.1')
    // A legacy credential in config.yaml is stripped, never served (D797).
    expect(raw.auth).toEqual({})
  })

  it('returns runtime defaults for optional sections via raw', async () => {
    const configPath = createConfigFile({
      server: { port: 4443 },
      auth: { adminPassword: 'secret123' },
    })

    const service = await createService(configPath)
    const raw = service.raw

    expect(raw.features.streaming).toBe(true)
    expect(raw.features.objectDetection).toBe(false)
    expect(raw.storage.provider).toBe('sqlite-storage')
    expect(raw.logging.level).toBe('info')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
    expect((raw.logging as any).retentionDays).toBe(30)
    expect(raw.eventBus.ringBufferSize).toBe(10000)
    // addons.enabled removed — installed = active
  })

  it('throws on invalid config (port as string)', async () => {
    const configPath = createConfigFile({
      server: { port: 'not-a-number' },
      auth: { adminPassword: 'secret123' },
    })

    await expect(createService(configPath)).rejects.toThrow()
  })

  it('dot-path access works for bootstrap keys', async () => {
    const configPath = createConfigFile({
      server: { port: 9090 },
      auth: { adminPassword: 'secret123' },
    })

    const service = await createService(configPath)

    expect(service.get<number>('server.port')).toBe(9090)
    expect(service.get<string>('auth.adminPassword')).toBeUndefined()
  })

  it('dot-path access returns runtime defaults for non-bootstrap keys', async () => {
    const configPath = createConfigFile({
      server: { port: 4443 },
      auth: { adminPassword: 'secret123' },
    })

    const service = await createService(configPath)

    expect(service.get<string>('logging.level')).toBe('info')
    expect(service.get<number>('retention.detectionEventsDays')).toBe(30)
    expect(service.get<boolean>('features.objectDetection')).toBe(false)
    // addons.enabled removed — installed = active
  })

  it('uses defaults when config file does not exist', async () => {
    const configPath = path.join(tmpDir, 'nonexistent.yaml')

    const service = await createService(configPath)
    const raw = service.raw

    expect(raw.server.port).toBe(4443)
    expect(raw.server.host).toBe('0.0.0.0')
    expect(raw.auth).toEqual({})
  })

  it('returns features via features getter with runtime defaults', async () => {
    const configPath = createConfigFile({
      server: { port: 4443 },
      auth: { adminPassword: 'secret123' },
    })

    const service = await createService(configPath)
    const features = service.features

    // Features come from RUNTIME_DEFAULTS (not YAML bootstrap config)
    expect(features.streaming).toBe(true)
    expect(features.objectDetection).toBe(false)
    expect(features.notifications).toBe(true)
  })

  it('getBootstrap returns bootstrap-only values', async () => {
    const configPath = createConfigFile({
      server: { port: 7777, dataPath: '/custom/data' },
      auth: { adminPassword: 'mypass', jwtSecret: 'mysecret' },
    })

    const service = await createService(configPath)

    expect(service.getBootstrap<number>('server.port')).toBe(7777)
    expect(service.getBootstrap<string>('server.dataPath')).toBe('/custom/data')
    // The session signing key is the keychain's, never config.yaml's (D797).
    expect(service.getBootstrap<string>('auth.jwtSecret')).toBeUndefined()
  })
})
