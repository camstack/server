/**
 * The NATIVE half of the Home Assistant export.
 *
 * A `cover` in Home Assistant is one entity with an open/close/stop
 * surface, a position slider and a tilt slider. Exported through the nine
 * platforms the 0.3.x component builds it is a `sensor` plus two more
 * `sensor`s plus three `button`s — automatable, but not a cover: no
 * `cover.open_cover`, no position in the more-info dialog, no
 * `device_class: garage`, and every dashboard card that expects a cover
 * refuses it. Same for a lock (`jammed` is not a boolean), a thermostat,
 * a vacuum and a media player.
 *
 * From component 0.4.0 those platforms exist, and this table says which
 * capability becomes which one. It is **structure only**: the topics a
 * native component names are the topics the DEGRADED entities already
 * used, so `state-projector.ts` is untouched and the value plane cannot
 * disagree with the entity plane. Nothing here publishes a value.
 *
 * ── Three rules, each with a cost behind it ──────────────────────────────
 *
 * 1. **A control appears only when its descriptor is writable.** The
 *    authority is `CAP_ENTITY_MAP` — the same flag that decides whether the
 *    degraded entity gets a command topic, and therefore the same flag that
 *    tracks `CAP_COMMAND_ROUTES`. A native cover on a hub whose route table
 *    cannot move a cover is a READ-ONLY cover: it shows state, position and
 *    tilt and offers no buttons. A control that calls nothing is the defect
 *    this repo has shipped twice (D62), and a prettier platform is not a
 *    reason to ship it a third time.
 *
 * 2. **A binding whose entity does not exist is skipped.** The degraded
 *    table is being widened in parallel (verb buttons, writable numbers).
 *    Every binding below is resolved against `CAP_ENTITY_MAP` at build
 *    time, so a control lights up the moment its descriptor appears and
 *    costs nothing until then. This is what lets the two halves land in
 *    either order.
 *
 * 3. **What the native entity reads, it OWNS — and only that.** A bound
 *    entity is not announced separately: a native cover plus a `sensor`
 *    reporting the same position is two readings of one value, and a native
 *    cover plus a `number` writing the same position is two knobs (D62).
 *    Everything NOT bound stays exactly as it was, and that is the property
 *    that makes widening safe in both directions: a vacuum's error label is
 *    still a diagnostic sensor because HA's vacuum cannot show one, and a
 *    thermostat's vertical-swing toggle is still a `switch` because HA's
 *    climate expresses swing as a mode vocabulary the capability does not
 *    have. A control this table has no binding for is never silently lost —
 *    it is simply not absorbed.
 */

import { commandTopic, derivedEntityId, derivedExtraEntityId, stateTopic } from './topics.js'
import type { HaComponent, HaNativeControl, HaPlatform } from './types.js'

/**
 * The half of a `CapEntityMapping` this builder reads.
 *
 * Structural on purpose. `entity-catalog.ts` is the authority and passes
 * its own rows in; declaring only what is read here means this file
 * compiles against the table BEFORE and AFTER the degraded half grows its
 * writable numbers and its verb buttons, which is the whole reason the two
 * can be worked on at once.
 */
export interface NativeSourceDescriptor {
  readonly writable?: boolean
  readonly range?: {
    readonly min: number
    readonly max: number
    readonly step: number
  }
  readonly unit?: string
}

export interface NativeSourceMapping extends NativeSourceDescriptor {
  readonly extras?: Readonly<Record<string, NativeSourceDescriptor>>
  /** Write-only verb buttons. Present once the degraded table declares them. */
  readonly commands?: Readonly<Record<string, unknown>>
}

/**
 * One sub-control of a native entity.
 *
 * `from` names the entity the control is bound to: `null` is the
 * capability's PRIMARY entity, anything else is the `extras` (or verb
 * button) suffix. The control therefore reads the topic that entity
 * already publishes on, and writes the topic the route table already
 * resolves — a native platform introduces no topic and no vocabulary of
 * its own.
 */
