/**
 * Per-device event rings — the history a single camera's Events panel reads.
 *
 * WHY THIS EXISTS. The retaining bus keeps ONE global ring
 * (`SharedBusState.recent`, {@link MAX_RECENT_EVENTS}). That ring is a COUNT,
 * not a window, and it is shared by the whole fleet, so a quiet camera is
 * evicted by its 31 noisy siblings long before the operator opens its panel.
 * Measured on the live hub: 16 events/s fleet-wide, 817 B average per event —
 * a 10 000-slot global ring covers 10.4 minutes of FLEET traffic and can hold
 * nothing at all for a camera that emitted an hour ago.
 *
 * WHAT THIS IS NOT. Still telemetry (D8/D11): in-memory, hub-main only, lost on
 * restart, no table, no persistence. Nothing durable may be derived from it.
 *
 * SHAPE. One ring per device id, each holding two disjoint parts:
 *
 *  - `history` — events of categories nobody declared a mirror. Bounded by
 *    {@link MAX_DEVICE_RING_EVENTS}. After coalescing the fleet emits ~1.1
 *    events/s (~3 000/day/camera), so 2 000 slots ≈ 16 h per camera — the day
 *    the operator asked for.
 *  - `mirrors` — the LATEST event per declared-mirror category
 *    ({@link MIRROR_CATEGORIES}). A mirror has no history, only a current
 *    value: the penultimate value of `device.state-changed` means nothing, and
 *    keeping it is what made 89 % of the fleet's traffic evict everything else.
 *    Bounded by the size of the declared set, i.e. a handful of slots.
 *
 * A category NOBODY classified is NOT coalesced. Keeping history is the safe
 * default; silently collapsing an unclassified category would lose data nobody
 * decided to lose.
 *
 * NO deviceId ⇒ NOT HERE. An event that carries no device attribution is a
 * first-class case: it is retained in the GLOBAL ring only and no device is
 * invented for it. (`broker.message`, the Home Assistant state mirror, used to be
 * the example; it is on `RING_BUFFER_DENY_PATTERNS` now and is retained nowhere.) If attribution is
 * added later, the event starts landing in a device ring with no change here.
 *
 * MEMORY. The retained `data` payload is capped
 * ({@link MAX_RETAINED_DATA_BYTES}), not the event count — hub-main's heap is
 * not a place to spend 52 MB on telemetry. A capped payload is REPLACED by a
 * marked {@link TruncatedEventData} so a consumer can tell a short payload from
 * a cut one.
 */
import type { SystemEvent } from '@camstack/types'

// ---------------------------------------------------------------------------
// Declared mirror categories
// ---------------------------------------------------------------------------

/** One declared mirror category and the reason it may be collapsed. */
export interface MirrorCategoryDeclaration {
  /** Exact event category. Not a glob — a mirror is declared one by one. */
  readonly category: string
  /** Why the penultimate value of this category carries no information. */
  readonly reason: string
}

/**
 * The categories whose per-device history is ONE slot: the latest value.
 *
 * Declared here, with a reason each, on purpose — the alternative is `if`s
 * scattered over the delivery path, and nobody can then answer "what does this
 * system collapse, and who decided?".
 *
 * Adding an entry DELETES history for that category. Add one only when the
 * category is genuinely a state mirror (a snapshot of a current value), never
 * because it is merely frequent — a frequent EDGE (a motion start, a crash)
 * belongs in `RING_BUFFER_DENY_PATTERNS` or nowhere, not here.
 */
export const MIRROR_CATEGORIES: readonly MirrorCategoryDeclaration[] = [
  {
    category: 'device.state-changed',
    reason:
      'Device runtime-state mirror, 69.1 % of fleet traffic. Each event is a snapshot of the ' +
      'slice AFTER the change; the superseded snapshot describes a state the device is no longer ' +
      'in, and every consumer (SystemMirror, DeviceStateHandle) reads the latest one only.',
  },
  {
    category: 'camera-streams.onCamStreamsChanged',
    reason:
      'Full stream-list snapshot per camera, 20.1 % of fleet traffic. The payload is the complete ' +
      'current list, not a delta, so an older list is strictly less true than the newer one.',
  },
  {
    category: 'system.ready-state',
    reason:
      'Readiness is a LEVEL, not an edge: the event reports whether a capability is ready right ' +
      'now. Declared for the case where it carries a deviceId; when it does not it stays in the ' +
      'global ring like any other unattributed event.',
  },
]

