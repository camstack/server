/**
 * bootstrapSchema — addon bootstrap section coverage.
 *
 * The new `bootstrap` section is what lets the kernel know which addon
 * provides the settings-store + which packages MUST be installed before
 * the kernel can read the persisted addon list. Locking the schema
 * shape here protects the boot-time contract from accidental drift.
 *
 * Spec: docs/superpowers/specs/2026-05-15-yaml-bootstrap-expansion.md
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { loadBootstrapConfig } from '../bootstrap-config.js'
import { bootstrapSchema } from '../config-schema.js'

describe('bootstrapSchema — bootstrap.* defaults', () => {
  it('defaults the entire bootstrap section when YAML omits it', () => {
    const parsed = bootstrapSchema.parse({})
    expect(parsed.bootstrap).toEqual({})
  })
})

describe('bootstrapSchema — dead yaml keys are ignored (#342)', () => {
  it('strips mode, hub, agent, auth, tls and the retired bootstrap keys instead of reading them', () => {
    const parsed = bootstrapSchema.parse({
      mode: 'agent',
      hub: { url: 'ws://elsewhere:1/agent', token: 'x' },
      agent: { name: 'edge', statusPort: 9999 },
      auth: { adminUsername: 'admin', adminPassword: 'changeme', jwtSecret: 'abc' },
      tls: { enabled: false },
      server: { port: 5555 },
      bootstrap: {
        settingsStoreAddon: '@camstack/addon-postgres-storage',
        forceDisable: ['@camstack/addon-broken'],
        installSource: 'local',
        requiredAddons: ['@x/y'],
      },
    })
    expect(Object.keys(parsed).sort()).toEqual(['bootstrap', 'server'])
    expect(parsed.server.port).toBe(5555)
    expect(parsed.bootstrap).toEqual({})
  })

  it('names exactly the surviving bootstrap keys', () => {
    const parsed = bootstrapSchema.parse({
      server: {},
      bootstrap: {},
    })
    expect(Object.keys(parsed.server).sort()).toEqual(['dataPath', 'host', 'port'])
    expect(Object.keys(parsed.bootstrap)).toEqual([])
  })
})

describe('bootstrapSchema — retired bootstrap.installSource', () => {
  it('strips the key: a yaml that still carries any value parses without it', () => {
    for (const value of ['npm', 'local', 'symlink', 'rsync']) {
      const parsed = bootstrapSchema.parse({ bootstrap: { installSource: value } })
      expect(parsed.bootstrap).toEqual({})
      expect('installSource' in parsed.bootstrap).toBe(false)
    }
  })
})

describe('bootstrapSchema — retired bootstrap.requiredAddons', () => {
  it('strips the key, empty array included: a yaml that still carries it parses without it', () => {
    for (const value of [[], ['@x/y']]) {
      const parsed = bootstrapSchema.parse({ bootstrap: { requiredAddons: value } })
      expect(parsed.bootstrap).toEqual({})
      expect('requiredAddons' in parsed.bootstrap).toBe(false)
    }
  })
})

describe('bootstrapSchema — retired server.corsOrigins (D707)', () => {
  it('no longer carries the key: a stale yaml value is stripped', () => {
    const parsed = bootstrapSchema.parse({ server: { corsOrigins: ['https://a.example'] } })
    expect(parsed.server).not.toHaveProperty('corsOrigins')
  })
})

describe('retired keychain.keyFile / keychain.previousKeyFile (D991)', () => {
  it('warns once, naming the mounted path, and boots with the section stripped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-keychain-'))
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, 'keychain:\n  keyFile: /k\n  previousKeyFile: /p\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const parsed = loadBootstrapConfig(file, { warnRetiredKeys: true })
      expect('keychain' in parsed).toBe(false)
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('keychain.keyFile'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('[Phase1] WARN')
      expect(lines[0]).toContain('/run/secrets/camstack-master-key')
    } finally {
      warn.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
