/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Slice-5, Task 6: agent-cap-dispatch-service tests.
 *
 * Verifies that:
 *  1. The `$agent-cap-fwd` Moleculer service is discoverable via
 *     `waitForServices` after `createAgentCapDispatchService` is registered.
 *  2. A cap call resolves the child via `resolveChildId` and delegates to
 *     `callCapOnChild`, returning the child's result.
 *  3. When `childId` IS provided in params, it is used directly — resolveChildId
 *     is not consulted.
 *  4. A cap with no providing child rejects with a descriptive error.
 *
 * Uses a spy double for `LocalChildRegistry` so the test stays free of real UDS
 * sockets. The discoverability assertion (case 1) uses a real ServiceBroker +
 * real `broker.createService` + `waitForServices`, proving the `$`-prefix does
 * not break Moleculer discovery with the Fake transporter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { AGENT_CAP_FWD_SERVICE, AGENT_CAP_FWD_ACTION } from '@camstack/system'
import type { CapCallInput, InProcessProviderLookup, InProcessProviderRef } from '@camstack/system'
import { createAgentCapDispatchService } from '../agent-cap-dispatch-service.js'
import { makeRegistryDouble } from './helpers/registry-double.js'

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createAgentCapDispatchService', { timeout: 15_000 }, () => {
  const agentNodeId = 'dev-agent-0'
  let b: ServiceBroker | undefined

  afterEach(async () => {
    if (b !== undefined) {
      await b.stop()
      b = undefined
    }
  })

  // -------------------------------------------------------------------------
  // (1) discoverability — the $-prefixed service must be found by waitForServices
  // -------------------------------------------------------------------------

  it('(1) $agent-cap-fwd is discoverable via waitForServices after registration', async () => {
    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })

    const registry = makeRegistryDouble('some-child', { ok: true })
    const schema = createAgentCapDispatchService(agentNodeId, registry)
    b.createService(schema)
    await b.start()

    await b.waitForServices([AGENT_CAP_FWD_SERVICE], 5_000)
    expect(b.getLocalService(AGENT_CAP_FWD_SERVICE)).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // (2) resolves child via resolveChildId and returns callCapOnChild result
  // -------------------------------------------------------------------------

  it('(2) resolves childId via resolveChildId and delegates to callCapOnChild', async () => {
    const expectedResult = { schema: 'pipeline-schema-v1' }
    const registry = makeRegistryDouble('pipeline-runner-child', expectedResult)

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry))
    await b.start()

    const params = {
      capName: 'pipeline-executor',
      method: 'getSchema',
      args: { nodeId: agentNodeId },
    }
    const result = await b.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)

    // resolveChildId must have been called with the correct capName (no deviceId)
    expect(registry.resolveChildId).toHaveBeenCalledWith('pipeline-executor', undefined)

    // callCapOnChild must be called with the resolved childId and correct input
    expect(registry.callCapOnChild).toHaveBeenCalledWith(
      'pipeline-runner-child',
      expect.objectContaining<Partial<CapCallInput>>({
        capName: 'pipeline-executor',
        method: 'getSchema',
        args: params.args,
      }),
    )
  })

  // -------------------------------------------------------------------------
  // (3) provided childId bypasses resolveChildId
  // -------------------------------------------------------------------------

  it('(3) uses childId from params directly — does not call resolveChildId', async () => {
    const expectedResult = { status: 'running' }
    const registry = makeRegistryDouble(null, expectedResult) // resolveChildId would return null but is never called

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry))
    await b.start()

    const params = {
      capName: 'pipeline-executor',
      method: 'getStatus',
      args: {},
      childId: 'explicit-child-id',
    }
    const result = await b.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)
    // resolveChildId must NOT be called when childId is provided
    expect(registry.resolveChildId).not.toHaveBeenCalled()
    // callCapOnChild must be called with the explicit childId
    expect(registry.callCapOnChild).toHaveBeenCalledWith(
      'explicit-child-id',
      expect.objectContaining<Partial<CapCallInput>>({
        capName: 'pipeline-executor',
        method: 'getStatus',
      }),
    )
  })

  // -------------------------------------------------------------------------
  // (4) no child provides the cap → action rejects with descriptive error
  // -------------------------------------------------------------------------

  it('(4) rejects with descriptive error when no child provides the cap', async () => {
    const registry = makeRegistryDouble(null, undefined) // resolveChildId returns null

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry))
    await b.start()

    const params = { capName: 'unknown-cap', method: 'doSomething', args: {} }

    await expect(b.call(AGENT_CAP_FWD_ACTION, params)).rejects.toMatchObject({
      message: expect.stringContaining('unknown-cap'),
    })
  })

  // -------------------------------------------------------------------------
  // (2b) deviceId is threaded through to resolveChildId and callCapOnChild
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // (5) no child provides the cap, but an in-process provider does → invoke it
  //     (agent core addons — platform-probe, metrics-provider — run in the
  //      agent's MAIN process, not as forked UDS children)
  // -------------------------------------------------------------------------

  it('(5) falls back to the in-process provider when no UDS child provides the cap', async () => {
    const expectedResult = { bestScore: { backend: 'cpu' } }
    // No child resolves this cap; callCapOnChild must never be reached.
    const registry = makeRegistryDouble(null, undefined)

    const invoke = vi.fn(
      (_method: string, _args: unknown): Promise<unknown> => Promise.resolve(expectedResult),
    )
    const inProcessLookup: InProcessProviderLookup = vi.fn(
      (capName: string): InProcessProviderRef | null =>
        capName === 'platform-probe' ? { invoke } : null,
    )

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry, inProcessLookup))
    await b.start()

    const params = {
      capName: 'platform-probe',
      method: 'getCapabilities',
      args: { nodeId: agentNodeId },
    }
    const result = await b.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)
    expect(inProcessLookup).toHaveBeenCalledWith('platform-probe')
    expect(invoke).toHaveBeenCalledWith('getCapabilities', params.args)
    // the UDS child path must NOT have been used
    expect(registry.callCapOnChild).not.toHaveBeenCalled()
  })

  it('(2b) deviceId is passed to resolveChildId and forwarded in callCapOnChild input', async () => {
    const expectedResult = { zones: [] }
    const registry = makeRegistryDouble('motion-child-42', expectedResult)

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry))
    await b.start()

    const params = {
      capName: 'motion-zones',
      method: 'getZones',
      args: { deviceId: 42 },
      deviceId: 42,
    }
    const result = await b.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)
    expect(registry.resolveChildId).toHaveBeenCalledWith('motion-zones', 42)
    expect(registry.callCapOnChild).toHaveBeenCalledWith(
      'motion-child-42',
      expect.objectContaining<Partial<CapCallInput>>({
        capName: 'motion-zones',
        method: 'getZones',
        deviceId: 42,
      }),
    )
  })

  // -------------------------------------------------------------------------
  // (2c) addonId (grouped-runner provider selection) is passed through to
  //      callCapOnChild input — Task 7.5a
  // -------------------------------------------------------------------------

  it('(2c) addonId is passed through to callCapOnChild input (grouped-runner provider selection)', async () => {
    // The hub's `AgentCapForwardParams` now carries `addonId` (Task 7.5a) so a
    // grouped runner (`execution.group`) hosting two co-located addons that
    // register the SAME collection cap can be disambiguated on the agent side
    // exactly as it already is on the hub-local-uds path
    // (`LocalChildRegistry.toCapCall`).
    const expectedResult = { status: 'ok' }
    const registry = makeRegistryDouble('net-access-child', expectedResult)

    b = new ServiceBroker({ nodeID: agentNodeId, transporter: 'Fake', logger: false })
    b.createService(createAgentCapDispatchService(agentNodeId, registry))
    await b.start()

    const params = {
      capName: 'network-access',
      method: 'getStatus',
      args: {},
      addonId: 'tailscale-ingress',
    }
    const result = await b.call(AGENT_CAP_FWD_ACTION, params)

    expect(result).toEqual(expectedResult)
    expect(registry.callCapOnChild).toHaveBeenCalledWith(
      'net-access-child',
      expect.objectContaining<Partial<CapCallInput>>({
        capName: 'network-access',
        method: 'getStatus',
        addonId: 'tailscale-ingress',
      }),
    )
  })
})
