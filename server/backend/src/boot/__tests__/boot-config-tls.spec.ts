import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeTlsEnabled } from '@camstack/server/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ignoredTlsCertSources,
  loadBootstrapConfig,
  retiredTlsEnabledSources,
  setupInfra,
} from '../boot-config'

/**
 * D726: the admin UI is the only way to set a node's certificate; the env path
 * is ignored, loudly. #342: whether the hub serves HTTPS at all is the
 * "Serve HTTPS" setting in Network → Local access, read at boot from the
 * `tls/enabled` marker — never `CAMSTACK_TLS_ENABLED` and never a yaml key.
 */
describe('boot config — certificate env is ignored (D726)', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-tls-'))
    configPath = path.join(dir, 'config.yaml')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('names every env variable that used to set a certificate', () => {
    expect(
      ignoredTlsCertSources({
        CAMSTACK_TLS_CERT: '/certs/a.pem',
        CAMSTACK_TLS_KEY: '/certs/a.key',
      }),
    ).toEqual(['CAMSTACK_TLS_CERT', 'CAMSTACK_TLS_KEY'])
  })

  it('names nothing when none is set, blank env included', () => {
    expect(ignoredTlsCertSources({ CAMSTACK_TLS_CERT: '' })).toEqual([])
    expect(ignoredTlsCertSources({})).toEqual([])
  })

  it('WARNs at boot that the env certificate is ignored', () => {
    vi.stubEnv('CAMSTACK_TLS_CERT', '/certs/fullchain.pem')
    vi.stubEnv('CAMSTACK_TLS_KEY', '/certs/privkey.pem')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    loadBootstrapConfig(configPath)

    const ignored = warn.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('CAMSTACK_TLS_CERT'))
    expect(ignored).toContain('CAMSTACK_TLS_KEY')
    expect(ignored).toContain('Network → Local access')
  })

  it('names the retired CAMSTACK_TLS_ENABLED and warns, with no tls key in the config', () => {
    expect(retiredTlsEnabledSources({ CAMSTACK_TLS_ENABLED: 'false' })).toEqual([
      'CAMSTACK_TLS_ENABLED',
    ])
    vi.stubEnv('CAMSTACK_TLS_ENABLED', 'false')
    fs.writeFileSync(configPath, 'tls:\n  enabled: false\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const config = loadBootstrapConfig(configPath)

    expect(config).not.toHaveProperty('tls')
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('CAMSTACK_TLS_ENABLED')
  })
})

describe('setupInfra — HTTPS is the stored setting, with a floor of on', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-tls-infra-'))
    configPath = path.join(dir, 'config.yaml')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function boot() {
    fs.writeFileSync(configPath, `server:\n  dataPath: ${dir}\n`)
    return setupInfra(configPath, loadBootstrapConfig(configPath))
  }

  it('first boot, no stored value: HTTPS on', async () => {
    const infra = await boot()
    expect(infra.tlsOptions).toBeDefined()
  })

  it('a stored false serves plain HTTP after boot', async () => {
    writeTlsEnabled(dir, false)
    const infra = await boot()
    expect(infra.tlsOptions).toBeUndefined()
  })

  it('the env variable changes nothing: still HTTPS with no stored value', async () => {
    vi.stubEnv('CAMSTACK_TLS_ENABLED', 'false')
    const infra = await boot()
    expect(infra.tlsOptions).toBeDefined()
  })

  it('a yaml tls.enabled changes nothing either', async () => {
    fs.writeFileSync(configPath, `server:\n  dataPath: ${dir}\ntls:\n  enabled: false\n`)
    const infra = await setupInfra(configPath, loadBootstrapConfig(configPath))
    expect(infra.tlsOptions).toBeDefined()
  })
})
