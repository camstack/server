import { describe, expect, it } from 'vitest'
import { AgentDeliveryLedger, DELIVERY_GRACE_MS } from '../agent-delivery-ledger'

/**
 * The window that says "the hub is writing addons to this node right now, so
 * the roster it reports is not evidence of anything".
 */
describe('AgentDeliveryLedger', () => {
  it('a node with no delivery history is not suppressed', () => {
    expect(new AgentDeliveryLedger().suppressionFor('agent-a')).toBeNull()
  })

  it('suppresses while a delivery is in flight, and names why', () => {
    const ledger = new AgentDeliveryLedger()
    ledger.begin('agent-a', '@camstack/addon-pipeline')

    const suppression = ledger.suppressionFor('agent-a')
    expect(suppression?.inFlight).toBe(1)
    // The REASON is the payload — a boolean would make a declined back-fill
    // indistinguishable from one that found nothing to do.
    expect(suppression?.packages).toEqual(['@camstack/addon-pipeline'])
  })

  it('keeps suppressing through the grace tail, then stops', () => {
    const ledger = new AgentDeliveryLedger()
    const finishedAt = 1_000_000
    ledger.begin('agent-a', '@camstack/addon-pipeline', () => finishedAt)()

    expect(ledger.suppressionFor('agent-a', finishedAt + 1)).not.toBeNull()
    expect(ledger.suppressionFor('agent-a', finishedAt + DELIVERY_GRACE_MS - 1)).not.toBeNull()
    expect(ledger.suppressionFor('agent-a', finishedAt + DELIVERY_GRACE_MS)).toBeNull()
  })

  it('stays open while ANY of several concurrent deliveries is running', () => {
    // A cluster propagation ships several packages to one node. The window must
    // not close on the first one that finishes.
    const ledger = new AgentDeliveryLedger()
    const closeA = ledger.begin('agent-a', '@camstack/addon-pipeline', () => 0)
    ledger.begin('agent-a', '@camstack/addon-ai', () => 0)

    closeA()
    // Long past the grace tail measured from A's completion — B is still running.
    expect(ledger.suppressionFor('agent-a', DELIVERY_GRACE_MS * 10)).not.toBeNull()
  })

  it('closing twice does not leak a negative in-flight count', () => {
    const ledger = new AgentDeliveryLedger()
    const close = ledger.begin('agent-a', '@camstack/addon-pipeline', () => 0)
    close()
    close()

    // A double-close must not push inFlight below zero and make a LATER
    // delivery's window close early.
    ledger.begin('agent-a', '@camstack/addon-ai')
    expect(ledger.suppressionFor('agent-a')?.inFlight).toBe(1)
  })

  it('suppresses only the node being written to', () => {
    const ledger = new AgentDeliveryLedger()
    ledger.begin('agent-a', '@camstack/addon-pipeline')

    expect(ledger.suppressionFor('mac-agent')).toBeNull()
  })

  it('forgets a node completely', () => {
    const ledger = new AgentDeliveryLedger()
    ledger.begin('agent-a', '@camstack/addon-pipeline')
    ledger.forget('agent-a')

    expect(ledger.suppressionFor('agent-a')).toBeNull()
  })
})
