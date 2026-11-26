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
import { Subscribe } from '@matter/protocol'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { MatterAttributeReport } from './matter-controller.js'
import {
  collectAttributeReports,
  collectEventReports,
  materialiseUpdate,
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

/**
 * Stop matter.js's own wildcard subscription so this addon owns the session.
 * `stateOf` is a read-only view (writing it throws ReadOnlyError); the writable
 * path is `setStateOf`, a transaction on the behavior. A failure is logged and
 * never aborts the subscribe: our own sustained subscription must still run.
 */
async function disableAutoSubscribe(
  peer: Record<string, unknown>,
  nodeId: string,
  logger: IScopedLogger | undefined,
): Promise<void> {
  const setStateOf = peer['setStateOf']
  if (typeof setStateOf !== 'function') return
  try {
    await Promise.resolve(Reflect.apply(setStateOf, peer, ['network', { autoSubscribe: false }]))
  } catch (err: unknown) {
    logger?.warn('Matter: could not turn off the library auto-subscribe', {
      tags: { addonId: 'matter-broker' },
      meta: { nodeId, error: errMsg(err) },
    })
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
export function subscribableFromPeer(
  peer: unknown,
  nodeId: string,
  logger?: IScopedLogger,
): MatterSubscribablePeer | null {
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
      await disableAutoSubscribe(peer, nodeId, logger)
      // `Subscribe()` builds the `attributeRequests` / `eventRequests` lists the
      // library counts; the raw `attributes` / `events` options are not read.
      const request = {
        ...Subscribe({
          attributes: [{}],
          events: [{}],
          keepSubscriptions: false,
          fabricFilter: true,
          minIntervalFloor: Seconds(SUBSCRIPTION_MIN_INTERVAL_S),
          maxIntervalCeiling: Seconds(SUBSCRIPTION_MAX_INTERVAL_S),
        }),
        sustain: true,
        bootstrapWithRead: true,
        updated: async (update: unknown) => {
          // The result is a one-shot stream: read it once, split by kind.
          const records = await materialiseUpdate(update)
          const reports = await collectAttributeReports(nodeId, records)
          for (const report of reports) handlers.onReport(report)
          const events = await collectEventReports(nodeId, records)
          for (const event of events) handlers.onEvent(event)
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
