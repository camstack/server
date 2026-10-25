/**
 * Doorbell delivery probe — the answer to "did the ring reach anything?".
 *
 * `DoorbellController.ringDoorbell()` calls `updateCharacteristic` on the
 * Doorbell service's `ProgrammableSwitchEvent`. hap-nodejs then broadcasts an
 * EVENT frame to each open HAP connection — but `HAPConnection.sendEvent`
 * begins with
 *
 * ```js
 * if (!this.registeredEvents.has(aid + "." + iid)) { return }
 * ```
 *
 * so a connection that has not SUBSCRIBED to that exact characteristic is
 * skipped in silence, and a ring with no subscribed connection at all
 * evaporates without a single line anywhere in the stack. `ringDoorbell()`
 * returns `void` and throws nothing in that case, which is why a real press on
 * camera 101 on 2026-08-07 produced zero `export-hap` log output and no iPhone
 * notification: the two are indistinguishable from the outside.
 *
 * This module makes them distinguishable. It reads the three facts that decide
 * delivery — the accessory is published (`aid`), the characteristic has an
 * instance id (`iid`), and how many open connections subscribed to `aid.iid` —
 * so the ring can state its own outcome.
 *
 * TYPE BOUNDARY: `Accessory._server`, `HAPServer.httpServer` and
 * `EventedHTTPServer.connections` are hap-nodejs internals with no public
 * accessor (the same boundary `accessoryPaired` already crosses for
 * `_accessoryInfo.pairedClients`). They are declared structurally here and
 * every hop is optional — a shape change in the library degrades this to
 * `serverPublished: false`, never to a throw on the ring path.
 */

/** Minimal structural view of the hap-nodejs internals we read. The inputs are
 *  taken as `unknown` and narrowed by guards: `Accessory._server` is `private`
 *  in the library's types, so a declared-shape parameter would not accept a
 *  real `Accessory` without a cast. */
interface HapConnectionLike {
  readonly hasEventNotifications: (aid: number, iid: number) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function isConnectionLike(value: unknown): value is HapConnectionLike {
  return isRecord(value) && typeof value['hasEventNotifications'] === 'function'
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

/** `accessory._server.httpServer.connections`, or null at any missing hop. */
function readConnections(accessory: unknown): Iterable<unknown> | null {
  if (!isRecord(accessory)) return null
  const server = accessory['_server']
  if (!isRecord(server)) return null
  const httpServer = server['httpServer']
  if (!isRecord(httpServer)) return null
  const connections = httpServer['connections']
  return isIterable(connections) ? connections : null
}

export interface DoorbellDeliveryReport {
  /** Accessory instance id — null until the accessory is published. */
  readonly aid: number | null
  /** Characteristic instance id — null until services are assigned ids. */
  readonly iid: number | null
  /** True when the accessory owns a running HAP server. */
  readonly serverPublished: boolean
  /** Open HAP connections (paired controllers + home hubs currently connected). */
  readonly connectionCount: number
  /** Connections SUBSCRIBED to this characteristic. Only these receive the ring. */
  readonly subscriberCount: number
}

/**
 * Probe how far a ring on `characteristic` of `accessory` can travel RIGHT NOW.
 * Pure with respect to HAP state — it only reads. Never throws.
 */
export function describeDoorbellDelivery(
  accessory: unknown,
  characteristic: unknown,
): DoorbellDeliveryReport {
  const aid = isRecord(accessory) ? numberOrNull(accessory['aid']) : null
  const iid = isRecord(characteristic) ? numberOrNull(characteristic['iid']) : null
  const serverPublished = isRecord(accessory) && isRecord(accessory['_server'])
  const connections = readConnections(accessory)

  if (connections === null) {
    return { aid, iid, serverPublished, connectionCount: 0, subscriberCount: 0 }
  }

  let connectionCount = 0
  let subscriberCount = 0
  for (const connection of connections) {
    connectionCount += 1
    if (aid === null || iid === null) continue
    if (isConnectionLike(connection) && connection.hasEventNotifications(aid, iid)) {
      subscriberCount += 1
    }
  }
  return { aid, iid, serverPublished, connectionCount, subscriberCount }
}

/**
 * True when the ring provably reached nobody: no connection is subscribed to
 * the characteristic, so hap-nodejs dropped every event frame silently. The
 * caller must say so out loud — this is a branch that discards work.
 */
export function ringReachedNobody(report: DoorbellDeliveryReport): boolean {
  return report.subscriberCount === 0
}
