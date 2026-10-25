import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ignoredTlsCertSources, loadBootstrapConfig } from '../boot-config'

/**
 * D726: the admin UI is the only way to set a node's certificate. The old
 * env path (`CAMSTACK_TLS_CERT` / `CAMSTACK_TLS_KEY`, mapped onto
 * `tls.certPath` / `tls.keyPath`) is ignored — loudly, so an operator who
 * still has it set learns where the certificate went.
 */
describe('boot config — certificate env is ignored (D726)', () => {
  let dir: string
  let configPath: string
  const saved = {
    cert: process.env['CAMSTACK_TLS_CERT'],
    key: process.env['CAMSTACK_TLS_KEY'],
    enabled: process.env['CAMSTACK_TLS_ENABLED'],
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-tls-'))
    configPath = path.join(dir, 'config.yaml')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    restore('CAMSTACK_TLS_CERT', saved.cert)
    restore('CAMSTACK_TLS_KEY', saved.key)
    restore('CAMSTACK_TLS_ENABLED', saved.enabled)
    vi.restoreAllMocks()
  })

  it('names every env variable and config.yaml key that used to set a certificate', () => {
    expect(
      ignoredTlsCertSources(
        { CAMSTACK_TLS_CERT: '/certs/a.pem', CAMSTACK_TLS_KEY: '/certs/a.key' },
        { tls: { certPath: '/x.pem', keyPath: '/x.key' } },
      ),
    ).toEqual(['CAMSTACK_TLS_CERT', 'CAMSTACK_TLS_KEY', 'tls.certPath', 'tls.keyPath'])
  })

  it('names nothing when none is set, blank env included', () => {
    expect(ignoredTlsCertSources({ CAMSTACK_TLS_CERT: '' }, { tls: { enabled: true } })).toEqual([])
    expect(ignoredTlsCertSources({}, {})).toEqual([])
  })

  it('does not carry the env certificate into the parsed config, and WARNs at boot', () => {
    process.env['CAMSTACK_TLS_CERT'] = '/certs/fullchain.pem'
    process.env['CAMSTACK_TLS_KEY'] = '/certs/privkey.pem'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const config = loadBootstrapConfig(configPath)

    expect(config.tls).toEqual({ enabled: true })
    const lines = warn.mock.calls.map((call) => String(call[0]))
    const ignored = lines.find((line) => line.includes('CAMSTACK_TLS_CERT'))
    expect(ignored).toBeDefined()
    expect(ignored).toContain('CAMSTACK_TLS_KEY')
    expect(ignored).toContain('ignored')
    expect(ignored).toContain('Network → Local access')
  })

  it('drops a config.yaml certificate path too, and WARNs', () => {
    fs.writeFileSync(
      configPath,
      'server: {}\nauth: {}\ntls:\n  enabled: true\n  certPath: /c.pem\n  keyPath: /c.key\n',
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(loadBootstrapConfig(configPath).tls).toEqual({ enabled: true })
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'tls.certPath, tls.keyPath ignored',
    )
  })

  it('still honours CAMSTACK_TLS_ENABLED — plain HTTP behind a reverse proxy', () => {
    process.env['CAMSTACK_TLS_ENABLED'] = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(loadBootstrapConfig(configPath).tls.enabled).toBe(false)
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
