/**
 * Wire types for the native Home Assistant export.
 *
 * Contract: `docs/superpowers/specs/2026-08-04-ha-native-export-design.md`.
 *
 * Everything in this file is a WIRE FORMAT. The custom component
 * (`camstack/homeassistant-component`) builds its entity registry from
 * `unique_id` and its component keys; changing either orphans every
 * entity in an operator's installation, taking its recorder history and
 * dashboard placement with it. Treat a rename here as a migration, not
 * an edit.
 *
 * Every identity in that format is keyed on the device's NUMERIC id —
 * `dev.ids[0]` / `entity_change.device_id` is `camstack-<deviceId>` and
 * `unique_id` is `<deviceId>_<entity>`, the same identity Alexa, HomeKit
 * and Google already export. `stableId` is provider-internal and appears
 * nowhere on this wire. The rule is built in one place, `topics.ts`
 * ({@link deviceKeyFor}); a synthetic device has no numeric id and is the
 * documented exception ({@link syntheticDeviceKeyFor}).
 */

import type { ReadingQuantity, WebrtcStreamTarget } from '@camstack/types'
import type { ItemEntity } from './item-entities.js'

/**
 * Home Assistant platforms the export can name.
 *
 * Naming one is not the same as the component BUILDING it: the component
 * announces the platforms it builds at `/api/camstack/version`, and
 * `component-support.ts` negotiates. A platform emitted into an older
 * component is logged there and produces no entity, which is why every
 * native platform below has a degraded fallback — see
 * `native-platforms.ts`.
 */
export type HaPlatform =
  | 'binary_sensor'
  | 'sensor'
  | 'image'
  | 'switch'
  | 'button'
  | 'select'
  | 'camera'
  | 'alarm_control_panel'
  | 'number'
  // Component >= 0.5.0: a notify entity (a message sent to it leaves through a
  // notification target). Negotiated; never assumed.
  | 'notify'
  // ── Native device platforms. Component >= 0.4.0 (Tier B) ───────────────
  | 'cover'
  | 'climate'
  | 'lock'
  | 'fan'
  | 'vacuum'
  | 'valve'
  | 'humidifier'
  | 'water_heater'
  | 'media_player'

/**
 * One Home Assistant component, in HA's MQTT-discovery shape.
 *
 * LONG-FORM keys only (`state_topic`, not `stat_t`). The reference
 * component accepts both, but its own documentation claims short form
 * while its plugin emits long — the fallbacks are dead code there and
 * we are not going to reproduce the ambiguity.
 */
export interface HaComponent {
  readonly platform: HaPlatform
  readonly unique_id: string
  readonly name: string
  readonly state_topic?: string
  readonly command_topic?: string
  readonly device_class?: string
  readonly unit_of_measurement?: string
  readonly state_class?: string
  readonly icon?: string
  /**
   * Static entity attributes, announced with the structure — what an entity
   * IS (a consumable's form, kind and label), never a value that changes on
   * the push plane. A component that predates them ignores the key; one
   * that reads them exposes them as `extra_state_attributes`.
   */
  readonly attributes?: Readonly<Record<string, string>>
  readonly entity_category?: 'config' | 'diagnostic'
  /**
   * Absent means `true` to the component. Set explicitly to `false` for
   * everything an operator would not automate on — the pressure valve
   * that makes ~73 entities per camera survivable.
   */
  readonly enabled_by_default?: boolean
  readonly options?: readonly string[]
  /**
   * `number` bounds. Home Assistant's MQTT number defaults to
   * **min 1 / max 100 / step 1** when a discovery payload omits them, and
   * those defaults are wrong for almost everything camstack writes: a cover
   * cannot be closed (`position: 0` is below the default minimum), a
   * thermostat cannot be set below 1 °C or to 20.5, and a colour temperature
   * in mireds runs to 1000. They are emitted for every `number` this export
   * builds rather than per entity, because a silently clamped control is a
   * control that lies about its range.
   *
   * The bounds are per CAPABILITY, not per device. A water heater's own
   * `minTemp`/`maxTemp` and a humidifier's `minHumidity`/`maxHumidity` live on
   * the slice, and narrowing to them needs a reconcile-time entity mint keyed
   * on the device — a design, not a descriptor field. The static range is
   * deliberately the WIDER one: a range too wide costs an operator a wrong
   * value the device rejects, a range too narrow costs them a value they can
   * never send.
   */
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly payload_on?: string
  readonly payload_off?: string
  readonly payload_press?: string

