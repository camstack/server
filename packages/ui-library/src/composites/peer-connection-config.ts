/**
 * The player's `RTCConfiguration`, in one place for every connect path.
 *
 * The player never forces `iceTransportPolicy: 'relay'` on its own (werift's
 * relay forward is unreliable across two real TURN servers, and relay would
 * defeat the direct LAN/Tailscale path). The policy exists for the WebRTC
 * diagnostics only, which run the SAME player once with `all` and once with
 * `relay` to tell a reachable relay path from a dead one. Absent, the key is
 * not set at all, so a production connect is byte-for-byte what it was.
 */

/** Public STUN kept as a fallback beside whatever the hub's TURN provider returns. */
export const FALLBACK_STUN_SERVER: RTCIceServer = { urls: 'stun:stun.l.google.com:19302' }

export function buildPeerConnectionConfig(
  iceServers: readonly RTCIceServer[] | undefined,
  iceTransportPolicy: RTCIceTransportPolicy | undefined,
): RTCConfiguration {
  const servers = [...(iceServers ?? []), FALLBACK_STUN_SERVER]
  return iceTransportPolicy === undefined
    ? { iceServers: servers }
    : { iceServers: servers, iceTransportPolicy }
}
