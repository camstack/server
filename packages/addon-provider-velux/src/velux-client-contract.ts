/**
 * The minimal contract the KLF-200 client library is adapted onto. The chosen
 * library is **`klf-200-api`** (v6.0.1, MIT, TypeScript-native — declared in
 * package.json). It is NOT yet installed / wired in this scaffold (Phase D is
 * scaffold-only, and the monorepo lockfile is not touched here), so this
 * interface is the seam the integration manager builds against and the whole
 * device layer type-checks today. Wiring = implement this contract over
 * `klf-200-api` in {@link VeluxIntegrationManager}'s `makeClient` factory and
 * drop the "not wired" default; NOTHING else in this addon changes.
 *
 * `klf-200-api` mapping reference:
 *   - `Connection` → open the TLS session + authenticate (host + web password).
 *   - `Gateway`    → gateway-level ops (this contract's `reboot()`).
 *   - `Products` / `Product` → one `Product` per actuator node; `Product.NodeID`
 *     → {@link VeluxNode.nodeId}, `Product.Name` → name, `Product.CurrentPosition`
 *     (0..1 → 0..100) → position, `Product.TypeID`/subtype → {@link VeluxCoverClass}.
 *     `Product.setTargetPositionAsync` → setPosition/open/close, `stopAsync` → stop.
 *
 * The KLF-200 speaks a binary TCP/TLS "SLIP" protocol on port 51200. It exposes
 * up to ~200 actuator "nodes"; each window / roller-shutter is one node with a
 * current position (0..100) and a type that classifies it as a `window` vs a
 * `shutter`. There is no tilt or climate surface — positional only.
 */

/** HA-oriented cover class the KLF-200 actuator type maps to. */
export type VeluxCoverClass = 'window' | 'shutter'

/** One KLF-200 actuator node (a window or a roller shutter). */
export interface VeluxNode {
  /** KLF-200 system-table node id (stable across reboots). */
  readonly nodeId: number
  /** Operator-assigned node name from the KLF-200 config. */
  readonly name: string
  /** 0 = fully closed, 100 = fully open (HA orientation). Null when the node
   *  has not yet reported a position. */
  readonly position: number | null
  /** Window vs shutter, derived from the actuator typeId / subtype. */
  readonly coverClass: VeluxCoverClass
  /** Whether the node is currently reachable through the gateway. */
  readonly online: boolean
}

/** The live client the addon drives one KLF-200 gateway with. */
export interface VeluxGatewayClient {
  /** Open the TLS/SLIP session and authenticate with the web password. */
  connect(): Promise<void>
  /** Close the session. */
  disconnect(): Promise<void>
  /** Enumerate all actuator nodes known to the gateway. */
  listNodes(): Promise<readonly VeluxNode[]>
  /** Resolve one node by id from the last-known system table, or null. */
  getNode(nodeId: number): VeluxNode | null
  /** Drive a node fully open. */
  open(nodeId: number): Promise<void>
  /** Drive a node fully closed. */
  close(nodeId: number): Promise<void>
  /** Stop a moving node. */
  stop(nodeId: number): Promise<void>
  /** Drive a node to an intermediate position (0 closed .. 100 open). */
  setPosition(nodeId: number, position: number): Promise<void>
  /** Reboot the gateway (KLF-200 `GW_REBOOT_REQ`). */
  reboot(): Promise<void>
}

/** Factory seam: build a live {@link VeluxGatewayClient} for a connection. */
export type VeluxGatewayClientFactory = (input: {
  readonly host: string
  readonly password: string
}) => VeluxGatewayClient
