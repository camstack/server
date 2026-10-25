/**
 * live-viewers — who counts as a PERSON watching a camera live right now.
 *
 * The broker's consumers are mostly the system itself: the detection decoder,
 * the recorder, the snapshot grabber, the prebuffer hold, the agents' derived
 * brokers, audio analysis. None of them is a viewer, and a count that included
 * them would read "3 watching" on a camera nobody has open. So a viewer is a
 * POSITIVE classification, decided once, here:
 *
 *  - a WebRTC session of an external kind ({@link VIEWER_CONSUMER_KINDS}) that
 *    is on the LIVE edge (a session scrubbing a recording is not watching live);
 *  - an RTSP restream client that is playing and is not one of ours
 *    ({@link isExternalRestreamClient}).
 *
 * Pure module — no I/O, no imports of the broker. Both counters
 * (`RtspRestreamer.countExternalViewers`, `BrokerWebrtcServer.countLiveViewers`)
 * and the manager's per-camera roll-up read these rules, so the definition
 * cannot drift between the two planes.
 */
import type { BrokerConsumerKind } from '@camstack/types'
import type { RestreamIntent } from './rtsp/restream-intent.js'

/**
 * WebRTC consumer kinds that are a person (or a person's device) watching.
 * Every other kind (`recording`, `pipeline`, `snapshot`, `warmup`,
 * `derived-broker`, `rtsp-listen`, `unknown`) is the system holding the stream.
 */
export const VIEWER_CONSUMER_KINDS: ReadonlySet<BrokerConsumerKind> = new Set<BrokerConsumerKind>([
  'webrtc-browser',
  'webrtc-mobile',
  'webrtc-whep',
  'alexa',
  'homekit',
])

export function isViewerConsumerKind(kind: BrokerConsumerKind): boolean {
  return VIEWER_CONSUMER_KINDS.has(kind)
}

/**
 * `User-Agent` prefixes our OWN processes put on their RTSP dials:
 * `recorder/<id>/…` (the writer), `decode/<id>/…` (the detection decode
 * worker), `camstack-…` (the RTSP client an agent's derived broker pulls this
 * restream with), `prebuffer` (the prebuffer hold).
 */
export const INTERNAL_RESTREAM_AGENT_PREFIXES: readonly string[] = [
  'recorder',
  'decode',
  'camstack-',
  'prebuffer',
]

/** What the restreamer knows about one RTSP client at the moment of counting. */
export interface RestreamClientFacts {
  /** Reached PLAY and is still connected. A DESCRIBE-only probe is no viewer. */
  readonly playing: boolean
  readonly userAgent: string | null
  /** `ip:port` as `RtspSession.getInfo` prints it. */
  readonly remoteAddr: string
  /** Dialed the audio-free `/muted` path — a local decoder loopback. */
  readonly muted: boolean
  /** The purpose the dial declared on its path, or null when it declared none. */
  readonly intent: RestreamIntent | null
}

const LOOPBACK_PREFIXES: readonly string[] = ['127.', '::1', '::ffff:127.', '[::1]']

/** True when the peer is this host — the system's own ffmpeg children. */
export function isLoopbackAddr(remoteAddr: string): boolean {
  return LOOPBACK_PREFIXES.some((p) => remoteAddr.startsWith(p))
}

/**
 * An RTSP restream client from OUTSIDE: playing, and none of
 *  - a declared dial purpose (detection / recording / sentry),
 *  - the muted decoder-loopback path,
 *  - one of our own `User-Agent`s,
 *  - a process on this same host (snapshot, grid compositor, the HomeKit leg —
 *    ffmpeg children that dial the restream over loopback).
 */
export function isExternalRestreamClient(facts: RestreamClientFacts): boolean {
  if (!facts.playing) return false
  if (facts.intent !== null) return false
  if (facts.muted) return false
  const ua = facts.userAgent
  if (ua !== null && INTERNAL_RESTREAM_AGENT_PREFIXES.some((p) => ua.startsWith(p))) return false
  if (isLoopbackAddr(facts.remoteAddr)) return false
  return true
}

/** A per-camera tally, ids with at least one viewer only. */
export type ViewerCounts = ReadonlyMap<number, number>

/** Sum several tallies into a new one (inputs are never mutated). */
export function mergeViewerCounts(parts: readonly ViewerCounts[]): ViewerCounts {
  const out = new Map<number, number>()
  for (const part of parts) {
    for (const [deviceId, n] of part) {
      if (n > 0) out.set(deviceId, (out.get(deviceId) ?? 0) + n)
    }
  }
  return out
}
