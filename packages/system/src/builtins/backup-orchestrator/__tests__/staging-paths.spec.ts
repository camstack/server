/**
 * Staging-directory placement + boot sweep.
 *
 * Two invariants proven here, both learned on the live hub:
 *
 * 1. The archive build/restore staging dir must live OUTSIDE every
 *    backed-up location. It used to be
 *    `addons-data/backup-orchestrator/staging` — inside the
 *    `addons-data` location — so pre-Jul-28 archives contained every
 *    previous archive (175M → 503M → 4.5G compounding), and even after
 *    the tar-filter fix the leaked files sat inside the backup set's
 *    own tree. It also must NOT be `<dataDir>/backups`: with
 *    `CAMSTACK_BACKUP_ROOT` unset (Electron, plain docker without the
 *    env) the default `backups` storage location seeds at exactly
 *    `<nodeDataDir>/backups`, and transient build files must never mix
 *    into an archive destination.
 *
 * 2. Staging is transient and must be swept at boot. `triggerBackup`
 *    deletes its archive in `finally`, but a runner crash mid-fanout
 *    leaks the file forever (the hub held staging archives from July),
 *    and a restore download is consumed by the boot-time hook without
 *    ever being deleted. The sweep must spare a file a pending-restore
 *    marker still points at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import {
  measureDirectoryFootprint,
  resolveStagingDir,
  STAGING_DIR_NAME,
  sweepStagingDir,
} from '../staging-paths.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('resolveStagingDir', () => {
  it('places staging directly under the node data root, outside addons-data', () => {
    const dir = resolveStagingDir('/data')
    expect(dir).toBe(path.join('/data', STAGING_DIR_NAME))
    expect(dir.includes('addons-data')).toBe(false)
  })

  it('never collides with the default backups destination (<dataDir>/backups)', () => {
    const dir = resolveStagingDir('/data')
    expect(dir).not.toBe('/data/backups')
    expect(dir.startsWith('/data/backups/')).toBe(false)
  })
})

describe('sweepStagingDir', () => {
  let tmpRoot: string
  let stagingDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-staging-'))
    stagingDir = path.join(tmpRoot, STAGING_DIR_NAME)
    fs.mkdirSync(stagingDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('removes stale files and reports the freed bytes', async () => {
    fs.writeFileSync(path.join(stagingDir, 'a.tar.gz'), 'x'.repeat(1000))
    fs.writeFileSync(path.join(stagingDir, 'a.tar.gz.7.manifest.json'), 'y'.repeat(200))

    const result = await sweepStagingDir({
      stagingDir,
      keepPaths: [],
      logger: makeLogger(),
    })

    expect(result.removedCount).toBe(2)
    expect(result.freedBytes).toBe(1200)
    expect(fs.readdirSync(stagingDir)).toEqual([])
  })

  it('removes stale subdirectories recursively', async () => {
    const sub = path.join(stagingDir, 'partial-extract')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'file.bin'), 'z'.repeat(300))

    const result = await sweepStagingDir({
      stagingDir,
      keepPaths: [],
      logger: makeLogger(),
    })

    expect(result.removedCount).toBe(1)
    expect(result.freedBytes).toBe(300)
    expect(fs.existsSync(sub)).toBe(false)
  })

  it('spares a file a pending-restore marker still points at', async () => {
    const restoreArchive = path.join(stagingDir, 'restore-abc.tar.gz')
    fs.writeFileSync(restoreArchive, 'restore-bytes')
    fs.writeFileSync(path.join(stagingDir, 'stale.tar.gz'), 'stale')

    const result = await sweepStagingDir({
      stagingDir,
      keepPaths: [restoreArchive],
      logger: makeLogger(),
    })

    expect(result.removedCount).toBe(1)
    expect(result.keptCount).toBe(1)
    expect(fs.existsSync(restoreArchive)).toBe(true)
    expect(fs.existsSync(path.join(stagingDir, 'stale.tar.gz'))).toBe(false)
  })

  it('is a no-op on a missing staging dir', async () => {
    const result = await sweepStagingDir({
      stagingDir: path.join(tmpRoot, 'does-not-exist'),
      keepPaths: [],
      logger: makeLogger(),
    })
    expect(result.removedCount).toBe(0)
    expect(result.freedBytes).toBe(0)
  })
})

describe('measureDirectoryFootprint', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-footprint-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('sums files recursively', async () => {
    const dir = path.join(tmpRoot, 'legacy')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.bin'), 'x'.repeat(100))
    fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), 'y'.repeat(50))

    const fp = await measureDirectoryFootprint(dir)
    expect(fp.present).toBe(true)
    expect(fp.fileCount).toBe(2)
    expect(fp.totalBytes).toBe(150)
  })

  it('reports an absent dir as not present', async () => {
    const fp = await measureDirectoryFootprint(path.join(tmpRoot, 'nope'))
    expect(fp.present).toBe(false)
    expect(fp.fileCount).toBe(0)
    expect(fp.totalBytes).toBe(0)
  })
})
