import type { IScopedLogger } from '@camstack/types'
import type { VeluxCoverClass } from './config.js'

/**
 * The contract the integration manager and the device classes build against.
 * The real implementation is {@link import('./klf-gateway-client.js').KlfGatewayClient}
 * over the `klf-200-api` library (TLS socket on port 51200, SLIP-framed binary
 * frames, password login); specs substitute a scripted fake.
 *
 * The KLF-200 exposes up to ~200 actuator "nodes". A window, a roller shutter,
 * a blind or an awning is one node with a current position; a window with an
 * integrated rain sensor also reports a rain limitation. There is no tilt.
 */

/** HA-oriented cover class the KLF-200 actuator type maps to. */
export type { VeluxCoverClass }

/** One KLF-200 actuator node, as last reported by the gateway. */
export interface VeluxNode {
  /** KLF-200 system-table node id (an index; can be reused after a node is removed). */
  readonly nodeId: number
  /** Hex serial number of the actuator — the stable identity. '' when none is reported. */
  readonly serial: string
  /** Operator-assigned node name from the KLF-200 config. */
  readonly name: string
  /** 0 = fully closed, 100 = fully open. Null when the node has no known position. */
  readonly position: number | null
  /** Where the node is heading (same scale), or null. */
  readonly targetPosition: number | null
  /** True while the node is executing a movement. */
  readonly moving: boolean
  /** Window / shutter / blind / awning / garage / gate. */
  readonly coverClass: VeluxCoverClass
  /** Whether the node is currently reachable through the gateway. */
  readonly online: boolean
  /** True for a window with an integrated rain sensor. */
  readonly rainSensor: boolean
  /** Rain state of a window with a rain sensor; null when unknown or no sensor. */
  readonly raining: boolean | null
}

/** Why a session ended — logged verbatim on every disconnect. */
export interface VeluxDisconnect {
  readonly reason: string
}

/** The live client the addon drives one KLF-200 gateway with. */
export interface VeluxGatewayClient {
  /** Open the TLS/SLIP session, authenticate, read all nodes and start listening for notifications. */
  connect(): Promise<void>
  /** Close the session. Never fires the disconnect callback. */
  disconnect(): Promise<void>
  /** Every cover-like node known to the gateway, last-known state. */
  listNodes(): readonly VeluxNode[]
  /** Drive a node fully open. */
  open(nodeId: number): Promise<void>
  /** Drive a node fully closed. */
  close(nodeId: number): Promise<void>
  /** Stop a moving node. */
  stop(nodeId: number): Promise<void>
  /** Drive a node to an intermediate position (0 closed .. 100 open). */
  setPosition(nodeId: number, position: number): Promise<void>
  /** Firmware (software) version the gateway reports, dotted (`0.2.0.0.71.0`). */
  readVersion(): Promise<string>
  /** Ask the gateway to reboot itself (GW_REBOOT_REQ). The session ends right after. */
  reboot(): Promise<void>
  /** Subscribe to node changes pushed by the gateway. Returns the unsubscribe. */
  onNodeChanged(listener: (node: VeluxNode) => void): () => void
  /** Subscribe to the end of an ESTABLISHED session (idle drop, reset, error). Returns the unsubscribe. */
  onDisconnected(listener: (event: VeluxDisconnect) => void): () => void
}

/** Raised by {@link VeluxGatewayClient.connect} when the gateway refused the password. */
export class VeluxLoginRefusedError extends Error {
  constructor() {
    super('KLF-200 refused the password (login failed)')
    this.name = 'VeluxLoginRefusedError'
  }
}

/** Factory seam: build a {@link VeluxGatewayClient} for one connection attempt. */
export type VeluxGatewayClientFactory = (input: {
  readonly host: string
  readonly password: string
  /** Logger already carrying the gateway device's `deviceId` tag. */
  readonly logger: IScopedLogger
}) => VeluxGatewayClient
