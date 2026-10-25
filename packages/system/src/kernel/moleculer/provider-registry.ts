import type { ServiceBroker } from 'moleculer'
import { asBrokerLike } from './event-bus.js'

/**
 * Per-broker provider registries. In production there is one broker per
 * process, so these behave like module-scoped singletons. In tests that
 * spin up multiple brokers in the same process, each broker gets its
 * own isolated set of maps so providers don't leak across nodes.
 */
interface BrokerRegistries {
  readonly providers: Map<string, unknown[]>
  readonly preferred: Map<string, string>
  readonly byAddonId: Map<string, Map<string, unknown>>
}
const perBrokerRegistries = new Map<string, BrokerRegistries>()

function getRegistries(brokerNodeId: string): BrokerRegistries {
  let r = perBrokerRegistries.get(brokerNodeId)
  if (!r) {
    r = {
      providers: new Map(),
      preferred: new Map(),
      byAddonId: new Map(),
    }
    perBrokerRegistries.set(brokerNodeId, r)
  }
  return r
}
export { getRegistries }
export type { BrokerRegistries }

/** Register the hosting addon id so future `registerProvider` calls can tag providers. */
let currentAddonId: string | null = null
function withAddonScope<T>(addonId: string, fn: () => T): T {
  const prev = currentAddonId
  currentAddonId = addonId
  try {
    return fn()
  } finally {
    currentAddonId = prev
  }
}
/** Exported for test harnesses that drive the factory manually. */
export { withAddonScope }

/** The addon id currently in scope, used by `registerProvider` to tag providers. */
function getCurrentAddonId(): string | null {
  return currentAddonId
}
export { getCurrentAddonId }

/** Update the preferred provider for a capability (called from binding-changed subscribers). */
function setPreferredProvider(
  capabilityName: string,
  addonId: string | null,
  brokerNodeId = 'hub',
): void {
  const regs = getRegistries(brokerNodeId)
  if (addonId === null || addonId.length === 0) {
    regs.preferred.delete(capabilityName)
  } else {
    regs.preferred.set(capabilityName, addonId)
  }
}
export { setPreferredProvider }

/**
 * One-shot subscription per kernel process to the cluster-bridged
 * `capability.binding-changed` event. The orchestrator addon (hub-side)
 * emits this whenever the operator swaps the addon implementing a cap
 * on a node; every process on the target node updates its local
 * `preferredProviderRegistry` so subsequent `resolveProvider` lookups
 * honour the new binding. Moleculer's `localBus` event emitter is the
 * in-process delivery channel — the hub-forwarder pushes payloads onto
 * the channel after receiving them via the cluster event bus.
 */
const bindingSubscriberInstalled = new Set<string>()
function ensureBindingSubscription(broker: ServiceBroker): void {
  const bkr = asBrokerLike(broker)
  if (bindingSubscriberInstalled.has(bkr.nodeID)) return
  bindingSubscriberInstalled.add(bkr.nodeID)
  // `broker.localBus` is a Moleculer EventEmitter (same one used by
  // `$node.connected` / `$node.disconnected`). Every cluster-bridged
  // event reaches this bus as a local emit; we filter to the
  // capability-binding-changed category and update the preferred-
  // provider registry on matches.
  const handler = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const evt = payload as {
      category?: string
      data?: { nodeId?: string; capName?: string; addonId?: string | null }
    }
    if (evt.category !== 'capability.binding-changed') return
    const data = evt.data
    if (!data || data.nodeId !== bkr.nodeID || typeof data.capName !== 'string') return
    setPreferredProvider(data.capName, data.addonId ?? null, bkr.nodeID)
  }
  bkr.localBus.on('$hub.event', handler)
}
export { ensureBindingSubscription }

// Test-only hook: reset the one-shot guard so tests that create
// multiple brokers in sequence can re-install the binding subscription.
// Production code never calls this — the guard keeps the handler from
// being registered twice per process.
function __resetBindingSubscriptionForTests(): void {
  bindingSubscriberInstalled.clear()
  perBrokerRegistries.clear()
}
export { __resetBindingSubscriptionForTests }
