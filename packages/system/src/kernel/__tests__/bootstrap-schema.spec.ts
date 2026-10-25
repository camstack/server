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
    expect(parsed.bootstrap.settingsStoreAddon).toBe('@camstack/addon-sqlite-storage')
    expect(parsed.bootstrap.requiredAddons).toBeUndefined()
    expect(parsed.bootstrap.forceDisable).toEqual([])
  })

  it('preserves explicit values over defaults', () => {
    const parsed = bootstrapSchema.parse({
      bootstrap: {
        settingsStoreAddon: '@camstack/addon-postgres-storage',
        requiredAddons: ['@camstack/system', '@camstack/addon-pipeline'],
        forceDisable: ['@camstack/addon-broken'],
      },
    })
    expect(parsed.bootstrap.settingsStoreAddon).toBe('@camstack/addon-postgres-storage')
    expect(parsed.bootstrap.requiredAddons).toEqual([
      '@camstack/system',
      '@camstack/addon-pipeline',
    ])
    expect(parsed.bootstrap.forceDisable).toEqual(['@camstack/addon-broken'])
  })

  it('accepts an empty requiredAddons array (operator wants zero auto-installs)', () => {
    const parsed = bootstrapSchema.parse({
      bootstrap: { requiredAddons: [] },
    })
    expect(parsed.bootstrap.requiredAddons).toEqual([])
  })

  it('keeps backward compatibility with pre-bootstrap-section config.yaml', () => {
    // A config.yaml that pre-dates the bootstrap section should still parse.
    const parsed = bootstrapSchema.parse({
      mode: 'hub',
      server: { port: 4443, host: '0.0.0.0', dataPath: 'camstack-data' },
      auth: { adminUsername: 'admin', adminPassword: 'changeme', jwtSecret: null },
    })
    expect(parsed.bootstrap).toBeDefined()
    expect(parsed.bootstrap.settingsStoreAddon).toBe('@camstack/addon-sqlite-storage')
    // The retired credentials are stripped, never carried (D797).
    expect(parsed.auth).toEqual({})
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

describe('bootstrapSchema — server.corsOrigins (D707)', () => {
  it('defaults to an empty list', () => {
    expect(bootstrapSchema.parse({}).server.corsOrigins).toEqual([])
  })

  it('takes a YAML list as is', () => {
    const parsed = bootstrapSchema.parse({
      server: { corsOrigins: ['https://a.example', 'http://localhost:8081'] },
    })
    expect(parsed.server.corsOrigins).toEqual(['https://a.example', 'http://localhost:8081'])
  })

  it('splits the comma-separated env string (CAMSTACK_CORS_ORIGINS)', () => {
    const parsed = bootstrapSchema.parse({
      server: { corsOrigins: ' https://a.example, ,http://localhost:8081 ' },
    })
    expect(parsed.server.corsOrigins).toEqual(['https://a.example', 'http://localhost:8081'])
  })
})
