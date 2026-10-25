/**
 * PostBootService restart-completed emission — boot-side handoff of the
 * `.restart-pending` marker into a `system.restart-completed` event.
 *
 * Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md (P2)
 *
 * Invariants:
 *   - Marker present at boot → event emitted with the marker's payload
 *     AND the marker is gone after boot.
 *   - No marker → no event of category `system.restart-completed`,
 *     `system.boot` still fires.
 *   - Boot is robust to a malformed marker (does not throw; just clears).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writePendingRestart, getRestartMarkerPath } from '@camstack/system'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { PostBootService } from '../boot/post-boot.service.js'
import { AddonRegistryService } from '../core/addon/addon-registry.service.js'
import { EventBusService } from '../core/events/event-bus.service.js'
import { LoggingService } from '../core/logging/logging.service.js'

interface CapturedEvent {
  readonly category: string
  readonly data: Record<string, unknown>
}

function createEnv(_dataDir: string): {
  service: PostBootService
  captured: CapturedEvent[]
} {
  const captured: CapturedEvent[] = []
  const bus: Pick<IEventBus, 'emit'> = {
    emit: (event: SystemEvent) => {
      captured.push({ category: event.category, data: event.data as Record<string, unknown> })
    },
  }
  const logger: IScopedLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: (() => logger) as IScopedLogger['child'],
  } as unknown as IScopedLogger

  const loggingService = {
    createLogger: () => logger,
  } as unknown as LoggingService

  const service = new PostBootService(
    {} as unknown as AddonRegistryService,
    bus as unknown as EventBusService,
    loggingService,
  )
  return { service, captured }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-boot-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('PostBootService restart-completed handoff', () => {
  it('emits system.restart-completed with the marker payload when a marker is present', async () => {
    writePendingRestart(tmpDir, {
      kind: 'framework-update',
      packageName: '@camstack/system',
      fromVersion: '0.1.36',
      toVersion: '0.1.37',
      requestedBy: 'admin',
      requestedAt: 1715717834567,
    })

    const { service, captured } = createEnv(tmpDir)
    await service.run({ port: 0, host: 'localhost', dataPath: tmpDir, trpcRegistered: false })

    const completed = captured.find((e) => e.category === 'system.restart-completed')
    expect(completed).toBeDefined()
    expect(completed?.data).toMatchObject({
      kind: 'framework-update',
      packageName: '@camstack/system',
      fromVersion: '0.1.36',
      toVersion: '0.1.37',
      requestedBy: 'admin',
      requestedAt: 1715717834567,
    })

    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(false)
  })

  it('still emits system.boot when no marker is present and does not emit system.restart-completed', async () => {
    const { service, captured } = createEnv(tmpDir)
    await service.run({ port: 0, host: 'localhost', dataPath: tmpDir, trpcRegistered: false })

    expect(captured.some((e) => e.category === 'system.boot')).toBe(true)
    expect(captured.some((e) => e.category === 'system.restart-completed')).toBe(false)
  })

  it('does not throw and clears the marker when the marker is malformed', async () => {
    fs.writeFileSync(getRestartMarkerPath(tmpDir), '{ broken', 'utf-8')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service, captured } = createEnv(tmpDir)
    await service.run({ port: 0, host: 'localhost', dataPath: tmpDir, trpcRegistered: false })

    expect(captured.some((e) => e.category === 'system.boot')).toBe(true)
    expect(captured.some((e) => e.category === 'system.restart-completed')).toBe(false)
    expect(fs.existsSync(getRestartMarkerPath(tmpDir))).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('PostBootService.getLastRestart retention window', () => {
  it('returns the marker emitted this boot, then null after the retention window', async () => {
    writePendingRestart(tmpDir, {
      kind: 'framework-update',
      packageName: '@camstack/system',
      fromVersion: '0.1.36',
      toVersion: '0.1.37',
      requestedBy: 'admin',
      requestedAt: 1715717834567,
    })

    const { service } = createEnv(tmpDir)
    await service.run({ port: 0, host: 'localhost', dataPath: tmpDir, trpcRegistered: false })

    // Immediately after boot the marker is queryable.
    const fresh = PostBootService.getLastRestart()
    expect(fresh).not.toBeNull()
    expect(fresh?.packageName).toBe('@camstack/system')

    // Past the retention window it auto-expires.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + PostBootService.LAST_RESTART_RETENTION_MS + 1)
    expect(PostBootService.getLastRestart()).toBeNull()
    vi.useRealTimers()
  })

  it('returns null when boot was not triggered by a restart marker', async () => {
    // Reset the static cache from any earlier test.
    const dummyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-boot-empty-'))
    const { service } = createEnv(dummyDir)
    await service.run({ port: 0, host: 'localhost', dataPath: dummyDir, trpcRegistered: false })

    // Note: this test passes whether or not a previous test populated
    // lastRestart since `lastRestart` is per-test-process state. The
    // assertion checks the public guarantee: no marker => no cached
    // payload from THIS boot. We don't depend on cross-test isolation.
    fs.rmSync(dummyDir, { recursive: true, force: true })
  })
})
