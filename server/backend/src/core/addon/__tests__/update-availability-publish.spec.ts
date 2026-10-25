/**
 * `listFrameworkPackages` is the surface that SHOWS `@camstack/system` has an
 * update — and it published nothing at all, so the operator was never told.
 * These tests pin the publish, the downgrade guard (the live hub runs a
 * `-dev.<ts>` build that is NEWER than the npm tag, and announcing that as an
 * "update" would be a lie), and the fallible-read rule: a registry lookup that
 * FAILS must log and publish nothing, never look like "no updates".
 *
 * They also pin the poll-interval knob living on the auto-update settings
 * surface, and surviving a restart.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger, SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Both resolve against the `vi.mock`s below, which vitest hoists above every
// import. The `execFile` fake reads `npmViewResult` only when CALLED, so the
// binding is initialised by then.
import {
  DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
  MIN_UPDATE_CHECK_INTERVAL_SECONDS,
} from '../../updates/update-check-scheduler.js'
import { AddonPackageService } from '../addon-package.service.js'

type ExecFileCallback = (err: Error | null, out?: { stdout: string; stderr: string }) => void

let npmViewResult: { readonly ok: true; readonly stdout: string } | { readonly ok: false } = {
  ok: true,
  stdout: '999.0.0\n',
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
      if (npmViewResult.ok) cb(null, { stdout: npmViewResult.stdout, stderr: '' })
      else cb(new Error('npm view failed: ENOTFOUND registry.npmjs.org'))
      return undefined
    },
  }
})

vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({
    startJob: async () => ({ jobId: 'job-1' }),
    getJob: () => null,
    listJobs: () => [],
    cancelJob: () => ({ cancelled: false }),
    reconcile: async () => ({ resumed: 0, failed: 0 }),
  }),
}))

type LogCall = { readonly message: string; readonly meta: unknown }

function recordingLogger(sink: LogCall[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, meta?: unknown) => {
      sink.push({ message, meta })
    },
    error: (message: string, meta?: unknown) => {
      sink.push({ message, meta })
    },
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

interface Built {
  readonly service: InstanceType<typeof AddonPackageService>
  readonly emitted: SystemEvent[]
  readonly warnings: LogCall[]
}

function buildService(): Built {
  const emitted: SystemEvent[] = []
  const warnings: LogCall[] = []
  const loggingService = { createLogger: () => recordingLogger(warnings) }
  const bus = { emit: (event: SystemEvent) => emitted.push(event) }
  const stub = {}
  const service = new AddonPackageService(
    loggingService as never,
    bus as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
  )
  return { service, emitted, warnings }
}

function availabilityEvents(events: readonly SystemEvent[]): readonly SystemEvent[] {
  return events.filter((event) => event.category === 'update.available')
}

describe('listFrameworkPackages → update.available', () => {
  let dataDir = ''
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env['CAMSTACK_DATA']
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fw-avail-'))
    process.env['CAMSTACK_DATA'] = dataDir
    npmViewResult = { ok: true, stdout: '999.0.0\n' }
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env['CAMSTACK_DATA']
    else process.env['CAMSTACK_DATA'] = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('publishes a server-target availability event when the registry is genuinely newer', async () => {
    const { service, emitted } = buildService()
    const rows = await service.listFrameworkPackages()
    expect(rows[0]?.latestVersion).toBe('999.0.0')

    const events = availabilityEvents(emitted)
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({
      target: 'server',
      packageName: '@camstack/system',
      latestVersion: '999.0.0',
    })
  })

  /**
   * The DISPLAYED flag has to obey the same rule as the published event.
   * `hasUpdate` was `latest !== current`, so a hub running a `-dev.<ts>` build
   * AHEAD of the npm tag — exactly what the live hub does — lit an "update
   * available" badge that, if followed, is a DOWNGRADE. The publish path
   * already gated on strictly-newer; the row the UI reads did not, so the two
   * disagreed on the same page.
   */
  it('does not flag an OLDER registry tag as an available update', async () => {
    npmViewResult = { ok: true, stdout: '0.0.1\n' }
    const { service, emitted } = buildService()

    const rows = await service.listFrameworkPackages()

    expect(rows[0]?.latestVersion).toBe('0.0.1')
    expect(rows[0]?.hasUpdate, 'an older tag is not an update').toBe(false)
    expect(availabilityEvents(emitted), 'and nothing is announced').toHaveLength(0)
  })

  it('announces the same framework version only once', async () => {
    const { service, emitted } = buildService()
    await service.listFrameworkPackages()
    await service.listFrameworkPackages()
    expect(availabilityEvents(emitted)).toHaveLength(1)
  })

  it('never announces a registry version OLDER than what is running', async () => {
    npmViewResult = { ok: true, stdout: '0.0.1\n' }
    const { service, emitted } = buildService()
    const rows = await service.listFrameworkPackages()
    expect(rows[0]?.currentVersion).not.toBe('unknown')
    expect(availabilityEvents(emitted)).toHaveLength(0)
  })

  it('logs and publishes nothing when the registry lookup FAILS', async () => {
    npmViewResult = { ok: false }
    const { service, emitted, warnings } = buildService()
    await service.listFrameworkPackages()

    expect(availabilityEvents(emitted)).toHaveLength(0)
    expect(warnings.some((w) => /framework/i.test(w.message))).toBe(true)
  })
})

