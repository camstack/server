/**
 * Reconnecting a broker's TRANSPORT in place, without rebuilding the broker (D856 amendment).
 *
 * An agent changes how it dials the hub (a new hub address, a new cluster secret, a mesh leaf
 * swap or its rollback) by replacing its transporter. It used to stop the whole `ServiceBroker`
 * and build another. That threw away everything bound to the old one: the `$process` service
 * (whose `stopped()` SIGTERMs every runner - the "child gone" lines), `$agent-cap-fwd`,
 * `$agent`, the event bus, the addon services and every closure that captured the broker. The
 * node came back ONLINE and capless, and the hub's confirm step then failed with
 * "`$agent-cap-fwd.forward` is not found".
 *
 * The broker, its services, its registries and its child runners are all independent of the
 * wire. So only the wire is replaced: disconnect the transit, forget the remote nodes (their
 * connection is gone, and the next `$node.connected` is what re-runs the mesh join), install a
 * new transporter on the SAME transit and connect it. Children never notice; the join's settle
 * re-sends the full manifest (D3), which still carries every child.
 */
import type { AgentTransport } from './broker-factory.js'

/** The slice of a Moleculer transporter this module drives. */
interface TransporterLike {
  init(transit: unknown, messageHandler: unknown, afterConnect: unknown): void
  send: unknown
  receive: unknown
  connected?: boolean
  connect(...args: unknown[]): Promise<unknown>
  disconnect(): Promise<unknown>
  /** TCP transporters keep their sockets on these; both are event emitters. */
  reader?: unknown
  writer?: unknown
}

/** The slice of Moleculer's `Transit` this module drives (a documented type boundary: the d.ts omits it). */
interface TransitLike {
  tx: TransporterLike
  connect(): Promise<unknown>
  disconnect(): Promise<unknown>
  messageHandler(cmd: string, packet: unknown): unknown
  afterConnect(wasReconnect: unknown): Promise<unknown>
}

interface NodeLike {
  readonly id: string
  readonly available: boolean
}

interface RegistryLike {
  nodes: {
    disconnected(nodeId: string, unexpected: boolean): void
    list(opts: { onlyAvailable: boolean }): readonly NodeLike[]
  }
}

interface WrappingBroker {
  nodeID: string
  registry: RegistryLike
  transit: TransitLike | null
  wrapMethod(
    name: string,
    handler: unknown,
    bindTo: unknown,
    opts?: { readonly reverse: boolean },
  ): unknown
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function'
}

/** Moleculer's d.ts hides the transit and the registry internals: check them at runtime instead. */
function isWrappingBroker(value: unknown): value is WrappingBroker {
  return (
    isObject(value) &&
    isFunction(Reflect.get(value, 'wrapMethod')) &&
    hasNodeCatalog(Reflect.get(value, 'registry')) &&
    'transit' in value
  )
}

/** The node catalog the swap forgets remote nodes through (private Moleculer API, pinned by a spec). */
function hasNodeCatalog(registry: unknown): boolean {
  if (!isObject(registry)) return false
  const nodes = Reflect.get(registry, 'nodes')
  return (
    isObject(nodes) &&
    isFunction(Reflect.get(nodes, 'disconnected')) &&
    isFunction(Reflect.get(nodes, 'list'))
  )
}

function isTransporterLike(value: unknown): value is TransporterLike {
  return (
    isObject(value) &&
    isFunction(Reflect.get(value, 'init')) &&
    isFunction(Reflect.get(value, 'connect')) &&
    isFunction(Reflect.get(value, 'disconnect'))
  )
}

/** Any Moleculer broker (the d.ts of `ServiceBroker` does not describe what this module drives). */
export type SwappableBroker = object

function wrapping(broker: SwappableBroker): WrappingBroker {
  if (!isWrappingBroker(broker)) throw new Error('not a Moleculer broker with a transport')
  return broker
}

function transitOf(broker: SwappableBroker): TransitLike {
  const transit = wrapping(broker).transit
  if (transit === null || transit === undefined) {
    throw new Error('the broker has no transport to reconnect')
  }
  return transit
}

/** A transporter built for a swap and not yet installed. */
export interface PendingTransporter {
  readonly tx: TransporterLike
}

/** The transporter currently installed on the broker (for identity checks). */
export function currentBrokerTransporter(broker: SwappableBroker): PendingTransporter {
  return { tx: transitOf(broker).tx }
}

