/**
 * Read-time overlay of a live rfc4571 endpoint onto native stream-catalog
 * descriptors.
 *
 * ## Why this exists
 *
 * A Reolink native `pull-rfc4571` catalog entry is published with a SYNTHETIC
 * SDP that deliberately omits `sprop-parameter-sets` and a `lazy:rfc4571:`
 * sentinel URL (see `synthetic-sdp.ts` — the omission keeps battery cams
 * asleep until a consumer actually dials). That is fine for the WebRTC /
 * restream consumers: the lib's muxer primes them with SPS/PPS in-band on the
 * first IDR. It is NOT fine for the raw ffmpeg DECODE reader
 * (`rfc4571-reader.ts`), which has no in-band parameter-set merge and needs
 * the SPS/PPS as SDP extradata — without them ffmpeg loops
 * `non-existing PPS 0 referenced → no frame` and decodes zero frames (verified
 * live on device 107: WebRTC worked, detection decode produced 0 frames).
 *
 * `materializeStreamSocket` already publishes the lib's real SDP (SPS/PPS from
 * the live IDR) on the first dial, but a later catalog re-pull (reconcile
 * poll / a second consumer such as the detection decoder starting) would
 * otherwise clobber that entry back to the synthetic descriptor. Applying this
 * overlay on EVERY catalog pull makes the pull serve the live endpoint's real
 * `tcp://` URL + real SDP whenever the upstream server is listening — one
 * source of truth — and revert cleanly to the synthetic/lazy entry once the
 * server idle-tears-down (the lookup returns null): the lib's real
 * `created.sdp` is always what gets advertised.
 */
import type { CamStreamDescriptor } from '@camstack/types'

/**
 * Minimal view of a live rfc4571 loopback server needed to upgrade a native
 * catalog descriptor: the real dial-URL parts + the lib's real SDP.
 */
export interface LiveRfc4571Endpoint {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  /** The lib's SDP — carries SPS/PPS extracted from the live IDR. */
  readonly sdp: string
}

/**
 * Resolve the live server for a camStreamId, or `null` when none is currently
 * listening. The camera wires this to `this.active` (guarded by
 * `server.server.listening`).
 */
export type LiveRfc4571Lookup = (camStreamId: string) => LiveRfc4571Endpoint | null

/**
 * Return a new descriptor list in which every native `pull-rfc4571` entry with
 * a live upstream server carries that server's real `tcp://` URL + real SDP.
 * Pure + immutable: non-native or cold entries pass through unchanged;
 * upgraded entries are fresh objects and sibling metadata keys are preserved.
 */
export function overlayLiveNativeRfc4571Sdp(
  descriptors: readonly CamStreamDescriptor[],
  liveServerFor: LiveRfc4571Lookup,
): CamStreamDescriptor[] {
  return descriptors.map((descriptor) => {
    if (descriptor.kind !== 'pull-rfc4571') return descriptor
    const live = liveServerFor(descriptor.camStreamId)
    if (!live) return descriptor
    const auth = `${encodeURIComponent(live.username)}:${encodeURIComponent(live.password)}`
    return {
      ...descriptor,
      url: `tcp://${auth}@${live.host}:${live.port}`,
      metadata: { ...descriptor.metadata, sdp: live.sdp },
    }
  })
}
