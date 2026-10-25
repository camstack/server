/**
 * Deleting a camera must actually delete it.
 *
 * The stream-broker keeps a device's profile-slot assignments FOREVER — they
 * outlive the device record. The orchestrator's dispatch reconcile derives its
 * "desired fleet" from exactly those slots (`listAllProfileSlots`), so a
 * deleted camera stayed desired, and the additive gap-fill re-dispatched it on
 * the next reconcile pass. Worse, the `DeviceUnregistered` teardown made it
 * MORE likely: dropping the camera from `known` is what put it in the gap.
 * Live evidence: 3217 and 3218, both deleted, both back on the runner.
 *
 * Three gates are asserted here, each independently:
 *  - the reconcile filters its desired set against the LIVE device registry,
 *    and tears a confirmed-gone device down instead of dispatching it;
 *  - a failed registry read prunes NOTHING (D49 — a read that fails changes
 *    nothing, and teardown destroys work);
 *  - the per-device funnel (`handleDeviceRegistered`) refuses a device the
 *    registry does not have, whatever woke it.
 *
 * Plus the reason a resurrected camera came back fully configured: its
 * per-device orchestrator settings survived the deletion.
 */
import type { IScopedLogger, StreamSourceEntry } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  enabledNodesFromBroker,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBrokerCap,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const DEFAULT_DEVICE_SETTINGS = {
  detectionMode: 'always-on' as const,
  motionSources: ['analyzer'] as const,
  motionStreamProfile: 'low' as const,
  detectionStreamProfile: 'high' as const,
  motionFps: 4,
  detectionFps: 10,
  motionCooldownMs: 10_000,
}

function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    {
      id: 'sub',
      label: 'sub',
      protocol: 'rtsp',
      url: 'rtsp://cam/sub',
      profileHint: 'low',
    },
    {
      id: 'main',
      label: 'main',
      protocol: 'rtsp',
      url: 'rtsp://cam/main',
      profileHint: 'high',
    },
  ]
}

/** Logger that records `warn` so a test can assert on the refusal lines. */
function makeRecordingLogger(): {
  logger: IScopedLogger
  warnings: { msg: string; ctx: unknown }[]
} {
  const warnings: { msg: string; ctx: unknown }[] = []
  const make = (): IScopedLogger => {
    const logger: IScopedLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, ctx?: unknown) => {
        warnings.push({ msg, ctx })
      },
      error: () => undefined,
      child: () => make(),
      withTags: () => make(),
    }
    return logger
  }
  return { logger: make(), warnings }
}

function hasWarning(warnings: { msg: string }[], fragment: string): boolean {
  return warnings.some((w) => w.msg.includes(fragment))
}

