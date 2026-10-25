/**
 * The dedup state behind `update.available` must OUTLIVE the process.
 *
 * It used to be two RAM Maps, so every hub restart re-announced every update
 * the operator had already seen and dismissed. These tests pin the durable
 * contract: a (package, version) announces exactly once ACROSS a restart, and
 * a genuinely newer version announces again.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateAvailabilityEmitter } from '../update-availability-emitter.js'
import { FileUpdateAvailabilityStore } from '../update-availability-store.js'

function busOf(emit: (event: SystemEvent) => void): IEventBus {
  return { emit } as unknown as IEventBus
}

function silentLogger(): IScopedLogger {
  const instance: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => instance,
    withTags: () => instance,
  }
  return instance
}

const PIPELINE = {
  target: 'addon' as const,
  packageName: '@camstack/addon-pipeline',
  currentVersion: '1.2.3',
  latestVersion: '1.2.4',
}

describe('UpdateAvailabilityEmitter durable dedup', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-update-avail-'))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('announces a (package, version) exactly once across a simulated restart', () => {
    const first = vi.fn<(event: SystemEvent) => void>()
    const before = new UpdateAvailabilityEmitter(
      busOf(first),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    before.publishSnapshot('addon', [PIPELINE])
    expect(first).toHaveBeenCalledTimes(1)

    // --- process restart: brand-new emitter, same on-disk scope -------------
    const second = vi.fn<(event: SystemEvent) => void>()
    const after = new UpdateAvailabilityEmitter(
      busOf(second),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    after.publishSnapshot('addon', [PIPELINE])

    expect(second).not.toHaveBeenCalled()
  })

  it('announces again after a restart when a NEWER version shows up', () => {
    const before = new UpdateAvailabilityEmitter(
      busOf(vi.fn()),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    before.publishSnapshot('addon', [PIPELINE])

    const emit = vi.fn<(event: SystemEvent) => void>()
    const after = new UpdateAvailabilityEmitter(
      busOf(emit),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    after.publishSnapshot('addon', [{ ...PIPELINE, latestVersion: '1.2.5' }])

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0].data).toMatchObject({ latestVersion: '1.2.5' })
  })

  it('rehydrates the full held list so a restart-then-new-package event lists both', () => {
    const before = new UpdateAvailabilityEmitter(
      busOf(vi.fn()),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    before.publishSnapshot('addon', [PIPELINE])

    const emit = vi.fn<(event: SystemEvent) => void>()
    const after = new UpdateAvailabilityEmitter(
      busOf(emit),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    const reolink = {
      target: 'addon' as const,
      packageName: '@camstack/addon-provider-reolink',
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
    }
    after.publishSnapshot('addon', [PIPELINE, reolink])

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0].data).toMatchObject({
      packages: [
        { packageName: PIPELINE.packageName, latestVersion: PIPELINE.latestVersion },
        { packageName: reolink.packageName, latestVersion: reolink.latestVersion },
      ],
    })
  })

  it('keeps separate scopes in separate files', () => {
    const addonEmit = vi.fn<(event: SystemEvent) => void>()
    const serverEmit = vi.fn<(event: SystemEvent) => void>()
    new UpdateAvailabilityEmitter(
      busOf(addonEmit),
      { type: 'core', id: 'a' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    ).publishSnapshot('addon', [PIPELINE])
    new UpdateAvailabilityEmitter(
      busOf(serverEmit),
      { type: 'core', id: 'b' },
      new FileUpdateAvailabilityStore(dataDir, 'server-update', silentLogger()),
    ).publishSnapshot('addon', [PIPELINE])

    expect(addonEmit).toHaveBeenCalledTimes(1)
    expect(serverEmit).toHaveBeenCalledTimes(1)
  })

  it('treats a corrupt state file as empty rather than throwing', () => {
    const store = new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger())
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
    fs.writeFileSync(store.filePath, '{ not json')

    const emit = vi.fn<(event: SystemEvent) => void>()
    const emitter = new UpdateAvailabilityEmitter(
      busOf(emit),
      { type: 'core', id: 'updates' },
      new FileUpdateAvailabilityStore(dataDir, 'addon-packages', silentLogger()),
    )
    emitter.publishSnapshot('addon', [PIPELINE])

    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('stays RAM-only (no file) when no store is injected', () => {
    const emit = vi.fn<(event: SystemEvent) => void>()
    const emitter = new UpdateAvailabilityEmitter(busOf(emit), { type: 'core', id: 'updates' })
    emitter.publishSnapshot('addon', [PIPELINE])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(dataDir, 'update-availability'))).toBe(false)
  })
})
