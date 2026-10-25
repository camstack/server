/**
 * Which slot a HomeKit session gets, decided the way the reference
 * implementation decides it.
 *
 * ## Why not by negotiated resolution
 *
 * Because that is what we were doing, and on 101 it lands on the one slot that
 * has never rendered. The camera's own configuration, read from the device:
 *
 * | slot | resolution | fps | profile | gop |
 * | --- | --- | --- | --- | --- |
 * | high | 3840x2160 | 25 | main | 100 |
 * | mid  | 1280x720  | **10** | main | 40 |
 * | low  | 640x360   | 25 | main | 100 |
 *
 * iOS negotiates 1280x720, "closest resolution" picks `mid`, and `mid` is a
 * 10 fps stream. Nothing else distinguishes it — same codec, same profile, a
 * 4 s key-frame interval — and it stayed black across every combination tried,
 * including a transcode with near-zero loss. `low` renders immediately.
 *
 * A mature reference implementation never selects it, because it does not
 * choose on resolution at all.
 *
 * ## What it chooses on
 *
 * The AUDIO packet time. Opus negotiates 20 ms on a local connection and 60 ms
 * through a relay, which is the only reliable remote-ness signal HAP exposes —
 * remote and local Wi-Fi are otherwise indistinguishable. Video width is used
 * for exactly one thing: spotting an Apple Watch, whose panel is under 640 px
 * wide.
 *
 * Every failing session on this hub logged `audioPacketTimeMs=20`. The signal
 * was in the log the whole time and nothing read it.
 */
import type { CamProfile } from '@camstack/types'

/**
 * `packet_time` at or above this means the audio is travelling through a
 * relay. Observed by the reference: Opus 20 local / 60 remote, AAC-ELD 30
 * local / 60 remote.
 */
export const REMOTE_AUDIO_PACKET_TIME_MS = 60

/** Widest Apple Watch panel, with room for a future one. */
export const WATCH_MAX_WIDTH_PX = 640

export type ConnectionClass = 'watch' | 'remote' | 'home-hub' | 'local'

export interface ConnectionClassInput {
  /** `request.video.width` — used ONLY to detect a watch. */
  readonly negotiatedWidth: number
  /** `request.audio.packet_time`, ms. The remote-ness signal. */
  readonly audioPacketTimeMs: number
  /**
   * Whether this session is known to arrive via a Home Hub relay. Left to the
   * caller because HAP does not say so: the reference infers it from its own
   * record of the last known hub address, and treats it as "might be remote".
   */
  readonly viaHomeHub: boolean
}

export function classifyConnection(input: ConnectionClassInput): ConnectionClass {
  if (input.negotiatedWidth < WATCH_MAX_WIDTH_PX) return 'watch'
  if (input.audioPacketTimeMs >= REMOTE_AUDIO_PACKET_TIME_MS) return 'remote'
  return input.viaHomeHub ? 'home-hub' : 'local'
}

/**
 * The slot each class asks for.
 *
 * ## `local` takes the camera's best stream — settled by measurement
 *
 * This function was pinned to `low` for EVERY class by one number. On 101/high,
 * 3840x2160 pass-through:
 *
 *   durationMs=30820  videoPacketsForwarded=93  videoKeyframes=1
 *   audioPacketsForwarded=1497  lost=0
 *
 * Three video datagrams a second, one key frame in half a minute, while the
 * AUDIO leg of the *same* ffmpeg ran perfectly. It read as "our path cannot
 * carry a high-bitrate stream".
 *
 * **It was not HomeKit, not 4K and not SRTP. The loopback UDP socket ffmpeg
 * writes its RTP into had no `SO_RCVBUF` at all** (2026-08-07). It ran on
 * `net.core.rmem_default`, 212 992 B — about a fifth of one 4K IDR, which
 * arrives as ~750 datagrams at `pkt_size=1378` in a single burst. The kernel
 * discarded the overflow, and a datagram dropped there never reaches a
 * `message` handler, so it lowered the forwarded count exactly like a packet
 * ffmpeg never wrote and the controller reported no loss for it either. Audio,
 * a few hundred bytes every 20 ms, never filled the buffer. That is the whole
 * asymmetry. See `stream-socket-buffer.ts`.
 *
 * With an 8 MiB buffer (granted — this hub's `net.core.rmem_max` is 16 MiB),
 * the same camera and the same slot, session
 * `12308100-7dbe-4ad1-b277-1f046ba54ec2` on 2026-08-07:
 *
 *   selectedProfile=high  transcode=false  slotMeasuredKbps=5097
 *   videoPacketsForwarded=6512  durationMs=9867      (~660/s, was ~3/s)
 *   msToFirstKeyframe=858  deliveredFps=24  worstFractionLostPct=0.4
 *   videoLoopRcvbufBytes=16777216  clamped=false
 *
 * Operator: loaded instantly, and visibly not the low stream. A 220x increase
 * in delivered packet rate from sizing one socket.
 *
 * ## Why the remote classes stay `low`
 *
 * Not caution left over from the freeze — a different, UNMEASURED question.
 * `watch`, `remote` and `home-hub` all send video across a link whose budget
 * nothing here has measured; the buffer fix says something about a loopback hop
 * inside one host and nothing whatsoever about a WAN. 4K pass-through at ~5 Mbps
 * to a phone on LTE is a decision that needs its own evidence, and `watch` has
 * a panel under 640 px wide that could not use the pixels anyway. Raise these
 * only with a measurement of the remote link, not by analogy with this one.
 *
 * `mid` remains excluded from every class, unrelated to all of the above: it is
 * a 10 fps stream on this fleet and it has never rendered under any combination
 * tried.
 */
export function slotForConnection(connection: ConnectionClass): CamProfile {
  switch (connection) {
    case 'watch':
      return 'low'
    case 'remote':
      return 'low'
    case 'home-hub':
      return 'low'
    case 'local':
      return 'high'
  }
}
