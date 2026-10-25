/**
 * Unit tests for `StorageOrchestratorService.seedDefaults` — first-boot
 * default location seeding (declaration-driven).
 *
 * Tests instantiate the service directly with a fake provider lookup and
 * an injected cardinality source; they do NOT boot a real `BaseAddon` or
 * kernel. The addon-level lazy/eager wiring (event-bus +
 * `seedFromDeclarations`) is covered by integration once a fully booted
 * hub ships.
 */
import { describe, expect, it, vi } from 'vitest'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never

describe('seedDefaults (declaration-driven)', () => {
  it('seeds one <id>:default per declaration under basePath/<id>', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [
        { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
        { id: 'logs', displayName: 'Logs', cardinality: 'single' },
      ],
    })
    expect(svc.getLocationById('recordings:default')?.config['basePath']).toBe('/data/recordings')
    expect(svc.getLocationById('logs:default')?.displayName).toBe('Logs')
  })

  it('routes defaultRoot:media declarations onto mediaBasePath (parent + defaultsTo child)', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      mediaBasePath: '/media',
      declarations: [
        { id: 'recordings', displayName: 'R', cardinality: 'multi', defaultRoot: 'media' },
        {
          id: 'recordingsLow',
          displayName: 'R Low',
          cardinality: 'multi',
          defaultsTo: 'recordings',
        },
        { id: 'backups', displayName: 'B', cardinality: 'multi' },
      ],
    })
    // media-marked → media volume; defaultsTo child inherits it; non-media → data.
    expect(svc.getLocationById('recordings:default')?.config['basePath']).toBe('/media/recordings')
    expect(svc.getLocationById('recordingsLow:default')?.config['basePath']).toBe(
      '/media/recordings',
    )
    expect(svc.getLocationById('backups:default')?.config['basePath']).toBe('/data/backups')
  })

  it('routes defaultRoot:backup declarations onto backupBasePath, falling back to basePath', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      backupBasePath: '/backups',
      declarations: [
        { id: 'backups', displayName: 'B', cardinality: 'multi', defaultRoot: 'backup' },
      ],
    })
    expect(svc.getLocationById('backups:default')?.config['basePath']).toBe('/backups/backups')

    const svc2 = new StorageOrchestratorService(logger, () => [], null)
    svc2.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc2.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [
        { id: 'backups', displayName: 'B', cardinality: 'multi', defaultRoot: 'backup' },
      ],
    })
    expect(svc2.getLocationById('backups:default')?.config['basePath']).toBe('/data/backups')
  })

  it('media declarations fall back to basePath when mediaBasePath is absent', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [
        { id: 'recordings', displayName: 'R', cardinality: 'multi', defaultRoot: 'media' },
      ],
    })
    expect(svc.getLocationById('recordings:default')?.config['basePath']).toBe('/data/recordings')
  })

  it('defaultsTo shares the referenced location root', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [
        { id: 'recordings', displayName: 'R', cardinality: 'multi' },
        {
          id: 'recordingsLow',
          displayName: 'R Low',
          cardinality: 'multi',
          defaultsTo: 'recordings',
        },
      ],
    })
    expect(svc.getLocationById('recordingsLow:default')?.config['basePath']).toBe(
      '/data/recordings',
    )
  })

  it('is idempotent', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    const declarations = [{ id: 'recordings', displayName: 'R', cardinality: 'multi' as const }]
    svc.seedDefaults({ providerId: 'fs', basePath: '/data', declarations })
    svc.seedDefaults({ providerId: 'fs', basePath: '/data', declarations })
    expect(svc.listLocations().filter((l) => l.type === 'recordings')).toHaveLength(1)
  })

  it('seeded ids satisfy the StorageLocationSchema id regex (`<type>:<slug>`)', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    svc.seedDefaults({
      providerId: 'fs',
      basePath: '/data',
      declarations: [
        { id: 'recordings', displayName: 'R', cardinality: 'multi' },
        { id: 'event-images', displayName: 'EI', cardinality: 'multi' },
      ],
    })
    const idRegex = /^[a-z][a-z0-9-]*:[a-z0-9-]+$/
    for (const loc of svc.listLocations()) {
      expect(loc.id).toMatch(idRegex)
    }
  })

  it('skips ids that already have ANY location (operator override wins)', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
    // Operator already configured a custom recordings location on a NAS.
    svc.upsertLocation({
      id: 'recordings:nas-01',
      type: 'recordings',
      displayName: 'NAS Recordings',
      providerId: 'sftp-remote',
      config: { host: 'nas.local', basePath: '/volume1/camstack' },
      isSystem: false,
    })
    svc.seedDefaults({
      providerId: 'filesystem-storage',
      basePath: '/data',
      declarations: [
        { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
        { id: 'logs', displayName: 'Logs', cardinality: 'single' },
      ],
    })
    const recordings = svc.listLocations({ type: 'recordings' })
    expect(recordings).toHaveLength(1)
    expect(recordings[0]?.id).toBe('recordings:nas-01')
    // logs was untouched, so it WAS seeded.
    expect(svc.getLocationById('logs:default')).toBeDefined()
  })
})

describe('pruneUndeclaredSystemLocations', () => {
  const recordingsDecl = { id: 'recordings', displayName: 'R', cardinality: 'multi' as const }
  it('prunes system rows of undeclared types but keeps declared + operator rows', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    // seed a declared one + manually inject stale rows
    svc.setRegistry({
      cardinalityOf: (id) => (id === 'recordings' ? 'multi' : null),
      accessOf: (id) => (id === 'recordings' ? 'local-path' : null),
      list: () => [recordingsDecl],
    })
    svc.seedDefaults({ providerId: 'fs', basePath: '/data', declarations: [recordingsDecl] })
    // inject a stale system row + an operator row of an undeclared type
    svc.upsertLocation({
      id: 'cache:default',
      type: 'cache',
      displayName: 'Cache',
      providerId: 'fs',
      config: {},
      isSystem: true,
    })
    svc.upsertLocation({
      id: 'recordings-low:nas',
      type: 'recordings-low',
      displayName: 'Old NAS',
      providerId: 'fs',
      config: {},
      isSystem: false,
    })
    svc.pruneUndeclaredSystemLocations()
    expect(svc.getLocationById('recordings:default')).toBeDefined() // declared → kept
    expect(svc.getLocationById('cache:default')).toBeUndefined() // undeclared system → pruned
    expect(svc.getLocationById('recordings-low:nas')).toBeDefined() // undeclared operator → kept
  })

  it('FAIL-SAFE: never prunes when the registry is empty (declarations not loaded)', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] }) // empty → declarations missing
    svc.upsertLocation({
      id: 'data:default',
      type: 'data',
      displayName: 'Data',
      providerId: 'fs',
      config: {},
      isSystem: true,
    })
    svc.upsertLocation({
      id: 'recordings:default',
      type: 'recordings',
      displayName: 'R',
      providerId: 'fs',
      config: {},
      isSystem: true,
    })
    svc.pruneUndeclaredSystemLocations()
    expect(svc.getLocationById('data:default')).toBeDefined() // NOT wiped
    expect(svc.getLocationById('recordings:default')).toBeDefined() // NOT wiped
  })
})
