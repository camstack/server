/**
 * There is no config.yaml (D1018). The one-release reader is gone: a leftover
 * file does not move port, host or data path.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrapConfig } from '../bootstrap-config.js'

describe('bootstrap config ignores a leftover config.yaml', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('keeps the built-in port when the file names another', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-config-yaml-'))
    dirs.push(dir)
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, 'server:\n  port: 5151\n  host: 10.0.0.1\n  dataPath: /elsewhere\n')
    vi.stubEnv('CONFIG_PATH', file)
    vi.stubEnv('CAMSTACK_DATA', dir)
    vi.stubEnv('CAMSTACK_PORT', '')
    vi.stubEnv('CAMSTACK_HOST', '')
    const config = loadBootstrapConfig()
    expect(config.server.port).toBe(4443)
    expect(config.server.host).toBe('0.0.0.0')
    expect(config.server.dataPath).not.toBe('/elsewhere')
  })
})
