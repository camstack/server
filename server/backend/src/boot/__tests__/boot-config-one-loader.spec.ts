import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigManager } from '@camstack/server/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBootstrapConfig } from '../boot-config'

/**
 * #342: there is ONE bootstrap loader (the kernel's). The hub's `main.ts` and
 * `ConfigManager` come through it, so an env override applies in both.
 * A leftover config.yaml is not read (D1018; the one-release transition reader is gone).
 */
describe('one bootstrap loader', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-config-one-'))
    configPath = path.join(dir, 'config.yaml')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('a leftover config.yaml is not read: the port stays the built-in default', () => {
    fs.writeFileSync(
      configPath,
      [
        'mode: agent',
        'hub: { url: "ws://x:1/agent", token: t }',
        'agent: { name: edge, statusPort: 9999 }',
        'auth: { jwtSecret: s }',
        'tls: { enabled: false }',
        'bootstrap: { settingsStoreAddon: "@x/y", forceDisable: ["@a/b"], installSource: local, requiredAddons: ["@x/y"] }',
        'keychain: { masterKeyFile: /x/key }',
        'server: { port: 5151 }',
        '',
      ].join('\n'),
    )
    vi.stubEnv('CONFIG_PATH', configPath)
    vi.stubEnv('CAMSTACK_PORT', '')
    const warn = vi.spyOn(console, 'warn')
    const config = loadBootstrapConfig()

    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).not.toMatch(/installSource|requiredAddons|config\.yaml/)
    const manager = new ConfigManager()
    expect('requiredAddons' in config.bootstrap).toBe(false)
    expect('installSource' in config.bootstrap).toBe(false)
    expect(Object.keys(config).sort()).toEqual(['bootstrap', 'server'])
    expect(config.server.port).toBe(4443)
    expect(config.bootstrap).toEqual({})
    for (const dead of ['mode', 'hub.url', 'agent.name', 'tls.enabled', 'auth.jwtSecret']) {
      expect(manager.getBootstrap(dead)).toBeUndefined()
    }
    expect(manager.getBootstrap<number>('server.port')).toBe(4443)
  })

  it('the retired secret and CORS env variables are not named at boot any more', () => {
    for (const name of [
      'CAMSTACK_JWT_SECRET',
      'CAMSTACK_ADMIN_USER',
      'CAMSTACK_ADMIN_PASS',
      'CAMSTACK_CLUSTER_SECRET',
      'CAMSTACK_SECRET_KEY',
      'HF_TOKEN',
      'HUGGING_FACE_HUB_TOKEN',
      'CAMSTACK_CORS_ORIGINS',
    ]) {
      vi.stubEnv(name, 'set-in-the-container')
    }
    const warn = vi.spyOn(console, 'warn')
    loadBootstrapConfig()
    const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(warned).not.toMatch(/CAMSTACK_JWT_SECRET|CAMSTACK_CORS_ORIGINS|HF_TOKEN|ignored/)
  })

  it('the launcher no longer reads bootstrap.requiredAddons: its set is the role default', () => {
    const launcher = fs.readFileSync(path.resolve(__dirname, '../../launcher.ts'), 'utf-8')
    expect(launcher).not.toMatch(/requiredAddons|readBootstrapRequiredAddons|bootstrapSchema/)
    expect(launcher).toMatch(/AddonInstaller\.AGENT_PACKAGES : deriveBootstrapFromSelf\(\)/)
  })

  it('an env override reaches both views', () => {
    vi.stubEnv('CAMSTACK_PORT', '6262')
    expect(loadBootstrapConfig().server.port).toBe(6262)
    expect(new ConfigManager().getBootstrap<number>('server.port')).toBe(6262)
  })

  it('no second loader exists in the hub backend or the system package', () => {
    const roots = [
      path.resolve(__dirname, '../../'),
      path.resolve(__dirname, '../../../../../packages/system/src'),
    ]
    const loaders: string[] = []
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf-8')
          if (/bootstrapSchema\.(safeParse|parse)\(/.test(text)) {
            loaders.push(path.relative(path.resolve(__dirname, '../../../../..'), full))
          }
        }
      }
    }
    for (const root of roots) walk(root)
    expect(loaders.sort()).toEqual(['packages/system/src/kernel/bootstrap-config.ts'])
    const env: string[] = []
    const walkEnv = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walkEnv(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
          if (fs.readFileSync(full, 'utf-8').includes("CAMSTACK_DATA: 'server.dataPath'")) {
            env.push(path.relative(path.resolve(__dirname, '../../../../..'), full))
          }
        }
      }
    }
    for (const root of roots) walkEnv(root)
    expect(env).toEqual(['packages/system/src/kernel/bootstrap-config.ts'])
  })
})
