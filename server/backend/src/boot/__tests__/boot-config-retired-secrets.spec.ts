import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrapConfig, retiredSecretSources } from '../boot-config'

/**
 * D797: no secret reaches the hub through env or config.yaml. The retired
 * variables and `auth.*` keys are IGNORED — and named in a warning, so a
 * container template that still sets them is told. Never their values.
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

  it('names every retired env variable that is set, and the retired auth keys', () => {
    const found = retiredSecretSources(
      {
        CAMSTACK_JWT_SECRET: 'x',
        CAMSTACK_ADMIN_PASS: 'y',
        CAMSTACK_CLUSTER_SECRET: '',
        HF_TOKEN: 'z',
      },
      { auth: { jwtSecret: 'abc', adminUsername: null } },
    )
    expect(found).toEqual([
      'CAMSTACK_JWT_SECRET',
      'CAMSTACK_ADMIN_PASS',
      'HF_TOKEN',
      'auth.jwtSecret',
    ])
  })

  it('ignores CAMSTACK_JWT_SECRET / ADMIN_* and config.yaml auth credentials, and warns without values', () => {
    vi.stubEnv('CAMSTACK_JWT_SECRET', 'env-jwt-value')
    vi.stubEnv('CAMSTACK_ADMIN_USER', 'root')
    vi.stubEnv('CAMSTACK_ADMIN_PASS', 'env-pass-value')
    fs.writeFileSync(configPath, 'auth:\n  jwtSecret: yaml-jwt-value\n  adminPassword: yaml-pass\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const config = loadBootstrapConfig(configPath)

    expect(config.auth).toEqual({})
    const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(warned).toContain('CAMSTACK_JWT_SECRET')
    expect(warned).toContain('auth.jwtSecret')
    for (const value of ['env-jwt-value', 'env-pass-value', 'yaml-jwt-value', 'yaml-pass']) {
      expect(warned).not.toContain(value)
    }
  })

  it('a fresh config.yaml carries no auth credentials', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    loadBootstrapConfig(configPath)
    const written = fs.readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('jwtSecret')
    expect(written).not.toContain('adminPassword')
  })
})
