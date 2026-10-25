import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SystemBackupService } from '../system-backup.service.js'

/**
 * `statLocations` specs, split out of `system-backup.service.spec.ts`: the
 * TTL-cache spec sleeps 40 ms against a 30 ms window and times out under
 * machine load. Heavy specs run only in the on-demand Checks (`npm run
 * test:heavy`).
 */
const noopLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

describe('SystemBackupService', () => {
  let tmpRoot: string
  let dataDir: string
  let service: SystemBackupService

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-sysbackup-'))
    dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.yaml'), 'cluster: prod\n')
    fs.mkdirSync(path.join(dataDir, 'addons', '@camstack', 'foo'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(dataDir, 'addons', '@camstack', 'foo', 'package.json'),
      JSON.stringify({ name: '@camstack/foo', version: '1.0.0' }),
    )
    service = new SystemBackupService(dataDir, noopLogger)
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('statLocations reports sizes without excluded subtrees — the modal shows what will be archived', async () => {
    const addonDir = path.join(dataDir, 'addons', '@camstack', 'foo')
    fs.mkdirSync(path.join(addonDir, 'node_modules', 'dep'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(addonDir, 'node_modules', 'dep', 'big.js'), 'x'.repeat(8192))

    const stats = await service.statLocations(['addons'])
    // Only the seeded package.json counts — node_modules is invisible.
    expect(stats[0]?.fileCount).toBe(1)
    expect(stats[0]?.sizeBytes).toBeLessThan(8192)
  })

  describe('statLocations', () => {
    it('resolves stats for present and missing locations without blocking', async () => {
      const stats = await service.statLocations(['config.yaml', 'addons', 'tls'])
      const byName = new Map(stats.map((s) => [s.name, s]))
      expect(byName.get('config.yaml')?.present).toBe(true)
      expect(byName.get('config.yaml')?.fileCount).toBe(1)
      expect(byName.get('addons')?.present).toBe(true)
      expect(byName.get('addons')?.fileCount).toBe(1)
      expect(byName.get('addons')?.sizeBytes).toBeGreaterThan(0)
      expect(byName.get('tls')?.present).toBe(false)
      expect(byName.get('tls')?.fileCount).toBe(0)
    })

    it('caches results within the TTL window and re-walks after it expires', async () => {
      const cached = new SystemBackupService(dataDir, noopLogger, {
        statCacheTtlMs: 30,
      })
      const first = await cached.statLocations(['addons'])
      fs.writeFileSync(path.join(dataDir, 'addons', 'extra.txt'), 'x')
      const second = await cached.statLocations(['addons'])
      expect(second[0]?.fileCount).toBe(first[0]?.fileCount)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const third = await cached.statLocations(['addons'])
      expect(third[0]?.fileCount).toBe((first[0]?.fileCount ?? 0) + 1)
    })

    it('single-flights concurrent stats of the same location', async () => {
      const [a, b] = await Promise.all([
        service.statLocations(['addons']),
        service.statLocations(['addons']),
      ])
      expect(a[0]).toBe(b[0])
    })
  })
})