/** Build the transporter an {@link AgentTransport} describes (nothing is bound or dialled yet). */
export function buildTransporter(transport: AgentTransport): PendingTransporter {
  const tx: unknown = transport.transporter
  if (!isTransporterLike(tx)) throw new Error('the agent transport is not a Moleculer transporter')
  return { tx }
}

/**
 * Whether `pending` is the transporter installed on the broker right now. A reconnect that was
 * abandoned at its deadline and resumes later must not tear down a newer run's transport.
 */
export function isInstalledTransporter(
  broker: SwappableBroker,
  pending: PendingTransporter,
): boolean {
  return transitOf(broker).tx === pending.tx
}

/**
 * Disconnect the installed transporter and forget every remote node. Forgetting is what makes the
 * hub's next INFO a NEW connection: `$node.connected` fires again, so the agent's mesh join re-runs
 * and its settle re-sends the manifest. Without it the hub would still be "available" in the local
 * registry and nothing would re-announce the node.
 */
export async function disconnectBrokerTransport(broker: SwappableBroker): Promise<void> {
  // `wrapping` throws BEFORE anything is dropped when a Moleculer upgrade moved what this relies on.
  const b = wrapping(broker)
  const transit = transitOf(broker)
  const leaving = transit.tx
  // From here the leaving transporter never connects again: Moleculer's own connect retry (every
  // 5 s, reading `transit.tx` when it fires) would otherwise re-run it, or a newer one, half-started.
  retired.add(leaving)
  try {
    await transit.disconnect()
  } finally {
    detachListeners(leaving)
    for (const node of b.registry.nodes.list({ onlyAvailable: true })) {
      if (node.id !== b.nodeID) b.registry.nodes.disconnected(node.id, false)
    }
  }
}

/** Transporters that were disconnected or replaced: their `connect` is a no-op for good. */
const retired = new WeakSet<object>()

/**
 * The leaving transporter's writer must not keep reporting into the SHARED node catalog: a late
 * FIN on one of its sockets would call `nodes.disconnected` on the node the NEW transporter just
 * connected to.
 */
function detachListeners(tx: TransporterLike): void {
  for (const emitter of [tx.writer, tx.reader]) {
    if (isObject(emitter) && isFunction(Reflect.get(emitter, 'removeAllListeners'))) {
      Reflect.get(emitter, 'removeAllListeners').call(emitter)
    }
  }
}

/**
 * One connect at a time per transporter, and none for a retired or replaced one. Moleculer's connect
 * retry re-runs `tx.connect()` on whatever `transit.tx` is when its timer fires; a second run of
 * `startTcpServer` overwrites the live reader and writer, leaks the gossip interval and leaves a
 * listening server behind. A connect that fails is cleaned up before the retry runs.
 */
function guardConnect(transit: TransitLike, tx: TransporterLike): void {
  const original = tx.connect.bind(tx)
  let inflight: Promise<unknown> | null = null
  tx.connect = (...args: unknown[]): Promise<unknown> => {
    if (retired.has(tx) || transit.tx !== tx) return Promise.resolve()
    if (inflight !== null) return inflight
    if (tx.connected === true) return Promise.resolve()
    const run: Promise<unknown> = original(...args)
      .catch(async (error: unknown) => {
        await Promise.resolve(tx.disconnect()).catch(() => undefined)
        throw error
      })
      .finally(() => {
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  }
}

/**
 * Install `pending` as the broker's transporter: the same wiring Moleculer's `Transit` constructor
 * does (init + the broker's send/receive middleware wrapping, which carries the mesh join gate).
 */
export function installBrokerTransporter(
  broker: SwappableBroker,
  pending: PendingTransporter,
): void {
  const b = wrapping(broker)
  const transit = transitOf(broker)
  const tx = pending.tx
  retired.add(transit.tx)
  guardConnect(transit, tx)
  tx.init(
    transit,
    (cmd: string, packet: unknown) => transit.messageHandler(cmd, packet),
    transit.afterConnect.bind(transit),
  )
  const send = b.wrapMethod('transporterSend', tx.send, tx)
  const receive = b.wrapMethod('transporterReceive', tx.receive, tx, {
    reverse: true,
  })
  tx.send = send
  tx.receive = receive
  transit.tx = tx
}

/** Connect the installed transporter (the broker's own `start()` path, minus the services). */
export async function connectBrokerTransport(broker: SwappableBroker): Promise<void> {
  await transitOf(broker).connect()
}
