import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrapConfig } from '../bootstrap-config.js'
import { legacyConfigYamlCandidates, reconcileLegacyConfigYaml } from '../legacy-config-yaml.js'

/** TRANSITION spec (D1018): goes with `legacy-config-yaml.ts` one release after it ships. */
describe('legacy config.yaml transition', () => {
  let dir: string
  let file: string
  let warn: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>

  /** Env that points the legacy lookup at this spec's dir and nothing else. */
  const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({
    CAMSTACK_DATA: dir,
    ...extra,
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-config-yaml-'))
    file = path.join(dir, 'config.yaml')
    for (const name of ['CAMSTACK_PORT', 'CAMSTACK_HOST', 'CAMSTACK_DATA', 'CONFIG_PATH']) {
      vi.stubEnv(name, '')
    }
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const load = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    return loadBootstrapConfig()
  }
  const warnings = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n')

  it('no file: defaults, no note', () => {
    const config = load(envFor())
    expect(config.server.port).toBe(4443)
    expect(warnings()).toBe('')
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('can be deleted')
  })

  it('a file equal to the defaults is ignored with one INFO line', () => {
    fs.writeFileSync(file, 'server:\n  port: 4443\n  host: 0.0.0.0\n')
    const config = load(envFor())
    expect(config.server.port).toBe(4443)
    expect(warnings()).toBe('')
    const info = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('can be deleted'))
    expect(info).toHaveLength(1)
  })

  it('a differing port with no env var is applied and the WARN names CAMSTACK_PORT', () => {
    fs.writeFileSync(file, 'server:\n  port: 8443\n')
    const config = load(envFor())
    expect(config.server.port).toBe(8443)
    expect(warnings()).toContain('CAMSTACK_PORT=8443')
    expect(warnings()).toContain(file)
  })

  it('a differing host is applied; a data path stays the env value', () => {
    fs.writeFileSync(file, 'server:\n  host: 127.0.0.1\n  dataPath: /srv/cam\n')
    const config = load({ CAMSTACK_DATA: dir })
    // CAMSTACK_DATA is set, so the data path stays the env value.
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.dataPath).toBe(dir)
    expect(warnings()).toContain('CAMSTACK_HOST=127.0.0.1')
    expect(warnings()).not.toContain('CAMSTACK_DATA=')
  })

  it('a differing port with the env var set: env wins and no port warning', () => {
    fs.writeFileSync(file, 'server:\n  port: 8443\n')
    const config = load(envFor({ CAMSTACK_PORT: '9000' }))
    expect(config.server.port).toBe(9000)
    expect(warnings()).not.toContain('CAMSTACK_PORT=8443')
  })

  it('an unparsable file is ignored with a warning and boot continues', () => {
    fs.writeFileSync(file, 'server: [unclosed\n  port: : :\n')
    const config = load(envFor())
    expect(config.server.port).toBe(4443)
    expect(warnings()).toContain('could not be parsed')
  })

  it('CONFIG_PATH is searched first', () => {
    const other = path.join(dir, 'elsewhere.yaml')
    fs.writeFileSync(other, 'server:\n  port: 7000\n')
    expect(legacyConfigYamlCandidates({ CONFIG_PATH: other, CAMSTACK_DATA: dir })[0]).toBe(other)
    expect(load(envFor({ CONFIG_PATH: other })).server.port).toBe(7000)
  })

  it('retired keys keep their notice', () => {
    fs.writeFileSync(file, 'keychain:\n  keyFile: /k\nbootstrap:\n  installSource: local\n')
    load(envFor())
    expect(warnings()).toContain('keychain.keyFile')
    expect(warnings()).toContain('/run/secrets/camstack-master-key')
    expect(warnings()).toContain('bootstrap.installSource')
  })

  it('reconcile is pure over the env it is given', () => {
    fs.writeFileSync(file, 'server:\n  port: 8443\n')
    const result = reconcileLegacyConfigYaml(
      { CAMSTACK_DATA: dir },
      { port: 4443, host: '0.0.0.0', dataPath: dir },
    )
    expect(result.overrides).toEqual({ port: 8443 })
  })
})