const MIRROR_REASON_BY_CATEGORY: ReadonlyMap<string, string> = new Map(
  MIRROR_CATEGORIES.map((m) => [m.category, m.reason]),
)

/** The declared reason this category is a mirror, or `undefined` if unclassified. */
export function mirrorReason(category: string): string | undefined {
  return MIRROR_REASON_BY_CATEGORY.get(category)
}

/**
 * Is this category declared a mirror? An unclassified category is NOT a mirror
 * — the safe default is to keep its history.
 */
export function isMirrorCategory(category: string): boolean {
  return MIRROR_REASON_BY_CATEGORY.has(category)
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Non-mirror events retained per device. ~1.1 events/s fleet-wide after
 * coalescing ⇒ ~3 000/day/camera ⇒ 2 000 ≈ 16 h.
 */
export const MAX_DEVICE_RING_EVENTS = 2000

/**
 * Cap on the retained `data` payload, in UTF-8 bytes. The COUNT is not what
 * costs memory — 32 devices × 2 000 events × 817 B (measured average) ≈ 52 MB.
 * Capping the payload brings the worst case to ≈ 26 MB and the realistic case
 * far below it, since most events are already under the cap.
 */
export const MAX_RETAINED_DATA_BYTES = 256

/** Bytes of the original JSON kept as a human-readable preview of a cut payload. */
export const TRUNCATED_PREVIEW_BYTES = 160

/**
 * Devices tracked at once. Far above the fleet (32) — it exists so a bad
 * deviceId stream cannot grow the map without bound. Eviction is
 * least-recently-written.
 */
export const MAX_TRACKED_DEVICES = 512

// ---------------------------------------------------------------------------
// Payload capping
// ---------------------------------------------------------------------------

/** Marker key present on — and only on — a payload this module cut. */
export const TRUNCATED_DATA_KEY = '__truncated'

/**
 * What replaces a payload above {@link MAX_RETAINED_DATA_BYTES}. A consumer
 * MUST be able to tell a short payload from a cut one, so the replacement says
 * so explicitly rather than silently shipping a prefix.
 */
export interface TruncatedEventData extends Record<string, unknown> {
  readonly __truncated: true
  /** Size of the original JSON payload, or `null` when it could not be measured. */
  readonly __originalBytes: number | null
  /** First {@link TRUNCATED_PREVIEW_BYTES} characters of the original JSON. */
  readonly __preview: string
}

/** Is this the marked replacement of a cut payload? */
export function isTruncatedEventData(data: Record<string, unknown>): data is TruncatedEventData {
  return data[TRUNCATED_DATA_KEY] === true
}

interface SerializedPayload {
  readonly json: string
  readonly bytes: number
}

function serializePayload(data: Record<string, unknown>): SerializedPayload | null {
  try {
    const json = JSON.stringify(data)
    if (typeof json !== 'string') return null
    return { json, bytes: Buffer.byteLength(json, 'utf8') }
  } catch {
    // Circular / unserializable payload — unmeasurable, so it is cut.
    return null
  }
}

/**
 * The event as it should be RETAINED: unchanged when its payload is within the
 * cap, otherwise a NEW event whose `data` is the marked replacement. The
 * argument is never mutated — the same object is still live on the fan-out path
 * and in the global ring.
 */
export function capEventData(event: SystemEvent): SystemEvent {
  const serialized = serializePayload(event.data)
  if (serialized !== null && serialized.bytes <= MAX_RETAINED_DATA_BYTES) return event
  const truncated: TruncatedEventData = {
    __truncated: true,
    __originalBytes: serialized?.bytes ?? null,
    __preview: serialized === null ? '' : serialized.json.slice(0, TRUNCATED_PREVIEW_BYTES),
  }
  return { ...event, data: truncated }
}

// ---------------------------------------------------------------------------
// Device attribution
// ---------------------------------------------------------------------------

/**
 * The device this event is about, or `undefined` when it is about no device.
 *
 * Same rule as `matchesEventFilter` — `source.deviceId`, or `source.id` when
 * the source IS a device — so a read filtered by `deviceId` and a read served
 * from that device's ring agree on which events belong to it. A non-numeric
 * device source id yields `undefined` rather than `NaN`: an unattributable
 * event must never become a bucket of its own.
 */
export function eventDeviceId(event: SystemEvent): number | undefined {
  const explicit = event.source.deviceId
  if (explicit !== undefined) return Number.isFinite(explicit) ? explicit : undefined
  if (event.source.type !== 'device') return undefined
  const asNumber = Number(event.source.id)
  return Number.isFinite(asNumber) ? asNumber : undefined
}

// ---------------------------------------------------------------------------
// The rings
// ---------------------------------------------------------------------------

interface DeviceRing {
  /** Non-mirror events, oldest first, bounded by {@link MAX_DEVICE_RING_EVENTS}. */
  readonly history: SystemEvent[]
  /** Latest event per declared-mirror category. */
  readonly mirrors: Map<string, SystemEvent>
}

/**
 * Every device's ring. Insertion order is least-recently-written first, which
 * is what {@link MAX_TRACKED_DEVICES} evicts by.
 */
export interface DeviceEventRings {
  readonly byDevice: Map<number, DeviceRing>
}

export function createDeviceEventRings(): DeviceEventRings {
  return { byDevice: new Map<number, DeviceRing>() }
}

function ringFor(rings: DeviceEventRings, deviceId: number): DeviceRing {
  const existing = rings.byDevice.get(deviceId)
  if (existing !== undefined) {
    // Move to the end — insertion order is the LRW order eviction reads.
    rings.byDevice.delete(deviceId)
    rings.byDevice.set(deviceId, existing)
    return existing
  }
  const created: DeviceRing = { history: [], mirrors: new Map<string, SystemEvent>() }
  rings.byDevice.set(deviceId, created)
  while (rings.byDevice.size > MAX_TRACKED_DEVICES) {
    const oldest = rings.byDevice.keys().next()
    if (oldest.done === true) break
    rings.byDevice.delete(oldest.value)
  }
  return created
}

/**
 * Retain `event` in its device's ring, with its payload capped.
 *
 * Returns the device it was filed under, or `undefined` when the event names no
 * device — the caller has already retained it in the global ring and nothing
 * more happens here. No device is fabricated.
 */
export function recordDeviceEvent(rings: DeviceEventRings, event: SystemEvent): number | undefined {
  const deviceId = eventDeviceId(event)
  if (deviceId === undefined) return undefined
  const ring = ringFor(rings, deviceId)
  const retained = capEventData(event)
  if (isMirrorCategory(event.category)) {
    ring.mirrors.set(event.category, retained)
    return deviceId
  }
  ring.history.push(retained)
  if (ring.history.length > MAX_DEVICE_RING_EVENTS) {
    ring.history.splice(0, ring.history.length - MAX_DEVICE_RING_EVENTS)
  }
  return deviceId
}

/**
 * Everything retained for one device, oldest first — history merged with the
 * current value of each mirror, ordered by timestamp so the caller's `-limit`
 * slice means the same thing it means on the global ring.
 *
 * An unknown device yields `[]`: unknown is the truth about a camera that has
 * emitted nothing since this process started.
 */
export function getDeviceRecent(rings: DeviceEventRings, deviceId: number): readonly SystemEvent[] {
  const ring = rings.byDevice.get(deviceId)
  if (ring === undefined) return []
  if (ring.mirrors.size === 0) return ring.history
  const merged = [...ring.history, ...ring.mirrors.values()]
  merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  return merged
}
