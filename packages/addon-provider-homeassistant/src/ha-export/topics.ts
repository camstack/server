/**
 * The topic grammar. Every topic in the export is built HERE.
 *
 * The previous HA exporter learned this the hard way: deriving one topic
 * by string-editing another (`stateTopic.replace(/\/[^/]+$/, '/availability')`)
 * broke the moment two components had different layouts. There is one
 * builder per topic kind and no exceptions.
 *
 * A topic is a wire format. `state` and `command` are matched verbatim by
 * the component, so a change here silently detaches every entity from its
 * value.
 */

/** Root of every topic. Namespaces the export inside HA's event bus. */
export const TOPIC_ROOT = 'camstack'

/** Prefix that turns a device's numeric id into its HA `device_id`. */
export const DEVICE_KEY_PREFIX = 'camstack-'

/**
 * The HA `device_id` for a camstack device. **THIS FILE OWNS THE RULE.**
 *
 * Derived from the NUMERIC device id, which is what the other three
 * ecosystem exports already key on: Alexa's `endpointId` is
 * `String(deviceId)`, HomeKit's accessory uuid is
 * `camstack:camera:<deviceId>` and Google's `id` is `String(deviceId)`.
 * Home Assistant was the only export keying on `stableId`, and `stableId`
 * is provider-internal — `(addonId, stableId)` is the addon-facing
 * identity in `device-meta-actions.ts`, not an identity meant to leave the
 * hub. This was the one place it leaked.
 *
 * The rationale that used to sit here — "numeric ids are reallocated by a
 * re-sync, so a captured number would address whichever camera inherited
 * it" — was FALSE and is deleted rather than softened.
 * `allocateNextDeviceId` (`@camstack/system`,
 * `device-meta-store.ts`) is a monotonic counter: it reads
 * `nextDeviceId ?? 1` and writes `current + 1`. A freed id is never
 * re-issued. The worst case after a re-adoption is an ORPHANED entity —
 * never a mis-addressed one — which is exactly what a changed `stableId`
 * produced too.
 *
 * The component MIRRORS this rule in `CamStackDevice.device_key`
 * (`custom_components/camstack/coordinator.py`), because the camera entity
 * is built from the export membership rather than pushed. Everywhere the
 * component receives a key it takes it verbatim (`dev.ids[0]` /
 * `entity_change.device_id`) instead of composing one. The two
 * compositions are pinned to the same literal by
 * `__tests__/entity-catalog.spec.ts` ("the cross-side identity contract")
 * and `tests/test_entities.py::test_the_device_key_matches_the_hub_rule`.
 */
export function deviceKeyFor(deviceId: number): string {
  return `${DEVICE_KEY_PREFIX}${deviceId}`
}

/**
 * The HA `device_id` for a SYNTHETIC device.
 *
 * Synthetic devices are built by the exporter and have no camstack device
 * behind them — `HaDevicePlan.deviceId` is `null` for one — so there is no
 * numeric id to key on and their own `synthetic-…` id IS their identity.
 * A separate builder rather than an overload: a caller that has a real
 * device must not be able to reach the string-keyed path by accident,
 * which is how a second HA device appears beside the first.
 */
export function syntheticDeviceKeyFor(syntheticId: string): string {
  return `${DEVICE_KEY_PREFIX}${syntheticId}`
}

export function stateTopic(deviceKey: string, entity: string): string {
  return `${TOPIC_ROOT}/${deviceKey}/${entity}`
}

export function commandTopic(deviceKey: string, entity: string): string {
  return `${TOPIC_ROOT}/${deviceKey}/${entity}/set`
}

/**
 * Parse a command topic back into its parts.
 *
 * Returns `null` for anything that is not a command topic — a malformed
 * topic is not a command with an empty target, and treating it as one is
 * how a misrouted POST becomes an action on the wrong device.
 */
export interface ParsedCommandTopic {
  readonly deviceKey: string
  readonly entity: string
}

export function parseCommandTopic(topic: string): ParsedCommandTopic | null {
  const parts = topic.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== TOPIC_ROOT) return null
  if (parts[3] !== 'set') return null
  const deviceKey = parts[1]
  const entity = parts[2]
  if (deviceKey === undefined || entity === undefined) return null
  if (deviceKey.length === 0 || entity.length === 0) return null
  return { deviceKey, entity }
}

/** `Person last image` ← `person_last_image`. Display only, never an id. */
export function humanise(entity: string): string {
  const words = entity.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * `person_detected` → `person-detected`.
 *
 * Component keys are kebab; entity/topic segments are snake. They are two
 * different namespaces and conflating them produces entities that build
 * but never receive a value.
 */
export function toComponentKey(platform: string, entity: string): string {
  const kebab = entity.replace(/_/g, '-').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${platform}-${kebab}`
}

/**
 * The entity id of a DERIVED capability entity — the one expression.
 *
 * The derived half of the catalog names its entity after the capability
 * it comes from, and the projector has to publish to that exact name.
 * They used to be two expressions in two files, and they disagreed:
 * the catalog built `camstack/<key>/motion` while the projector
 * published `motion_detected`, `triggered` and a set of doorbell topics
 * of its own. **Only `battery` and `online` lined up**, so a non-camera
 * motion, contact, smoke, leak or doorbell device got entities that
 * could never receive a value — the same failure the 2026-08-05 audit
 * measured on the old exporter (177 of 293 devices), reproduced on a
 * narrower set.
 *
 * Both sides now come from here, and
 * `__tests__/state-projector.spec.ts` walks every `CAP_ENTITY_MAP` entry
 * asserting the catalog's `state_topic` is the topic the projector
 * publishes to. That test is the guard: it fails the moment either side
 * drifts.
 */
export function derivedEntityId(capName: string): string {
  return toSlug(capName)
}

/**
 * The entity id of a SECONDARY entity of the same capability.
 *
 * The nine allowed platforms cannot express a cover, a thermostat or a
 * media player as one entity, so a capability may produce several: a
 * `cover` is its state AND its position, a `climate-control` is its mode
 * AND the temperature it measures. They are still ONE capability and one
 * slice, so their ids are built from the same expression as the primary
 * — `<cap>_<suffix>` — rather than invented per row. Two expressions in
 * two files is exactly what left a non-camera contact sensor with an
 * entity that could never receive a value.
 */
export function derivedExtraEntityId(capName: string, suffix: string): string {
  return `${toSlug(capName)}_${toSlug(suffix)}`
}

/** Lower-case, underscore-joined, diacritic-free. Ids only, never labels. */
export function toSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}
