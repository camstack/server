/**
 * The clip intent of a WebRTC session (#566).
 *
 * A session opened to play a CamStack clip never dials the camera: the clip
 * is a file on our own storage, and on a sleeping battery camera every live
 * subscription is a wake. The intent covers the INITIAL negotiation only.
 * Everything that happens to the session after it is a re-offer of the same
 * session id, and this record says what that re-offer must be:
 *
 * - `live` — the client went live (`goLive`). The re-offer is an ordinary live
 *   session (wake, warm-up, the camera's codec), whatever hints it resends.
 * - `clip-codec` — the clip's codec is not the one the session negotiated. The
 *   re-offer stays a clip session, negotiated at the clip's codec, and the
 *   server puts the clip back on the pointer itself (the client has already
 *   forgotten it asked for one).
 */
import {
  parseProfileBrokerId,
  type WebrtcClientHints,
  type WebrtcStreamTarget,
} from '@camstack/types'
import type { ClipPlaybackHandle } from '../recorded/timeline-session.js'

export type ClipVideoCodec = 'H264' | 'H265'

export type ClipReoffer =
  | { readonly kind: 'live' }
  | {
      readonly kind: 'clip-codec'
      readonly codec: ClipVideoCodec
      readonly clip: ClipPlaybackHandle
      /** Where the client last asked the clip to start. */
      readonly offsetMs: number
    }

/** Is this offer a clip-intent one? A pending re-offer record outranks the hints. */
export function isClipIntent(hints: WebrtcClientHints, reoffer: ClipReoffer | undefined): boolean {
  if (reoffer === undefined) return hints.intent === 'clip'
  return reoffer.kind === 'clip-codec'
}

/**
 * The renegotiation target that re-offers the SAME stream the session was
 * opened on, in the vocabulary the client resolves (`WebrtcStreamTarget`).
 */
export function sameStreamTarget(streamId: string): WebrtcStreamTarget {
  if (streamId.endsWith('/adaptive')) return { kind: 'adaptive' }
  const profile = parseProfileBrokerId(streamId)
  if (profile !== null) return { kind: 'profile', profile: profile.profile }
  const slash = streamId.indexOf('/')
  return { kind: 'cam-stream', camStreamId: slash > 0 ? streamId.slice(slash + 1) : streamId }
}

export type PushVideoAccessUnit = (
  annexB: Uint8Array,
  rtpTs90k: number,
  codec: ClipVideoCodec,
) => void

/**
 * Pass a clip's access units only when they are in the codec the session
 * negotiated. Packetised under the other codec's payload type they are a
 * black picture, so a mismatch is dropped and reported instead.
 */
export function gateClipCodec(
  push: PushVideoAccessUnit,
  negotiated: () => ClipVideoCodec,
  onMismatch: (clipCodec: ClipVideoCodec) => void,
): PushVideoAccessUnit {
  return (annexB, rtpTs90k, codec) => {
    if (codec !== negotiated()) {
      onMismatch(codec)
      return
    }
    push(annexB, rtpTs90k, codec)
  }
}
