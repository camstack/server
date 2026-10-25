/**
 * WHICH accessories ride the bridge, and what a bridge can hold.
 *
 * HomeKit forbids a bridged CAMERA: a camera must be its own standalone
 * accessory with its own mDNS advertisement and HAP server, and a bridge
 * hosting many of them overloads one HAP connection. Everything else — an
 * alarm panel, a switch, a light, a sensor, a lock — has no such rule, and
 * one accessory each costs the operator a port, an advertisement, a pairing
 * record and a separate "Add Accessory" in the Home app.
 *
 * So the model is HYBRID, and the default follows the constraint rather than
 * the history: a camera is never bridged, a non-camera is bridged unless the
 * operator says otherwise.
 */
import type { MapperKind } from './mappers/kind.js'

/**
 * hap-nodejs throws past this (`Accessory.js`, `MAX_ACCESSORIES = 149`), and a
 * throw at `addBridgedAccessory` time would be a device that silently fails to
 * expose. The gate is here so the refusal is ours, named, and logged.
 */
export const MAX_BRIDGED_ACCESSORIES = 149

export interface BridgeDecisionInput {
  readonly mapperKind: MapperKind
  /** The operator's per-device choice. `undefined` = never asked. */
  readonly useBridge?: boolean | undefined
}

/**
 * Whether this device's accessory belongs on the bridge.
 *
 * A camera is `false` whatever the operator picked — the answer is HomeKit's,
 * not ours, and an operator who switched it on before the field was gated must
 * not end up with a camera nobody can pair.
 *
 * Absent means ON for everything else: the field did not exist for entries
 * persisted before it, and the default the operator asked for is the bridge.
 */
export function shouldBridge(input: BridgeDecisionInput): boolean {
  if (input.mapperKind === 'camera') return false
  return input.useBridge !== false
}

/** Whether the bridge has room for one more. */
export function bridgeHasRoom(current: number): boolean {
  return current < MAX_BRIDGED_ACCESSORIES
}
