/**
 * `deliverAddonToAgent` — the ONE way a bundle reaches an agent.
 *
 * The regression this pins: `camstack deploy <pkg> -n <agent>` used a second,
 * hand-written delivery body that called `$agent.deploy` and STOPPED. The bytes
 * landed, the manifest bumped, the CLI printed `✓` — and every runner on the
 * agent kept executing the previous dist, forever. Verified on agent-a
 * 2026-08-07: probe file present in `dist/`, not one runner pid recycled.
 *
 * So: deploy is not delivery. Delivery is deploy → hash check → reload, and
 * both callers (single-node and cluster propagation) go through this function
 * so they cannot drift apart again.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type AgentDeliveryBroker, deliverAddonToAgent } from '../agent-addon-delivery.js'

function makeLogger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
}

const SOURCE = {
  kind: 'hub-http',
  url: 'https://hub/api/addons/deploy-bundle/abc',
  token: 'tok',
  sha256: 'a'.repeat(64),
  bytes: 42,
} as const

function makeBroker(handlers: { deploy?: () => unknown; reload?: () => unknown }): {
  broker: AgentDeliveryBroker
  calls: { action: string; nodeID: string }[]
} {
  const calls: { action: string; nodeID: string }[] = []
  const broker: AgentDeliveryBroker = {
    call: async (action, _params, options) => {
      calls.push({ action, nodeID: options.nodeID })
      if (action === '$agent.deploy') {
        return handlers.deploy
          ? handlers.deploy()
          : { success: true, addonId: '@camstack/addon-x', path: '/data/addons/@camstack/addon-x' }
      }
      if (action === '$agent.reload') {
        return handlers.reload ? handlers.reload() : { loaded: ['runner-a'] }
      }
      throw new Error(`unexpected action ${action}`)
    },
  }
  return { broker, calls }
}

describe('deliverAddonToAgent', () => {
  it('reloads the agent after the bundle lands — a deploy alone leaves the old code running', async () => {
    const { broker, calls } = makeBroker({})
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })

    expect(result.success).toBe(true)
    expect(result.loaded).toEqual(['runner-a'])
    expect(calls.map((c) => c.action)).toEqual(['$agent.deploy', '$agent.reload'])
    expect(calls.every((c) => c.nodeID === 'agent-a')).toBe(true)
  })

  it('FAILS when the agent applied a bundle whose hash is not the one we shipped', async () => {
    const { broker, calls } = makeBroker({
      deploy: () => ({
        success: true,
        addonId: '@camstack/addon-x',
        appliedSha256: 'b'.repeat(64),
      }),
    })
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/hash/i)
    // A node that applied the wrong bytes must NOT then be told to load them.
    expect(calls.map((c) => c.action)).toEqual(['$agent.deploy'])
  })

  it('accepts the deploy when the agent confirms the shipped hash', async () => {
    const { broker } = makeBroker({
      deploy: () => ({
        success: true,
        addonId: '@camstack/addon-x',
        appliedSha256: SOURCE.sha256,
      }),
    })
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })
    expect(result.success).toBe(true)
    expect(result.verifiedSha256).toBe(SOURCE.sha256)
  })

  it('reports unverified (not failed) when the agent predates hash reporting', async () => {
    const { broker } = makeBroker({})
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })
    expect(result.success).toBe(true)
    expect(result.verifiedSha256).toBeUndefined()
  })

  it('surfaces an empty reload as a warning the caller can render, not a silent success', async () => {
    const logger = makeLogger()
    const { broker } = makeBroker({ reload: () => ({ loaded: [] }) })
    const result = await deliverAddonToAgent({
      broker,
      logger,
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })
    expect(result.success).toBe(true)
    expect(result.loaded).toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('fails when $agent.deploy answers with a malformed body', async () => {
    const { broker, calls } = makeBroker({ deploy: () => ({ nope: true }) })
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/malformed/i)
    expect(calls.map((c) => c.action)).toEqual(['$agent.deploy'])
  })

  it('fails when the reload throws — the bytes are on disk but nothing runs them', async () => {
    const { broker } = makeBroker({
      reload: () => {
        throw new Error('reload timeout')
      },
    })
    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/reload timeout/)
  })
})

/**
 * The delivery window. `$agent.deploy` evicts the package's declaration ids and
 * `$agent.reload` re-registers the node, so for the length of a delivery the
 * node's reported roster is missing exactly the package the hub just shipped.
 * The addon back-fill reads that roster. On 2026-08-07 it "repaired" the node
 * over every agent deploy, ~1.5s after each one.
 *
 * So the window must be open before the first byte and still open when the
 * reload's re-registrations arrive — including when the delivery FAILS, which
 * is the case a naive `try { ... } close()` drops.
 */
describe('deliverAddonToAgent — delivery window', () => {
  function makeLedger() {
    const opened: Array<{
      nodeId: string
      packageName: string
      openDuringDeploy: boolean
    }> = []
    let open = 0
    return {
      opened,
      isOpen: () => open > 0,
      ledger: {
        begin(nodeId: string, packageName: string) {
          open += 1
          opened.push({ nodeId, packageName, openDuringDeploy: true })
          return () => {
            open -= 1
          }
        },
      },
    }
  }

  it('is open across BOTH the deploy and the reload, and closed after', async () => {
    const seenOpen: string[] = []
    const l = makeLedger()
    const { broker } = makeBroker({})
    const wrapped = {
      call: async (
        action: string,
        params: Record<string, unknown>,
        options: { nodeID: string; timeout: number },
      ) => {
        if (l.isOpen()) seenOpen.push(action)
        return broker.call(action, params, options)
      },
    }

    await deliverAddonToAgent({
      broker: wrapped,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
      deliveryLedger: l.ledger,
    })

    expect(seenOpen).toEqual(['$agent.deploy', '$agent.reload'])
    expect(l.isOpen()).toBe(false)
    expect(l.opened[0]?.packageName).toBe('@camstack/addon-x')
  })

  it('closes the window even when the delivery throws', async () => {
    const l = makeLedger()
    const { broker } = makeBroker({
      deploy: () => {
        throw new Error('agent unreachable')
      },
    })

    const result = await deliverAddonToAgent({
      broker,
      logger: makeLogger(),
      nodeId: 'agent-a',
      packageName: '@camstack/addon-x',
      source: SOURCE,
      deliveryLedger: l.ledger,
    })

    expect(result.success).toBe(false)
    // A leaked window would protect this node from the back-fill for the rest
    // of the hub's life — the exact opposite of what the gate is for.
    expect(l.isOpen()).toBe(false)
  })
})