  // ── Native platforms (component >= 0.4.0) ─────────────────────────────
  /**
   * The sub-controls a native entity owns — a cover's position and tilt, a
   * thermostat's setpoints and its fan mode, a media player's volume.
   *
   * A deliberate DIVERGENCE from HA's MQTT discovery, which spells these as
   * ~60 flat sibling keys (`set_position_topic`, `tilt_command_topic`,
   * `temperature_low_state_topic`, …). One map is one reader on each side
   * instead of sixty optional fields here and sixty lookups in the
   * component; the control NAMES are the vocabulary, and
   * `native-platforms.ts` is the only place they are minted.
   *
   * Every topic in here is one the DEGRADED entity already used, so a
   * native component changes structure and never the value plane.
   */
  readonly controls?: Readonly<Record<string, HaNativeControl>>
  /** `climate` / `water_heater`: the unit every temperature topic carries. */
  readonly temperature_unit?: string
  /** `alarm_control_panel`: the panel demands a PIN, per `requiresCode`. */
  readonly code_arm_required?: boolean

  /**
   * `camera`: WHICH stream of the camera this entity shows.
   *
   * The one component field that is not a topic, and it is deliberate. A
   * camera entity carries no value on the push plane at all: the component
   * fetches its still from `snapshot.getSnapshot` and negotiates live video
   * by handing this target straight to `webrtcSession.handleOffer`. Passing
   * a URL instead — which this export did until 2026-08-14 — meant an RTSP
   * address minted on the hub, sanitised against a password and against a
   * loopback host, announced on a `state_topic`, and consumed by nothing:
   * the component has never built a camera entity from `cmps`. The target
   * is the hub's own vocabulary (`webrtcSession.listStreams` returns it
   * verbatim), so no address, credential or codec assumption crosses.
   */
  readonly stream_target?: WebrtcStreamTarget
}

/**
 * One sub-control of a native entity.
 *
 * `state_topic` absent means write-only (a verb folded into the platform);
 * `command_topic` absent means read-only, which is what a control whose
 * capability has no route looks like — the reading is still worth having,
 * and Home Assistant simply does not advertise the feature.
 */