describe('a failed registry lookup never looks like "no updates"', () => {
  let dataDir = ''
  let previousDataDir: string | undefined
  let latestByName: Record<string, string | 'fail'> = {}

  beforeEach(() => {
    previousDataDir = process.env['CAMSTACK_DATA']
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fallible-'))
    process.env['CAMSTACK_DATA'] = dataDir
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      const encoded = url.split('/').at(-2) ?? ''
      const name = decodeURIComponent(encoded)
      const latest = latestByName[name]
      if (latest === undefined) return new Response(null, { status: 404 })
      if (latest === 'fail') throw new Error('ENOTFOUND registry.npmjs.org')
      return new Response(JSON.stringify({ version: latest }), { status: 200 })
    }) as typeof fetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousDataDir === undefined) delete process.env['CAMSTACK_DATA']
    else process.env['CAMSTACK_DATA'] = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('keeps the dedup state intact when one lookup fails mid-check', async () => {
    const { service, emitted, warnings } = buildService()
    const installed = [{ name: '@camstack/addon-pipeline', version: '1.2.3' }]

    latestByName = { '@camstack/addon-pipeline': '1.2.4' }
    await service.checkUpdatesForInstalled(installed, 'agent-a')
    expect(availabilityEvents(emitted)).toHaveLength(1)

    // The registry goes away. This must NOT publish an empty snapshot: an
    // empty snapshot is "up to date" and would clear the dedup state.
    latestByName = { '@camstack/addon-pipeline': 'fail' }
    await service.checkUpdatesForInstalled(installed, 'agent-a')
    expect(availabilityEvents(emitted)).toHaveLength(1)
    const incomplete = warnings.find((w) => /incomplete/i.test(w.message))
    expect(incomplete).toBeDefined()
    expect(incomplete?.meta).toMatchObject({ tags: { nodeId: 'agent-a' } })

    // Registry comes back with the SAME answer — still nothing new to say.
    latestByName = { '@camstack/addon-pipeline': '1.2.4' }
    await service.checkUpdatesForInstalled(installed, 'agent-a')
    expect(availabilityEvents(emitted)).toHaveLength(1)
  })

  it('still clears the scope when a COMPLETE check finds nothing', async () => {
    const { service, emitted } = buildService()
    const installed = [{ name: '@camstack/addon-pipeline', version: '1.2.3' }]

    latestByName = { '@camstack/addon-pipeline': '1.2.4' }
    await service.checkUpdatesForInstalled(installed, 'agent-a')
    expect(availabilityEvents(emitted)).toHaveLength(1)

    // Operator installed it. A clean, complete check drops the row…
    latestByName = { '@camstack/addon-pipeline': '1.2.4' }
    await service.checkUpdatesForInstalled(
      [{ name: '@camstack/addon-pipeline', version: '1.2.4' }],
      'agent-a',
    )
    // …so the same version becomes announceable again if it ever regresses.
    latestByName = { '@camstack/addon-pipeline': '1.2.4' }
    await service.checkUpdatesForInstalled(installed, 'agent-a')
    expect(availabilityEvents(emitted)).toHaveLength(2)
  })
})

describe('update-check interval setting', () => {
  let dataDir = ''
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env['CAMSTACK_DATA']
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-interval-'))
    process.env['CAMSTACK_DATA'] = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env['CAMSTACK_DATA']
    else process.env['CAMSTACK_DATA'] = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('defaults to six hours and rides on the auto-update settings surface', () => {
    const { service } = buildService()
    const settings = service.getAutoUpdateSettings()
    expect(settings.channel).toBe('off')
    expect(settings.updateCheckIntervalSeconds).toBe(DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS)
    expect(DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS).toBe(6 * 60 * 60)
  })

  it('persists a changed interval and re-arms the poller', async () => {
    const { service } = buildService()
    const reschedule = vi.fn()
    service.setUpdateCheckRescheduler(reschedule)

    await service.setAutoUpdateSettings('off', undefined, 3_600)

    expect(reschedule).toHaveBeenCalledTimes(1)
    expect(service.getAutoUpdateSettings().updateCheckIntervalSeconds).toBe(3_600)

    // Restart: a fresh service reads the interval back off disk.
    const { service: reloaded } = buildService()
    expect(reloaded.getAutoUpdateSettings().updateCheckIntervalSeconds).toBe(3_600)
  })

  it('refuses an interval below the documented minimum', async () => {
    const { service } = buildService()
    await service.setAutoUpdateSettings('off', undefined, 5)
    expect(service.getAutoUpdateSettings().updateCheckIntervalSeconds).toBe(
      MIN_UPDATE_CHECK_INTERVAL_SECONDS,
    )
  })
})
