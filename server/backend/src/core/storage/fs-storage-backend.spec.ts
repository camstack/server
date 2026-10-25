// server/backend/src/core/storage/fs-storage-backend.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FsStorageBackend } from './fs-storage-backend'

describe('FsStorageBackend', () => {
  let tempDir: string
  let backend: FsStorageBackend

  beforeEach(() => {
    tempDir = join(tmpdir(), `fs-backend-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    backend = new FsStorageBackend(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('type is local', () => {
    expect(backend.type).toBe('local')
  })

  it('basePath is resolved to absolute', () => {
    const relative = new FsStorageBackend('./relative/path')
    expect(relative.basePath).toContain('/')
    expect(relative.basePath).not.toContain('./')
  })

  it('resolve joins subpath', () => {
    expect(backend.resolve('models/yolov8n.onnx')).toBe(join(tempDir, 'models/yolov8n.onnx'))
  })

  it('resolve returns absolute paths as-is', () => {
    expect(backend.resolve('/absolute/path')).toBe('/absolute/path')
  })

  it('isAvailable returns true for existing writable dir', () => {
    expect(backend.isAvailable()).toBe(true)
  })

  // As root every existing ancestor (here `/`) is writable, so the premise of
  // this case cannot hold: a self-hosted CI runner executes the suite as root.
  const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
  it.skipIf(runsAsRoot)('isAvailable returns false when no existing ancestor is writable', () => {
    // Nothing under /nonexistent exists, so no writable ancestor →
    // the backend cannot be created when needed.
    const missing = new FsStorageBackend('/nonexistent/path/xyz')
    expect(missing.isAvailable()).toBe(false)
  })

  it('isAvailable returns true for a not-yet-existing dir whose parent is writable', () => {
    // Lazy creation: the backend reports itself as available when the
    // nearest existing ancestor (tempDir) is writable, because we can
    // `mkdir -p` the missing segments on first write.
    const notYet = new FsStorageBackend(join(tempDir, 'sub', 'dir'))
    expect(notYet.isAvailable()).toBe(true)
  })

  it('initialize is a no-op — directory is created lazily on first write', async () => {
    const { existsSync } = await import('node:fs')
    const newPath = join(tempDir, 'sub', 'dir')
    const newBackend = new FsStorageBackend(newPath)
    // The base dir doesn't exist yet, but the ancestor chain is
    // writable — so the backend is available and initialize is a
    // no-op (doesn't create the dir eagerly).
    expect(newBackend.isAvailable()).toBe(true)
    await newBackend.initialize()
    expect(existsSync(newPath)).toBe(false)
  })
})
