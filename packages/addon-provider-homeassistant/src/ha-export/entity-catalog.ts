/**
 * The entity catalog — pure. Device + zones + macros → the `cmps` set.
 *
 * No I/O lives here on purpose: this is the 1:1 mapping the design
 * agreed, and it is where the mapping is tested. A change to this file
 * changes what an operator sees in Home Assistant, so it is tested
 * rather than reasoned about.
 *
 * The split is principled, not expedient (design addendum):
 *
 *   - **Cameras** get a HAND-WRITTEN catalog, because their entities are
 *     projections of pipeline and notification-center output — there is
 *     no capability to derive `last_detection`, `last_label` or a
 *     per-zone count from.
 *   - **Every other kind** is DERIVED from the capability the device
 *     declares. A switch's state IS modelled by a cap; an alarm panel's
 *     state IS `AlarmStateSchema`.
 *
 * Two guards protect the half that a future change would silently break:
 * `MACROS_NOT_EXPORTED` and `CAPS_NOT_EXPORTED` force a written decision
 * for every macro and every mapped capability. Something declared that
 * nothing produces is the failure this repo keeps paying for.
 */

/**
 * The enums a `select` offers come from the CAP, never from a list here: a
 * second copy of `HvacModeSchema` would be one rename away from offering an
 * operator a mode their thermostat has never heard of.
 */
import {
  FanDirectionSchema,
  HvacModeSchema,
  MediaPlayerRepeatSchema,
  type ReadingQuantity,
  type WebrtcStreamTarget,
  baseUnitOf,
} from '@camstack/types'
import { cameraStreamEntities } from './camera-entities.js'
import { type PlatformSupport, UNNEGOTIATED_SUPPORT } from './component-support.js'
import { isItemEntityCap, ITEM_ENTITY_MAP, type ItemEntity } from './item-entities.js'
import { buildNativeComponent, DEGRADED_PLATFORM, nativePlatformFor } from './native-platforms.js'
import {
  commandTopic,
  derivedEntityId,
  derivedExtraEntityId,
  deviceKeyFor,
  humanise,
  stateTopic,
  toComponentKey,
  toSlug,
} from './topics.js'
import type {
  CatalogDevice,
  CatalogZone,
  HaComponent,
  HaDeviceBlock,
  HaDevicePlan,
  HaPlatform,
} from './types.js'

// ── Macros ──────────────────────────────────────────────────────────────

/**
 * The macro classes an operator automates on.
 *
 * Deliberately the macros and NOT the 21 fine classes: those include
 * `kite` and `toothbrush`, and 21 × 4 entities per camera buys nothing.
 */
export const EXPORTED_MACROS: readonly string[] = [
  'motion',
  'audio',
  'person',
  'vehicle',
  'animal',
  'package',
]

/** A macro deliberately NOT exported, with the reason. Never neither. */
export interface UnexportedMacro {
  readonly macro: string
  readonly reason: string
}

export const MACROS_NOT_EXPORTED: readonly UnexportedMacro[] = [
  {
    macro: 'sensor',
    reason:
      'A sensor reading is not a camera analytic — it belongs to the sensor device itself, which the derived half of this catalog exports from its own capability.',
  },
  {
    macro: 'control',
    reason:
      'A control (lock, switch, siren, button, doorbell) is an actuator on its own device, exported as a writable entity there rather than as a detection class on a camera.',
  },
]

/**
 * Macros that carry an IDENTIFICATION: the recognised face for `person`,
 * the plate for `vehicle`, the sub-class for `animal`.
 *
 * `package`, `motion` and `audio` have no label, so the entity is NOT
 * created for them rather than created empty — an entity that can never
 * receive a value reads to an operator as a broken integration.
 */
export const LABELLED_MACROS: readonly string[] = ['person', 'vehicle', 'animal']

/** Per zone the macro set is restricted — matching the reference. */
export const ZONE_MACROS: readonly string[] = ['person', 'vehicle', 'animal']

// ── The pressure valve ──────────────────────────────────────────────────

/**
 * `enabled_by_default: false` is a DECISION, taken per entity, never
 * inferred from its name or its platform.
 *
 * It used to be inferred — a name-and-platform heuristic written for the
 * camera catalog (`endsWith('_detected')`, `platform === 'switch'`) and
 * then applied to every device the catalog builds. On a camera it is
 * right: three zones is ~73 entities and the fleet is ~880, so only what
 * an operator automates on arrives enabled. On a DERIVED device it was
 * simply wrong — every sensor, every number and the alarm panel matched
 * nothing and shipped switched off, so a temperature sensor exported its
 * temperature disabled and the operator found the thing they installed
 * the integration for turned off. Measured on the live hub, the whole
 * derived half is **228 entities across 115 devices — 2 on average, 3 at
 * most**: there is no fan-out there to protect against.
 *
 * So the flag is a required field on every spec. A new entity — or the
 * synthetic devices the design addendum still owes — cannot inherit a
 * camera's pressure valve by accident.
 *
 * **`last_image` is exempt, on every level of the fan-out** (operator,
 * 2026-08-09). The valve exists to stop a fleet's worth of entities
 * arriving switched on, but the picture IS the reason to look at a
 * notification: an operator who wires `person_detected` into an
 * automation wants the frame with it, and having to hunt through HA's
 * disabled-entity list per camera per macro per zone is the opposite of
 * what the export is for. The three `*_last_image` entities — camera,
 * per macro, per zone × macro — therefore ship enabled. They cost one
 * entity each and carry a signed URL, not bytes.
 *
 * **So are the three things the operator asked for on 2026-08-14**, and
 * each has a reason that is a property of the value rather than a taste:
 *
 *   - **`<macro>_last_detection`, and the camera's own.** "When was a
 *     person last seen" is a timestamp, and half of what an operator
 *     builds on a camera is a duration since one — a `for:` in a
 *     template, a "nobody has been at the door since" notification. A
 *     boolean that is `off` right now cannot answer it.
 *   - **`<macro>_last_label`.** This is where the RECOGNISED FACE and the
 *     read PLATE arrive. It was the single highest-value item in the gap
 *     against the reference integration and it shipped switched off, so
 *     the name camstack worked out was in Home Assistant and invisible.
 *   - **`battery` and `charger` on a battery camera.** A battery
 *     percentage is the headline of a battery device, not a diagnostic
 *     detail about one; `sleeping` stays off because it describes the
 *     power state machine rather than the charge.
 *
 * What stays off is what the valve was built for: the per-macro and
 * per-zone `*_objects` COUNTERS (a count of what is on screen right now,
 * which the `_detected` boolean and the camera-wide `objects` total
 * already answer for automation), the per-zone timestamps, and the
 * doorbell's since-restart counter.
 */

// ── PTZ ─────────────────────────────────────────────────────────────────

export const PTZ_BUTTONS: readonly string[] = [
  'ptz_up',
  'ptz_down',
  'ptz_left',
  'ptz_right',
  'ptz_zoom_in',
  'ptz_zoom_out',
]

// ── Builder ─────────────────────────────────────────────────────────────

interface EntitySpec {
  readonly entity: string
  readonly platform: HaPlatform
  readonly label: string
  /**
   * Required, and never inferred. `false` means "registered but off,
   * for the operator to enable" — the camera fan-out, and nothing else.
   */
  readonly enabledByDefault: boolean
  /** Overrides the default `<deviceId>_<entity>` identity. */
  readonly uniqueSuffix?: string
  readonly deviceClass?: string
  readonly unit?: string
  /** `sensor` only — `measurement` makes Home Assistant keep statistics. */
  readonly stateClass?: string
  /** Static attributes. See `HaComponent.attributes`. */
  readonly attributes?: Readonly<Record<string, string>>
  readonly icon?: string
  readonly writable?: boolean
  readonly options?: readonly string[]
  /** `number` only. See {@link HaNumberRange}. */
  readonly range?: HaNumberRange
  readonly entityCategory?: 'config' | 'diagnostic'
  /** `camera` only — the stream the component negotiates. See `HaComponent`. */
  readonly streamTarget?: WebrtcStreamTarget
}

/**
 * Platforms whose entity carries no value on the push plane.
 *
 * A `button` is a command. A `camera` is a stream the component fetches
 * for itself (`snapshot.getSnapshot` + `webrtcSession.handleOffer`) from
 * the target it is given. Announcing a `state_topic` for either would
 * declare a value nothing ever publishes — which is precisely how twelve
 * camera components came to sit in an announce that produced no entity.
 */
const STATELESS_PLATFORMS: ReadonlySet<HaPlatform> = new Set<HaPlatform>(['button', 'camera'])

/**
 * Platforms that can carry a command topic.
 *
 * `writable` on a descriptor means "the route table writes exactly this
 * value" — a fact about the CAPABILITY. Whether Home Assistant can offer
 * a control for it is a fact about the PLATFORM, and the two are not the
 * same: `climate-control.fanMode` is written by `setFanMode` and has no
 * closed vocabulary, so its degraded form is a `sensor` and its native
 * form is the climate entity's fan-mode control. Announcing a command
 * topic on the degraded `sensor` would describe a control Home Assistant
 * cannot render — a leftover that reads as verification.
 */
const COMMANDABLE_PLATFORMS: ReadonlySet<HaPlatform> = new Set<HaPlatform>([
  'switch',
  'button',
  'select',
  'number',
  'alarm_control_panel',
  'cover',
  'climate',
  'lock',
  'fan',
  'vacuum',
  'valve',
  'humidifier',
  'water_heater',
  'media_player',
])

/**
 * The bounds a writable `number` carries.
 *
 * Required on every writable `number`, and asserted by the catalog spec: HA
 * defaults an omitted range to min 1 / max 100 / step 1, so a `number` that
 * forgets it silently refuses `0` (a closed cover), any temperature below 1 °C
 * and every half-degree setpoint. See the note on {@link HaComponent.min}.
 */
export interface HaNumberRange {
  readonly min: number
  readonly max: number
  readonly step: number
}

/** 0..100, the shape every camstack percentage declares in its own schema. */
export const PERCENT_RANGE: HaNumberRange = { min: 0, max: 100, step: 1 }

/**
 * A temperature setpoint, in Celsius.
 *
 * Deliberately WIDER than any one device: a heat-pump water heater runs to
 * 80 °C, a freezer setpoint is negative, and the per-device truth
 * (`climate-control`'s `getOptions`, `water-heater`'s `minTemp`/`maxTemp`)
 * is on the provider and the slice, not in this static table. Half-degree
 * steps because every thermostat this repo has met accepts them and a step of
 * 1 would make 20.5 unreachable.
 */
export const TEMPERATURE_RANGE: HaNumberRange = {
  min: -20,
  max: 90,
  step: 0.5,
}

/** `ColorInputSchema` declares mireds as `int().min(50).max(1000)`. */
export const MIRED_RANGE: HaNumberRange = { min: 50, max: 1000, step: 1 }