describe('PipelineOrchestratorAddon — a deleted device stays deleted', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('never re-dispatches a deleted camera whose broker slots outlive it, and tears it down', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3217, 'provider-rtsp', makeCameraStreams())
    streamBrokerCap.register(101, 'provider-rtsp', makeCameraStreams())

    const deleted = new Set<number>()
    const { logger, warnings } = makeRecordingLogger()
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [3217, { ...DEFAULT_DEVICE_SETTINGS }],
        [101, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      deletedDeviceIds: deleted,
      logger,
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const emitSlots = (deviceId: number, seq: number): void =>
      eventBus.emit({
        id: `evt-slots-${deviceId}-${seq}`,
        timestamp: new Date(),
        source: { type: 'device', id: deviceId },
        category: EventCategory.CameraStreamsProfileSlotsChanged,
        data: { deviceId, providerId: 'provider-rtsp' },
      })

    emitSlots(3217, 0)
    emitSlots(101, 0)
    await waitUntil(() => runner.attachedCameras.has(3217) && runner.attachedCameras.has(101), 3000)

    // The operator deletes 3217. The broker KEEPS its slots (that is the bug's
    // fuel — `streamBrokerCap` is deliberately untouched here).
    //
    // No `DeviceUnregistered` is emitted: the reconcile must stand on its own.
    // That is the state a hub restart leaves behind (the deletion happened
    // while this addon was not listening), and it is the state in which the
    // camera is still attached to a runner — so the reconcile has to TEAR IT
    // DOWN, not merely decline to re-dispatch it.
    deleted.add(3217)

    // Two reconcile passes, driven by a SIBLING camera's slot broadcast — the
    // exact path that resurrected 3217 (its own event path is not involved).
    emitSlots(101, 1)
    await new Promise((r) => setTimeout(r, 400))
    emitSlots(101, 2)
    await new Promise((r) => setTimeout(r, 400))

    // Torn down: the deleted camera is off the runner, and it was the reconcile
    // that did it (nothing else in this test ever detaches).
    await waitUntil(() => !runner.attachedCameras.has(3217), 3000)
    // The healthy sibling is untouched — the filter prunes the deleted device,
    // not the fleet.
    expect(runner.attachedCameras.has(101)).toBe(true)
    expect(hasWarning(warnings, 'dispatch reconcile: device no longer exists')).toBe(true)
  })

  it('does NOT tear a device down on the FIRST pass it is missing (one read never destroys work)', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3217, 'provider-rtsp', makeCameraStreams())

    const deleted = new Set<number>()
    const { logger, warnings } = makeRecordingLogger()
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [3217, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      deletedDeviceIds: deleted,
      logger,
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-slots-3217-0',
      timestamp: new Date(),
      source: { type: 'device', id: 3217 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 3217, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => runner.attachedCameras.has(3217), 3000)

    // A single listing that omits the device (which a partial/racy read looks
    // exactly like) must change nothing at all.
    deleted.add(3217)
    eventBus.emit({
      id: 'evt-slots-3217-1',
      timestamp: new Date(),
      source: { type: 'device', id: 3217 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 9999, providerId: 'provider-rtsp' },
    })
    await new Promise((r) => setTimeout(r, 400))

    expect(hasWarning(warnings, 'dispatch reconcile: device no longer exists')).toBe(false)
    expect(runner.attachedCameras.has(3217)).toBe(true)
  })

  it('tears nothing down when the registry read FAILS (a failed read never prunes the fleet)', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3217, 'provider-rtsp', makeCameraStreams())
    streamBrokerCap.register(101, 'provider-rtsp', makeCameraStreams())

    const deleted = new Set<number>()
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [3217, { ...DEFAULT_DEVICE_SETTINGS }],
        [101, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      deletedDeviceIds: deleted,
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const emitSlots = (deviceId: number, seq: number): void =>
      eventBus.emit({
        id: `evt-slots-${deviceId}-${seq}`,
        timestamp: new Date(),
        source: { type: 'device', id: deviceId },
        category: EventCategory.CameraStreamsProfileSlotsChanged,
        data: { deviceId, providerId: 'provider-rtsp' },
      })

    emitSlots(3217, 0)
    emitSlots(101, 0)
    await waitUntil(() => runner.attachedCameras.has(3217) && runner.attachedCameras.has(101), 3000)

    // The device IS deleted — but every registry listing fails from here on,
    // so the orchestrator has no evidence and must keep everything as-is.
    deleted.add(3217)
    const api = ctx.api
    expect(api).toBeDefined()
    vi.spyOn(api!.deviceManager.listAll, 'query').mockRejectedValue(
      new Error('discovery deadline exceeded for device-manager.listAll'),
    )

    for (let i = 1; i <= 3; i++) {
      emitSlots(101, i)
      await new Promise((r) => setTimeout(r, 400))
    }

    expect(runner.attachedCameras.has(3217)).toBe(true)
    expect(runner.attachedCameras.has(101)).toBe(true)
  })

  it('refuses to start detection for a device the registry no longer has', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3218, 'provider-rtsp', makeCameraStreams())

    const deleted = new Set<number>([3218])
    const { logger, warnings } = makeRecordingLogger()
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [3218, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      deletedDeviceIds: deleted,
      logger,
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-slots-3218-0',
      timestamp: new Date(),
      source: { type: 'device', id: 3218 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 3218, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => hasWarning(warnings, 'refusing to start detection'), 3000)

    expect(runner.attachedCameras.has(3218)).toBe(false)
  })

  it('purges the orchestrator per-device settings on removal, so a re-created id starts clean', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3217, 'provider-rtsp', makeCameraStreams())

    const { ctx, eventBus, store } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [3217, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-slots-3217-0',
      timestamp: new Date(),
      source: { type: 'device', id: 3217 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 3217, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => runner.attachedCameras.has(3217), 3000)
    expect(store.devices.has(3217)).toBe(true)

    eventBus.emit({
      id: 'evt-unregistered-3217',
      timestamp: new Date(),
      source: { type: 'device', id: 3217 },
      category: EventCategory.DeviceUnregistered,
      data: { deviceId: 3217 },
    })

    await waitUntil(() => !store.devices.has(3217), 3000)
    expect(store.devices.has(3217)).toBe(false)
  })
})
