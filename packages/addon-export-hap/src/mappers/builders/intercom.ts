/**
 * Intercom builder — declares two-way-audio capability so the HAP
 * controller adds the Microphone + Speaker services automatically and
 * advertises mic/speaker support in the stream offer.
 *
 * Round 3 (this build):
 *   - We flip `twoWayAudio: true` on the streaming options so iOS Home
 *     renders the press-to-talk button.
 *   - The camera-streams builder wires the SRTP RECEIVE socket and
 *     decodes incoming Opus → PCM s16le 16 kHz mono via the
 *     `audio-codec` cap (when mounted). PCM frames are counted +
 *     logged on a 5 s heartbeat.
 *   - The final hop (PCM → camera talk channel) is NOT wired yet. It
 *     requires a cap-level extension — see addon docstring "known
 *     limitations". Until then, the press-to-talk button works as far
 *     as iOS is concerned (UDP socket binds, SRTP packets arrive,
 *     codec runs), but no audio reaches the camera speaker.
 *
 * The function is async-shaped to stay symmetric with the other
 * builders and to leave room for an early-probe call against
 * `proxy.intercom.getStatus({})` once we wire the real path.
 */
import type { CameraStreamingOptions } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'

export interface IntercomBuilderInput {
  readonly bctx: BuilderContext
  readonly streamingOptions: CameraStreamingOptions
}

export async function buildIntercom(input: IntercomBuilderInput): Promise<BuilderHandle> {
  const { bctx, streamingOptions } = input
  if (streamingOptions.audio) {
    // Mutate is OK here — we own the object created moments ago by the
    // camera-streams builder; nothing else has a reference yet.
    ;(streamingOptions.audio as { twoWayAudio?: boolean }).twoWayAudio = true
  }

  bctx.ctx.logger
    .withTags({ deviceId: bctx.numericDeviceId })
    .debug(
      'export-hap: intercom advertised (downstream wired; upstream decodes Opus → PCM but talk-back to camera requires intercom-cap extension)',
    )

  return {
    async dispose(): Promise<void> {
      // Nothing to tear down today — the controller owns the
      // microphone/speaker services and removes them with the accessory.
      // The audio-codec session (lazy-opened on first incoming RTP) and
      // the upstream UDP socket are both owned by the camera-streams
      // builder's session-state map; their `dispose` runs on stream
      // stop, not accessory unexpose. No double-cleanup risk.
    },
  }
}
