/**
 * The Matter controller seam.
 *
 * `MatterController` is the interface the rest of the addon depends on. The
 * broker, adoption and device layers never import matter.js. Production uses
 * {@link import('./matter-controller-impl.js').MatterJsController} (`ServerNode`
 * + per-node `interaction.subscribe`). {@link StubMatterController} is the test
 * double: it boots and lists nothing, and throws on commission / commands.
 *
 * IP / on-network commissioning only. BLE (`@matter/nodejs-ble`) is not wired.
 */

import type { CommissionProgress } from './matter-commission-progress.js'

/** A commissioned Matter node as the addon models it (controller-agnostic). */
export interface MatterNodeSnapshot {
  /** Matter operational node id (stable per fabric). */
  readonly nodeId: string
  /** Vendor / product label when the controller could read Basic Information. */
  readonly label: string
  /** True when the controller currently has a live subscription to the node. */
  readonly online: boolean
  /** One entry per endpoint with the server cluster ids the endpoint exposes. */
  readonly endpoints: readonly MatterEndpointSnapshot[]
}

/** A single endpoint of a node: its index + the server cluster ids present. */
export interface MatterEndpointSnapshot {
  /** Endpoint index within the node (endpoint 0 is the root). */
  readonly endpointId: number
  /** Server cluster ids present on this endpoint (decimal Matter cluster ids). */
  readonly clusterIds: readonly number[]
}

/** A single attribute report pushed from a commissioned node. */
export interface MatterAttributeReport {
  readonly nodeId: string
  readonly endpointId: number
  readonly clusterId: number
  readonly attributeId: number
  readonly value: unknown
}

/** An outbound cluster command invocation. */
export interface MatterCommandInvocation {
  readonly nodeId: string
  readonly endpointId: number
  readonly clusterId: number
  readonly commandName: string
  readonly args?: Record<string, unknown>
}

/** Result of a commissioning attempt. */
export interface CommissionResult {
  readonly nodeId: string
}

/** Disposer returned by a subscription. */
export type Unsubscribe = () => void

/**
 * The controller surface the addon consumes. A single fabric per broker entry.
 * All methods are async; the stub throws a clear "native controller not wired"
 * error for the operations that require matter.js.
 */
export interface MatterController {
  /** Boot the controller + load/persist the fabric from `dataDir`. */
  start(): Promise<void>
  /** Tear the controller down (idempotent). Closes subscriptions FIRST. */
  stop(): Promise<void>
  /** Commission a new node from a QR (`MT:...`) or 11-digit manual code. */
  commissionNode(pairingCode: string): Promise<CommissionResult>
  /** The current commissioned-node inventory (PULL reconcile source-of-truth). */
  listNodes(): Promise<readonly MatterNodeSnapshot[]>
  /** A single node snapshot, or null when not commissioned. */
  getNode(nodeId: string): Promise<MatterNodeSnapshot | null>
  /** Subscribe to attribute reports across all nodes. Returns a disposer. */
  subscribe(handler: (report: MatterAttributeReport) => void): Unsubscribe
  /** Invoke a cluster command on an endpoint (outbound control). */
  invokeCommand(invocation: MatterCommandInvocation): Promise<void>
  /** Remove (decommission) a node from this fabric. */
  removeNode(nodeId: string): Promise<void>
  /**
   * Ensure every commissioned node has a live attribute subscription.
   * Called on start, after commission, and on the reconcile backstop.
   */
  syncSubscriptions(): Promise<void>
}

/** Thrown by the stub for every operation that needs the real matter.js binding. */
export class MatterControllerNotWiredError extends Error {
  constructor(op: string) {
    super(
      `matter-broker: native matter.js controller not wired (operation "${op}"). ` +
        'Replace StubMatterController with the matter.js CommissioningController binding.',
    )
    this.name = 'MatterControllerNotWiredError'
  }
}

/** Options for constructing a controller. */
export interface MatterControllerOptions {
  /** Absolute path to the addon dataDir where the fabric/storage persists. */
  readonly dataDir: string
  /** Stable broker id (one fabric per broker). */
  readonly brokerId: string
  /** Commissioning phases for the admin UI. The stub ignores this. */
  readonly onCommissionProgress?: (progress: CommissionProgress) => void
  /** Adopted container id for subscription logs. Null until the node is adopted. */
  readonly resolveDeviceId?: (nodeId: string) => number | null
}

/**
 * Compiling, fully-typed stub. `start`/`stop`/`subscribe`/`listNodes` are safe
 * no-ops so the addon boots; the fabric-mutating + node-touching operations
 * throw {@link MatterControllerNotWiredError} until matter.js is bound.
 */
export class StubMatterController implements MatterController {
  readonly #handlers: Set<(report: MatterAttributeReport) => void> = new Set()
  readonly #options: MatterControllerOptions

  constructor(options: MatterControllerOptions) {
    this.#options = options
  }

  /** The dataDir/brokerId this controller would persist its fabric under. */
  get options(): MatterControllerOptions {
    return this.#options
  }

  async start(): Promise<void> {
    // No-op: the stub has no fabric. Production boots ServerNode from dataDir.
  }

  async stop(): Promise<void> {
    this.#handlers.clear()
  }

  async commissionNode(_pairingCode: string): Promise<CommissionResult> {
    throw new MatterControllerNotWiredError('commissionNode')
  }

  async listNodes(): Promise<readonly MatterNodeSnapshot[]> {
    // No persisted fabric in the stub — an empty inventory is the honest answer.
    return []
  }

  async getNode(_nodeId: string): Promise<MatterNodeSnapshot | null> {
    return null
  }

  subscribe(handler: (report: MatterAttributeReport) => void): Unsubscribe {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  async invokeCommand(_invocation: MatterCommandInvocation): Promise<void> {
    throw new MatterControllerNotWiredError('invokeCommand')
  }

  async removeNode(_nodeId: string): Promise<void> {
    throw new MatterControllerNotWiredError('removeNode')
  }

  async syncSubscriptions(): Promise<void> {
    // No peers in the stub.
  }
}

/**
 * Factory seam (stub default): build a {@link StubMatterController}.
 *
 * The production factory is {@link import('./matter-controller-impl.js')} wired
 * by the integration manager, which has the scoped logger the real
 * `MatterJsController` needs. This stub-returning factory keeps a logger-free
 * construction path for callers/tests that only need the no-op controller; the
 * stub remains the canonical test double.
 */
export function createMatterController(options: MatterControllerOptions): MatterController {
  return new StubMatterController(options)
}
