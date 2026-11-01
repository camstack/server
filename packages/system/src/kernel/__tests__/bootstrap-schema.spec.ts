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
import { describe, it, expect } from 'vitest'
import { bootstrapSchema } from '../config-schema.js'

describe('bootstrapSchema — bootstrap.* defaults', () => {
  it('defaults the entire bootstrap section when YAML omits it', () => {
    const parsed = bootstrapSchema.parse({})
    expect(parsed.bootstrap).toEqual({})
  })

  it('preserves explicit values over defaults', () => {
    const parsed = bootstrapSchema.parse({
      bootstrap: { requiredAddons: ['@camstack/server', '@camstack/addon-pipeline'] },
    })
    expect(parsed.bootstrap.requiredAddons).toEqual([
      '@camstack/server',
      '@camstack/addon-pipeline',
    ])
  })

  it('accepts an empty requiredAddons array (operator wants zero auto-installs)', () => {
    const parsed = bootstrapSchema.parse({
      bootstrap: { requiredAddons: [] },
    })
    expect(parsed.bootstrap.requiredAddons).toEqual([])
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
      },
    })
    expect(Object.keys(parsed).sort()).toEqual(['bootstrap', 'keychain', 'server'])
    expect(parsed.server.port).toBe(5555)
    expect(parsed.bootstrap).toEqual({ installSource: 'local' })
  })

  it('names exactly the surviving bootstrap keys', () => {
    const parsed = bootstrapSchema.parse({
      server: {},
      bootstrap: { installSource: 'npm', requiredAddons: [] },
      keychain: { keyFile: '/k', previousKeyFile: '/p' },
    })
    expect(Object.keys(parsed.server).sort()).toEqual(['dataPath', 'host', 'port'])
    expect(Object.keys(parsed.bootstrap).sort()).toEqual(['installSource', 'requiredAddons'])
    expect(Object.keys(parsed.keychain).sort()).toEqual(['keyFile', 'previousKeyFile'])
  })
})

describe('bootstrapSchema — bootstrap.installSource', () => {
  it('defaults to undefined when YAML omits it (launcher uses its own resolution)', () => {
    const parsed = bootstrapSchema.parse({})
    expect(parsed.bootstrap.installSource).toBeUndefined()
  })

  it('accepts the three known modes', () => {
    for (const value of ['npm', 'local', 'symlink'] as const) {
      const parsed = bootstrapSchema.parse({ bootstrap: { installSource: value } })
      expect(parsed.bootstrap.installSource).toBe(value)
    }
  })

  it('rejects unknown install source values', () => {
    const result = bootstrapSchema.safeParse({ bootstrap: { installSource: 'rsync' } })
    expect(result.success).toBe(false)
  })
})

describe('bootstrapSchema — retired server.corsOrigins (D707)', () => {
  it('no longer carries the key: a stale yaml value is stripped', () => {
    const parsed = bootstrapSchema.parse({ server: { corsOrigins: ['https://a.example'] } })
    expect(parsed.server).not.toHaveProperty('corsOrigins')
  })
})