export interface NativeControlBinding {
  readonly from: string | null
  /**
   * The entity whose COMMAND topic this control writes, when it is not the
   * one it reads.
   *
   * One capability needs it and the reason is worth stating: the degraded
   * `lock-control` is a `switch`, so its primary entity publishes a
   * DERIVED boolean and the enum lives on the `state` extra. A native lock
   * reads the enum — `jammed` is the whole reason the platform is worth
   * having — and writes the switch, which is what `parseLocked` routes.
   */
  readonly commandFrom?: string | null
  /** The control carries no value; only a command. A verb button. */
  readonly commandOnly?: boolean
  /** Slice field holding the values this control accepts (`availableModes`, …). */
  readonly optionsField?: string
  /** Slice fields holding the per-device bounds (`minTemp`, `maxHumidity`, …). */
  readonly minField?: string
  readonly maxField?: string
  /** Slice field holding the per-device granularity (`percentageStep`). */
  readonly stepField?: string
  /** Static bounds, when the device reports none. */
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

export interface NativePlatformMapping {
  readonly platform: HaPlatform
  readonly deviceClass?: string
  readonly icon?: string
  /**
   * The entity's OWN state and command. `from` is usually `null`, but a
   * water heater's Home Assistant state is its operation MODE while the
   * capability's primary entity is the measured temperature — so the
   * binding names the entity rather than assuming the primary.
   */
  readonly primary: NativeControlBinding
  readonly controls?: Readonly<Record<string, NativeControlBinding>>
  /** Emitted verbatim on the component. `temperature_unit`, and nothing implicit. */
  readonly constants?: Readonly<Record<string, string>>
  /** Boolean component keys read from the slice — `code_arm_required`. */
  readonly flagFields?: Readonly<Record<string, string>>
}

/**
 * capability → the native Home Assistant platform it becomes.
 *
 * Every capability here also has a row in `CAP_ENTITY_MAP`, which stays
 * the fallback for a component that does not build the platform. The two
 * are never both announced.
 */
export const NATIVE_CAP_PLATFORMS: Readonly<Record<string, NativePlatformMapping>> = {
  /**
   * `CoverStatusSchema`: `state` is the HA lifecycle verbatim
   * (`open`/`opening`/`closing`/`closed`/`stopped`), `position` and
   * `tiltPosition` are 0..100 or null. The three verbs are bound BOTH ways:
   * to the primary command topic (one topic, `OPEN`/`CLOSE`/`STOP`) and to
   * the per-verb buttons, so whichever the degraded table grows, the
   * native cover can drive it.
   */
  cover: {
    platform: 'cover',
    primary: { from: null },
    controls: {
      position: { from: 'position', min: 0, max: 100, step: 1 },
      tilt: { from: 'tilt', min: 0, max: 100, step: 1 },
      open: { from: 'open', commandOnly: true },
      close: { from: 'close', commandOnly: true },
      stop: { from: 'stop', commandOnly: true },
    },
  },
  /** `ValveStatusSchema` — the cover lifecycle without tilt. */
  valve: {
    platform: 'valve',
    primary: { from: null },
    controls: {
      position: { from: 'position', min: 0, max: 100, step: 1 },
      open: { from: 'open', commandOnly: true },
      close: { from: 'close', commandOnly: true },
      stop: { from: 'stop', commandOnly: true },
    },
  },
  /**
   * The reason this platform exists. `LockStateSchema` is
   * `locked | unlocked | locking | unlocking | jammed`, and every one of
   * those is a state Home Assistant's `lock` has — including the one a
   * `switch` silently reports as "unlocked".
   *
   * It READS the enum extra and WRITES the switch. The degraded primary
   * publishes a boolean derived from the same field, so binding the state
   * to it would throw away exactly the distinction the platform is for.
   */
  'lock-control': {
    platform: 'lock',
    primary: { from: 'state', commandFrom: null },
    controls: { open: { from: 'open', commandOnly: true } },
  },
  /**
   * `AlarmStateSchema` IS Home Assistant's alarm vocabulary, and
   * `availableModes` is the subset this panel accepts — a panel that
   * cannot arm `vacation` must not offer the button. `requiresCode` is the
   * panel's own answer about a PIN.
   *
   * This is also the only row here whose degraded form is a REGRESSION
   * rather than the status quo: `CAP_ENTITY_MAP` already names
   * `alarm_control_panel`, which the 0.3.x component does not build, so an
   * alarm panel exported to it produces NO entity at all. The fallback
   * below gives those installations the state as a sensor.
   */
  'alarm-panel': {
    platform: 'alarm_control_panel',
    primary: { from: null, optionsField: 'availableModes' },
    flagFields: { code_arm_required: 'requiresCode' },
  },
  /**
   * `ClimateControlStatusSchema`. Every temperature is Celsius by the
   * cap's own doc comment, and the mode/fan-mode/preset vocabularies are
   * `available*` arrays on the DEVICE — which is exactly why they cannot be
   * a static `select` in the degraded table and can be a native climate
   * here: the component receives the list with the entity.
   */
  'climate-control': {
    platform: 'climate',
    primary: { from: null, optionsField: 'availableModes' },
    constants: { temperature_unit: '°C' },
    controls: {
      current_temperature: { from: 'current-temp' },
      current_humidity: { from: 'current-humidity' },
      target_humidity: { from: 'target-humidity', min: 0, max: 100, step: 1 },
      target: { from: 'target', min: -20, max: 90, step: 0.5 },
      target_low: { from: 'target-low', min: -20, max: 90, step: 0.5 },
      target_high: { from: 'target-high', min: -20, max: 90, step: 0.5 },
      fan_mode: { from: 'fan-mode', optionsField: 'availableFanModes' },
      preset: { from: 'preset', optionsField: 'availablePresets' },
    },
  },
  /**
   * A fan has no `on` field: `percentage` IS its state and 0 is off, which
   * is what Home Assistant's fan does too (`turn_off` writes 0).
   * `percentageStep` is the device's own granularity — a 4-speed fan
   * reports 25, and a step of 1 would offer 37% to hardware that rounds it.
   */
  'fan-control': {
    platform: 'fan',
    primary: { from: null, min: 0, max: 100, step: 1, stepField: 'percentageStep' },
    controls: {
      preset: { from: 'preset', optionsField: 'availablePresets' },
      oscillation: { from: 'oscillating' },
      direction: { from: 'direction' },
    },
  },
  /** `HumidifierStatusSchema`. `minHumidity`/`maxHumidity` are per device. */
  humidifier: {
    platform: 'humidifier',
    deviceClass: 'humidifier',
    primary: { from: null },
    controls: {
      current_humidity: { from: 'current-humidity' },
      target_humidity: {
        from: 'target-humidity',
        minField: 'minHumidity',
        maxField: 'maxHumidity',
        min: 0,
        max: 100,
        step: 1,
      },
      mode: { from: 'mode', optionsField: 'availableModes' },
      action: { from: 'action' },
    },
  },
  /**
   * Home Assistant's water heater IS its operation mode — the entity state
   * is `eco`/`performance`/`off`, not a temperature. The capability's
   * primary entity is the MEASURED temperature, so the primary binding
   * names the mode extra and the measurement becomes a control.
   */
  'water-heater': {
    platform: 'water_heater',
    primary: { from: 'mode', optionsField: 'availableModes' },
    constants: { temperature_unit: '°C' },
    controls: {
      current_temperature: { from: null },
      target: {
        from: 'target',
        minField: 'minTemp',
        maxField: 'maxTemp',
        min: -20,
        max: 90,
        step: 0.5,
      },
      away: { from: 'away' },
    },
  },
  /**
   * `VacuumStateSchema` is `idle|cleaning|paused|returning|docked|drying|error`;
   * Home Assistant has every one but `drying`, which the component folds
   * into `cleaning` rather than dropping the update.
   *
   * Battery, progress and the error label are deliberately NOT absorbed.
   * Home Assistant deprecated the vacuum battery attribute in favour of a
   * separate `sensor`, and it has nowhere to show a progress percentage or
   * a vendor error string at all — as sensors they stay automatable.
   */
  'vacuum-control': {
    platform: 'vacuum',
    primary: { from: null },
    controls: {
      fan_speed: { from: 'fan-speed', optionsField: 'availableFanSpeeds' },
      start: { from: 'start', commandOnly: true },
      pause: { from: 'pause', commandOnly: true },
      stop: { from: 'stop', commandOnly: true },
      return_to_base: { from: 'return-to-base', commandOnly: true },
      locate: { from: 'locate', commandOnly: true },
    },
  },
  /**
   * `MediaPlayerStatusSchema`. `volumeLevel` is 0..100 in the cap and
   * 0..1 in Home Assistant — the component converts, in one place, because
   * a factor of 100 applied on the wrong side is a player that jumps to
   * full volume.
   *
   * `currentMedia` is an object and stays unexported: title and artist
   * would need a projector that walks into a sub-object, and an entity
   * that reports `unrenderable` on every delivery is worse than one that
   * does not exist.
   */
  'media-player': {
    platform: 'media_player',
    primary: { from: null },
    controls: {
      volume: { from: 'volume', min: 0, max: 100, step: 1 },
      mute: { from: 'muted' },
      source: { from: 'source', optionsField: 'availableSources' },
      shuffle: { from: 'shuffle' },
      repeat: { from: 'repeat' },
      play: { from: 'play', commandOnly: true },
      pause: { from: 'pause', commandOnly: true },
      stop: { from: 'stop', commandOnly: true },
      next: { from: 'next', commandOnly: true },
      previous: { from: 'previous', commandOnly: true },
    },
  },
}

/**
 * What a platform becomes when the component on the other end cannot
 * build it.
 *
 * The native platforms never reach this: `buildDerivedPlan` asks about
 * support BEFORE choosing one, and falls back to the capability's own
 * degraded row. This is for the other direction — a platform the DEGRADED
 * table already names that an older component still does not build.
 *
 * There is exactly one, and it is a live defect rather than a
 * hypothetical: the export has been announcing `alarm_control_panel`
 * since the native export shipped, and the 0.3.x component builds eight
 * platforms not including it. Every alarm panel exported to one of those
 * installations produced a warning line and no entity at all. A `sensor`
 * carrying the panel state is not an alarm card, but it is a value an
 * operator can automate on, which is strictly more than nothing.
 */
export const DEGRADED_PLATFORM: Readonly<Partial<Record<HaPlatform, HaPlatform>>> = {
  alarm_control_panel: 'sensor',
}

/** Everything the builder needs about the device. No I/O, no registry. */
export interface NativeBuildInput {
  readonly deviceKey: string
  /** The numeric device id — the `unique_id` prefix. See `deviceKeyFor`. */
  readonly deviceId: number
  readonly capName: string
  readonly label: string
  /** The capability's status slice, for the option lists and the bounds. */
  readonly slice: Readonly<Record<string, unknown>> | undefined
  /** The capability's row in `CAP_ENTITY_MAP`. */
  readonly mapping: NativeSourceMapping
}

export interface NativeComponentPlan {
  readonly component: HaComponent
  /** Entity ids the native component owns; the catalog announces no others. */
  readonly absorbed: ReadonlySet<string>
}

/** Whether a capability has a native platform at all. */
export function nativePlatformFor(capName: string): HaPlatform | null {
  return NATIVE_CAP_PLATFORMS[capName]?.platform ?? null
}

function readStringArray(slice: Readonly<Record<string, unknown>> | undefined, field: string) {
  const raw = slice?.[field]
  if (!Array.isArray(raw)) return undefined
  const values = raw.filter((entry): entry is string => typeof entry === 'string')
  return values.length > 0 ? values : undefined
}

function readNumber(slice: Readonly<Record<string, unknown>> | undefined, field: string) {
  const raw = slice?.[field]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * Resolve one binding against the degraded table.
 *
 * Returns `null` when the entity it names does not exist — that is rule 2,
 * and it is what lets a control be declared here before the descriptor
 * that feeds it exists. `writable` decides the command topic and nothing
 * else: a control with no route is a control with no command, never an
 * absent one, because the READING is still worth having.
 */
/** One entity of the degraded table, resolved. `null` when it does not exist. */
interface ResolvedEntity {
  readonly entity: string
  readonly writable: boolean
  readonly descriptor: NativeSourceDescriptor | undefined
}

function resolveEntity(input: NativeBuildInput, suffix: string | null): ResolvedEntity | null {
  const { capName, mapping } = input
  const descriptor = suffix === null ? mapping : mapping.extras?.[suffix]
  const isCommandEntity =
    suffix !== null && descriptor === undefined && mapping.commands?.[suffix] !== undefined
  if (descriptor === undefined && !isCommandEntity) return null
  return {
    entity: suffix === null ? derivedEntityId(capName) : derivedExtraEntityId(capName, suffix),
    writable: isCommandEntity || descriptor?.writable === true,
    descriptor,
  }
}

function resolveBinding(
  input: NativeBuildInput,
  binding: NativeControlBinding,
): { readonly entities: readonly string[]; readonly control: HaNativeControl } | null {
  const { deviceKey } = input
  const source = resolveEntity(input, binding.from)
  if (source === null) return null
  /**
   * The written entity, when it is not the read one. Absent rather than
   * refused: a control whose command entity does not exist is still a
   * READING worth announcing.
   */
  const target =
    binding.commandFrom === undefined ? source : resolveEntity(input, binding.commandFrom)

  const entity = source.entity
  const descriptor = source.descriptor
  const writable = target?.writable === true
  const options =
    binding.optionsField === undefined
      ? undefined
      : readStringArray(input.slice, binding.optionsField)
  /**
   * The DEVICE's own bounds win over the static ones. A heat-pump water
   * heater that reports `maxTemp: 60` must not offer 90, and a static
   * range is only ever the backstop for hardware that reports none.
   */
  const min =
    (binding.minField === undefined ? undefined : readNumber(input.slice, binding.minField)) ??
    descriptor?.range?.min ??
    binding.min
  const max =
    (binding.maxField === undefined ? undefined : readNumber(input.slice, binding.maxField)) ??
    descriptor?.range?.max ??
    binding.max
  const step =
    (binding.stepField === undefined ? undefined : readNumber(input.slice, binding.stepField)) ??
    descriptor?.range?.step ??
    binding.step
  const control: HaNativeControl = {
    ...(binding.commandOnly === true ? {} : { state_topic: stateTopic(deviceKey, entity) }),
    ...(writable && target !== null
      ? { command_topic: commandTopic(deviceKey, target.entity) }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
  }
  return {
    entities: target === null || target.entity === entity ? [entity] : [entity, target.entity],
    control,
  }
}

/**
 * Build one native component, or `null` when the capability has none.
 *
 * The component's identity — its `unique_id` and therefore the component
 * key — is the capability's PRIMARY entity id, the same one the degraded
 * `sensor` used. Home Assistant keys its registry on
 * `(platform, integration, unique_id)`, so this is a NEW entity even
 * though the id is unchanged, and the old one is removed by the
 * component's own diff rather than left orphaned. That is the whole
 * migration, and `docs/design/ecosystem-export-plan.md` records why an
 * in-place one is not possible.
 */
export function buildNativeComponent(input: NativeBuildInput): NativeComponentPlan | null {
  const native = NATIVE_CAP_PLATFORMS[input.capName]
  if (native === undefined) return null

  const primary = resolveBinding(input, native.primary)
  // A native platform whose own state has no source is not a platform.
  if (primary === null) return null

  const absorbed = new Set<string>([derivedEntityId(input.capName), ...primary.entities])
  const controls: Record<string, HaNativeControl> = {}
  for (const [name, binding] of Object.entries(native.controls ?? {})) {
    const resolved = resolveBinding(input, binding)
    if (resolved === null) continue
    controls[name] = resolved.control
    for (const entity of resolved.entities) absorbed.add(entity)
  }

  const flags: Record<string, boolean> = {}
  for (const [key, field] of Object.entries(native.flagFields ?? {})) {
    const raw = input.slice?.[field]
    if (typeof raw === 'boolean') flags[key] = raw
  }

  const component: HaComponent = {
    platform: native.platform,
    unique_id: `${input.deviceId}_${derivedEntityId(input.capName)}`,
    name: input.label,
    ...primary.control,
    ...(native.deviceClass !== undefined ? { device_class: native.deviceClass } : {}),
    ...(native.icon !== undefined ? { icon: native.icon } : {}),
    ...(Object.keys(controls).length > 0 ? { controls } : {}),
    ...native.constants,
    ...flags,
  }
  return { component, absorbed }
}
