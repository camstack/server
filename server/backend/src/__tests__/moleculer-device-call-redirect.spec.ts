/**
 * `MoleculerService.callCapabilityOnNode` — the hub's OWN resolver entry for a
 * device call a redirect takes over (D963). The generated `DeviceProxy` sends a
 * `nodeId` pin on every native-cap call, so a media-player command from the
 * admin UI, or from any hub in-process addon's `ctx.api`, arrives here and would
 * dispatch straight to the owning runner's native cap. It asks the registry's
 * device-call redirect first, through the same `answerDeviceCallRedirect` the
 * two UDS entries use. A pin does not bypass it.
 *
 * A REAL `MoleculerService` (constructor only — no broker start) over a REAL
 * `CapabilityRegistry` carrying the redirect, with a hub-local child manifest
 * registered for `battery`. In this harness there is no UDS registry, so a call
 * that IS routed to the child fails with the callFn's own "does not currently
 * provide" — a deterministic proof that routing happened.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '@camstack/system'
import type { RegisterNodeParams } from '@camstack/system'
import {
  batteryCapability,
  type IScopedLogger,
  type DeviceCall,
  type DeviceCallAnswer,
  type SystemEvent,
} from '@camstack/types'
import { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { ConfigService } from '../core/config/config.service.js'
import type { LoggingService } from '../core/logging/logging.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'
import type { StreamProbeService } from '../core/streaming/stream-probe.service.js'

const DEVICE = 7
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
  readonly attempts: DeviceCall[]
  setAnswer(answer: DeviceCallAnswer | Error): void
}

function createHarness(): Harness {
  const registry = new CapabilityRegistry(makeLogger())
  registry.declareCapability(batteryCapability)
  registry.ready()
  const attempts: DeviceCall[] = []
  let answer: DeviceCallAnswer | Error = { kind: 'redirected', result: 'sent' }
  registry.setDeviceCallRedirect({
    covers: (cap, method) => cap === 'battery' && method === 'wakeForStream',
    attempt: async (call) => {
      attempts.push(call)
      if (answer instanceof Error) throw answer
      return answer
    },
  })

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
  return {
    driver,
    registry,
    attempts,
    setAnswer: (next) => {
      answer = next
    },
  }
}

describe('callCapabilityOnNode — a device call a redirect takes over, nodeId-pinned (D963)', () => {
  const wake = { deviceId: DEVICE, timeoutMs: 1000 }

  it('a pinned covered call is answered from the redirect, never routed to the child', async () => {
    const { driver, attempts } = createHarness()
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'wakeForStream', wake),
    ).resolves.toBe('sent')
    expect(attempts).toEqual([
      { capName: 'battery', method: 'wakeForStream', deviceId: DEVICE, args: wake },
    ])
  })

  it('a call nothing takes over IS routed to the child (here: the callFn refuses, no UDS registry)', async () => {
    const { driver, setAnswer } = createHarness()
    setAnswer({ kind: 'not-redirected' })
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'wakeForStream', wake),
    ).rejects.toThrow(/does not currently provide cap "battery"/)
  })

  it('a method the redirect does not cover is routed and never asks it', async () => {
    const { driver, attempts } = createHarness()
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'getStatus', { deviceId: DEVICE }),
    ).rejects.toThrow(/does not currently provide cap "battery"/)
    expect(attempts).toEqual([])
  })

  it('a failing redirect fails the call — the native cap does not run in its place', async () => {
    const { driver, setAnswer } = createHarness()
    setAnswer(new Error('board is off'))
    await expect(
      driver.callCapabilityOnNode(CHILD_NODE, 'battery', 'wakeForStream', wake),
    ).rejects.toThrow('board is off')
  })
})
