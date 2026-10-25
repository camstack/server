import { describe, it, expect } from 'vitest'
import {
  isLocationEnabled,
  LegacyStorageLocationDefaultSchema,
  StorageLocationSchema,
  StorageLocationRefSchema,
  StorageLocationTypeSchema,
} from '../storage-location.js'

describe('StorageLocationSchema', () => {
  it('parses a valid persisted record', () => {
    const now = Date.now()
    const parsed = StorageLocationSchema.parse({
      id: 'backups:default',
      type: 'backups',
      providerId: 'filesystem-storage',
      displayName: 'Default Backups',
      config: { basePath: '/var/data/backups' },
      createdAt: now,
      updatedAt: now,
    })
    expect(parsed.id).toBe('backups:default')
    expect(parsed.type).toBe('backups')
    expect(parsed.providerId).toBe('filesystem-storage')
    expect(parsed.displayName).toBe('Default Backups')
    expect(parsed.config).toEqual({ basePath: '/var/data/backups' })
    expect(parsed.createdAt).toBe(now)
    expect(parsed.updatedAt).toBe(now)
  })

  it('strips the RETIRED isDefault key — enabled is the whole write model (D383)', () => {
    const now = Date.now()
    const parsed = StorageLocationSchema.parse({
      id: 'backups:nas-01',
      type: 'backups',
      providerId: 'sftp-storage',
      displayName: 'NAS backups',
      config: {},
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })
    expect('isDefault' in parsed).toBe(false)
    // …and the one reader that still needs it — the orchestrator's boot
    // migration — takes it from the schema that DECLARES it, rather than from a
    // key silently stripped here (D380/D381).
    expect(LegacyStorageLocationDefaultSchema.parse({ isDefault: true }).isDefault).toBe(true)
    expect(LegacyStorageLocationDefaultSchema.parse({}).isDefault).toBeUndefined()
  })

  it('reads an absent enabled flag as ENABLED, in one place', () => {
    expect(isLocationEnabled({})).toBe(true)
    expect(isLocationEnabled({ enabled: true })).toBe(true)
    expect(isLocationEnabled({ enabled: false })).toBe(false)
  })

  it('rejects an id with no colon', () => {
    expect(() =>
      StorageLocationSchema.parse({
        id: 'invalid',
        type: 'backups',
        providerId: 'filesystem-storage',
        displayName: 'X',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow()
  })

  it('rejects an id with uppercase characters', () => {
    expect(() =>
      StorageLocationSchema.parse({
        id: 'BACKUPS:Foo',
        type: 'backups',
        providerId: 'filesystem-storage',
        displayName: 'X',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow()
  })

  it('rejects an id with empty slug after the colon', () => {
    expect(() =>
      StorageLocationSchema.parse({
        id: 'backups:',
        type: 'backups',
        providerId: 'filesystem-storage',
        displayName: 'X',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow()
  })

  it('rejects an empty displayName', () => {
    expect(() =>
      StorageLocationSchema.parse({
        id: 'backups:default',
        type: 'backups',
        providerId: 'filesystem-storage',
        displayName: '',
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow()
  })
})

describe('StorageLocationTypeSchema', () => {
  it('accepts well-known built-in type ids', () => {
    const builtins = [
      'data',
      'media',
      'recordings',
      'recordings-high',
      'recordings-low',
      'recordings-clips',
      'event-images',
      'models',
      'cache',
      'logs',
      'addons-data',
      'backups',
    ] as const
    for (const t of builtins) {
      expect(StorageLocationTypeSchema.parse(t)).toBe(t)
    }
  })

  it('accepts an addon-declared id that does not appear in the old enum', () => {
    expect(StorageLocationTypeSchema.parse('my-addon-storage')).toBe('my-addon-storage')
  })

  it('accepts camelCase ids (mixed case after first char)', () => {
    expect(StorageLocationTypeSchema.parse('myAddonStorage')).toBe('myAddonStorage')
  })

  it('rejects an id that starts with an uppercase letter', () => {
    expect(() => StorageLocationTypeSchema.parse('BadType')).toThrow()
  })

  it('rejects an id containing a space', () => {
    expect(() => StorageLocationTypeSchema.parse('bad type')).toThrow()
  })

  it('rejects an empty string', () => {
    expect(() => StorageLocationTypeSchema.parse('')).toThrow()
  })
})

describe('StorageLocationRefSchema', () => {
  it('accepts a bare StorageLocationType', () => {
    expect(StorageLocationRefSchema.parse('backups')).toBe('backups')
  })

  it('accepts every known StorageLocationType', () => {
    const types = [
      'data',
      'media',
      'recordings',
      'models',
      'cache',
      'logs',
      'addons-data',
      'backups',
    ] as const
    for (const t of types) {
      expect(StorageLocationRefSchema.parse(t)).toBe(t)
    }
  })

  it('accepts an addon-declared type id not in the old enum', () => {
    expect(StorageLocationRefSchema.parse('myAddonStorage')).toBe('myAddonStorage')
  })

  it('accepts a fully-qualified id', () => {
    expect(StorageLocationRefSchema.parse('backups:nas-01')).toBe('backups:nas-01')
  })

  it('accepts a camelCase declared id (e.g. recordingsLow:default)', () => {
    // Declaration ids may be camelCase; the instance id `<id>:<slug>` must too.
    expect(StorageLocationRefSchema.parse('recordingsLow:default')).toBe('recordingsLow:default')
    expect(StorageLocationRefSchema.parse('eventMedia:default')).toBe('eventMedia:default')
    expect(
      StorageLocationSchema.parse({
        id: 'recordingsLow:default',
        type: 'recordingsLow',
        providerId: 'fs',
        displayName: 'R',
        config: {},
        isSystem: true,
        createdAt: 1,
        updatedAt: 1,
      }).id,
    ).toBe('recordingsLow:default')
  })

  it('rejects an empty slug after the colon', () => {
    expect(() => StorageLocationRefSchema.parse('backups:')).toThrow()
  })

  it('rejects an uppercase id', () => {
    expect(() => StorageLocationRefSchema.parse('BACKUPS:Foo')).toThrow()
  })
})