export interface HaNativeControl {
  readonly state_topic?: string
  readonly command_topic?: string
  /** The values this control accepts, as the DEVICE reports them. */
  readonly options?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

/** component key → component. The key is part of the entity's identity. */
export type HaCmps = Readonly<Record<string, HaComponent>>

/** HA device-registry block. `mf`/`mdl` are the keys the component reads. */
export interface HaDeviceBlock {
  readonly ids: readonly string[]
  readonly name: string
  readonly mf: string
  readonly mdl: string
}

/** A fully planned Home Assistant device: identity + its component set. */
export interface HaDevicePlan {
  /** The `device_id` on the wire — also `dev.ids[0]`. Never the numeric id. */
  readonly deviceKey: string
  /** CamStack's numeric device id, or `null` for a synthetic device. */
  readonly deviceId: number | null
  readonly dev: HaDeviceBlock
  readonly cmps: HaCmps
}

// ── Push messages ───────────────────────────────────────────────────────

export interface StateUpdateMessage {
  readonly type: 'state_update'
  readonly topic: string
  /** ALWAYS a string. The component lowercases binary values verbatim. */
  readonly value: string
}

/**
 * One entity's value, before it becomes a {@link StateUpdateMessage}.
 *
 * Here rather than in `state-projector.ts` because the camera-stream
 * plane produces these too, and a second identical interface in a second
 * file is how two halves of one export come to disagree about a shape.
 */
export interface StateValue {
  readonly topic: string
  readonly value: string
}

/**
 * Structure change.
 *
 * Carries the COMPLETE `cmps` set for the device, never a delta, and is
 * re-sent in full on reconnect. D8: an event is telemetry and may be
 * dropped, so a lost `entity_change` must not be able to leave HA with a
 * half-built device — the next full snapshot repairs it. The component
 * already diffs, so completeness costs nothing.
 */
export interface EntityChangeMessage {
  readonly type: 'entity_change'
  readonly device_id: string
  readonly cmps: HaCmps
  readonly dev: HaDeviceBlock
  /**
   * Present (and `true`) only on an announce sent by a FULL resync pass: the
   * hub could not vouch for what Home Assistant holds (first pass after a
   * start, a link that went away, a push that failed), so this announce is
   * the authoritative whole and the receiver may rebuild anything it lost.
   * Absent on an ordinary pass. Optional, so an older component ignores it.
   */
  readonly full?: true
}

/**
 * Liveness. The component marks every entity unavailable when these
 * stop, so this is the one source of truth for "camstack is alive" —
 * there is deliberately no second availability signal to disagree with.
 */
export interface HeartbeatMessage {
  readonly type: 'heartbeat'
  readonly ts: number
}

export interface BatchMessage {
  readonly type: 'batch'
  readonly items: readonly PushMessage[]
}

export type PushMessage = StateUpdateMessage | EntityChangeMessage | HeartbeatMessage | BatchMessage

// ── Catalog inputs ──────────────────────────────────────────────────────

/** A zone as the catalog needs it: a stable id and a renameable label. */
export interface CatalogZone {
  readonly id: string
  readonly name: string
}

/**
 * One per-camera function switch, as `deriveCameraFunctions` reports it
 * (`camera-functions.ts`) — the pure derivation over the AUTHORITIES that own
 * each function. The export NEVER writes an authority directly — it renders
 * these and commands back through `resolveCameraFunctionWrite` +
 * `applyCameraFunctionWrite`, so the HA toggle cannot become the second knob
 * that disagrees with the first (D62).
 */
export interface CatalogFunctionSwitch {
  readonly id: string
  readonly label: string
  readonly available: boolean
}

/**
 * One stream of a camera, as `webrtcSession.listStreams` reports it.
 *
 * A structural subset of `WebrtcStreamChoice`: the catalog needs the id
 * (which becomes the entity), the label, the target the component will
 * hand back to `handleOffer`, and the height it puts in the label. The
 * codec, the broker status and the live FPS are diagnostics for a picker
 * UI, not part of an entity's identity.
 *
 * `listStreams` rather than `cameraStreams.getProfileRtspEntries`: the
 * latter answers "what RTSP address serves this profile", a question no
 * consumer of this export asks, and answering it forced two url gates
 * (credentials, loopback) onto a plane that now carries no url at all.
 * `listStreams` also returns the raw `cam-stream` sources — the camera's
 * own main/sub substreams — which the profile view cannot express and
 * which the operator's reference integration has always exposed.
 */
export interface CatalogStreamChoice {
  /** `adaptive` | `profile:high` | `stream:native:main`. */
  readonly id: string
  /** The hub's own label for the stream — `Adaptive`, `High`, `Main`. */
  readonly label: string
  readonly target: WebrtcStreamTarget
  /** Vertical resolution, for the label. Absent when the hub reports none. */
  readonly height?: number
}

/** Everything the pure catalog needs about one device. No I/O. */
export interface CatalogDevice {
  /**
   * The numeric device id, and the ONLY identity this export carries.
   * `stableId` is deliberately absent: it is the addon-facing identity
   * and a field here would read as a second one.
   */
  readonly id: number
  readonly name: string
  readonly type: string
  readonly manufacturer?: string
  readonly model?: string
  readonly features: readonly string[]
  readonly boundCaps: readonly string[]
  readonly zones: readonly CatalogZone[]
  readonly switches: readonly CatalogFunctionSwitch[]
  /** Preset names probed from the camera. Empty when it has none. */
  readonly ptzPresets?: readonly string[]
  /** Slices present on the device, used to decide battery/charger entities. */
  readonly slices: readonly string[]
  /**
   * Quantity of a polymorphic reading (`numeric-sensor`, numeric `control`),
   * copied from `SourceInfo.quantity`. The export advertises that quantity's
   * base unit. Absent when the device has not chosen one.
   */
  readonly readingQuantity?: ReadingQuantity
  /**
   * capability → its status slice, as the reconcile last read it.
   *
   * STRUCTURE reading a value looks wrong and is not: a native `climate`
   * carries the modes the device accepts, and `availableModes` is on the
   * slice and nowhere else. A static list would offer an operator modes
   * their thermostat rejects while hiding the ones it takes — the same
   * reason the degraded half refuses to make those a `select`.
   *
   * It is announced, not published: an option list that changes arrives on
   * the next reconcile's `entity_change`, exactly as a renamed zone or a
   * new PTZ preset already does.
   */
  readonly capSlices?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /**
   * capability → the per-item entities its slice mints (`item-entities.ts`),
   * AFTER the reconcile's `ReadMirror`: an item that left the slice is still
   * here until a second read agrees it is gone. Absent means none.
   */
  readonly itemEntities?: Readonly<Record<string, readonly ItemEntity[]>>
  /**
   * Every stream of the camera, for the live `camera` entities. Absent on
   * a non-camera and on a camera the reconcile could not read them for —
   * absent means NO camera entity, never an entity pointed at nothing.
   */
  readonly streams?: readonly CatalogStreamChoice[]
}
