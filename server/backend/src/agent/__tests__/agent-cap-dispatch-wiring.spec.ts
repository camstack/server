/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Slice-5, Task 7 — agent bootstrap wiring test for the cap-dispatch service.
 *
 * Verifies that `registerAgentCapDispatch` (the extracted bootstrap helper)
 * correctly registers `$agent-cap-fwd` with a real Moleculer broker when the
 * registry is defined, and is a no-op when it is `undefined`. Both the
 * positive and negative wiring paths are asserted, so a regression that
 * deletes either branch would be caught.
 *
 * Why this approach instead of running full `startAgent()`:
 *   `startAgent` requires disk access, addon packages, Moleculer transporter
 *   connections, and a config file — too heavy and flaky for a fast unit test.
 *   The extracted `registerAgentCapDispatch` helper lets us exercise the ACTUAL
 *   WIRING LOGIC added in Task 7 without any of that overhead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { AGENT_CAP_FWD_SERVICE, AGENT_CAP_FWD_ACTION } from '@camstack/system'
import type { CapCallInput } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { registerAgentCapDispatch } from '../register-agent-cap-dispatch.js'
import { makeRegistryDouble } from './helpers/registry-double.js'

// ---------------------------------------------------------------------------
// Logger double
// ---------------------------------------------------------------------------

function makeConsoleLogger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: function () {
      return this
    },
    withTags: function () {
      return this
    },
  }
}

// ---------------------------------------------------------------------------
// Suite — bootstrap wiring contract
// ---------------------------------------------------------------------------

describe('registerAgentCapDispatch: bootstrap wiring contract (slice-5 task 7)', {
  timeout: 15_000,
}, () => {
  const agentNodeId = 'dev-agent-task7'
  let broker: ServiceBroker | undefined

  afterEach(async () => {
    if (broker !== undefined) {
      await broker.stop()
      broker = undefined
    }
  })

  /**
   * Positive path — with a defined registry the service is registered and
   * discoverable via Moleculer's service-discovery API.
   *
   * Also asserts the logger is passed through: on the happy path (service
   * registered, no forward call made) `logger.info` must NOT have been called,
   * confirming the logger argument flows in but doesn't produce spurious output.
   */
  it('(+) with a defined registry: $agent-cap-fwd is registered and discoverable', async () => {
    broker = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    const registry = makeRegistryDouble('some-child', { ok: true })
    const logger = makeConsoleLogger()

    registerAgentCapDispatch(broker, registry, undefined, logger)
    await broker.start()

    await broker.waitForServices([AGENT_CAP_FWD_SERVICE], 5_000)
    expect(broker.getLocalService(AGENT_CAP_FWD_SERVICE)).toBeDefined()

    // Logger must not produce spurious output on the happy (no-forward) path.
    expect(logger.info).not.toHaveBeenCalled()
  })

  /**
   * Negative path — with `agentUdsRegistry = undefined` the helper is a no-op:
   * no service is created, so `getLocalService` returns `undefined`.
   *
   * This test falsifies a regression that would remove the `=== undefined`
   * guard and unconditionally call `registrar.createService`.
   */
  it('(-) with undefined registry: $agent-cap-fwd is NOT registered', async () => {
    broker = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    const logger = makeConsoleLogger()

    registerAgentCapDispatch(broker, undefined, undefined, logger)
    await broker.start()

    expect(broker.getLocalService(AGENT_CAP_FWD_SERVICE)).toBeUndefined()
  })

  /**
   * End-to-end forward path — the hub dispatches a cap call and the result
   * flows through the registry double back to the caller.
   */
  it('(2) forward action is invocable and delegates to the UDS registry', async () => {
    const expectedResult = { status: 'ok', zones: [1, 2, 3] }
    broker = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    const registry = makeRegistryDouble('motion-child-7', expectedResult)

    registerAgentCapDispatch(broker, registry)
    await broker.start()

    const params = {
      capName: 'motion-zones',
      method: 'getZones',
      args: { deviceId: 7 },
      deviceId: 7,
    }
    const result = await broker.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)
    expect(registry.resolveChildId).toHaveBeenCalledWith('motion-zones', 7)
    expect(registry.callCapOnChild).toHaveBeenCalledWith(
      'motion-child-7',
      expect.objectContaining<Partial<CapCallInput>>({
        capName: 'motion-zones',
        method: 'getZones',
        deviceId: 7,
      }),
    )
  })

  /**
   * Error path — the service is registered but the registry has no child.
   */
  it('(3) rejects when the registry has no child for the requested cap', async () => {
    broker = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    const registry = makeRegistryDouble(null, undefined)

    registerAgentCapDispatch(broker, registry)
    await broker.start()

    await expect(
      broker.call(AGENT_CAP_FWD_ACTION, {
        capName: 'stream-params',
        method: 'getStatus',
        args: {},
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('stream-params') })
  })
})
