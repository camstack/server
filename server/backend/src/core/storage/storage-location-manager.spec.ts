// server/backend/src/core/storage/storage-location-manager.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StorageLocationManager, type StorageLocationName } from './storage-location-manager'

describe('StorageLocationManager', () => {
  let tempDir: string
  let manager: StorageLocationManager

  beforeEach(() => {
    tempDir = join(tmpdir(), `slm-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    manager = new StorageLocationManager(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    rmSync('/tmp/camstack-cache', { recursive: true, force: true })
  })

  it('initializeDefaults registers all 6 location backends', async () => {
    await manager.initializeDefaults()
    const names = manager.getLocationNames()
    expect(names).toHaveLength(6)
    expect(names).toContain('data')
    expect(names).toContain('media')
    expect(names).toContain('recordings')
    expect(names).toContain('models')
    expect(names).toContain('cache')
    expect(names).toContain('logs')
  })

  it('initializeDefaults does NOT create the location directories on disk (lazy)', async () => {
    await manager.initializeDefaults()
    // None of the 6 location paths should exist — directories are
    // created on first write by the filesystem storage provider, not
    // eagerly at boot. This is the anti-bloat invariant: a fresh
    // installation should not materialise empty `recordings/`,
    // `media/`, `logs/` folders just because StorageLocationManager
    // was initialized.
    expect(existsSync(join(tempDir, 'db'))).toBe(false)
    expect(existsSync(join(tempDir, 'media'))).toBe(false)
    expect(existsSync(join(tempDir, 'recordings'))).toBe(false)
    expect(existsSync(join(tempDir, 'models'))).toBe(false)
    expect(existsSync(join(tempDir, 'logs'))).toBe(false)
  })

  it('initializeDefaults reports all locations as available (parent dir writable)', async () => {
    await manager.initializeDefaults()
    const status = manager.getStatus()
    // A backend is "available" as long as it can be created when
    // needed (nearest existing ancestor is writable). Since `tempDir`
    // exists and is writable, every location underneath it is
    // available even though the location dir itself does not yet
    // exist.
    for (const entry of status) {
      expect(entry.available).toBe(true)
    }
  })

  it('getLocationNames returns all 6 location names', async () => {
    await manager.initializeDefaults()
    const names = manager.getLocationNames()
    const expected: StorageLocationName[] = [
      'data',
      'media',
      'recordings',
      'models',
      'cache',
      'logs',
    ]
    expect(names.toSorted()).toEqual(expected.toSorted())
  })

  it('resolve joins subpath correctly within a location', async () => {
    await manager.initializeDefaults()
    const resolved = manager.resolve('data', 'camstack.db')
    expect(resolved).toBe(join(tempDir, 'db', 'camstack.db'))
  })

  it('resolve for cache uses /tmp/camstack-cache base', async () => {
    await manager.initializeDefaults()
    const resolved = manager.resolve('cache', 'thumbnails')
    expect(resolved).toBe('/tmp/camstack-cache/thumbnails')
  })

  it('setLocationPath overrides a location with absolute path', async () => {
    await manager.initializeDefaults()
    const newPath = join(tempDir, 'custom-media')
    await manager.setLocationPath('media', newPath)
    const backend = manager.getBackend('media')
    expect(backend.basePath).toBe(newPath)
    // Still lazy — overriding the path doesn't eagerly create it.
    expect(backend.isAvailable()).toBe(true)
    expect(existsSync(newPath)).toBe(false)
  })

  it('setLocationPath overrides a location with relative path (resolved against dataPath)', async () => {
    await manager.initializeDefaults()
    await manager.setLocationPath('logs', 'custom-logs')
    const backend = manager.getBackend('logs')
    expect(backend.basePath).toBe(join(tempDir, 'custom-logs'))
    expect(backend.isAvailable()).toBe(true)
  })

  it('getStatus reports all locations with name, available, path', async () => {
    await manager.initializeDefaults()
    const status = manager.getStatus()
    expect(status).toHaveLength(6)
    for (const entry of status) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('available')
      expect(entry).toHaveProperty('path')
      expect(typeof entry.available).toBe('boolean')
    }
  })

  it('missing location throws error', () => {
    // not initialized
    expect(() => manager.getBackend('data')).toThrow('Storage location "data" not initialized')
  })

  it('resolve on uninitialized location throws error', () => {
    expect(() => manager.resolve('media', 'file.mp4')).toThrow(
      'Storage location "media" not initialized',
    )
  })
})
