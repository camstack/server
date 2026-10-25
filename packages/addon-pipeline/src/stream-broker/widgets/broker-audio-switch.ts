/**
 * The BROKER-side audio mute for one camera, as the stream-broker panel
 * controls it ([D113](../../../../../docs/decisions/adr-0113.md) phase 3, the
 * `broker-audio` row).
 *
 * | Function | Authority read | Authority written |
 * | --- | --- | --- |
 * | `broker-audio` | `streamBroker.getDeviceAudioMute` | `streamBroker.setDeviceAudioMute` |
 *
 * The authority is the broker's own `DeviceOverride` blob (D83) — no new store
 * — and while it is muted this node distributes none of the camera's audio on
 * any plane it serves: live subscribers AND the RTSP restream the recorder
 * pulls.
 *
 * ## The node is not a detail, it is the whole correctness argument
 *
 * `stream-broker` is a PER-NODE singleton and a camera's brokers live on the
 * node that owns its source pull. A call with no routing key resolves the
 * cap locally — for a browser that means the HUB's broker, which answers about
 * a camera it does not serve. Server-side the fix is `nodePin`; over HTTP the
 * cap router takes a top-level `nodeId` in the input, which is what this module
 * carries.
 *
 * So there are two ways to be wrong and only one of them looks wrong:
 * reading the wrong node returns a confident `muted: false` for a camera whose
 * real broker is muted, and writing the wrong node persists an override on a
 * node with no broker for that camera at all — a write nothing reads, which is
 * the exact failure this whole refactor exists to remove. **An unknown source
 * owner is therefore UNKNOWN, never a silent fall back to the hub.**
 *
 * Polarity inverts: the fact is `muted`, the control is "Audio". The words the
 * panel shows for it live in the widget bundle's i18n files, not here.
 */

export interface BrokerAudioState {
  /** Is this node distributing the camera's audio? `null` = unknown. */
  readonly on: boolean | null
  /** A control is only offered when the state is known AND routable. */
  readonly available: boolean
  /** The node whose broker answers for this camera; `null` = unresolved. */
  readonly nodeId: string | null
}

export interface BrokerAudioInput {
  /** `getDeviceAudioMute().muted`; `null` when the read failed or was skipped. */
  readonly muted: boolean | null
  /**
   * `pipelineOrchestrator.getCameraStatus().assignment.sourceNodeId` — the node
   * whose stream-broker holds this camera's brokers. `null` when unresolved,
   * which makes the whole control unknown.
   */
  readonly sourceNodeId: string | null
  /** The value an in-flight write asked for; `null` when nothing is in flight. */
  readonly pendingOn?: boolean | null
}

export function resolveBrokerAudio(input: BrokerAudioInput): BrokerAudioState {
  const routable = input.sourceNodeId !== null && input.sourceNodeId !== ''
  // Not routable is UNKNOWN even if a `muted` value is in hand: a value read
  // without the routing key describes some other node's broker.
  const read = routable && input.muted !== null ? !input.muted : null
  const pending = input.pendingOn ?? null
  const on = read === null ? null : (pending ?? read)
  return {
    on,
    available: read !== null,
    nodeId: routable ? input.sourceNodeId : null,
  }
}

/**
 * The write ONE toggle implies, including the routing key it must carry.
 *
 * A type alias rather than an interface deliberately: the generated cap
 * mutation takes the router's LOOSE input (`{ [x: string]: unknown } & …`, the
 * shape that carries `nodeId`), and an interface has no implicit index
 * signature — so declaring this as one would force a cast at the single call
 * site that matters most.
 */
export type BrokerAudioWrite = {
  readonly deviceId: number
  readonly muted: boolean
  /** The cap router's out-of-band routing key. Never omitted. */
  readonly nodeId: string
}

export function brokerAudioWrite(
  state: BrokerAudioState,
  deviceId: number,
): BrokerAudioWrite | null {
  if (!state.available || state.on === null || state.nodeId === null) return null
  return { deviceId, muted: state.on, nodeId: state.nodeId }
}
