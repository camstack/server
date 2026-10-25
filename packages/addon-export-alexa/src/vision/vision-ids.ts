/**
 * The identifiers an `ObjectDetection` event and a `DataReport` item carry
 * (R4, D779).
 *
 *  - `objectIdentifier`: "a UUID identifying a specific physical object" — one
 *    per pipeline track. Amazon types it "Version 4 UUID String", so it is
 *    v4-shaped like the event id: a hash of `object|<deviceId>:<trackId>` under
 *    this hub's namespace, stable for the track's life and across restarts.
 *    (The first build sent a UUIDv5 here — D779 amendment.)
 *  - `eventIdentifier`: Amazon requires a version-4 UUID per event in the
 *    history. This skill posts ONE event per track, so the event id is derived
 *    from the track too — a v4-shaped UUID whose 122 "random" bits are a
 *    SHA-256 of the hub namespace and the track. Deriving it (instead of
 *    `randomUUID()`) is what lets the history (`ReportData` by time range)
 *    hand Alexa the SAME id the live event carried, without a lookup table
 *    that would have to outlive the tracks it describes.
 *
 * The hub namespace is a random UUID generated once and stored hidden in the
 * addon settings, so two hubs never mint the same ids for the same track id.
 */
import { createHash } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidBytes(uuid: string): Buffer {
  if (!UUID.test(uuid)) throw new Error(`not a UUID: ${uuid}`)
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function stamp(bytes: Buffer, version: number): Buffer {
  const out = Buffer.from(bytes.subarray(0, 16))
  out[6] = ((out[6] ?? 0) & 0x0f) | (version << 4)
  out[8] = ((out[8] ?? 0) & 0x3f) | 0x80
  return out
}

/** RFC 4122 UUIDv5 (SHA-1, name-based). */
export function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()
  return formatUuid(stamp(hash, 5))
}

/** A version-4-formatted UUID whose bits are a hash — see the file header. */
export function hashedUuidV4(namespace: string, name: string): string {
  const hash = createHash('sha256').update(uuidBytes(namespace)).update(name, 'utf8').digest()
  return formatUuid(stamp(hash, 4))
}

function trackName(deviceId: number, trackId: string): string {
  return `${deviceId}:${trackId}`
}

export function objectIdentifierFor(namespace: string, deviceId: number, trackId: string): string {
  return hashedUuidV4(namespace, `object|${trackName(deviceId, trackId)}`)
}

/** One event per track AND class: a track re-classified person → package is a
 *  second event about the same object. */
export function eventIdentifierFor(
  namespace: string,
  deviceId: number,
  trackId: string,
  imageNetClass: string,
): string {
  return hashedUuidV4(namespace, `event|${trackName(deviceId, trackId)}|${imageNetClass}`)
}

export function isUuid(value: string): boolean {
  return UUID.test(value)
}
