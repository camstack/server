/**
 * `MoleculerService.callCapabilityOnNode` — the hub's OWN resolver entry (D663,
 * ruling S3). It is reached by every hub tRPC call carrying a `nodeId` pin (the
 * generated `DeviceProxy` sends `providerNodeId` on every native-cap call, so
 * the admin UI for any agent-resident device), by every hub in-process addon's
 * `ctx.api.<deviceCap>` through `deviceCapResolverLink`, and by
 * `resolveNodeCapability`. It dispatches straight to the owning runner, whose
 * `getStatus` is the NATIVE slice — so it asks the hub's claim authority first,
 * through the same `answerClaimedGetStatus` the two UDS entries use. A pin does
 * not bypass it.
 *
 * A REAL `MoleculerService` (constructor only — no broker start, as
 * `moleculer-register-node-idempotency.spec.ts` does) over a REAL
 * `CapabilityRegistry` carrying the overlay, with a hub-local child manifest
 * registered for `battery`. In this harness there is no UDS registry, so a call
 * that IS routed to the child fails with the callFn's own "does not currently
 * provide" — a deterministic proof that routing happened.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '@camstack/system'
import type { RegisterNodeParams } from '@camstack/system'
import {
  batteryCapability,
  type IScopedLogger,
  type StatusOverlayAnswer,
  type SystemEvent,
} from '@camstack/types'
import { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { ConfigService } from '../core/config/config.service.js'
import type { LoggingService } from '../core/logging/logging.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'
import type { StreamProbeService } from '../core/streaming/stream-probe.service.js'

const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED_SLICE = { ...NATIVE, percentage: 90 }
const DEVICE = 7
const OTHER_DEVICE = 8
const CHILD_NODE = 'hub/provider-homeassistant'

/**
 * The two methods this spec drives. `onRegisterNode` is private (the
 * `$hub.registerNode` action is its only production caller); the sibling
 * idempotency spec crosses the same documented seam.
 */
interface Driver {
  onRegisterNode: (params: RegisterNodeParams) => void
  callCapabilityOnNode: (
    nodeId: string,
    capabilityName: string,
    methodName: string,
    params: unknown,
  ) => Promise<unknown>
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly driver: Driver
  readonly registry: CapabilityRegistry
  readonly resolve: ReturnType<typeof vi.fn>
}

function createHarness(): Harness {
  const registry = new CapabilityRegistry(makeLogger())
  registry.declareCapability(batteryCapability)
  registry.ready()
  const resolve = vi.fn(
    async (cap: string, id: number): Promise<StatusOverlayAnswer> =>
      cap === 'battery' && id === DEVICE
        ? { kind: 'claimed', slice: OWNED_SLICE }
        : { kind: 'unclaimed' },
  )
  registry.setStatusOverlay({ peek: () => ({ kind: 'unknown' }), resolve })

  const fakeEventBus = {
    emit: (_event: SystemEvent) => undefined,
    subscribe: () => () => undefined,
    getRecent: () => [],
  } as unknown as EventBusService
  const fakeConfig = {
    get: () => undefined,
    getAddonConfig: () => ({}),
  } as unknown as ConfigService
  const fakeLogging = {
    createLogger: () => makeLogger(),
    writeFromWorker: () => undefined,
  } as unknown as LoggingService
  const fakeCapability = { getRegistry: () => registry } as unknown as CapabilityService
  const fakeStreamProbe = {} as unknown as StreamProbeService

  const service = new MoleculerService(
    fakeEventBus,
    fakeConfig,
    fakeLogging,
    fakeCapability,
    fakeStreamProbe,
  )
  const driver = service as unknown as Driver
  driver.onRegisterNode({
    nodeId: CHILD_NODE,
    addons: [{ addonId: 'provider-homeassistant', capabilities: ['battery'] }],
  })
  return { driver, registry, resolve }
}

describe('callCapabilityOnNode — getStatus of a CLAIMED cap, nodeId-pinned (S3)', () => {
  it('a pinned getStatus of a claimed device is answered from the hub mirror, never routed to the child', async () => {
    const { driver, resolve } = createHarness()
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'getStatus', { deviceId: DEVICE }),
    ).resolves.toEqual(OWNED_SLICE)
    expect(resolve).toHaveBeenCalledWith('battery', DEVICE)
  })

  it('getStatus of an UNCLAIMED device IS routed to the child (here: the callFn refuses, no UDS registry)', async () => {
    const { driver } = createHarness()
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'getStatus', { deviceId: OTHER_DEVICE }),
    ).rejects.toThrow(/does not currently provide cap "battery"/)
  })

  it('every other method of the claimed device is routed too, and never asks the claim authority', async () => {
    const { driver, resolve } = createHarness()
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'wakeForStream', {
        deviceId: DEVICE,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/does not currently provide cap "battery"/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a device whose claims cannot be known is "not reported" (null), never routed to the native', async () => {
    const { driver, registry } = createHarness()
    registry.setStatusOverlay({
      peek: () => ({ kind: 'unknown' }),
      resolve: async () => ({ kind: 'unknown' }),
    })
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'getStatus', { deviceId: DEVICE }),
    ).resolves.toBeNull()
  })
})
