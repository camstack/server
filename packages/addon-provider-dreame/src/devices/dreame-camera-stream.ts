/**
 * The robot camera as a stream the broker can pull — the pure facts.
 *
 * A Dreame relay carries video only between `open()` and `close()`, and the
 * robot runs on a battery, so the camera cannot sit in the catalog with a
 * URL the way a mains RTSP camera does. The seam is the broker's own battery
 * path: `battery.wakeForStream` opens the monitor, and the catalog then
 * names the local RFC 4571 server (`dreame-rfc4571-server.ts`) the broker
 * pulls. While the monitor is CLOSED the
 * catalog carries the broker's lazy sentinel (Reolink's shape): the stream is
 * listed, and the first dial asks the publisher to materialize it.
 */
import { type BatteryStatus, type CamStreamDescriptor, hubAddressHostname } from '@camstack/types'

/** The one stream the robot camera offers. Half of the broker id (`<deviceId>/live`). */
export const CAMERA_STREAM_ID = 'live'
/** The plugin's cap: a monitor never outlives this, whoever is watching. */
export const MAX_STREAM_MS = 10 * 60_000
/** How long a cold robot may take to produce its first keyframe (the plugin's default). */
export const WAKE_TIMEOUT_MS = 45_000

/** `ChargingStatus` as the robot reports it (siid 3 piid 2, VERIFIED r2532a). */
const CHARGING_STATUS_CHARGING = 1

export interface CameraBatteryFacts {
  readonly level: number | null
  readonly charging: number | null
  /** The monitor is open — the camera is AWAKE in the cap's vocabulary. */
  readonly streamOpen: boolean
  readonly now: number
  /** Last time the robot said anything (a state change), null when never. */
  readonly contactAt: number | null
}

function clampLevel(level: number | null): number | null {
  if (level === null || !Number.isFinite(level)) return null
  return Math.max(0, Math.min(100, level))
}

/**
 * The battery slice the broker reads before a play: `sleeping` decides
 * whether it asks for a wake, `lastContactAt` decides whether it refuses to
 * (`deriveBatteryPresence` calls hours of silence "unreachable"). A contact
 * of 0 would read as "never heard" — the field is omitted instead.
 */
export function cameraBatterySlice(facts: CameraBatteryFacts): BatteryStatus {
  const charging: BatteryStatus['charging'] =
    facts.charging === null
      ? 'unknown'
      : facts.charging === CHARGING_STATUS_CHARGING
        ? 'dc'
        : 'none'
  return {
    level: clampLevel(facts.level),
    charging,
    sleeping: !facts.streamOpen,
    lastUpdated: facts.now,
    ...(facts.contactAt !== null && facts.contactAt > 0 ? { lastContactAt: facts.contactAt } : {}),
  }
}

export interface CameraStreamSession {
  /** Where the broker pulls: `tcp://<host>:<port>` of the local RFC 4571 server. */
  readonly url: string
  /** The SDP the server built from the first keyframe (sprop-parameter-sets). */
  readonly sdp: string
}

/** The broker's sentinel for "a source the publisher builds on demand" (the Reolink shape). */
export const LAZY_RFC4571_URL = `lazy:rfc4571:${CAMERA_STREAM_ID}`

/**
 * The SDP the stream carries BEFORE the monitor is open — codec only, no
 * parameter sets. It is what lets the stream be LISTED (a broker the device
 * page shows, the viewer's play disc) while nothing is dialled; the real SDP
 * with sprop-parameter-sets replaces it when the server is up. Same audio
 * facts every open has reported (AAC, 16 kHz, mono).
 */
export function syntheticRobotSdp(): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 0.0.0.0',
    's=No Name',
    't=0 0',
    'm=video 0 RTP/AVP 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 packetization-mode=1',
    'm=audio 0 RTP/AVP 97',
    'c=IN IP4 0.0.0.0',
    'b=AS:128',
    'a=rtpmap:97 MPEG4-GENERIC/16000/1',
    'a=fmtp:97 profile-level-id=1; mode=AAC-hbr; sizelength=13; indexlength=3; indexdeltalength=3',
    '',
  ].join('\r\n')
}

/**
 * One `pull-rfc4571` descriptor, ALWAYS: the local RTP server while the
 * monitor is open, the lazy sentinel while it is closed. The sentinel is what
 * Reolink's native streams use for the same reason — the stream stays listed
 * and definable, and the broker's first dial asks the publisher to
 * materialize it (`onRequestStreamSourceRefresh`), which for the robot is
 * the wake.
 */
export function cameraStreamCatalog(
  session: CameraStreamSession | null,
): readonly CamStreamDescriptor[] {
  return [
    {
      camStreamId: CAMERA_STREAM_ID,
      kind: 'pull-rfc4571',
      url: session === null ? LAZY_RFC4571_URL : session.url,
      codec: 'h264',
      label: 'Robot camera',
      deviceFeatures: ['battery-operated'],
      autoEligible: true,
      // The robot's ONE stream is a 720p relay: the `low` of this camera in
      // every respect, and the profile the recorder files under
      // `recordingsLow` and scrub reads. Without the hint the broker parks a
      // single stream on `mid` — the slot no storage class is written for on
      // its own — and the footage can neither be scrubbed nor kept with the
      // low-class retention.
      profileHint: 'low',
      metadata: { sdp: session === null ? syntheticRobotSdp() : session.sdp },
    },
  ]
}

/** The `internal` slice of `local-network.getAddresses()` the relay reads. */
export interface InternalAddressAnswer {
  readonly roles: { readonly internal: { readonly resolved: string | null } }
}

/**
 * The hub's internal address (D734) — the one a broker on another node dials
 * the relay at. Never the public endpoint: the relay is LAN traffic.
 */
export function relayHubAddress(book: InternalAddressAnswer): string | null {
  return book.roles.internal.resolved
}

/**
 * The host the broker is told to dial. The provider and the ingest owner
 * share the hub today, but a broker on another node reaches the hub only
 * through the hub's internal address — `local-network.getAddresses()
 * .roles.internal` (the address flagged "Internal" on the Network page, else
 * the detected LAN address).
 * Loopback when that names nothing: then the only broker that can dial at
 * all is this node's own.
 */
export function advertisedRfcHost(clusterBaseUrl: string | null): string {
  return hubAddressHostname(clusterBaseUrl) ?? '127.0.0.1'
}

export function rfcUrl(host: string, port: number): string {
  return `tcp://${host}:${String(port)}`
}