function buildComponent(device: CatalogDevice, spec: EntitySpec): HaComponent {
  const deviceKey = deviceKeyFor(device.id)
  const base: HaComponent = {
    platform: spec.platform,
    unique_id: `${device.id}_${spec.uniqueSuffix ?? spec.entity}`,
    name: spec.label,
    ...(STATELESS_PLATFORMS.has(spec.platform)
      ? {}
      : { state_topic: stateTopic(deviceKey, spec.entity) }),
    ...(spec.writable === true && COMMANDABLE_PLATFORMS.has(spec.platform)
      ? { command_topic: commandTopic(deviceKey, spec.entity) }
      : {}),
    ...(spec.deviceClass !== undefined ? { device_class: spec.deviceClass } : {}),
    ...(spec.unit !== undefined ? { unit_of_measurement: spec.unit } : {}),
    ...(spec.stateClass !== undefined ? { state_class: spec.stateClass } : {}),
    ...(spec.attributes !== undefined ? { attributes: spec.attributes } : {}),
    ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.range !== undefined
      ? { min: spec.range.min, max: spec.range.max, step: spec.range.step }
      : {}),
    ...(spec.entityCategory !== undefined ? { entity_category: spec.entityCategory } : {}),
    ...(spec.enabledByDefault ? {} : { enabled_by_default: false }),
    ...(spec.platform === 'binary_sensor' || spec.platform === 'switch'
      ? { payload_on: 'true', payload_off: 'false' }
      : {}),
    ...(spec.platform === 'button' ? { payload_press: 'PRESS' } : {}),
    ...(spec.streamTarget !== undefined ? { stream_target: spec.streamTarget } : {}),
  }
  return base
}

function deviceBlock(device: CatalogDevice): HaDeviceBlock {
  return {
    ids: [deviceKeyFor(device.id)],
    name: device.name,
    mf: device.manufacturer ?? 'CamStack',
    mdl: device.model ?? device.type,
  }
}

/**
 * The fan-out, and the reason the valve exists: zones × zone-macros × 4.
 * The detector is what an operator automates on; the other three are
 * detail they can switch on per entity.
 */
function zoneSpecs(zone: CatalogZone): readonly EntitySpec[] {
  const slug = toSlug(zone.id)
  // The zone TOTAL — not the sum of the three macro counters below. A zone
  // holds classes that map to no exported macro, and "is anyone in the
  // driveway" wants the honest count. Enabled: it is the one an operator
  // automates on, and it is one entity per zone, not per zone × macro.
  const specs: EntitySpec[] = [
    {
      entity: `${slug}_objects`,
      platform: 'sensor',
      label: `${zone.name} objects`,
      uniqueSuffix: `${zone.id}_objects`,
      icon: 'mdi:counter',
      enabledByDefault: true,
    },
  ]
  for (const macro of ZONE_MACROS) {
    const label = `${zone.name} ${macro}`
    specs.push(
      {
        entity: `${slug}_${macro}_detected`,
        platform: 'binary_sensor',
        label: `${label} detected`,
        uniqueSuffix: `${zone.id}_${macro}_detected`,
        deviceClass: 'motion',
        enabledByDefault: true,
      },
      {
        entity: `${slug}_${macro}_last_image`,
        platform: 'image',
        label: `${label} last image`,
        uniqueSuffix: `${zone.id}_${macro}_last_image`,
        enabledByDefault: true,
      },
      {
        entity: `${slug}_${macro}_last_detection`,
        platform: 'sensor',
        label: `${label} last detection`,
        uniqueSuffix: `${zone.id}_${macro}_last_detection`,
        deviceClass: 'timestamp',
        enabledByDefault: false,
      },
      {
        entity: `${slug}_${macro}_objects`,
        platform: 'sensor',
        label: `${label} objects`,
        uniqueSuffix: `${zone.id}_${macro}_objects`,
        icon: 'mdi:counter',
        enabledByDefault: false,
      },
    )
  }
  return specs
}

