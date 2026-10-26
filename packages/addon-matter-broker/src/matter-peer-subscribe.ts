/**
 * Adapt a matter.js client node to {@link MatterSubscribablePeer}. The only
 * file besides the controller that talks to `interaction.subscribe`.
 *
 * matter.js also auto-subscribes a wildcard on commission. We turn that off
 * for the peer and own one sustained subscription, so a reconnect has a single
 * resubscribe path. `keepSubscriptions: false` drops the library's leftover
 * subscription when ours is established.
 */

import { Seconds } from '@matter/general'
import type { MatterAttributeReport } from './matter-controller.js'
import {
  collectAttributeReports,
  type MatterPeerSubscription,
  type MatterSubscribablePeer,
} from './matter-subscription.js'

/** Sleepy Thread locks (the U200) report on a short floor and a one-minute ceiling. */
export const SUBSCRIPTION_MIN_INTERVAL_S = 0
export const SUBSCRIPTION_MAX_INTERVAL_S = 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function peerOnline(peer: Record<string, unknown>): boolean {
  const lifecycle = peer['lifecycle']
  if (!isRecord(lifecycle)) return false
  return lifecycle['isOnline'] === true
}

function listenLifecycle(
  peer: Record<string, unknown>,
  event: 'online' | 'offline',
  handler: () => void,
): () => void {
  const lifecycle = peer['lifecycle']
  if (!isRecord(lifecycle)) return () => undefined
  const observable = lifecycle[event]
  if (!isRecord(observable)) return () => undefined
  const on = observable['on']
  const off = observable['off']
  if (typeof on !== 'function' || typeof off !== 'function') return () => undefined
  Reflect.apply(on, observable, [handler])
  return () => {
    Reflect.apply(off, observable, [handler])
  }
}

/** Stop matter.js's own wildcard subscription so this addon owns the session. */
function disableAutoSubscribe(peer: Record<string, unknown>): void {
  const stateOf = peer['stateOf']
  if (typeof stateOf !== 'function') return
  let network: unknown
  try {
    network = Reflect.apply(stateOf, peer, ['network'])
  } catch {
    return
  }
  if (!isRecord(network)) return
  if ('autoSubscribe' in network) {
    network['autoSubscribe'] = false
  }
}

function subscriptionFrom(result: unknown): MatterPeerSubscription {
  return {
    close: async () => {
      if (!isRecord(result)) return
      const fn = result['close']
      if (typeof fn !== 'function') return
      await Promise.resolve(Reflect.apply(fn, result, []))
    },
  }
}

/**
 * Build a subscribable view of a commissioned peer, or null when the peer has
 * no `interaction.subscribe` (nothing to attach — the caller logs that).
 */
export function subscribableFromPeer(peer: unknown, nodeId: string): MatterSubscribablePeer | null {
  if (!isRecord(peer)) return null
  const interaction = peer['interaction']
  if (!isRecord(interaction) || typeof interaction['subscribe'] !== 'function') return null
  const subscribe = interaction['subscribe']
  return {
    nodeId,
    online: () => peerOnline(peer),
    onOnline: (handler) => listenLifecycle(peer, 'online', handler),
    onOffline: (handler) => listenLifecycle(peer, 'offline', handler),
    subscribe: async (handlers) => {
      disableAutoSubscribe(peer)
      const request = {
        sustain: true,
        keepSubscriptions: false,
        fabricFilter: true,
        attributes: [{}],
        minIntervalFloor: Seconds(SUBSCRIPTION_MIN_INTERVAL_S),
        maxIntervalCeiling: Seconds(SUBSCRIPTION_MAX_INTERVAL_S),
        bootstrapWithRead: true,
        updated: async (update: unknown) => {
          const reports = await collectAttributeReports(nodeId, update)
          for (const report of reports) handlers.onReport(report)
        },
        closed: () => {
          handlers.onClosed()
        },
      }
      const result: unknown = await Promise.resolve(
        Reflect.apply(subscribe, interaction, [request]),
      )
      return subscriptionFrom(result)
    },
  }
}

/** Re-export so the controller can forward a single report type. */
export type { MatterAttributeReport }
