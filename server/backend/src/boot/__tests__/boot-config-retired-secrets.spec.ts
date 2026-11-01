import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrapConfig, retiredCorsSources, retiredSecretSources } from '../boot-config'

/**
 * D797: no secret reaches the hub through env or config.yaml. The retired
 * variables are IGNORED — and named in a warning, so a container template that
 * still sets them is told. Never their values. A yaml `auth` section is a dead
 * key (#342): not read, and not warned about either.
 */
describe('boot config — retired secret sources (D797)', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-secrets-'))
    configPath = path.join(dir, 'config.yaml')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('names every retired env variable that is set, blank ones excluded', () => {
    expect(
      retiredSecretSources({
        CAMSTACK_JWT_SECRET: 'x',
        CAMSTACK_ADMIN_PASS: 'y',
        CAMSTACK_CLUSTER_SECRET: '',
        HF_TOKEN: 'z',
      }),
    ).toEqual(['CAMSTACK_JWT_SECRET', 'CAMSTACK_ADMIN_PASS', 'HF_TOKEN'])
  })

  it('ignores the env secrets and a yaml auth section, and warns without values', () => {
    vi.stubEnv('CAMSTACK_JWT_SECRET', 'env-jwt-value')
    vi.stubEnv('CAMSTACK_ADMIN_USER', 'root')
    vi.stubEnv('CAMSTACK_ADMIN_PASS', 'env-pass-value')
    fs.writeFileSync(configPath, 'auth:\n  jwtSecret: yaml-jwt-value\n  adminPassword: yaml-pass\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const config = loadBootstrapConfig(configPath)

    expect(config).not.toHaveProperty('auth')
    const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(warned).toContain('CAMSTACK_JWT_SECRET')
    for (const value of ['env-jwt-value', 'env-pass-value', 'yaml-jwt-value', 'yaml-pass']) {
      expect(warned).not.toContain(value)
    }
  })
})

describe('boot config — retired CORS env (D707)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('names the env variable, never a value', () => {
    expect(retiredCorsSources({ CAMSTACK_CORS_ORIGINS: 'https://a.example' })).toEqual([
      'CAMSTACK_CORS_ORIGINS',
    ])
    expect(retiredCorsSources({ CAMSTACK_CORS_ORIGINS: '' })).toEqual([])
  })

  it('ignores the env value and logs the name', () => {
    vi.stubEnv('CAMSTACK_CORS_ORIGINS', 'https://env-origin.example')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-cors-'))
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.spyOn(console, 'log').mockImplementation(() => undefined)

      const config = loadBootstrapConfig(path.join(dir, 'config.yaml'))

      expect(config.server).not.toHaveProperty('corsOrigins')
      const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(warned).toContain('CAMSTACK_CORS_ORIGINS')
      expect(warned).not.toContain('env-origin.example')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