function cameraSpecs(device: CatalogDevice): readonly EntitySpec[] {
  const specs: EntitySpec[] = [
    {
      entity: 'triggered',
      platform: 'binary_sensor',
      label: 'Triggered',
      deviceClass: 'motion',
      enabledByDefault: true,
    },
    {
      entity: 'online',
      platform: 'binary_sensor',
      label: 'Online',
      deviceClass: 'connectivity',
      entityCategory: 'diagnostic',
      enabledByDefault: true,
    },
    {
      entity: 'last_image',
      platform: 'image',
      label: 'Last image',
      enabledByDefault: true,
    },
    /**
     * The SCENE — everything on camera, in a zone or not, and including
     * confirmed stationary objects (they are still there). The frame-wide
     * scope of the same occupancy snapshot the per-zone counters come from,
     * which was computed and simply never projected.
     */
    {
      entity: 'objects',
      platform: 'sensor',
      label: 'Objects',
      icon: 'mdi:counter',
      enabledByDefault: true,
    },
    /**
     * What was heard, and how loud. Both fed by `pipeline.audio-inference-result`
     * via `projectAudioWindow` — which is also where `audio_detected` (the
     * `audio` row of the macro loop below) gets its value now. Until this was
     * fixed, `audio_detected` was fed only by the track lifecycle, which
     * almost never carries an audio macro, so the entity existed and
     * effectively never moved: a comment right here used to claim this window
     * was already its source, and it was not — an avanzo that described the
     * right design while being false.
     *
     * `audio_last_sound`, NOT `audio_last_label`: `<macro>_last_label` is the
     * TRACK path's naming, reserved for the macros that carry an
     * identification (`LABELLED_MACROS`), and `audio` is deliberately not one
     * of them because the track lifecycle has no label for it. Reusing that
     * name would put two sources on one topic — the classifier here and the
     * track projector there — which is the two-knobs failure this repo keeps
     * paying for. Different source, different entity, different name.
     *
     * dBFS is negative-going (0 = full scale), so silence reads as a large
     * negative number rather than as a missing value. There is no unit
     * declared: HA has no dBFS device class, and mislabelling it `dB` would
     * put a plausible wrong unit on a dashboard.
     */
    {
      entity: 'audio_last_sound',
      platform: 'sensor',
      label: 'Audio last sound',
      icon: 'mdi:ear-hearing',
      enabledByDefault: true,
    },
    {
      entity: 'audio_volume',
      platform: 'sensor',
      label: 'Audio level',
      unit: 'dBFS',
      icon: 'mdi:volume-high',
      enabledByDefault: true,
    },
    /**
     * BOTH levels, because they answer different questions and neither
     * derives from the other in a way an operator should have to do in a
     * template. dBFS is logarithmic and negative-going — the one to threshold
     * on ("louder than -30") — while RMS is the linear amplitude, which is
     * what a graph of relative loudness wants. The analyzer computes both in
     * the same window; publishing one and making the other a `log10` template
     * in Home Assistant is work we already did.
     */
    {
      entity: 'audio_level_rms',
      platform: 'sensor',
      label: 'Audio level (RMS)',
      icon: 'mdi:waveform',
      enabledByDefault: true,
    },
    {
      entity: 'last_detection',
      platform: 'sensor',
      label: 'Last detection',
      deviceClass: 'timestamp',
      icon: 'mdi:clock',
      enabledByDefault: true,
    },
  ]

  if (device.slices.includes('network-link')) {
    specs.push(
      {
        entity: 'link',
        platform: 'sensor',
        label: 'Network link',
        icon: 'mdi:lan-connect',
        entityCategory: 'diagnostic',
        enabledByDefault: true,
      },
      {
        entity: 'signal',
        platform: 'sensor',
        label: 'Signal',
        icon: 'mdi:wifi',
        unit: '%',
        entityCategory: 'diagnostic',
        enabledByDefault: true,
      },
    )
  }

  if (device.slices.includes('battery')) {
    specs.push(
      {
        entity: 'battery',
        platform: 'sensor',
        label: 'Battery',
        deviceClass: 'battery',
        unit: '%',
        entityCategory: 'diagnostic',
        enabledByDefault: true,
      },
      {
        entity: 'charger',
        platform: 'binary_sensor',
        label: 'Charging',
        deviceClass: 'battery_charging',
        entityCategory: 'diagnostic',
        enabledByDefault: true,
      },
      {
        entity: 'sleeping',
        platform: 'binary_sensor',
        label: 'Sleeping',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    )
  }

  /**
   * One HA switch per AVAILABLE camera function, rendered from
   * `deriveCameraFunctions` and commanded back through
   * `resolveCameraFunctionWrite` + `applyCameraFunctionWrite` — each straight
   * onto the authority that already owns it (D62, D113 phase 4).
   *
   * The export never writes an authority itself: a second knob that can
   * disagree with the admin UI is worse than no knob (D62). An
   * unavailable switch produces NO entity — a control defaulted to `on`
   * because a source did not answer is exactly the lie that rule exists
   * to prevent.
   */
  for (const sw of device.switches) {
    if (!sw.available) continue
    specs.push({
      entity: toSlug(sw.id),
      platform: 'switch',
      label: sw.label,
      writable: true,
      enabledByDefault: true,
    })
  }

  if (device.features.includes('rebootable')) {
    specs.push({
      entity: 'reboot',
      platform: 'button',
      label: 'Reboot',
      writable: true,
      enabledByDefault: true,
    })
  }

  if (device.boundCaps.includes('ptz')) {
    for (const entity of PTZ_BUTTONS) {
      specs.push({
        entity,
        platform: 'button',
        label: humanise(entity),
        writable: true,
        enabledByDefault: true,
      })
    }
    specs.push({
      entity: 'ptz_preset',
      platform: 'select',
      label: 'PTZ preset',
      writable: true,
      options: device.ptzPresets ?? [],
      enabledByDefault: true,
    })
  }

  /**
   * The doorbell, when the operator has bound the cap to this camera.
   *
   * A press is not a detection macro — it is not something the pipeline
   * classifies — so it is NOT in `EXPORTED_MACROS`, and `MACROS_NOT_EXPORTED`
   * says a doorbell is an actuator on its own device. Both stay true for the
   * BUTTON accessory. What was missing is the camera case: a camera with the
   * `doorbell` cap bound rings, and the operator automates on the ring the same
   * way they automate on `person_detected`. Reolink's own doorbell is exactly
   * this shape (`ReolinkSimpleEvent.type === 'doorbell'` at the camera level),
   * and so is any camera composed into a doorbell by its customization (D671).
   *
   * Every entity here is fed by the `doorbell` runtime-state slice
   * (`lastPressedAt`, `pressCountSinceStart`) on `device.state-changed` —
   * the same road the `battery` slice already travels.
   *
   * **`doorbell_last_image` is owed, and the frame for it already exists.**
   * A press DOES have a picture: `sensor-marker-projector.ts` materialises a
   * synthetic marker track carrying a `keyFrameSmall` of the camera, taken
   * before the track is persisted, and the notification names that track as
   * its media owner. What is missing is only the road to THIS addon:
   * `persistSyntheticTrack` writes the row directly and emits no
   * `pipeline-analytics.track-lifecycle`, which is the single event the export
   * listens to for frames. So the export never hears about the marker while
   * the notification centre shows its photo — measured 2026-08-09.
   *
   * It is NOT fixed by taking a second snapshot here at push time: the marker
   * projector's own record argues that out (one snapshot, one owner, one
   * persistence point — the producer's), and a second photograph of a doorway
   * seconds after the ring is a different picture from the one in the
   * notification. The fix belongs upstream, at the point that already owns the
   * frame. Named here rather than shipped as an entity nothing feeds.
   */
  if (device.boundCaps.includes('doorbell')) {
    specs.push(
      {
        entity: 'doorbell_pressed',
        platform: 'binary_sensor',
        label: 'Doorbell pressed',
        deviceClass: 'occupancy',
        enabledByDefault: true,
      },
      {
        entity: 'doorbell_last_pressed',
        platform: 'sensor',
        label: 'Doorbell last pressed',
        deviceClass: 'timestamp',
        icon: 'mdi:bell-ring',
        enabledByDefault: true,
      },
      {
        entity: 'doorbell_press_count',
        platform: 'sensor',
        label: 'Doorbell presses since restart',
        icon: 'mdi:counter',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    )
  }

  /**
   * `status` — the entity D62 exists for outside this repo. A camera an
   * operator switched off must never paint the same picture in Home
   * Assistant as one that is genuinely broken (`projectCameraStatus`).
   *
   * No `device_class`: HA's `enum` device class demands `options`, and a
   * `select` here would be a control that cannot be written — the dead
   * control this whole export refuses to ship.
   */
  specs.push({
    entity: 'status',
    platform: 'sensor',
    label: 'Status',
    icon: 'mdi:cctv',
    enabledByDefault: true,
  })

  /** «Is it recording right now?» — `CameraStatus.recording.active`. */
  specs.push({
    entity: 'recording_active',
    platform: 'binary_sensor',
    label: 'Recording',
    deviceClass: 'running',
    enabledByDefault: true,
  })

  for (const macro of EXPORTED_MACROS) {
    const label = humanise(macro)
    specs.push(
      {
        entity: `${macro}_detected`,
        platform: 'binary_sensor',
        label: `${label} detected`,
        deviceClass: 'motion',
        enabledByDefault: true,
      },
      {
        entity: `${macro}_last_image`,
        platform: 'image',
        label: `${label} last image`,
        enabledByDefault: true,
      },
      {
        entity: `${macro}_last_detection`,
        platform: 'sensor',
        label: `${label} last detection`,
        deviceClass: 'timestamp',
        enabledByDefault: true,
      },
      {
        entity: `${macro}_objects`,
        platform: 'sensor',
        label: `${label} objects`,
        icon: 'mdi:counter',
        enabledByDefault: false,
      },
    )
    if (LABELLED_MACROS.includes(macro)) {
      specs.push(
        {
          entity: `${macro}_last_label`,
          platform: 'sensor',
          label: `${label} last label`,
          icon: 'mdi:tag',
          enabledByDefault: true,
        },
        /**
         * The identification OCCURRENCE — moves on every recognition,
         * including a repeat of the SAME name (an unchanged `last_label`
         * is deduped by the push client, and an identical value is not a
         * state change in HA). This is the entity an automation's trigger
         * binds to; the label value arrives in the same batch, ordered
         * first. Enabled for the same reason `<macro>_last_detection` is:
         * it IS the automation hook, not a diagnostic.
         */
        {
          entity: `${macro}_last_label_at`,
          platform: 'sensor',
          label: `${label} last label at`,
          deviceClass: 'timestamp',
          enabledByDefault: true,
        },
      )
    }
  }

  /**
   * The live picture — every stream the hub lists EXCEPT the adaptive one,
   * which the component's own entity already is. See `camera-entities.ts`
   * for why the entity carries a WebRTC target and not a url, and why
   * announcing the adaptive stream would collide on an identity that has
   * shipped.
   */
  for (const stream of cameraStreamEntities(device.streams ?? [])) {
    specs.push({
      entity: stream.entity,
      platform: stream.platform,
      label: stream.label,
      enabledByDefault: stream.enabledByDefault,
      streamTarget: stream.target,
    })
  }

  /**
   * The two capability-derived entities a camera carries.
   *
   * `buildDerivedPlan` is the NON-camera path, so a camera-scoped
   * capability reaches Home Assistant only if the camera catalog builds
   * it — and it is built from the same descriptor and the same entity id
   * as the derived half, so `projectCapSlice` publishes to the topic
   * this component declares without a second expression anywhere.
   */
  for (const cap of CAMERA_DERIVED_CAPS) {
    if (!device.boundCaps.includes(cap)) continue
    specs.push(...capEntitySpecs(cap))
  }

  for (const zone of device.zones) {
    specs.push(...zoneSpecs(zone))
  }

  return specs
}

function assemble(device: CatalogDevice, specs: readonly EntitySpec[]): HaDevicePlan {
  const cmps: Record<string, HaComponent> = {}
  for (const spec of specs) {
    cmps[toComponentKey(spec.platform, spec.entity)] = buildComponent(device, spec)
  }
  return {
    deviceKey: deviceKeyFor(device.id),
    deviceId: device.id,
    dev: deviceBlock(device),
    cmps,
  }
}

/**
 * The per-item entities of every per-item capability the device binds
 * (`item-entities.ts`), as the reconcile settled them. A button is a
 * command, so it is the one writable kind.
 */
function itemEntitySpecs(device: CatalogDevice, capName: string): readonly EntitySpec[] {
  return (device.itemEntities?.[capName] ?? []).map((item: ItemEntity) => ({
    entity: item.entity,
    platform: item.platform,
    label: item.label,
    uniqueSuffix: item.uniqueSuffix,
    enabledByDefault: true,
    ...(item.deviceClass !== undefined ? { deviceClass: item.deviceClass } : {}),
    ...(item.unit !== undefined ? { unit: item.unit } : {}),
    ...(item.stateClass !== undefined ? { stateClass: item.stateClass } : {}),
    ...(item.attributes !== undefined ? { attributes: item.attributes } : {}),
    ...(item.options !== undefined ? { options: item.options } : {}),
    ...(item.icon !== undefined ? { icon: item.icon } : {}),
    ...(item.entityCategory !== undefined ? { entityCategory: item.entityCategory } : {}),
    ...(item.platform === 'button' ? { writable: true } : {}),
  }))
}

/**
 * The hand-written half: a camera's entities come from analytics — plus
 * the per-item capabilities, which bind on every device type (a camera can
 * report consumables like anything else) and mint the same ids either way.
 */
export function buildCameraPlan(device: CatalogDevice): HaDevicePlan {
  const items = device.boundCaps
    .filter((cap) => isItemEntityCap(cap))
    .flatMap((cap) => itemEntitySpecs(device, cap))
  return assemble(device, [...cameraSpecs(device), ...items])
}

// ── The derived half ────────────────────────────────────────────────────

/**
 * capability → the HA entity it produces.
 *
 * A base device's state IS modelled by its capability, so this half is a
 * declarative table rather than a hand-written set. There is deliberately
 * NO default branch: a cap in neither this table nor `CAPS_NOT_EXPORTED`
 * is reported as unclassified, because a previous exporter's default
 * branch produced 177 entities that never received a value.
 */
/**
 * A slice value → the value the entity carries.
 *
 * Only ever a comparison against a string, and deliberately only that: a
 * capability whose state is an ENUM (`lock-control`, `presence`) has a
 * boolean projection an operator wants AND a spelling a boolean cannot
 * hold — `jammed` is not "unlocked", and `not_home` is not the name of
 * the zone somebody is in. Every cap that derives one therefore ALSO
 * exports the raw string as a second entity, so the derivation is a
 * convenience and never a loss.
 *
 * A richer expression language is not wanted here. A projection that
 * needs arithmetic or a lookup is a projection whose authority is the
 * capability, and it belongs in the cap's own status.
 */
export type CapValueDerivation =
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'not-equals'; readonly value: string }

/**
 * One entity derived from one capability slice.
 *
 * `field` is checked against the capability's own status schema by
 * `scripts/check-export-coverage.ts`: the schema is the authority, and
 * eleven descriptors here named a field that did not exist in it.
 */
export interface CapEntityDescriptor {
  readonly platform: HaPlatform
  /** Slice field carrying the value. */
  readonly field: string
  readonly deviceClass?: string
  readonly unit?: string
  readonly icon?: string
  /**
   * Writable ONLY when `CAP_COMMAND_ROUTES` names a route for the
   * capability. A control that writes nothing is worse than no control
   * (D62), so a cap whose write route does not exist yet ships read-only
   * — as a `sensor` / `binary_sensor` rather than as a dead `switch`.
   */
  readonly writable?: boolean
  /**
   * Required on a writable `number`; meaningless on anything else. See
   * {@link HaNumberRange} — an omitted range is silently 1..100 step 1.
   */
  readonly range?: HaNumberRange
  /**
   * Required on a `select`; meaningless on anything else. The list is
   * CLOSED and STATIC, so it may only ever come from an enum in the cap's own
   * schema. A free-form vocabulary whose values live on the slice
   * (`availableFanModes`, `availablePresets`, `availableSources`,
   * `availableFanSpeeds`, `availableModes`) cannot be a `select` here: a
   * static list would offer an operator values their device rejects and hide
   * the ones it accepts. Those stay read-only sensors until an entity mint
   * keyed on the device exists.
   */
  readonly options?: readonly string[]
  readonly derive?: CapValueDerivation
  /** Absent means enabled. See the note on {@link buildDerivedPlan}. */
  readonly enabledByDefault?: boolean
  readonly entityCategory?: 'config' | 'diagnostic'
}

/** A secondary entity of the same capability. Named, never auto-labelled. */
export interface CapExtraEntity extends CapEntityDescriptor {
  readonly label: string
}

/**
 * A WRITE-ONLY entity of a capability — a `button`.
 *
 * Deliberately not a {@link CapEntityDescriptor}: a button carries a command
 * and never a value, so it has no `field`, and giving it one to satisfy the
 * shape would be a leftover that describes the wrong design — the projector
 * would then be reading a field for an entity that has no state topic. The
 * catalog builds it, `CAP_COMMAND_ROUTES` routes it, and the projector never
 * sees it.
 *
 * Buttons are how a capability whose action is a VERB reaches Home Assistant
 * at all. `cover.open`, `vacuum-control.returnToBase` and `script-runner.run`
 * take no value: there is no `number`, `switch` or `select` that can express
 * them, and the nine platforms the component builds include no `cover`,
 * `vacuum` or `script`. A button per verb is the honest projection.
 */
export interface CapCommandEntity {
  readonly label: string
  readonly icon?: string
  /** Absent means enabled. See the note on {@link buildDerivedPlan}. */
  readonly enabledByDefault?: boolean
  readonly entityCategory?: 'config' | 'diagnostic'
}

export interface CapEntityMapping extends CapEntityDescriptor {
  /**
   * Suffix → the secondary entity, e.g. `position` on `cover` becomes
   * `cover_position`. The nine platforms the component knows cannot
   * express a cover, a thermostat or a media player as one entity, and
   * the alternative — a `sensor` carrying only the enum and nothing an
   * operator can threshold on — is a device exported in name only.
   */
  readonly extras?: Readonly<Record<string, CapExtraEntity>>
  /**
   * Suffix → a write-only `button`, e.g. `open` on `cover` becomes
   * `cover_open`. Every entry MUST be routed by `CAP_COMMAND_ROUTES`; the
   * catalog spec asserts both directions, so a button with no route and a
   * route with no button both fail the build.
   */
  readonly commands?: Readonly<Record<string, CapCommandEntity>>
}

/**
 * capability → the entities it produces.
 *
 * ── What decides read-only ──────────────────────────────────────────────
 *
 * The plan's rule, and D62's rule generalised: **a writable descriptor
 * must name a route `CAP_COMMAND_ROUTES` can resolve, or ship read-only.**
 * The route table now covers every Tier A family, so the rows below are
 * writable wherever the capability declares a method that writes exactly
 * the value the entity carries.
 *
 * ── `writable` is about the CAPABILITY, not about the platform ───────────
 *
 * Six values are written by a real method and have no Home Assistant
 * control in the DEGRADED shape: `climate-control.fanMode`, `.preset`,
 * `fan-control.preset`, `water-heater.operationMode`, `humidifier.mode`,
 * `media-player.source` and `vacuum-control.fanSpeed` are free-form
 * strings whose accepted values are `available*` arrays on the DEVICE. A
 * static `select` cannot hold them — it would offer values the device
 * rejects while hiding the ones it takes — so their degraded platform is
 * a `sensor`.
 *
 * They are still marked `writable`, and that is the point: the flag means
 * "`CAP_COMMAND_ROUTES` writes exactly this value", which is what
 * `native-platforms.ts` asks before giving a native climate its fan-mode
 * control or a native vacuum its fan-speed control. `buildComponent`
 * announces a `command_topic` only on a platform that can carry one
 * (`COMMANDABLE_PLATFORMS`), so the degraded `sensor` stays a reading and
 * the native entity gains the control. They were read-only until
 * 2026-08-14 and the native controls silently did not appear, because the
 * one flag was answering two different questions.
 *
 * **`setTargetRange` is the one setter that needs two values at once**,
 * and it is routed by READING the other half first — see the note on
 * `target-high` below. Everything else in this table names one method
 * with one value.
 *
 * Only **a value that is not flat** still ships read-only. See below.
 *
 * ── Why a nested object is never a field ────────────────────────────────
 *
 * `renderCapValue` carries strings, numbers and booleans. `color.rgb` and
 * `event-emitter.lastEvent` are objects: mapping one would publish
 * an entity that reports `unrenderable` on every single delivery. Where a
 * capability's headline value is only expressible as an object, the flat
 * neighbours are exported and the object is named in the doc comment
 * rather than mapped. An ARRAY of named items (`consumables.items`) is not
 * a row here either: `ITEM_ENTITY_MAP` (`item-entities.ts`) mints one
 * entity set per item from the device's own slice.
 */
export const CAP_ENTITY_MAP: Readonly<Record<string, CapEntityMapping>> = {
  // ── Controls with a route ─────────────────────────────────────────────
  switch: { platform: 'switch', field: 'on', writable: true },
  /**
   * The lock is BOTH: a switch, because that is what an operator
   * automates on and `lockControl.lock` / `.unlock` is a route that
   * works — and a sensor, because `LockStateSchema` is
   * `locked | unlocked | locking | unlocking | jammed` and a boolean
   * silently reports a JAMMED door as unlocked. The boolean is derived
   * from the same field, so the two can never disagree.
   */
  'lock-control': {
    platform: 'switch',
    field: 'state',
    deviceClass: 'lock',
    writable: true,
    derive: { kind: 'equals', value: 'locked' },
    extras: {
      state: {
        platform: 'sensor',
        field: 'state',
        label: 'Lock state',
        icon: 'mdi:lock-question',
      },
    },
    /**
     * `lockControl.open` — the LATCH, which is not `unlock`.
     *
     * Home Assistant spells it `LockEntityFeature.OPEN` and its native lock
     * offers it as a third button; the cap has declared the method since it
     * was written and nothing routed it, so `NATIVE_CAP_PLATFORMS`'
     * `open` control resolved to no entity and was skipped every time.
     * Registered and off in the degraded table for the same reason `stop`
     * is: a lock without a latch answers the press with the provider's own
     * refusal, and that is a button most operators never want to see.
     */
    commands: {
      open: {
        label: 'Open latch',
        icon: 'mdi:door-open',
        enabledByDefault: false,
      },
    },
  },
  button: { platform: 'button', field: 'pressed', writable: true },
  /**
   * The range is not decoration. `brightness.setBrightness` declares
   * `0..100` and the entity carried no bounds, so Home Assistant applied its
   * own default of min 1 — an operator could not send `0` and could not turn
   * the light off from the number. It has been that way since the entity
   * existed.
   */
  brightness: {
    platform: 'number',
    field: 'level',
    unit: '%',
    writable: true,
    range: PERCENT_RANGE,
  },
  'alarm-panel': {
    platform: 'alarm_control_panel',
    field: 'state',
    writable: true,
  },

  // ── Binary sensors ────────────────────────────────────────────────────
  binary: { platform: 'binary_sensor', field: 'on' },
  motion: {
    platform: 'binary_sensor',
    field: 'detected',
    deviceClass: 'motion',
  },
  contact: {
    platform: 'binary_sensor',
    field: 'entryOpen',
    deviceClass: 'door',
  },
  /**
   * `state` is a STRING — `home`, `not_home`, or the name of any zone the
   * operator defined. The binary answers "is anybody in", which is what
   * an automation triggers on; the extra carries the zone NAME, which is
   * the whole reason a presence device is not a contact sensor. A native
   * `device_tracker` (which carries both at once) is Tier B.
   */
  presence: {
    platform: 'binary_sensor',
    field: 'state',
    deviceClass: 'presence',
    derive: { kind: 'not-equals', value: 'not_home' },
    extras: {
      zone: {
        platform: 'sensor',
        field: 'state',
        label: 'Presence zone',
        icon: 'mdi:map-marker-account',
      },
    },
  },
  connectivity: {
    platform: 'binary_sensor',
    field: 'connected',
    deviceClass: 'connectivity',
  },
  flood: {
    platform: 'binary_sensor',
    field: 'flooded',
    deviceClass: 'moisture',
  },
  smoke: { platform: 'binary_sensor', field: 'detected', deviceClass: 'smoke' },
  gas: { platform: 'binary_sensor', field: 'detected', deviceClass: 'gas' },
  'carbon-monoxide': {
    platform: 'binary_sensor',
    field: 'detected',
    deviceClass: 'carbon_monoxide',
  },
  tamper: {
    platform: 'binary_sensor',
    field: 'tampered',
    deviceClass: 'tamper',
  },
  vibration: {
    platform: 'binary_sensor',
    field: 'detected',
    deviceClass: 'vibration',
  },
  doorbell: {
    platform: 'sensor',
    field: 'lastPressedAt',
    deviceClass: 'timestamp',
  },

  // ── Measurements ──────────────────────────────────────────────────────
  'temperature-sensor': {
    platform: 'sensor',
    field: 'temperature',
    deviceClass: 'temperature',
    unit: '°C',
  },
  'humidity-sensor': {
    platform: 'sensor',
    field: 'humidity',
    deviceClass: 'humidity',
    unit: '%',
  },
  'pressure-sensor': {
    platform: 'sensor',
    field: 'pressure',
    deviceClass: 'pressure',
    unit: 'hPa',
  },
  'ambient-light-sensor': {
    platform: 'sensor',
    field: 'illuminance',
    deviceClass: 'illuminance',
    unit: 'lx',
  },
  'numeric-sensor': { platform: 'sensor', field: 'value' },
  'enum-sensor': { platform: 'sensor', field: 'value' },
  battery: {
    platform: 'sensor',
    field: 'level',
    deviceClass: 'battery',
    unit: '%',
  },
  'power-meter': {
    platform: 'sensor',
    field: 'power',
    deviceClass: 'power',
    unit: 'W',
  },
  'air-quality-sensor': {
    platform: 'sensor',
    field: 'aqi',
    deviceClass: 'aqi',
  },

  // ── Tier A: the device families the export had no row for at all ──────
  /**
   * A cover is its state, its two positions and its three verbs.
   *
   * `state` stays a `sensor`: `opening`/`closing` are transitions, not
   * commands, and there is no cap method that writes the lifecycle directly.
   * The positions are `number`s because `setPosition` / `setTiltPosition`
   * write exactly them, and the verbs are buttons because `open`, `close` and
   * `stop` take no value at all.
   */
  cover: {
    platform: 'sensor',
    field: 'state',
    icon: 'mdi:window-shutter',
    extras: {
      position: {
        platform: 'number',
        field: 'position',
        label: 'Position',
        unit: '%',
        icon: 'mdi:arrow-up-down',
        writable: true,
        range: PERCENT_RANGE,
      },
      tilt: {
        platform: 'number',
        field: 'tiltPosition',
        label: 'Tilt position',
        unit: '%',
        icon: 'mdi:angle-acute',
        writable: true,
        range: PERCENT_RANGE,
        enabledByDefault: false,
      },
    },
    commands: {
      open: { label: 'Open', icon: 'mdi:arrow-up-box' },
      close: { label: 'Close', icon: 'mdi:arrow-down-box' },
      stop: { label: 'Stop', icon: 'mdi:stop', enabledByDefault: false },
    },
  },
  /**
   * Every temperature here is CELSIUS by the cap's own doc comment
   * ("Single setpoint in Celsius", "Current measured temperature in
   * Celsius"), so the unit is declared rather than guessed.
   */
  'climate-control': {
    platform: 'select',
    field: 'mode',
    icon: 'mdi:thermostat',
    writable: true,
    /**
     * The one closed list on this capability, and it is closed because
     * `HvacModeSchema` is an enum. `availableModes` narrows it PER DEVICE and
     * a static descriptor cannot read a slice, so an operator can select a
     * mode their unit rejects — the provider refuses it and the refusal
     * surfaces as a 422 with the device's own message, which is the honest
     * failure. `fanMode` and `preset` get no such list at all: they are
     * free-form strings, so they stay sensors.
     */
    options: HvacModeSchema.options,
    extras: {
      'current-temp': {
        platform: 'sensor',
        field: 'currentTemp',
        label: 'Current temperature',
        deviceClass: 'temperature',
        unit: '°C',
      },
      target: {
        platform: 'number',
        field: 'target',
        label: 'Target temperature',
        deviceClass: 'temperature',
        unit: '°C',
        writable: true,
        range: TEMPERATURE_RANGE,
      },
      'current-humidity': {
        platform: 'sensor',
        field: 'currentHumidity',
        label: 'Current humidity',
        deviceClass: 'humidity',
        unit: '%',
        enabledByDefault: false,
      },
      'target-humidity': {
        platform: 'number',
        field: 'targetHumidity',
        label: 'Target humidity',
        deviceClass: 'humidity',
        unit: '%',
        writable: true,
        range: PERCENT_RANGE,
        enabledByDefault: false,
      },
      /**
       * Free-form: the accepted values are `availableFanModes` on the slice,
       * so the degraded platform is a `sensor` and only the native climate
       * renders the control. `setFanMode` is the route.
       */
      'fan-mode': {
        platform: 'sensor',
        field: 'fanMode',
        label: 'Fan mode',
        icon: 'mdi:fan',
        writable: true,
        enabledByDefault: false,
      },
      /** Free-form: the accepted values are `availablePresets` on the slice. */
      preset: {
        platform: 'sensor',
        field: 'preset',
        label: 'Preset',
        writable: true,
        enabledByDefault: false,
      },
      /**
       * The dual setpoint — and the one route in this export that READS
       * before it writes.
       *
       * `setTargetRange` takes `targetLow` AND `targetHigh` together, while
       * Home Assistant's climate sends the two halves on two topics, so a
       * command carrying one of them has to learn the other before it can
       * make the call. `applyCapCommand` therefore reads
       * `climateControl.getStatus`, substitutes the half it was given, and
       * calls once. A device reporting `null` for the other half is REFUSED
       * rather than defaulted: inventing the missing bound is how a
       * thermostat comes to be told to hold 20 °C to 20 °C.
       */
      'target-high': {
        platform: 'sensor',
        field: 'targetHigh',
        label: 'Target high',
        deviceClass: 'temperature',
        unit: '°C',
        writable: true,
        enabledByDefault: false,
      },
      'target-low': {
        platform: 'sensor',
        field: 'targetLow',
        label: 'Target low',
        deviceClass: 'temperature',
        unit: '°C',
        writable: true,
        enabledByDefault: false,
      },
      /**
       * Two INDEPENDENT axes, each with its own setter and its own
       * `DeviceFeature`. A device with neither reports `null` on both, and a
       * null renders as `unknown` rather than as a switch stuck off.
       */
      'swing-vertical': {
        platform: 'switch',
        field: 'swingVertical',
        label: 'Vertical swing',
        icon: 'mdi:arrow-up-down',
        writable: true,
        enabledByDefault: false,
      },
      'swing-horizontal': {
        platform: 'switch',
        field: 'swingHorizontal',
        label: 'Horizontal swing',
        icon: 'mdi:arrow-left-right',
        writable: true,
        enabledByDefault: false,
      },
    },
  },
  /** A fan has no `on` field — `percentage` IS its state, and 0 is off. */
  'fan-control': {
    platform: 'number',
    field: 'speed',
    unit: '%',
    icon: 'mdi:fan',
    writable: true,
    /**
     * `percentageStep` on the slice is the device's own granularity (25 for a
     * four-speed fan). A static step of 1 is the WIDER choice: a value the
     * device rounds is recoverable, a step that hides three of its four speeds
     * is not.
     */
    range: PERCENT_RANGE,
    extras: {
      /**
       * Free-form: the accepted values are `availablePresets` on the slice.
       * `fanControl.setPreset` is the route; the native fan renders it.
       */
      preset: {
        platform: 'sensor',
        field: 'preset',
        label: 'Preset',
        writable: true,
        enabledByDefault: false,
      },
      oscillating: {
        platform: 'switch',
        field: 'oscillating',
        label: 'Oscillating',
        icon: 'mdi:arrow-oscillating',
        writable: true,
        enabledByDefault: false,
      },
      direction: {
        platform: 'select',
        field: 'direction',
        label: 'Direction',
        writable: true,
        options: FanDirectionSchema.options,
        enabledByDefault: false,
      },
    },
  },
  humidifier: {
    platform: 'switch',
    field: 'on',
    icon: 'mdi:air-humidifier',
    writable: true,
    extras: {
      'current-humidity': {
        platform: 'sensor',
        field: 'currentHumidity',
        label: 'Current humidity',
        deviceClass: 'humidity',
        unit: '%',
      },
      /**
       * `minHumidity`/`maxHumidity` on the slice are the device's own bounds;
       * the static range is the full percentage for the reason on
       * {@link HaNumberRange}.
       */
      'target-humidity': {
        platform: 'number',
        field: 'targetHumidity',
        label: 'Target humidity',
        deviceClass: 'humidity',
        unit: '%',
        writable: true,
        range: PERCENT_RANGE,
      },
      /**
       * Free-form: the accepted values are `availableModes` on the slice.
       * `humidifier.setMode` is the route; the native humidifier renders it.
       */
      mode: {
        platform: 'sensor',
        field: 'mode',
        label: 'Mode',
        writable: true,
        enabledByDefault: false,
      },
      action: {
        platform: 'sensor',
        field: 'action',
        label: 'Action',
        enabledByDefault: false,
      },
    },
  },
  'water-heater': {
    platform: 'sensor',
    field: 'currentTemp',
    deviceClass: 'temperature',
    unit: '°C',
    extras: {
      target: {
        platform: 'number',
        field: 'targetTemp',
        label: 'Target temperature',
        deviceClass: 'temperature',
        unit: '°C',
        writable: true,
        range: TEMPERATURE_RANGE,
      },
      /**
       * Free-form: the accepted values are `availableModes` on the slice, and
       * this is the entity Home Assistant's water heater uses as its STATE —
       * `setOperationMode` is what a native water_heater writes when the
       * operator picks `eco`. Read-only here left that platform with no
       * command at all.
       */
      mode: {
        platform: 'sensor',
        field: 'operationMode',
        label: 'Operation mode',
        writable: true,
        enabledByDefault: false,
      },
      away: {
        platform: 'switch',
        field: 'away',
        label: 'Away mode',
        writable: true,
        enabledByDefault: false,
      },
    },
  },
  valve: {
    platform: 'sensor',
    field: 'state',
    icon: 'mdi:valve',
    extras: {
      position: {
        platform: 'number',
        field: 'position',
        label: 'Position',
        unit: '%',
        icon: 'mdi:arrow-up-down',
        writable: true,
        range: PERCENT_RANGE,
      },
    },
    commands: {
      open: { label: 'Open', icon: 'mdi:valve-open' },
      close: { label: 'Close', icon: 'mdi:valve-closed' },
      stop: { label: 'Stop', icon: 'mdi:stop', enabledByDefault: false },
    },
  },
  'vacuum-control': {
    platform: 'sensor',
    field: 'state',
    icon: 'mdi:robot-vacuum',
    extras: {
      battery: {
        platform: 'sensor',
        field: 'batteryLevel',
        label: 'Battery',
        deviceClass: 'battery',
        unit: '%',
      },
      /**
       * Free-form: the accepted values are `availableFanSpeeds` on the slice.
       * `vacuumControl.setFanSpeed` is the route; the native vacuum renders it.
       */
      'fan-speed': {
        platform: 'sensor',
        field: 'fanSpeed',
        label: 'Fan speed',
        writable: true,
        enabledByDefault: false,
      },
      progress: {
        platform: 'sensor',
        field: 'progress',
        label: 'Progress',
        unit: '%',
        enabledByDefault: false,
      },
      error: {
        platform: 'sensor',
        field: 'errorLabel',
        label: 'Error',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
    commands: {
      start: { label: 'Start', icon: 'mdi:play' },
      pause: { label: 'Pause', icon: 'mdi:pause' },
      stop: { label: 'Stop', icon: 'mdi:stop', enabledByDefault: false },
      'return-to-base': {
        label: 'Return to base',
        icon: 'mdi:home-import-outline',
      },
      locate: {
        label: 'Locate',
        icon: 'mdi:map-marker-radius',
        enabledByDefault: false,
      },
    },
  },
  /**
   * A dishwasher. The headline is the appliance's OWN operation state (`Run`, `DelayedStart`,
   * `ActionRequired`, …) — not the coarse `state`, which folds nine states into six.
   *
   * Every flag is a `binary_sensor` / `switch` whose value is `null` until the appliance has
   * said: the projector publishes nothing for a null, so Home Assistant shows `unknown`, never
   * `off` (the slice is nullable for exactly this reason).
   *
   * Not mapped, by design: `availablePrograms` / `activeEvents` are arrays, and the program
   * list is the appliance's own vocabulary (a static `select` would offer programs it rejects);
   * `selectedProgram` / `program` are exported read-only. The raised events are separate
   * entities already — one `binary_sensor` per event and the events emitter.
   */
  dishwasher: {
    platform: 'sensor',
    field: 'operationState',
    icon: 'mdi:dishwasher',
    extras: {
      program: {
        platform: 'sensor',
        field: 'program',
        label: 'Active program',
        icon: 'mdi:dishwasher',
      },
      'selected-program': {
        platform: 'sensor',
        field: 'selectedProgram',
        label: 'Selected program',
        enabledByDefault: false,
      },
      'remaining-time': {
        platform: 'sensor',
        field: 'remaining',
        label: 'Remaining time',
        deviceClass: 'duration',
        unit: 's',
      },
      'delayed-start': {
        platform: 'sensor',
        field: 'delayedStart',
        label: 'Delayed start',
        deviceClass: 'duration',
        unit: 's',
        enabledByDefault: false,
      },
      progress: {
        platform: 'sensor',
        field: 'progress',
        label: 'Progress',
        unit: '%',
        enabledByDefault: false,
      },
      door: {
        platform: 'binary_sensor',
        field: 'doorOpen',
        label: 'Door',
        deviceClass: 'door',
      },
      'door-locked': {
        platform: 'binary_sensor',
        field: 'doorLocked',
        label: 'Door locked',
        icon: 'mdi:lock',
        enabledByDefault: false,
        entityCategory: 'diagnostic',
      },
      'remote-start-allowed': {
        platform: 'binary_sensor',
        field: 'remoteStartAllowed',
        label: 'Remote start allowed',
        enabledByDefault: false,
      },
      'remote-control': {
        platform: 'binary_sensor',
        field: 'remoteControlActive',
        label: 'Remote control active',
        enabledByDefault: false,
        entityCategory: 'diagnostic',
      },
      'local-control': {
        platform: 'binary_sensor',
        field: 'localControlActive',
        label: 'Local control active',
        enabledByDefault: false,
        entityCategory: 'diagnostic',
      },
      power: { platform: 'switch', field: 'powerOn', label: 'Power', writable: true },
      'child-lock': {
        platform: 'switch',
        field: 'childLock',
        label: 'Child lock',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      'half-load': {
        platform: 'switch',
        field: 'halfLoad',
        label: 'Half load',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      'hygiene-plus': {
        platform: 'switch',
        field: 'hygienePlus',
        label: 'Hygiene plus',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      'extra-dry': {
        platform: 'switch',
        field: 'extraDry',
        label: 'Extra dry',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      'intensive-zone': {
        platform: 'switch',
        field: 'intensiveZone',
        label: 'Intensive zone',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      'vario-speed-plus': {
        platform: 'switch',
        field: 'varioSpeedPlus',
        label: 'VarioSpeed+',
        writable: true,
        entityCategory: 'config',
        enabledByDefault: false,
      },
      error: {
        platform: 'sensor',
        field: 'errorLabel',
        label: 'Error',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
    commands: {
      start: { label: 'Start', icon: 'mdi:play' },
      pause: { label: 'Pause', icon: 'mdi:pause' },
      resume: { label: 'Resume', icon: 'mdi:play-pause', enabledByDefault: false },
      stop: { label: 'Stop', icon: 'mdi:stop', enabledByDefault: false },
    },
  },
  'lawn-mower-control': {
    platform: 'sensor',
    field: 'activity',
    icon: 'mdi:robot-mower',
    extras: {
      battery: {
        platform: 'sensor',
        field: 'batteryLevel',
        label: 'Battery',
        deviceClass: 'battery',
        unit: '%',
      },
      progress: {
        platform: 'sensor',
        field: 'progress',
        label: 'Progress',
        unit: '%',
        enabledByDefault: false,
      },
      error: {
        platform: 'sensor',
        field: 'currentCodeLabel',
        label: 'Status code',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
    commands: {
      start: { label: 'Start mowing', icon: 'mdi:play' },
      pause: { label: 'Pause', icon: 'mdi:pause' },
      dock: { label: 'Dock', icon: 'mdi:home-import-outline' },
    },
  },
  /** `currentMedia` is an object; the flat fields around it are exported. */
  'media-player': {
    platform: 'sensor',
    field: 'state',
    icon: 'mdi:play-circle',
    extras: {
      volume: {
        platform: 'number',
        field: 'volumeLevel',
        label: 'Volume',
        icon: 'mdi:volume-high',
        writable: true,
        range: PERCENT_RANGE,
      },
      muted: {
        platform: 'switch',
        field: 'isMuted',
        label: 'Muted',
        icon: 'mdi:volume-off',
        writable: true,
      },
      /**
       * Free-form: the accepted values are `availableSources` on the slice.
       * `mediaPlayer.selectSource` is the route; the native media_player
       * renders it as its source list.
       */
      source: {
        platform: 'sensor',
        field: 'source',
        label: 'Source',
        writable: true,
        enabledByDefault: false,
      },
      repeat: {
        platform: 'select',
        field: 'repeat',
        label: 'Repeat',
        writable: true,
        options: MediaPlayerRepeatSchema.options,
        enabledByDefault: false,
      },
      shuffle: {
        platform: 'switch',
        field: 'shuffle',
        label: 'Shuffle',
        writable: true,
        enabledByDefault: false,
      },
    },
    commands: {
      play: { label: 'Play', icon: 'mdi:play' },
      pause: { label: 'Pause', icon: 'mdi:pause' },
      stop: { label: 'Stop', icon: 'mdi:stop', enabledByDefault: false },
      next: { label: 'Next', icon: 'mdi:skip-next' },
      previous: { label: 'Previous', icon: 'mdi:skip-previous' },
    },
  },
  /**
   * `rgb` and `hsv` are nested objects, so hue and saturation cannot be
   * two flat `number` entities without a projector that walks into a
   * sub-object — and a `light` platform that carries the whole colour is
   * Tier B. What IS flat is the colour MODE and the colour temperature,
   * and both are automatable.
   */
  color: {
    platform: 'sensor',
    field: 'mode',
    icon: 'mdi:palette',
    extras: {
      /**
       * The one writable surface `setColor` has that is a single number: its
       * input is a discriminated union and `{ mode: 'mired', colorTemperature }` is the
       * only arm with exactly one scalar in it. `mode` itself stays read-only
       * — writing it alone would be a call with no colour in it.
       */
      mireds: {
        platform: 'number',
        field: 'colorTemperature',
        label: 'Colour temperature',
        unit: 'mired',
        writable: true,
        range: MIRED_RANGE,
        enabledByDefault: false,
      },
    },
  },
  update: {
    platform: 'binary_sensor',
    field: 'updatable',
    deviceClass: 'update',
    extras: {
      available: {
        platform: 'sensor',
        field: 'availableVersion',
        label: 'Available version',
        entityCategory: 'diagnostic',
      },
      current: {
        platform: 'sensor',
        field: 'currentVersion',
        label: 'Installed version',
        entityCategory: 'diagnostic',
      },
      installing: {
        platform: 'binary_sensor',
        field: 'inProgress',
        label: 'Installing',
        deviceClass: 'running',
        enabledByDefault: false,
      },
    },
  },
  image: {
    platform: 'image',
    field: 'url',
    extras: {
      updated: {
        platform: 'sensor',
        field: 'lastUpdated',
        label: 'Last updated',
        deviceClass: 'timestamp',
        enabledByDefault: false,
      },
    },
  },
  'script-runner': {
    platform: 'binary_sensor',
    field: 'isRunning',
    deviceClass: 'running',
    icon: 'mdi:script-text-play',
    extras: {
      'last-run': {
        platform: 'sensor',
        field: 'lastRunAt',
        label: 'Last run',
        deviceClass: 'timestamp',
      },
      'last-error': {
        platform: 'sensor',
        field: 'lastError',
        label: 'Last error',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
    commands: {
      run: { label: 'Run', icon: 'mdi:play' },
      stop: { label: 'Stop', icon: 'mdi:stop' },
    },
  },
  /**
   * `enabled` is a switch because `enable`/`disable` write exactly it;
   * `trigger` is a button because firing the action block is a verb, and it
   * works on a DISABLED automation — which is why it is not folded into the
   * switch.
   */
  'automation-control': {
    platform: 'switch',
    field: 'enabled',
    icon: 'mdi:robot',
    writable: true,
    commands: {
      trigger: { label: 'Trigger', icon: 'mdi:flash' },
    },
    extras: {
      running: {
        platform: 'binary_sensor',
        field: 'isRunning',
        label: 'Running',
        deviceClass: 'running',
        enabledByDefault: false,
      },
      'last-triggered': {
        platform: 'sensor',
        field: 'lastTriggeredAt',
        label: 'Last triggered',
        deviceClass: 'timestamp',
      },
      'last-error': {
        platform: 'sensor',
        field: 'lastError',
        label: 'Last error',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
  },
  /**
   * `lastEvent` is an object and `eventTypes` an array, so the plan's
   * "last-event + last-event-at" pair has nothing flat to read. The COUNT
   * is flat, monotonic and the thing an automation can trigger on ("it
   * went up") — a native `event` platform, which carries the payload, is
   * Tier B.
   */
  'event-emitter': {
    platform: 'sensor',
    field: 'eventCountSinceStart',
    icon: 'mdi:counter',
  },
  'pet-feeder': {
    platform: 'sensor',
    field: 'foodLevel',
    unit: '%',
    icon: 'mdi:food-drumstick',
    extras: {
      'low-food': {
        platform: 'binary_sensor',
        field: 'lowFood',
        label: 'Low food',
        deviceClass: 'problem',
      },
      feeding: {
        platform: 'binary_sensor',
        field: 'feeding',
        label: 'Feeding',
        deviceClass: 'running',
        enabledByDefault: false,
      },
      desiccant: {
        platform: 'sensor',
        field: 'desiccantLeftDays',
        label: 'Desiccant remaining',
        unit: 's',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
      status: {
        platform: 'sensor',
        field: 'status',
        label: 'Status',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
  },
  /**
   * Weather numbers are stored in the quantity base (°C, hPa, m/s). The
   * export advertises those symbols. A Fahrenheit dashboard converts at read.
   */
  weather: {
    platform: 'sensor',
    field: 'condition',
    icon: 'mdi:weather-partly-cloudy',
    extras: {
      temperature: {
        platform: 'sensor',
        field: 'temperature',
        label: 'Temperature',
        unit: '°C',
        deviceClass: 'temperature',
        icon: 'mdi:thermometer',
      },
      humidity: {
        platform: 'sensor',
        field: 'humidity',
        label: 'Humidity',
        deviceClass: 'humidity',
        unit: '%',
      },
      pressure: {
        platform: 'sensor',
        field: 'pressure',
        label: 'Pressure',
        unit: 'hPa',
        deviceClass: 'pressure',
        icon: 'mdi:gauge',
        enabledByDefault: false,
      },
      wind: {
        platform: 'sensor',
        field: 'windSpeed',
        label: 'Wind speed',
        unit: 'm/s',
        deviceClass: 'wind_speed',
        icon: 'mdi:weather-windy',
        enabledByDefault: false,
      },
      bearing: {
        platform: 'sensor',
        field: 'windBearing',
        label: 'Wind bearing',
        unit: '°',
        enabledByDefault: false,
      },
    },
  },
  /**
   * The generic user-settable input. `value` is `number | string` and
   * `kind` on the slice says which of the four shapes it is. The row
   * here is the PROJECTOR + route authority (`writable` gates
   * `control.setValue`); the announced platform (`select` / `number` /
   * read-only `sensor`) is minted at reconcile from the slice by
   * {@link controlEntitySpecs} — a static `select` here cannot carry
   * the device's live `options`, and a static `number` cannot carry
   * its live min/max/step.
   */
  control: {
    platform: 'sensor',
    field: 'value',
    writable: true,
    extras: {
      kind: {
        platform: 'sensor',
        field: 'kind',
        label: 'Input kind',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
  },
  'motion-trigger': {
    platform: 'binary_sensor',
    field: 'enabled',
    icon: 'mdi:motion-sensor',
  },

  // ── Camera-scoped, built by the CAMERA half ───────────────────────────
  /**
   * Three capabilities a camera carries that an operator automates on. They
   * are in this table because the descriptor and the push path are the
   * derived half's; they reach a camera through {@link CAMERA_DERIVED_CAPS}
   * because `buildDerivedPlan` never runs for one.
   */
  /**
   * Talk-back, exported on the operator's decision and READ-ONLY.
   *
   * It was excluded until 2026-08-14 for a measured reason: the cap declared
   * `status` and no `runtimeState`, and the export's only two sources of a
   * value — the `device.state-changed` slice and the
   * `deviceState.getAllSnapshots` snapshot — are both built from runtime
   * state. The entity would have been published and never received a value.
   * `intercom.cap.ts` now declares the slice and the Reolink and Hikvision
   * providers write it at the four points that open and close a session, so
   * the entity has a feed before it has a row here.
   *
   * Read-only, and that is not a missing route: talk-back is an AUDIO
   * STREAM. `startTalkSession` opens a channel that `pushTalkAudio` feeds
   * frame by frame, and Home Assistant's switch carries `true`. A switch
   * that opened a session nobody could speak into is the control that lies.
   */
  intercom: {
    platform: 'binary_sensor',
    field: 'talking',
    icon: 'mdi:account-voice',
    extras: {
      'last-session': {
        platform: 'sensor',
        field: 'lastSessionAt',
        label: 'Last talk session',
        deviceClass: 'timestamp',
        enabledByDefault: false,
      },
    },
  },
  'day-night': {
    platform: 'sensor',
    field: 'mode',
    icon: 'mdi:theme-light-dark',
    extras: {
      sensitivity: {
        platform: 'sensor',
        field: 'sensitivity',
        label: 'IR-cut sensitivity',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
      'switch-delay': {
        platform: 'sensor',
        field: 'switchDelaySec',
        label: 'IR-cut switch delay',
        unit: 's',
        entityCategory: 'diagnostic',
        enabledByDefault: false,
      },
    },
  },
  'ptz-autotrack': {
    platform: 'binary_sensor',
    field: 'enabled',
    icon: 'mdi:crosshairs-gps',
  },
}

/**
 * Capabilities exported on a CAMERA rather than through
 * `buildDerivedPlan`, which only ever runs for a non-camera device.
 */
export const CAMERA_DERIVED_CAPS: readonly string[] = ['day-night', 'ptz-autotrack', 'intercom']

/** Every VALUE entity one capability produces, primary first. */
export interface CapEntityRef {
  readonly entity: string
  readonly label: string
  readonly descriptor: CapEntityDescriptor
}

/** Every write-only entity one capability produces. */
export interface CapCommandRef {
  readonly entity: string
  /** The key in `mapping.commands` — what the route table is keyed on. */
  readonly suffix: string
  readonly label: string
  readonly command: CapCommandEntity
}

/**
 * The command buttons a capability produces.
 *
 * Separate from {@link capEntities} on purpose: that list is what the
 * PROJECTOR walks, and a button has nothing to project. Keeping them in one
 * list would put an entity with no `field` in front of code whose whole job is
 * to read one.
 */
export function capCommandEntities(capName: string): readonly CapCommandRef[] {
  const mapping = CAP_ENTITY_MAP[capName]
  if (mapping === undefined) return []
  return Object.entries(mapping.commands ?? {}).map(([suffix, command]) => ({
    entity: derivedExtraEntityId(capName, suffix),
    suffix,
    label: command.label,
    command,
  }))
}

/**
 * The one expression that turns a descriptor into entities.
 *
 * Both halves of the catalog and the projector call it, so a capability
 * cannot build a component under one id and publish under another — the
 * failure `derivedEntityId` was extracted to end, now that a capability
 * can produce more than one entity.
 */
export function capEntities(capName: string): readonly CapEntityRef[] {
  const mapping = CAP_ENTITY_MAP[capName]
  if (mapping === undefined) return []
  const refs: CapEntityRef[] = [
    {
      entity: derivedEntityId(capName),
      label: humanise(capName),
      descriptor: mapping,
    },
  ]
  for (const [suffix, extra] of Object.entries(mapping.extras ?? {})) {
    refs.push({
      entity: derivedExtraEntityId(capName, suffix),
      label: extra.label,
      descriptor: extra,
    })
  }
  return refs
}

/**
 * Apply a descriptor's derivation.
 *
 * Returns `null` — which renders as `unrenderable` and is LOGGED — when
 * the slice carried something a comparison cannot be made against. A
 * derivation that quietly answered `false` for a non-string would report
 * a jammed lock as unlocked, which is the failure the derivation exists
 * to avoid.
 */
export function deriveCapValue(derivation: CapValueDerivation | undefined, raw: unknown): unknown {
  if (derivation === undefined) return raw
  if (typeof raw !== 'string') return null
  return derivation.kind === 'equals' ? raw === derivation.value : raw !== derivation.value
}

/** A capability's entities as the catalog builders consume them. */
function capEntitySpecs(capName: string): readonly EntitySpec[] {
  const specs: EntitySpec[] = capEntities(capName).map((ref) => ({
    entity: ref.entity,
    platform: ref.descriptor.platform,
    label: ref.label,
    enabledByDefault: ref.descriptor.enabledByDefault ?? true,
    ...(ref.descriptor.deviceClass !== undefined
      ? { deviceClass: ref.descriptor.deviceClass }
      : {}),
    ...(ref.descriptor.unit !== undefined ? { unit: ref.descriptor.unit } : {}),
    ...(ref.descriptor.icon !== undefined ? { icon: ref.descriptor.icon } : {}),
    ...(ref.descriptor.options !== undefined ? { options: ref.descriptor.options } : {}),
    ...(ref.descriptor.range !== undefined ? { range: ref.descriptor.range } : {}),
    ...(ref.descriptor.entityCategory !== undefined
      ? { entityCategory: ref.descriptor.entityCategory }
      : {}),
    ...(ref.descriptor.writable === true ? { writable: true } : {}),
  }))
  for (const ref of capCommandEntities(capName)) {
    specs.push({
      entity: ref.entity,
      platform: 'button',
      label: ref.label,
      enabledByDefault: ref.command.enabledByDefault ?? true,
      writable: true,
      ...(ref.command.icon !== undefined ? { icon: ref.command.icon } : {}),
      ...(ref.command.entityCategory !== undefined
        ? { entityCategory: ref.command.entityCategory }
        : {}),
    })
  }
  return specs
}

function readControlOptions(
  slice: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const raw = slice?.['options']
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function readFiniteNumber(
  slice: Readonly<Record<string, unknown>> | undefined,
  field: string,
): number | undefined {
  const raw = slice?.[field]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * The announced shape of a `control` device, from its live slice.
 *
 * `CAP_ENTITY_MAP.control` cannot name a static `select`/`number`: the
 * options and the bounds live on the slice and change (VPN station list,
 * HA `input_number` limits). A select with no options is an entity HA
 * builds with nothing to choose from — so an empty list falls back to a
 * read-only sensor rather than a dead control.
 */
export function controlEntitySpecs(
  slice: Readonly<Record<string, unknown>> | undefined,
  quantity?: ReadingQuantity,
): readonly EntitySpec[] {
  const kind = typeof slice?.['kind'] === 'string' ? slice['kind'] : null
  const primary = derivedEntityId('control')
  const kindExtra: EntitySpec = {
    entity: derivedExtraEntityId('control', 'kind'),
    platform: 'sensor',
    label: 'Input kind',
    entityCategory: 'diagnostic',
    enabledByDefault: false,
  }

  if (kind === 'select') {
    const options = readControlOptions(slice)
    if (options.length > 0) {
      return [
        {
          entity: primary,
          platform: 'select',
          label: humanise('control'),
          writable: true,
          options,
          enabledByDefault: true,
        },
        kindExtra,
      ]
    }
  }

  if (kind === 'numeric') {
    const min = readFiniteNumber(slice, 'min') ?? PERCENT_RANGE.min
    const max = readFiniteNumber(slice, 'max') ?? PERCENT_RANGE.max
    const step = readFiniteNumber(slice, 'step') ?? PERCENT_RANGE.step
    const unit = quantity === undefined ? undefined : baseUnitOf(quantity)
    if (min < max && step > 0) {
      return [
        {
          entity: primary,
          platform: 'number',
          label: humanise('control'),
          writable: true,
          range: { min, max, step },
          ...(unit !== undefined ? { unit } : {}),
          enabledByDefault: true,
        },
        kindExtra,
      ]
    }
  }

  return [
    {
      entity: primary,
      platform: 'sensor',
      label: humanise('control'),
      enabledByDefault: true,
    },
    kindExtra,
  ]
}

export interface UnexportedCap {
  readonly cap: string
  readonly reason: string
}

export const CAPS_NOT_EXPORTED: readonly UnexportedCap[] = [
  {
    cap: 'ir-transmitter',
    reason:
      'A pulse-train emitter with no state: it is driven by the remote that owns ' +
      'a command table, and a raw send has no meaningful single entity.',
  },
  {
    cap: 'group-status',
    reason:
      'Bookkeeping for a helper group (D944): how many members were included, ' +
      'excluded, or named. The value an operator automates on is the output ' +
      'capability (the temperature, the motion, the watts). These counts are ' +
      'session-only, have no history, and would publish a second entity that ' +
      'never means the reading.',
  },
  {
    cap: 'meter',
    reason:
      'The integral of a gauge that is not watts (D944). The total is base-unit ' +
      'seconds between resets; energy from watts is power-meter.energy. The ' +
      'source quantity is not on this device yet, so publishing the total as a ' +
      'sensor would give it no unit.',
  },
  {
    cap: 'group-active',
    reason:
      'Whether a helper actuator group counts as active (D944): a cover is open, ' +
      'a lock is locked, a player is playing. Session-only, no history, and the ' +
      'group is not exported as the type it commands; the members are.',
  },
  {
    cap: 'group-commands',
    reason:
      'The last fan-out a helper group attempted (D944), one row per member. ' +
      'It is session-only and has no history. The command an automation sends ' +
      'is the member capability (switch, brightness, colour), not this record.',
  },
  {
    cap: 'recording-onboard',
    reason:
      'An EDITOR of the CAMERA\u2019s own recorder: a weekly schedule of windows per ' +
      'trigger, plus the facts about the card it writes to. The schedule is a ' +
      'document an operator authors, not a reading \u2014 an entity would publish 168 ' +
      'slots as a state and nothing in Home Assistant could act on it. The storage ' +
      'side is a reading, but it belongs to the camera\u2019s own health rather than to ' +
      'this cap\u2019s editor surface, and publishing capacity here would put the same ' +
      'number in two places the day a health cap carries it. ' +
      'ONE thing here is arguably a real binary sensor: `recordingToNowhere` \u2014 ' +
      'scheduled to record with no usable card. It is deliberately NOT exported ' +
      'yet, because exporting half a cap needs the split decided first, and the ' +
      'two cameras it fires on today are already a danger banner and a WARN.',
  },
  {
    cap: 'camera-grid-layout',
    reason:
      'An EDITOR, not a reading: it carries which camera sits in which cell of a ' +
      'composite grid, authored through a host widget in the device tab. Nothing ' +
      'about it is a measurement and nothing in Home Assistant can act on it — the ' +
      'grid itself already reaches HA as an ordinary camera entity, which is the ' +
      'thing an operator actually watches. An entity here would publish a layout ' +
      'document as a state and never carry a value anyone could use.',
  },
  {
    cap: 'stream-signals',
    reason:
      'A DECLARATION, not a state: it lists the signals a camera can emit to wake ' +
      'its own stream, so the broker can offer them as wake sources. Nothing about ' +
      'it changes over time and nothing about it is a reading — an entity here ' +
      'would show a constant list forever. The signals themselves already reach ' +
      'Home Assistant where they mean something: motion as the motion sensor, a ' +
      'camera-native detection as its own binary sensor.',
  },
  {
    cap: 'network-link',
    reason:
      'Already exported, imperatively: the device catalog pushes a `Network link` ' +
      'sensor and a `Signal` percentage sensor for any device carrying the slice. ' +
      'A CAP_ENTITY_MAP row would produce a THIRD entity from the same slice, and ' +
      'the cap needs two entities from one slice (a link type and a percentage that ' +
      'is null on a wired link) which a single mapping row cannot express.',
  },
  {
    cap: 'recording-signal',
    reason:
      'A signal ABOUT the recorder, not a state of the device: it says whether this ' +
      "camera's footage is being written and why not when it is not. Home Assistant " +
      'would carry it as a property of the camera the operator is looking at, and the ' +
      'camera catalog does not model the recorder — exporting it here would put a ' +
      'CamStack-internal reason string on a device entity nothing in HA can act on.',
  },
  {
    cap: 'navigation',
    reason:
      'Rooms, zones and a map for a robot: a spatial surface with no Home Assistant ' +
      'entity shape. HA models a vacuum as a `vacuum` entity with commands, which ' +
      '`vacuum-control` already provides; the map behind it is drawn by the CamStack ' +
      'UI and has no projection that survives being flattened into a state string.',
  },
  {
    cap: 'snapshot',
    reason:
      'Carried by the camera catalog as `last_image`; a second image entity from the cap would duplicate it.',
  },
  {
    cap: 'privacy-mask',
    reason:
      'Rendered as two camera function switches (privacy-mask, device-audio) through ' +
      'deriveCameraFunctions, never written directly (D62, D113 phase 4).',
  },
  {
    cap: 'zone-analytics',
    reason: 'Projected into the per-zone object counts on the camera, not an entity of its own.',
  },
  {
    cap: 'native-object-detection',
    reason:
      'On-camera AI feeds the same per-macro entities as the pipeline; a parallel set would disagree with them.',
  },
  {
    cap: 'ptz',
    reason: 'Rendered as buttons and a preset select by the camera catalog.',
  },
  {
    cap: 'reboot',
    reason: 'Rendered as a button, gated on the `rebootable` feature rather than the binding.',
  },
  // The four infrastructure caps below carry no user-facing value. They were in
  // NEITHER list, so the guard would have fired `capabilities in neither the map
  // nor the exclusion list` on the FIRST device ever exported — a warning that
  // reads as a defect on day one and trains the reader to ignore the guard.
  // Classifying them is the whole point of the guard: a written decision, not a
  // default branch.
  {
    cap: 'device-status',
    reason:
      'Auto-registered by BaseDevice on EVERY device, so it would add an entity to all of them; availability is already the heartbeat, per device.',
  },
  {
    cap: 'feature-probe',
    reason:
      'The runtime truth about what a device CAN do — it decides which entities exist, so exporting it as one would be circular.',
  },
  {
    cap: 'device-ops',
    reason: 'The per-device operations envelope; its members surface individually (e.g. reboot).',
  },
  {
    cap: 'device-discovery',
    reason: 'Adoption-time only — it describes candidates, never the state of an adopted device.',
  },

  // ── Secrets. The strongest exclusions in this file ─────────────────────
  {
    cap: 'camera-credentials',
    reason:
      "It carries the camera's host, port and password. An entity would write that password into Home Assistant's registry and into every debug log it keeps, on a host camstack does not own. Never an entity, at any tier.",
  },
  {
    cap: 'stream-catalog',
    reason:
      "Transport — and it returns the camera's native URL with the password inline, so exporting it leaks the credential exactly as camera-credentials would. The streams reach HA as `camera` entities built from the broker restream instead (camera-entities.ts).",
  },

  // ── Camera transport and pipeline configuration ───────────────────────
  // Operator decision 6 (plan §4): these are transport, not state. Each one
  // is either a road media travels down or a knob the pipeline reads; none
  // of them is a value an automation triggers on. The OUTPUT of the pipeline
  // is what reaches HA, through the camera catalog's macro entities.
  {
    cap: 'audio-analysis',
    reason:
      "Pipeline configuration. The audio DETECTIONS it drives already reach HA as the camera catalog's `audio_last_sound` / `audio_volume` entities, from the analyzer's own event.",
  },
  {
    cap: 'camera-pipeline-config',
    reason: 'Transport/pipeline configuration — it selects the road, it is not a state.',
  },
  {
    cap: 'camera-streams',
    reason:
      'Transport. Its profile slots become the live `camera` entities (T4), which is the exported form; the slot configuration itself is not something an automation reads.',
  },
  {
    cap: 'detection-pipeline',
    reason:
      'Pipeline configuration. Its output is the per-macro camera entities, which are exported and which would disagree with a second set derived from the config.',
  },
  {
    cap: 'image-settings',
    reason:
      'Firmware image tuning — encoder brightness/contrast/saturation. A rendering setting with no state an automation reads.',
  },
  {
    cap: 'motion-detection',
    reason:
      "The LOCAL ML motion pipeline's configuration. Motion STATE is the `motion` capability, which is mapped; two sources on one question is the failure D62 records.",
  },
  {
    cap: 'motion-zones',
    reason:
      "Zone geometry, not state. Per-zone counts already reach HA through the camera catalog's zone fan-out.",
  },
  {
    cap: 'osd',
    reason: 'On-screen-display text overlay — a rendering setting with no automatable state.',
  },
  {
    cap: 'pipeline-analytics',
    reason:
      'Pipeline telemetry. Cluster health is already the CamStack Server synthetic device; per-camera pipeline counters would fan out across the fleet with nothing consuming them.',
  },
  {
    cap: 'stream-params',
    reason: 'Encoder parameters (bitrate/resolution/fps) — transport rather than state.',
  },
  {
    cap: 'device-extension',
    reason:
      'A configuration VIEW (D648): which other devices extend this one (linked ' +
      'devices, doorbell trigger sources), read from stores other addons own. It has ' +
      'no state of its own to publish, and the extended functions already export ' +
      'through their own caps.',
  },
  {
    cap: 'videoclips',
    reason:
      'Media retrieval by handle, not a state. Clips reach the operator through notifications and the viewer.',
  },
  {
    cap: 'recording',
    reason:
      'Since D625 this is the per-camera COVERAGE and PLAYBACK collection: which ' +
      'sources a camera has recordings in, what each covers over a window, and how ' +
      'to play an instant of it. Every method takes a window and a chosen source, ' +
      'so nothing here is a state a descriptor could publish — an entity would have ' +
      'to invent both. What an operator actually wants in Home Assistant is "is ' +
      'this camera recording", and that is `RecordingConfig.enabled` on ' +
      '`recording-archive`, which the camera-function switches already export as ' +
      'the ONE authority (D62). A second entity over this cap would be the second ' +
      'knob that decision forbids.',
  },
  {
    cap: 'webrtc-session',
    reason: 'A session opener — the definition of transport.',
  },
  {
    cap: 'events',
    reason:
      "A paginated event LOG, not a state. Its natural target is HA's `event` platform, which the component does not build (Tier B).",
  },

  // ── Measurements a static descriptor cannot name ──────────────────────
  {
    cap: 'scene-monitor',
    reason:
      'Per-ROI reference-region state, `monitors` being an array of operator-named regions. The entity set is per device and changes when the operator adds a region, which a static descriptor cannot express. `ITEM_ENTITY_MAP` (`item-entities.ts`) is the per-item mint that could carry it; what each region should become in Home Assistant is not decided.',
  },
  {
    cap: 'audio-metrics',
    reason:
      "A real measurement, and already exported from its authority: the camera catalog projects `audio_volume` and `audio_level_rms` from the analyzer's own `pipeline.audio-inference-result`. A second source on the same question is the two-knobs failure D62 records.",
  },

  // ── Structure and services ────────────────────────────────────────────
  {
    cap: 'notifier',
    reason:
      'A delivery service, not an entity — HA models these as `notify.<service>`, which is not one of the nine platforms the component builds.',
  },
  {
    cap: 'accessories',
    reason:
      'Grouping metadata. Every listed child is a device in its own right and is exported as one; a second entity would restate the link and disagree with it the moment a child moves.',
  },
  {
    cap: 'zones',
    reason:
      'Zone geometry — configuration, not state. Same reason as `zone-analytics`, whose per-zone counts are what actually reaches HA.',
  },
  {
    cap: 'zone-rules',
    reason:
      'Per-stage zone rules — configuration the pipeline consumes, with no value an automation reads.',
  },
  {
    cap: 'heating-valve',
    reason:
      'Radiator valve position telemetry (0–100 %). Shown on the CamStack thermostat ' +
      'row; no Home Assistant / voice-assistant entity mapping is defined yet — ' +
      'export would mint a sensor with no agreed device_class or control surface.',
  },
  {
    cap: 'running-state',
    reason:
      'The HA binary projector skips a null running reading and leaves the previous on/off in place, ' +
      'which would show a machine as running after its state became unknown. HomeKit booleans coerce ' +
      'a missing reading to false. Export waits until null can be published as unavailable (D933).',
  },
]

/**
 * What the Home Assistant on the other end can BUILD.
 *
 * The one input to the catalog that is not about the device. A capability
 * with a native platform is announced as that platform when the component
 * builds it and as its degraded `sensor` fan-out when it does not — see
 * `component-support.ts` for how the answer is obtained, and
 * `native-platforms.ts` for what changes.
 *
 * Defaulted, deliberately: a caller with no opinion gets exactly what the
 * export produced before any of this existed (`UNNEGOTIATED_SUPPORT`).
 * Forgetting to negotiate costs fidelity and can never cost entities.
 */
export interface DevicePlanOptions {
  readonly platforms: PlatformSupport
}

export const UNNEGOTIATED_PLAN_OPTIONS: DevicePlanOptions = {
  platforms: UNNEGOTIATED_SUPPORT,
}

/**
 * An entity whose platform the component cannot build, degraded to one it
 * can.
 *
 * The command topic goes with the platform: the degraded form is a
 * READING, and announcing a command topic on it would leave a route open
 * that nothing can reach. See `DEGRADED_PLATFORM` for the one entry this
 * exists for.
 */
function degradeUnsupported(spec: EntitySpec, options: DevicePlanOptions): EntitySpec {
  if (options.platforms.has(spec.platform)) return spec
  const fallback = DEGRADED_PLATFORM[spec.platform]
  if (fallback === undefined) return spec
  const { writable: _writable, ...rest } = spec
  return { ...rest, platform: fallback }
}

/** A capability in neither list — the thing the guard exists to surface. */
export function unclassifiedCaps(caps: readonly string[]): readonly string[] {
  const known = new Set([
    ...Object.keys(CAP_ENTITY_MAP),
    ...Object.keys(ITEM_ENTITY_MAP),
    ...CAPS_NOT_EXPORTED.map((e) => e.cap),
  ])
  return [...new Set(caps)].filter((cap) => !known.has(cap)).sort()
}

/**
 * The derived half: every non-camera kind, from the caps it declares.
 *
 * **Everything here arrives ENABLED**, and that is the rule rather than
 * an oversight in the other direction. A cap-derived entity IS the reason
 * the device exists — a temperature sensor's temperature, a light's
 * brightness, an alarm panel's state — and there is no fan-out to
 * protect against: measured on the live hub, 115 non-camera devices
 * produce 228 entities, 2 per device on average and 3 at most, because a
 * device declares one or two mapped caps and the rest of its bindings
 * (`device-status`, `feature-probe`, `device-ops`) carry no entity at
 * all. The camera valve is for 73-per-device; this is not that problem,
 * and exporting the operator's temperature switched off was the bug.
 *
 * **The Tier A widening qualifies that, per ENTITY rather than per
 * device.** A cover, a thermostat or a media player is not one value; it
 * is a state plus the numbers around it, and the numbers are the reason
 * to own the device. So the PRIMARY entity of every capability still
 * arrives enabled — it is what the device is — and a secondary one
 * arrives enabled only when an operator automates on it. A thermostat's
 * measured temperature: yes. Its swing preset and its dual-setpoint
 * bounds: registered and off. That keeps a widened `climate-control`
 * device at three enabled entities rather than eight, without hiding the
 * data from anyone who wants it.
 */
export function buildDerivedPlan(
  device: CatalogDevice,
  options: DevicePlanOptions = UNNEGOTIATED_PLAN_OPTIONS,
): HaDevicePlan {
  const specs: EntitySpec[] = [
    {
      entity: 'online',
      platform: 'binary_sensor',
      label: 'Online',
      deviceClass: 'connectivity',
      entityCategory: 'diagnostic',
      enabledByDefault: true,
    },
  ]
  const native: Record<string, HaComponent> = {}
  for (const cap of device.boundCaps) {
    /**
     * A camera-scoped capability is built by the CAMERA half. Nothing
     * binds `day-night` to a base device today, and if something did,
     * two halves of this file would build the same entity id twice.
     */
    if (CAMERA_DERIVED_CAPS.includes(cap)) continue
    /** Per-item: the entity set comes from the slice, not from a row. */
    if (isItemEntityCap(cap)) {
      specs.push(...itemEntitySpecs(device, cap).map((spec) => degradeUnsupported(spec, options)))
      continue
    }
    /**
     * `control` is slice-shaped: select options and number bounds are not
     * on the static row. Mint the announced platform here; the CAP_ENTITY_MAP
     * row stays the projector + writable-route authority.
     */
    if (cap === 'control') {
      specs.push(
        ...controlEntitySpecs(device.capSlices?.['control'], device.readingQuantity).map((spec) =>
          degradeUnsupported(spec, options),
        ),
      )
      continue
    }
    if (cap === 'numeric-sensor') {
      const unit =
        device.readingQuantity === undefined ? undefined : baseUnitOf(device.readingQuantity)
      specs.push(
        ...capEntitySpecs(cap).map((spec) =>
          degradeUnsupported(unit === undefined ? spec : { ...spec, unit }, options),
        ),
      )
      continue
    }
    const mapping = CAP_ENTITY_MAP[cap]
    const platform = nativePlatformFor(cap)
    const plan =
      mapping === undefined || platform === null || !options.platforms.has(platform)
        ? null
        : buildNativeComponent({
            deviceKey: deviceKeyFor(device.id),
            deviceId: device.id,
            capName: cap,
            label: humanise(cap),
            slice: device.capSlices?.[cap],
            mapping,
          })
    if (plan === null) {
      specs.push(...capEntitySpecs(cap).map((spec) => degradeUnsupported(spec, options)))
      continue
    }
    native[toComponentKey(plan.component.platform, derivedEntityId(cap))] = plan.component
    /**
     * Rule 3 of `native-platforms.ts`: what the native entity reads, it
     * owns. What it does NOT read is still announced — a vacuum's error
     * label has nowhere to go on Home Assistant's vacuum, and dropping it
     * to make the device look tidy would be a silent loss of a value an
     * operator already automates on.
     */
    specs.push(...capEntitySpecs(cap).filter((spec) => !plan.absorbed.has(spec.entity)))
  }
  const assembled = assemble(device, specs)
  return { ...assembled, cmps: { ...assembled.cmps, ...native } }
}

/** Camera or base kind — the only place that decision is made. */
export function buildDevicePlan(
  device: CatalogDevice,
  options: DevicePlanOptions = UNNEGOTIATED_PLAN_OPTIONS,
): HaDevicePlan {
  return device.type === 'camera' ? buildCameraPlan(device) : buildDerivedPlan(device, options)
}
