/**
 * The hub's addon sweep is the npm probe: one sweep is one outcome. It reports
 * "not reached" only when lookups were made and none answered, "reached" when
 * any did, and nothing when no addon was looked up at all.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonPackageService } from '../addon-package.service.js'

vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({
    startJob: async () => ({ jobId: 'job-1' }),
    getJob: () => null,
    listJobs: () => [],
    cancelJob: () => ({ cancelled: false }),
    reconcile: async () => ({ resumed: 0, failed: 0 }),
  }),
}))

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

function buildService(): AddonPackageService {
  const stub = {}
  return new AddonPackageService(
    { createLogger: () => logger } as never,
    { emit: () => undefined } as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
  )
}

function writeAddon(addonsDir: string, name: string): void {
  const dir = path.join(addonsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', camstack: { addons: [{ id: name }] } }),
  )
}

describe('npm reachability from the hub addon sweep', () => {
  let root = ''
  let previousAddonsDir: string | undefined
  const events: string[] = []

  beforeEach(() => {
    events.length = 0
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-reach-'))
    previousAddonsDir = process.env['CAMSTACK_ADDONS_DIR']
    process.env['CAMSTACK_ADDONS_DIR'] = root
  })

  afterEach(() => {
    if (previousAddonsDir === undefined) delete process.env['CAMSTACK_ADDONS_DIR']
    else process.env['CAMSTACK_ADDONS_DIR'] = previousAddonsDir
    fs.rmSync(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  function observe(service: AddonPackageService): void {
    service.setNpmReachabilityObserver({
      reached: async () => {
        events.push('reached')
      },
      failed: async (reason) => {
        events.push(`failed:${reason}`)
      },
    })
  }

  it('reports failed when every lookup throws', async () => {
    writeAddon(root, '@camstack/addon-a')
    writeAddon(root, '@camstack/addon-b')
    vi.stubGlobal('fetch', async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    })
    const service = buildService()
    observe(service)
    await service.checkUpdates(true)
    expect(events).toEqual(['failed:ENOTFOUND registry.npmjs.org'])
  })

  it('reports reached when a lookup answers', async () => {
    writeAddon(root, '@camstack/addon-a')
    vi.stubGlobal('fetch', async () => Response.json({ version: '1.0.0' }))
    const service = buildService()
    observe(service)
    await service.checkUpdates(true)
    expect(events).toEqual(['reached'])
  })

  it('says nothing when there was no lookup', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('should not be called')
    })
    const service = buildService()
    observe(service)
    await service.checkUpdates(true)
    expect(events).toEqual([])
  })
})
