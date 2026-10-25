/**
 * Cap → event-kind mapping for the SENSOR / CONTROL cap families — the table
 * `pipeline-analytics.listEventKinds` uses to turn a linked device's bound
 * caps into per-camera event-kind descriptors.
 *
 * The descriptor DATA (color / iconId / labelKey / parentKind / category)
 * is NOT duplicated here — every entry is derived from the single
 * `EVENT_TAXONOMY` dictionary (`catalogs/event-taxonomy.ts`). This file owns
 * ONLY the cap-name → taxonomy-kind mapping. Adding a new eventful sensor /
 * control cap means adding one line here (and a taxonomy entry); the anti-
 * drift guard `scripts/check-event-kind-coverage.ts` fails the build if an
 * eventful cap is missing.
 */
import { EVENT_TAXONOMY, type EventTaxonomyEntry } from '../catalogs/event-taxonomy.js'
import type { EventKindDescriptor, EventKindIcon } from './pipeline-analytics.cap.js'

/**
 * The static half of an `EventKindDescriptor` (no per-device `source`).
 * Extends the taxonomy entry with the legacy closed-enum `icon` glyph kept
 * as a fallback for clients that predate `iconId`.
 */
export interface SensorEventKindDescriptor extends EventTaxonomyEntry {
  /** Legacy closed-vocab glyph — fallback for `iconId`. */
  readonly icon: EventKindIcon
}

/** Map a taxonomy `iconId` onto the legacy closed `EventKindIcon` enum. */
const LEGACY_ICON: Readonly<Record<string, EventKindIcon>> = {
  // Macro iconIds map 1:1 onto the legacy enum.
  motion: 'motion',
  audio: 'audio',
  person: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  package: 'package',
  // Sensor / control iconIds → closest legacy glyph.
  door: 'door',
  pir: 'pir',
  smoke: 'smoke',
  water: 'water',
  button: 'button',
  generic: 'generic',
  gas: 'smoke',
  vibration: 'generic',
  tamper: 'generic',
  presence: 'person',
  lock: 'generic',
  siren: 'generic',
  switch: 'generic',
  doorbell: 'button',
}

function legacyIcon(iconId: string): EventKindIcon {
  return LEGACY_ICON[iconId] ?? 'generic'
}

/**
 * Cap name → taxonomy kind id. Covers EVERY eventful sensor / control cap.
 * The anti-drift guard cross-checks this against the eventful caps declared
 * in `packages/types/src/capabilities/*.cap.ts`.
 */
const CAP_TO_KIND: Readonly<Record<string, string>> = {
  // Passive sensors → category 'sensor'.
  contact: 'contact',
  motion: 'motion-sensor',
  smoke: 'smoke',
  flood: 'flood',
  gas: 'gas',
  'carbon-monoxide': 'carbon-monoxide',
  vibration: 'vibration',
  tamper: 'tamper',
  presence: 'presence',
  'enum-sensor': 'enum-sensor',
  'event-emitter': 'device-event',
  // Actuators / controls → category 'control'.
  'lock-control': 'lock',
  cover: 'cover',
  switch: 'switch',
  button: 'button',
  doorbell: 'doorbell',
}

function buildDescriptor(capName: string, kind: string): SensorEventKindDescriptor {
  const t = EVENT_TAXONOMY[kind]
  if (t === undefined) {
    throw new Error(`EVENT_KIND_BY_CAP: cap '${capName}' maps to unknown taxonomy kind '${kind}'`)
  }
  return { ...t, icon: legacyIcon(t.iconId) }
}

/**
 * Sensor / control cap name → static event-kind descriptor. A linked device
 * contributes one entry per bound cap present in this map.
 */
export const EVENT_KIND_BY_CAP: Readonly<Record<string, SensorEventKindDescriptor>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CAP_TO_KIND).map(([capName, kind]) => [capName, buildDescriptor(capName, kind)]),
  ),
)

/** The cap names covered by the taxonomy (for the anti-drift guard). */
export const EVENTFUL_CAP_NAMES: readonly string[] = Object.keys(CAP_TO_KIND)

/**
 * Build a full `EventKindDescriptor` for a taxonomy `kind`, stamping the
 * per-device `source`. Returns null when `kind` is not in the taxonomy.
 * This is THE bridge from the serializable taxonomy dictionary to the cap
 * wire shape — every event-kind descriptor the server emits goes through it,
 * so color/iconId/labelKey are never re-declared at a call site.
 */
export function buildEventKindDescriptor(
  kind: string,
  source: { readonly capName: string; readonly deviceId: number },
): EventKindDescriptor | null {
  const t = EVENT_TAXONOMY[kind]
  if (t === undefined) return null
  return {
    kind: t.kind,
    labelKey: t.labelKey,
    label: t.label,
    color: t.color,
    iconId: t.iconId,
    icon: legacyIcon(t.iconId),
    category: t.category,
    parentKind: t.parentKind,
    level: t.level,
    source: { capName: source.capName, deviceId: source.deviceId },
  }
}
