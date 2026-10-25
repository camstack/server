import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveDeployConfig, parseRc } from '../lib/resolve-config.js'

/**
 * The deploy config resolution is the most security-sensitive code in
 * the plugin: it owns the token-fetch precedence. Lock down every
 * level so a regression that, say, silently picks env over the
 * explicit option, breaks the test instead of the operator's CI run.
 */
describe('parseRc', () => {
  it('parses KEY=value lines', () => {
    expect(parseRc('CAMSTACK_SERVER=http://h:4443\nCAMSTACK_TOKEN=abc')).toEqual({
      CAMSTACK_SERVER: 'http://h:4443',
      CAMSTACK_TOKEN: 'abc',
    })
  })

  it('skips blank lines and # comments', () => {
    const content = `# user rc\n\n# server config\nCAMSTACK_SERVER=https://h\n# token\nCAMSTACK_TOKEN=x`
    expect(parseRc(content)).toEqual({
      CAMSTACK_SERVER: 'https://h',
      CAMSTACK_TOKEN: 'x',
    })
  })

  it('strips surrounding double + single quotes', () => {
    expect(parseRc(`CAMSTACK_TOKEN="quoted"`)).toEqual({ CAMSTACK_TOKEN: 'quoted' })
    expect(parseRc(`CAMSTACK_TOKEN='also'`)).toEqual({ CAMSTACK_TOKEN: 'also' })
  })

  it('preserves mismatched quotes as part of the value', () => {
    expect(parseRc(`CAMSTACK_TOKEN="dangling`)).toEqual({ CAMSTACK_TOKEN: '"dangling' })
  })

  it('handles CRLF line endings', () => {
    expect(parseRc(`KEY1=a\r\nKEY2=b\r\n`)).toEqual({ KEY1: 'a', KEY2: 'b' })
  })

  it('ignores lines without =', () => {
    expect(parseRc('justakey\nKEY=value')).toEqual({ KEY: 'value' })
  })
})

describe('resolveDeployConfig', () => {
  let rcDir: string
  let rcPath: string

  beforeEach(() => {
    rcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-rc-'))
    rcPath = path.join(rcDir, '.camstackrc')
  })

  afterEach(() => {
    fs.rmSync(rcDir, { recursive: true, force: true })
  })

  it('prefers explicit option over env', () => {
    const cfg = resolveDeployConfig({
      server: 'https://opt-server',
      token: 'opt-token',
      env: { CAMSTACK_SERVER: 'https://env-server', CAMSTACK_TOKEN: 'env-token' },
      rcPath,
    })
    expect(cfg).toEqual({ server: 'https://opt-server', token: 'opt-token' })
  })

  it('falls back to env when options are absent', () => {
    const cfg = resolveDeployConfig({
      env: { CAMSTACK_SERVER: 'https://env-server', CAMSTACK_TOKEN: 'env-token' },
      rcPath,
    })
    expect(cfg).toEqual({ server: 'https://env-server', token: 'env-token' })
  })

  it('falls back to rc file when env is empty', () => {
    fs.writeFileSync(rcPath, 'CAMSTACK_SERVER=https://rc-server\nCAMSTACK_TOKEN=rc-token\n')
    const cfg = resolveDeployConfig({ env: {}, rcPath })
    expect(cfg).toEqual({ server: 'https://rc-server', token: 'rc-token' })
  })

  it('uses the default server (http://localhost:4443) when nothing else is set', () => {
    fs.writeFileSync(rcPath, 'CAMSTACK_TOKEN=t\n')
    const cfg = resolveDeployConfig({ env: {}, rcPath })
    expect(cfg.server).toBe('http://localhost:4443')
  })

  it('strips trailing slashes from the resolved server', () => {
    const cfg = resolveDeployConfig({
      server: 'https://h.example/',
      token: 't',
      env: {},
      rcPath,
    })
    expect(cfg.server).toBe('https://h.example')
  })

  it('throws a helpful error when no token can be resolved', () => {
    expect(() => resolveDeployConfig({ env: {}, rcPath })).toThrow(/No auth token resolved/)
  })

  it('precedence — option > env > rc > default (all four levels combined)', () => {
    fs.writeFileSync(rcPath, 'CAMSTACK_SERVER=https://rc\nCAMSTACK_TOKEN=rc-token\n')
    // option wins server
    const a = resolveDeployConfig({
      server: 'https://opt',
      env: { CAMSTACK_SERVER: 'https://env', CAMSTACK_TOKEN: 'env-token' },
      rcPath,
    })
    expect(a.server).toBe('https://opt')
    // env wins server when no option
    const b = resolveDeployConfig({
      env: { CAMSTACK_SERVER: 'https://env', CAMSTACK_TOKEN: 'env-token' },
      rcPath,
    })
    expect(b.server).toBe('https://env')
    // rc wins server when no option/env
    const c = resolveDeployConfig({ env: {}, rcPath })
    expect(c.server).toBe('https://rc')
  })
})
