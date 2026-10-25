/**
 * Home Assistant → camstack.
 *
 * The component POSTs `{topic, value}` onto this addon's `addon-routes`
 * surface; this module turns that pair into a typed command AND owns the
 * call each capability command makes. Resolution is pure; the dispatch
 * takes an injected `DeviceProxy` slice, so both halves are testable
 * without a hub.
 *
 * **The route and the call live together on purpose.** They used not to:
 * `resolveCommand` collapsed every non-button writable cap into
 * `kind: 'cap-switch'` and the addon called `device.switch.setState`
 * unconditionally, so `lock-control`, `siren`, `alarm-panel` and
 * `brightness` all advertised a control in Home Assistant that could not
 * work — a lock got `noProvider` and a 422, and `brightness` is a number
 * that never parsed as a boolean and never routed at all. A table that
 * names a method in one file and a switch that calls it in another is
 * exactly the drift that produced four lying controls.
 *
 * The rule that shapes every branch: **an unroutable or malformed
 * command is refused, never approximated.** A `switch` payload that is
 * neither `true` nor `false` is not "off"; a PTZ press on a camera that
 * declares no `ptz` cap is not a no-op worth pretending succeeded; a cap
 * with no route does NOT fall through to `switch.setState`. Every
 * refusal carries a named reason so the log line says which of those it
 * was.
 */
import {
  AlarmArmModeSchema,
  CAMERA_SWITCH_ORDER,
  FanDirectionSchema,
  HvacModeSchema,
  MediaPlayerRepeatSchema,
  type AlarmArmMode,
  type DeviceProxy,
  type FanDirection,
  type HvacMode,
  type MediaPlayerRepeat,
} from '@camstack/types'
import { capCommandEntities, CAP_ENTITY_MAP, PTZ_BUTTONS } from './entity-catalog.js'
import type { ItemEntity } from './item-entities.js'
import { derivedEntityId, derivedExtraEntityId, toSlug } from './topics.js'

/** Everything resolution needs about the addressed device. No I/O. */
export interface CommandTarget {
  readonly deviceId: number
  readonly type: string
  readonly boundCaps: readonly string[]
  /**
   * The per-item entities the device's plan announced (`item-entities.ts`).
   * A per-item button's entity id is a SLUG of the provider's key, so the
   * key the command sends back is looked up here rather than un-slugged.
   */
  readonly itemEntities?: readonly ItemEntity[]
}

/** The camera surfaces, which are projections rather than capabilities. */
export type CameraExportCommand =
  /**
   * The per-camera function switches. Resolved through
   * `resolveCameraFunctionWrite` and applied through
   * `applyCameraFunctionWrite` — each straight onto the authority that
   * already owns the function, never a group: the HA toggle must not become a
   * second knob that can disagree with the admin UI (D62, D113 phase 4).
   */
  | {
      readonly kind: 'camera-function'
      readonly deviceId: number
      readonly switchId: string
      readonly enabled: boolean
    }
  | { readonly kind: 'reboot'; readonly deviceId: number }
  | {
      readonly kind: 'ptz-move'
      readonly deviceId: number
      readonly direction: string
    }
  | {
      readonly kind: 'ptz-preset'
      readonly deviceId: number
      readonly preset: string
    }

/** What an `alarm-panel` command asks the panel to do. */
export type AlarmCommandAction =
  | { readonly kind: 'arm'; readonly mode: AlarmArmMode }
  | { readonly kind: 'disarm' }
  | { readonly kind: 'trigger' }

/**
 * The derived half: one variant per capability that can be WRITTEN.
 *
 * Each variant names exactly one `DeviceProxy` call, and {@link applyCapCommand}
 * makes it. A capability with no variant here has no route, and a
 * descriptor that declares itself `writable` without one is refused —
 * never coerced into a neighbouring cap's method.
 */
export type CapExportCommand =
  | {
      readonly kind: 'cap-switch'
      readonly deviceId: number
      readonly capName: string
      readonly on: boolean
    }
  | {
      readonly kind: 'cap-lock'
      readonly deviceId: number
      readonly locked: boolean
    }
  /** The LATCH, not `unlock` — `LockEntityFeature.OPEN` on the HA side. */
  | { readonly kind: 'cap-lock-open'; readonly deviceId: number }
  | {
      readonly kind: 'cap-brightness'
      readonly deviceId: number
      readonly percentage: number
    }
  | {
      readonly kind: 'cap-alarm'
      readonly deviceId: number
      readonly action: AlarmCommandAction
    }
  | {
      readonly kind: 'cap-button'
      readonly deviceId: number
      readonly capName: string
    }
  /**
   * A `control` write. The payload is always a string from Home Assistant;
   * {@link applyCapCommand} reads the slice's `kind` and coerces (numeric
   * parses the string; select/text/datetime pass it through).
   */
  | {
      readonly kind: 'cap-control'
      readonly deviceId: number
      readonly value: string
    }
  // ── Tier A ────────────────────────────────────────────────────────────
  | {
      readonly kind: 'cover-position'
      readonly deviceId: number
      readonly position: number
    }
  | {
      readonly kind: 'cover-tilt'
      readonly deviceId: number
      readonly tiltPosition: number
    }
  | {
      readonly kind: 'cover-verb'
      readonly deviceId: number
      readonly verb: CoverVerb
    }
  | {
      readonly kind: 'climate-mode'
      readonly deviceId: number
      readonly mode: HvacMode
    }
  | {
      readonly kind: 'climate-target'
      readonly deviceId: number
      readonly target: number
    }
  | {
      readonly kind: 'climate-fan-mode'
      readonly deviceId: number
      readonly fanMode: string
    }
  | {
      readonly kind: 'climate-preset'
      readonly deviceId: number
      readonly preset: string
    }
  /**
   * HALF of a dual setpoint. `setTargetRange` needs both, so this variant
   * carries the edge it was given and {@link applyCapCommand} reads the
   * other one off the device before making the single call the cap declares.
   */
  | {
      readonly kind: 'climate-target-edge'
      readonly deviceId: number
      readonly edge: 'low' | 'high'
      readonly value: number
    }
  | {
      readonly kind: 'climate-target-humidity'
      readonly deviceId: number
      readonly targetHumidity: number
    }
  | {
      readonly kind: 'climate-swing'
      readonly deviceId: number
      readonly axis: 'vertical' | 'horizontal'
      readonly on: boolean
    }
  | {
      readonly kind: 'fan-percentage'
      readonly deviceId: number
      readonly percentage: number
    }
  | {
      readonly kind: 'fan-preset'
      readonly deviceId: number
      readonly preset: string
    }
  | {
      readonly kind: 'fan-oscillating'
      readonly deviceId: number
      readonly oscillating: boolean
    }
  | {
      readonly kind: 'fan-direction'
      readonly deviceId: number
      readonly direction: FanDirection
    }
  | {
      readonly kind: 'humidifier-on'
      readonly deviceId: number
      readonly on: boolean
    }
  | {
      readonly kind: 'humidifier-humidity'
      readonly deviceId: number
      readonly humidity: number
    }
  | {
      readonly kind: 'humidifier-mode'
      readonly deviceId: number
      readonly mode: string
    }
  | {
      readonly kind: 'water-heater-temp'
      readonly deviceId: number
      readonly temp: number
    }
  | {
      readonly kind: 'water-heater-away'
      readonly deviceId: number
      readonly on: boolean
    }
  | {
      readonly kind: 'water-heater-mode'
      readonly deviceId: number
      readonly mode: string
    }
  | {
      readonly kind: 'valve-position'
      readonly deviceId: number
      readonly position: number
    }
  | {
      readonly kind: 'valve-verb'
      readonly deviceId: number
      readonly verb: ValveVerb
    }
  | {
      readonly kind: 'vacuum-verb'
      readonly deviceId: number
      readonly verb: VacuumVerb
    }
  | {
      readonly kind: 'vacuum-fan-speed'
      readonly deviceId: number
      readonly speed: string
    }
  | {
      readonly kind: 'mower-verb'
      readonly deviceId: number
      readonly verb: MowerVerb
    }
  | {
      readonly kind: 'media-verb'
      readonly deviceId: number
      readonly verb: MediaVerb
    }
  | {
      readonly kind: 'media-volume'
      readonly deviceId: number
      readonly volumeLevel: number
    }
  | {
      readonly kind: 'media-mute'
      readonly deviceId: number
      readonly muted: boolean
    }
  | {
      readonly kind: 'media-shuffle'
      readonly deviceId: number
      readonly shuffle: boolean
    }
  | {
      readonly kind: 'media-repeat'
      readonly deviceId: number
      readonly repeat: MediaPlayerRepeat
    }
  | {
      readonly kind: 'media-source'
      readonly deviceId: number
      readonly source: string
    }
  | {
      readonly kind: 'color-mireds'
      readonly deviceId: number
      readonly mireds: number
    }
  | {
      readonly kind: 'script-verb'
      readonly deviceId: number
      readonly verb: ScriptVerb
    }
  | {
      readonly kind: 'automation-enabled'
      readonly deviceId: number
      readonly enabled: boolean
    }
  | { readonly kind: 'automation-trigger'; readonly deviceId: number }
  | {
      readonly kind: 'dishwasher-verb'
      readonly deviceId: number
      readonly verb: DishwasherVerb
    }
  | {
      readonly kind: 'dishwasher-switch'
      readonly deviceId: number
      readonly control: DishwasherSwitch
      readonly on: boolean
    }
  /** `consumables.reset` for one item, by the provider's own key. */
  | {
      readonly kind: 'consumable-reset'
      readonly deviceId: number
      readonly key: string
    }

/** What a dishwasher button does. */
export type DishwasherVerb = 'start' | 'pause' | 'resume' | 'stop'

/** The dishwasher switches, one per `dishwasher.set*` method that takes `{ on }`. */
export type DishwasherSwitch =
  | 'power'
  | 'child-lock'
  | 'half-load'
  | 'hygiene-plus'
  | 'extra-dry'
  | 'intensive-zone'
  | 'vario-speed-plus'

/**
 * The verb sets, one per capability whose action takes no value.
 *
 * Named unions rather than bare strings so `applyCapCommand`'s switch is
 * exhaustive: a verb added to the catalog's `commands` map without a call
 * here fails to compile instead of falling through to nothing.
 */
export type CoverVerb = 'open' | 'close' | 'stop'
export type ValveVerb = 'open' | 'close' | 'stop'
export type VacuumVerb = 'start' | 'pause' | 'stop' | 'return-to-base' | 'locate'
export type MowerVerb = 'start' | 'pause' | 'dock'
export type MediaVerb = 'play' | 'pause' | 'stop' | 'next' | 'previous'
export type ScriptVerb = 'run' | 'stop'

export type ExportCommand = CameraExportCommand | CapExportCommand

/** Why a command was refused. Named so the dropped-work log line can say. */
export type CommandRefusalReason =
  /** The entity slug addresses nothing this device exports. */
  | 'unknown-entity'
  /** The entity exists but the catalog does not declare it writable. */
  | 'not-writable'
  /** The device does not declare the capability the entity is derived from. */
  | 'cap-not-bound'
  /** Declared writable, but no capability route knows how to write it. */
  | 'no-route'
  /** The payload is not a value this entity's platform can carry. */
  | 'bad-value'

export interface CommandResolved {
  readonly ok: true
  readonly command: ExportCommand
}

export interface CommandRefused {
  readonly ok: false
  readonly reason: CommandRefusalReason
  /** The capability the entity is derived from, when there is one. */
  readonly capName?: string
}

export type CommandResolution = CommandResolved | CommandRefused

/** The camera function ids, keyed by the entity slug the catalog emits. */
const CAMERA_SWITCH_BY_SLUG: Readonly<Record<string, string>> = Object.fromEntries(
  CAMERA_SWITCH_ORDER.map((id) => [toSlug(id), id]),
)

const PTZ_DIRECTION_BY_ENTITY: Readonly<Record<string, string>> = Object.fromEntries(
  PTZ_BUTTONS.map((entity) => [entity, entity.slice('ptz_'.length)]),
)

function parseBool(value: string): boolean | null {
  const lower = value.trim().toLowerCase()
  if (lower === 'true' || lower === 'on' || lower === '1') return true
  if (lower === 'false' || lower === 'off' || lower === '0') return false
  return null
}

/**
 * A lock's payload.
 *
 * The catalog renders `lock-control` as a `switch`, so Home Assistant
 * sends `true`/`false` — but the component is not the only caller and a
 * lock's own vocabulary is `lock`/`unlock`. Both are accepted because
 * both are unambiguous; anything else is refused rather than read as
 * "unlock", which is the wrong way to be wrong about a door.
 */
function parseLocked(value: string): boolean | null {
  const asBool = parseBool(value)
  if (asBool !== null) return asBool
  const lower = value.trim().toLowerCase()
  if (lower === 'lock' || lower === 'locked') return true
  if (lower === 'unlock' || lower === 'unlocked') return false
  return null
}

/**
 * A free-form vocabulary value, as the DEVICE spells it.
 *
 * `fanMode`, `preset`, `operationMode`, `mode`, `fanSpeed` and `source` are
 * `z.string().min(1)` in their caps and their accepted values live in an
 * `available*` array on the slice. Nothing here validates against that list:
 * a pure resolution has no slice, and a second copy of the vocabulary would
 * be one firmware away from refusing a mode the device accepts. The device
 * is the authority on its own vocabulary, and its refusal surfaces with its
 * own words. Only EMPTY is refused here, because a blank is never a mode.
 */
function parseVocabulary(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 0..100 inclusive, as `brightness.setBrightness` declares it. */
function parsePercentage(value: string): number | null {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return null
  if (parsed < 0 || parsed > 100) return null
  return parsed
}

/**
 * An alarm panel's payload.
 *
 * Home Assistant's alarm-panel command vocabulary is `ARM_HOME`,
 * `ARM_AWAY`, `ARM_NIGHT`, `ARM_VACATION`, `ARM_CUSTOM_BYPASS`, `DISARM`
 * and `TRIGGER`; the cap's own vocabulary is the arm MODE (`home`,
 * `away`, …) and its state vocabulary is `armed_home`. All three are
 * accepted — they are the same instruction spelled by three layers of the
 * same stack — and the mode itself is validated by `AlarmArmModeSchema`
 * rather than by a second list here that could drift from the cap.
 */
function parseAlarmAction(value: string): AlarmCommandAction | null {
  const lower = value.trim().toLowerCase()
  if (lower === 'disarm' || lower === 'disarmed') return { kind: 'disarm' }
  if (lower === 'trigger' || lower === 'triggered') return { kind: 'trigger' }
  const withoutPrefix = lower.startsWith('armed_')
    ? lower.slice('armed_'.length)
    : lower.startsWith('arm_')
      ? lower.slice('arm_'.length)
      : lower
  const mode = AlarmArmModeSchema.safeParse(withoutPrefix)
  return mode.success ? { kind: 'arm', mode: mode.data } : null
}

/** A finite number in `[min, max]`, or `null` when the payload is neither. */
function parseBounded(value: string, min: number, max: number): number | null {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return null
  if (parsed < min || parsed > max) return null
  return parsed
}

/**
 * A payload against an enum the CAP declares.
 *
 * Never against a second list here. `HvacModeSchema`, `FanDirectionSchema`
 * and `MediaPlayerRepeatSchema` are the same objects the catalog offers as
 * the `select`'s options, so the values HA can send and the values this
 * accepts cannot drift apart.
 */
function parseEnum<T extends string>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false }
  },
  value: string,
): T | null {
  const parsed = schema.safeParse(value.trim().toLowerCase())
  return parsed.success ? parsed.data : null
}

/** A dishwasher `{ on }` switch: an unparseable payload is refused, never read as "off". */
function dishwasherSwitch(control: DishwasherSwitch): CapCommandBuilder {
  return (deviceId, value) => {
    const on = parseBool(value)
    return on === null ? null : { kind: 'dishwasher-switch', deviceId, control, on }
  }
}

/** Builds the command a capability's payload means, or `null` if it means none. */
export type CapCommandBuilder = (deviceId: number, value: string) => CapExportCommand | null

/**
 * One capability's write surface: its primary entity, its writable extras
 * and its command buttons.
 *
 * Keyed the same way the catalog keys them — `extras` and `commands` by
 * SUFFIX — so a descriptor and its route are looked up by the same string.
 * `resolveCommand` matches an incoming entity id against
 * `derivedEntityId(cap)` and `derivedExtraEntityId(cap, suffix)`, which is
 * exactly how the catalog built it.
 */
export interface CapCommandRoute {
  /** Writes the capability's PRIMARY entity. */
  readonly primary?: CapCommandBuilder
  /** Extra suffix → the builder that writes that secondary entity. */
  readonly extras?: Readonly<Record<string, CapCommandBuilder>>
  /** Command suffix → the builder for that write-only button. */
  readonly commands?: Readonly<Record<string, CapCommandBuilder>>
}

/**
 * capability → the commands that WRITE it.
 *
 * The entity catalog decides WHICH entities are writable; this decides what
 * writing each one does. An entity declared `writable` with no entry here is
 * refused with `no-route` and the drop is logged — it must never fall through
 * to another cap's method, which is how four controls came to advertise a
 * function they could not perform.
 *
 * Both directions are asserted by the specs: a writable descriptor with no
 * route fails, and a route with no descriptor fails too. An unreachable route
 * is the same defect read backwards — it describes a control the catalog
 * never built, and a leftover that describes the right design reads as
 * verification.
 *
 * **Every builder names ONE method with ONE value, and none of them reads
 * the device.** Resolution is pure and has no slice, which is why
 * `climate-control.setTargetRange` — the only cap method that takes two
 * values at once — resolves to a `climate-target-edge` carrying the half it
 * was given. The read of the other half belongs to {@link applyCapCommand},
 * which has the device; composing it here would have needed a slice this
 * function must not have.
 */
export const CAP_COMMAND_ROUTES: Readonly<Record<string, CapCommandRoute>> = {
  switch: {
    primary: (deviceId, value) => {
      const on = parseBool(value)
      return on === null ? null : { kind: 'cap-switch', deviceId, capName: 'switch', on }
    },
  },
  'lock-control': {
    primary: (deviceId, value) => {
      const locked = parseLocked(value)
      return locked === null ? null : { kind: 'cap-lock', deviceId, locked }
    },
    commands: {
      open: (deviceId) => ({ kind: 'cap-lock-open', deviceId }),
    },
  },
  brightness: {
    primary: (deviceId, value) => {
      const percentage = parsePercentage(value)
      return percentage === null ? null : { kind: 'cap-brightness', deviceId, percentage }
    },
  },
  'alarm-panel': {
    primary: (deviceId, value) => {
      const action = parseAlarmAction(value)
      return action === null ? null : { kind: 'cap-alarm', deviceId, action }
    },
  },
  button: {
    primary: (deviceId) => ({
      kind: 'cap-button',
      deviceId,
      capName: 'button',
    }),
  },
  control: {
    primary: (deviceId, value) =>
      value.trim().length === 0 ? null : { kind: 'cap-control', deviceId, value },
  },

  // ── Tier A ────────────────────────────────────────────────────────────
  cover: {
    extras: {
      position: (deviceId, value) => {
        const position = parsePercentage(value)
        return position === null ? null : { kind: 'cover-position', deviceId, position }
      },
      tilt: (deviceId, value) => {
        const tiltPosition = parsePercentage(value)
        return tiltPosition === null ? null : { kind: 'cover-tilt', deviceId, tiltPosition }
      },
    },
    commands: {
      open: (deviceId) => ({ kind: 'cover-verb', deviceId, verb: 'open' }),
      close: (deviceId) => ({ kind: 'cover-verb', deviceId, verb: 'close' }),
      stop: (deviceId) => ({ kind: 'cover-verb', deviceId, verb: 'stop' }),
    },
  },
  'climate-control': {
    primary: (deviceId, value) => {
      const mode = parseEnum(HvacModeSchema, value)
      return mode === null ? null : { kind: 'climate-mode', deviceId, mode }
    },
    extras: {
      /**
       * Bounded by the entity's declared range and nothing narrower: the
       * per-device limits are the provider's (`getOptions`), and refusing
       * here on a guess would reject a setpoint the device accepts.
       */
      target: (deviceId, value) => {
        const target = parseBounded(value, TEMPERATURE_MIN, TEMPERATURE_MAX)
        return target === null ? null : { kind: 'climate-target', deviceId, target }
      },
      'target-humidity': (deviceId, value) => {
        const targetHumidity = parsePercentage(value)
        return targetHumidity === null
          ? null
          : { kind: 'climate-target-humidity', deviceId, targetHumidity }
      },
      'fan-mode': (deviceId, value) => {
        const fanMode = parseVocabulary(value)
        return fanMode === null ? null : { kind: 'climate-fan-mode', deviceId, fanMode }
      },
      preset: (deviceId, value) => {
        const preset = parseVocabulary(value)
        return preset === null ? null : { kind: 'climate-preset', deviceId, preset }
      },
      /**
       * The two halves of `setTargetRange`, each bounded by the same range
       * `target` is. They resolve to an EDGE rather than to a call: the other
       * half is a fact about the device, and resolution is pure.
       */
      'target-low': (deviceId, value) => {
        const low = parseBounded(value, TEMPERATURE_MIN, TEMPERATURE_MAX)
        return low === null
          ? null
          : { kind: 'climate-target-edge', deviceId, edge: 'low', value: low }
      },
      'target-high': (deviceId, value) => {
        const high = parseBounded(value, TEMPERATURE_MIN, TEMPERATURE_MAX)
        return high === null
          ? null
          : {
              kind: 'climate-target-edge',
              deviceId,
              edge: 'high',
              value: high,
            }
      },
      'swing-vertical': (deviceId, value) => {
        const on = parseBool(value)
        return on === null ? null : { kind: 'climate-swing', deviceId, axis: 'vertical', on }
      },
      'swing-horizontal': (deviceId, value) => {
        const on = parseBool(value)
        return on === null ? null : { kind: 'climate-swing', deviceId, axis: 'horizontal', on }
      },
    },
  },
  'fan-control': {
    primary: (deviceId, value) => {
      const percentage = parsePercentage(value)
      return percentage === null ? null : { kind: 'fan-percentage', deviceId, percentage }
    },
    extras: {
      preset: (deviceId, value) => {
        const preset = parseVocabulary(value)
        return preset === null ? null : { kind: 'fan-preset', deviceId, preset }
      },
      oscillating: (deviceId, value) => {
        const oscillating = parseBool(value)
        return oscillating === null ? null : { kind: 'fan-oscillating', deviceId, oscillating }
      },
      direction: (deviceId, value) => {
        const direction = parseEnum(FanDirectionSchema, value)
        return direction === null ? null : { kind: 'fan-direction', deviceId, direction }
      },
    },
  },
  humidifier: {
    primary: (deviceId, value) => {
      const on = parseBool(value)
      return on === null ? null : { kind: 'humidifier-on', deviceId, on }
    },
    extras: {
      'target-humidity': (deviceId, value) => {
        const humidity = parsePercentage(value)
        return humidity === null ? null : { kind: 'humidifier-humidity', deviceId, humidity }
      },
      mode: (deviceId, value) => {
        const mode = parseVocabulary(value)
        return mode === null ? null : { kind: 'humidifier-mode', deviceId, mode }
      },
    },
  },
  'water-heater': {
    extras: {
      target: (deviceId, value) => {
        const temp = parseBounded(value, TEMPERATURE_MIN, TEMPERATURE_MAX)
        return temp === null ? null : { kind: 'water-heater-temp', deviceId, temp }
      },
      away: (deviceId, value) => {
        const on = parseBool(value)
        return on === null ? null : { kind: 'water-heater-away', deviceId, on }
      },
      mode: (deviceId, value) => {
        const mode = parseVocabulary(value)
        return mode === null ? null : { kind: 'water-heater-mode', deviceId, mode }
      },
    },
  },
  valve: {
    extras: {
      position: (deviceId, value) => {
        const position = parsePercentage(value)
        return position === null ? null : { kind: 'valve-position', deviceId, position }
      },
    },
    commands: {
      open: (deviceId) => ({ kind: 'valve-verb', deviceId, verb: 'open' }),
      close: (deviceId) => ({ kind: 'valve-verb', deviceId, verb: 'close' }),
      stop: (deviceId) => ({ kind: 'valve-verb', deviceId, verb: 'stop' }),
    },
  },
  'vacuum-control': {
    extras: {
      'fan-speed': (deviceId, value) => {
        const speed = parseVocabulary(value)
        return speed === null ? null : { kind: 'vacuum-fan-speed', deviceId, speed }
      },
    },
    commands: {
      start: (deviceId) => ({ kind: 'vacuum-verb', deviceId, verb: 'start' }),
      pause: (deviceId) => ({ kind: 'vacuum-verb', deviceId, verb: 'pause' }),
      stop: (deviceId) => ({ kind: 'vacuum-verb', deviceId, verb: 'stop' }),
      'return-to-base': (deviceId) => ({
        kind: 'vacuum-verb',
        deviceId,
        verb: 'return-to-base',
      }),
      locate: (deviceId) => ({ kind: 'vacuum-verb', deviceId, verb: 'locate' }),
    },
  },
  dishwasher: {
    extras: {
      power: dishwasherSwitch('power'),
      'child-lock': dishwasherSwitch('child-lock'),
      'half-load': dishwasherSwitch('half-load'),
      'hygiene-plus': dishwasherSwitch('hygiene-plus'),
      'extra-dry': dishwasherSwitch('extra-dry'),
      'intensive-zone': dishwasherSwitch('intensive-zone'),
      'vario-speed-plus': dishwasherSwitch('vario-speed-plus'),
    },
    commands: {
      start: (deviceId) => ({ kind: 'dishwasher-verb', deviceId, verb: 'start' }),
      pause: (deviceId) => ({ kind: 'dishwasher-verb', deviceId, verb: 'pause' }),
      resume: (deviceId) => ({ kind: 'dishwasher-verb', deviceId, verb: 'resume' }),
      stop: (deviceId) => ({ kind: 'dishwasher-verb', deviceId, verb: 'stop' }),
    },
  },
  'lawn-mower-control': {
    commands: {
      start: (deviceId) => ({ kind: 'mower-verb', deviceId, verb: 'start' }),
      pause: (deviceId) => ({ kind: 'mower-verb', deviceId, verb: 'pause' }),
      dock: (deviceId) => ({ kind: 'mower-verb', deviceId, verb: 'dock' }),
    },
  },
  'media-player': {
    extras: {
      volume: (deviceId, value) => {
        const volumeLevel = parsePercentage(value)
        return volumeLevel === null ? null : { kind: 'media-volume', deviceId, volumeLevel }
      },
      muted: (deviceId, value) => {
        const muted = parseBool(value)
        return muted === null ? null : { kind: 'media-mute', deviceId, muted }
      },
      shuffle: (deviceId, value) => {
        const shuffle = parseBool(value)
        return shuffle === null ? null : { kind: 'media-shuffle', deviceId, shuffle }
      },
      repeat: (deviceId, value) => {
        const repeat = parseEnum(MediaPlayerRepeatSchema, value)
        return repeat === null ? null : { kind: 'media-repeat', deviceId, repeat }
      },
      source: (deviceId, value) => {
        const source = parseVocabulary(value)
        return source === null ? null : { kind: 'media-source', deviceId, source }
      },
    },
    commands: {
      play: (deviceId) => ({ kind: 'media-verb', deviceId, verb: 'play' }),
      pause: (deviceId) => ({ kind: 'media-verb', deviceId, verb: 'pause' }),
      stop: (deviceId) => ({ kind: 'media-verb', deviceId, verb: 'stop' }),
      next: (deviceId) => ({ kind: 'media-verb', deviceId, verb: 'next' }),
      previous: (deviceId) => ({
        kind: 'media-verb',
        deviceId,
        verb: 'previous',
      }),
    },
  },
  color: {
    extras: {
      mireds: (deviceId, value) => {
        const mireds = parseBounded(value, MIRED_MIN, MIRED_MAX)
        // `ColorInputSchema` declares mireds as an INT. Rounding a fractional
        // payload would send the device a colour the operator did not ask for.
        if (mireds === null || !Number.isInteger(mireds)) return null
        return { kind: 'color-mireds', deviceId, mireds }
      },
    },
  },
  'script-runner': {
    commands: {
      run: (deviceId) => ({ kind: 'script-verb', deviceId, verb: 'run' }),
      stop: (deviceId) => ({ kind: 'script-verb', deviceId, verb: 'stop' }),
    },
  },
  'automation-control': {
    primary: (deviceId, value) => {
      const enabled = parseBool(value)
      return enabled === null ? null : { kind: 'automation-enabled', deviceId, enabled }
    },
    commands: {
      trigger: (deviceId) => ({ kind: 'automation-trigger', deviceId }),
    },
  },
}

/**
 * The bounds the parsers enforce, kept HERE rather than imported from the
 * catalog's `TEMPERATURE_RANGE` / `MIRED_RANGE`: the catalog's ranges are
 * what Home Assistant is TOLD, and these are what the hub ACCEPTS. They
 * agree today, and the catalog spec asserts they still do — but the
 * assertion has to be able to fail, which it cannot if both read one
 * constant.
 */
const TEMPERATURE_MIN = -20
const TEMPERATURE_MAX = 90
const MIRED_MIN = 50
const MIRED_MAX = 1000

/**
 * capability → what pressing one of its per-item buttons does. The builder
 * receives the item's KEY in place of a payload (a button's payload is
 * always `PRESS`). Keyed like `ITEM_ENTITY_MAP`; the spec asserts every cap
 * there that mints a button has a route here.
 */
export const ITEM_COMMAND_ROUTES: Readonly<Record<string, CapCommandBuilder>> = {
  consumables: (deviceId, key) =>
    key.length === 0 ? null : { kind: 'consumable-reset', deviceId, key },
}

/** Whether a capability's PRIMARY entity can be written. */
export function hasCommandRoute(capName: string): boolean {
  return CAP_COMMAND_ROUTES[capName]?.primary !== undefined
}

/** Whether a capability's `extras[suffix]` entity can be written. */
export function hasExtraCommandRoute(capName: string, suffix: string): boolean {
  return CAP_COMMAND_ROUTES[capName]?.extras?.[suffix] !== undefined
}

/** Whether a capability's `commands[suffix]` button can be pressed. */
export function hasButtonCommandRoute(capName: string, suffix: string): boolean {
  return CAP_COMMAND_ROUTES[capName]?.commands?.[suffix] !== undefined
}

export function resolveCommand(
  target: CommandTarget,
  entity: string,
  value: string,
): CommandResolution {
  /**
   * The per-item half — first, because a camera binds per-item caps too.
   * Only a `button` is a command; the item it addresses is the one the plan
   * announced, so a press for an item that left the
   * slice (or was never resettable) is `unknown-entity`, never a guess.
   */
  const item = target.itemEntities?.find(
    (candidate) => candidate.entity === entity && candidate.platform === 'button',
  )
  if (item !== undefined) {
    if (!target.boundCaps.includes(item.capName)) {
      return { ok: false, reason: 'cap-not-bound', capName: item.capName }
    }
    return build(ITEM_COMMAND_ROUTES[item.capName], target.deviceId, item.itemKey, item.capName)
  }

  if (target.type === 'camera') {
    const switchId = CAMERA_SWITCH_BY_SLUG[entity]
    if (switchId !== undefined) {
      const enabled = parseBool(value)
      if (enabled === null) return { ok: false, reason: 'bad-value' }
      return {
        ok: true,
        command: {
          kind: 'camera-function',
          deviceId: target.deviceId,
          switchId,
          enabled,
        },
      }
    }

    if (entity === 'reboot') {
      return {
        ok: true,
        command: { kind: 'reboot', deviceId: target.deviceId },
      }
    }

    const direction = PTZ_DIRECTION_BY_ENTITY[entity]
    if (direction !== undefined) {
      if (!target.boundCaps.includes('ptz'))
        return { ok: false, reason: 'cap-not-bound', capName: 'ptz' }
      return {
        ok: true,
        command: { kind: 'ptz-move', deviceId: target.deviceId, direction },
      }
    }

    if (entity === 'ptz_preset') {
      if (!target.boundCaps.includes('ptz'))
        return { ok: false, reason: 'cap-not-bound', capName: 'ptz' }
      if (value.trim().length === 0) return { ok: false, reason: 'bad-value', capName: 'ptz' }
      return {
        ok: true,
        command: {
          kind: 'ptz-preset',
          deviceId: target.deviceId,
          preset: value,
        },
      }
    }

    return { ok: false, reason: 'unknown-entity' }
  }

  /**
   * The derived half.
   *
   * One capability can produce several entities — a cover is a state, two
   * positions and three verbs — so the match is against every id the CATALOG
   * builds for the cap, through the same two expressions it used
   * (`derivedEntityId` / `derivedExtraEntityId`). Anything derived from the
   * catalog rather than re-spelled here cannot address an entity that does
   * not exist, which is the failure the shared expressions were extracted to
   * end.
   */
  for (const capName of Object.keys(CAP_ENTITY_MAP)) {
    const route = CAP_COMMAND_ROUTES[capName]

    // Value entities: primary and extras, matched by the catalog's own ids.
    if (derivedEntityId(capName) === entity) {
      const mapping = CAP_ENTITY_MAP[capName]
      if (mapping?.writable !== true) return { ok: false, reason: 'not-writable', capName }
      if (!target.boundCaps.includes(capName)) {
        return { ok: false, reason: 'cap-not-bound', capName }
      }
      return build(route?.primary, target.deviceId, value, capName)
    }
    for (const [suffix, extra] of Object.entries(CAP_ENTITY_MAP[capName]?.extras ?? {})) {
      if (derivedExtraEntityId(capName, suffix) !== entity) continue
      if (extra.writable !== true) return { ok: false, reason: 'not-writable', capName }
      if (!target.boundCaps.includes(capName)) {
        return { ok: false, reason: 'cap-not-bound', capName }
      }
      return build(route?.extras?.[suffix], target.deviceId, value, capName)
    }

    /**
     * Command buttons. A button carries no state, so there is no `writable`
     * to consult — its existence in the catalog IS the declaration, and the
     * route table is the other half. The payload (`PRESS`) is ignored on
     * purpose: HA sends whatever `payload_press` says and the verb is
     * already in the topic.
     */
    for (const ref of capCommandEntities(capName)) {
      if (ref.entity !== entity) continue
      if (!target.boundCaps.includes(capName)) {
        return { ok: false, reason: 'cap-not-bound', capName }
      }
      return build(route?.commands?.[ref.suffix], target.deviceId, value, capName)
    }
  }

  return { ok: false, reason: 'unknown-entity' }
}

/** Run a builder, or name the refusal. The one place `no-route` is decided. */
function build(
  builder: CapCommandBuilder | undefined,
  deviceId: number,
  value: string,
  capName: string,
): CommandResolution {
  if (builder === undefined) return { ok: false, reason: 'no-route', capName }
  const command = builder(deviceId, value)
  if (command === null) return { ok: false, reason: 'bad-value', capName }
  return { ok: true, command }
}

/**
 * The camera half, listed rather than the capability half.
 *
 * The capability half is the one that grows — every Tier A row adds a
 * variant — and a narrowing written the other way round would silently send
 * each new one down the camera switch below. There are five camera
 * projections and there have been for the life of this file.
 */
function isCameraCommand(command: ExportCommand): command is CameraExportCommand {
  switch (command.kind) {
    case 'camera-function':
    case 'reboot':
    case 'ptz-move':
    case 'ptz-preset':
      return true
    default:
      return false
  }
}

/** Narrows an `ExportCommand` to the half {@link applyCapCommand} can make. */
export function isCapCommand(command: ExportCommand): command is CapExportCommand {
  return !isCameraCommand(command)
}

/**
 * The `DeviceProxy` surface a capability command writes through.
 *
 * A `Pick` of the generated proxy rather than a hand-written interface:
 * the method names and their inputs are then the codegen's, so a cap
 * whose signature changes fails to compile here instead of failing at
 * runtime on a device nobody is watching.
 */
export type CapCommandDevice = Pick<
  DeviceProxy,
  | 'switch'
  | 'lockControl'
  | 'brightness'
  | 'alarmPanel'
  | 'button'
  | 'control'
  | 'cover'
  | 'climateControl'
  | 'fanControl'
  | 'humidifier'
  | 'waterHeater'
  | 'valve'
  | 'vacuumControl'
  | 'lawnMowerControl'
  | 'mediaPlayer'
  | 'color'
  | 'scriptRunner'
  | 'automationControl'
  | 'dishwasher'
  | 'consumables'
>

export interface CapCommandApplied {
  readonly ok: true
}

export interface CapCommandFailed {
  readonly ok: false
  /** `no-provider`: the device declares the cap but nothing serves it. */
  readonly reason: 'no-provider' | 'refused'
  readonly capName: string
  readonly error?: string
}

export type CapCommandOutcome = CapCommandApplied | CapCommandFailed

/**
 * Make the call the command names.
 *
 * Every branch names ONE method on ONE cap. Nothing here falls back to a
 * neighbouring cap: a device that declares `lock-control` but serves no
 * provider for it is refused with `no-provider`, and the caller logs the
 * drop rather than turning a lock into a switch.
 */
export async function applyCapCommand(
  device: CapCommandDevice,
  command: CapExportCommand,
): Promise<CapCommandOutcome> {
  switch (command.kind) {
    case 'cap-switch': {
      if (device.switch === undefined) {
        return { ok: false, reason: 'no-provider', capName: command.capName }
      }
      await device.switch.setState({ on: command.on })
      return { ok: true }
    }
    case 'cap-lock': {
      if (device.lockControl === undefined) {
        return { ok: false, reason: 'no-provider', capName: 'lock-control' }
      }
      if (command.locked) await device.lockControl.lock({})
      else await device.lockControl.unlock({})
      return { ok: true }
    }
    case 'cap-lock-open': {
      if (device.lockControl === undefined) {
        return { ok: false, reason: 'no-provider', capName: 'lock-control' }
      }
      /**
       * A lock without a latch REFUSES this, and the refusal is the answer.
       * `lock-control` declares `open` unconditionally while the latch is a
       * property of the hardware, so the provider is the only thing that
       * knows — reporting success over its refusal would leave Home
       * Assistant showing a door that opened and did not.
       */
      try {
        await device.lockControl.open({})
      } catch (err) {
        return {
          ok: false,
          reason: 'refused',
          capName: 'lock-control',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      return { ok: true }
    }
    case 'cap-brightness': {
      if (device.brightness === undefined) {
        return { ok: false, reason: 'no-provider', capName: 'brightness' }
      }
      await device.brightness.setBrightness({ percentage: command.percentage })
      return { ok: true }
    }
    case 'cap-alarm': {
      if (device.alarmPanel === undefined) {
        return { ok: false, reason: 'no-provider', capName: 'alarm-panel' }
      }
      /**
       * **The arm can be REFUSED.** CamStack's own panel throws
       * `NcAlarmArmRefusedError` when a contact the mode covers is open,
       * and that refusal is the operator's answer — reporting success
       * over it would leave Home Assistant showing `armed_away` on a
       * house with an open door. It is caught HERE rather than left to
       * the caller's generic catch so the reason is named `refused` and
       * the panel's own message survives into the log.
       */
      try {
        switch (command.action.kind) {
          case 'arm':
            await device.alarmPanel.arm({ mode: command.action.mode })
            break
          case 'disarm':
            await device.alarmPanel.disarm({})
            break
          case 'trigger':
            await device.alarmPanel.trigger({})
            break
        }
      } catch (err) {
        return {
          ok: false,
          reason: 'refused',
          capName: 'alarm-panel',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      return { ok: true }
    }
    case 'cap-button': {
      if (device.button === undefined) {
        return { ok: false, reason: 'no-provider', capName: command.capName }
      }
      await device.button.press({})
      return { ok: true }
    }
    case 'cap-control':
      return call(device.control, 'control', async (control) => {
        const status = await control.getStatus({})
        if (status === null || typeof status !== 'object') {
          throw new Error('the device reports no control status, so setValue has no kind')
        }
        const kind = Reflect.get(status, 'kind')
        if (kind === 'numeric') {
          const numeric = Number(command.value)
          if (!Number.isFinite(numeric)) {
            throw new Error(`control value is not a number: ${command.value}`)
          }
          await control.setValue({ control: { kind: 'numeric', value: numeric } })
          return
        }
        if (kind === 'select' || kind === 'text' || kind === 'datetime') {
          await control.setValue({ control: { kind, value: command.value } })
          return
        }
        throw new Error(`unsupported control kind: ${String(kind)}`)
      })

    // ── Tier A ──────────────────────────────────────────────────────────
    case 'cover-position':
      return call(device.cover, 'cover', (cover) =>
        cover.setPosition({ position: command.position }),
      )
    case 'cover-tilt':
      return call(device.cover, 'cover', (cover) =>
        cover.setTiltPosition({ tiltPosition: command.tiltPosition }),
      )
    case 'cover-verb':
      return call(device.cover, 'cover', (cover) => {
        switch (command.verb) {
          case 'open':
            return cover.open({})
          case 'close':
            return cover.close({})
          case 'stop':
            return cover.stop({})
        }
      })
    case 'climate-mode':
      return call(device.climateControl, 'climate-control', (climate) =>
        climate.setMode({ mode: command.mode }),
      )
    case 'climate-target':
      return call(device.climateControl, 'climate-control', (climate) =>
        climate.setTarget({ target: command.target }),
      )
    case 'climate-fan-mode':
      return call(device.climateControl, 'climate-control', (climate) =>
        climate.setFanMode({ fanMode: command.fanMode }),
      )
    case 'climate-preset':
      return call(device.climateControl, 'climate-control', (climate) =>
        climate.setPreset({ preset: command.preset }),
      )
    /**
     * The one read-then-write in this file, and the reason is the cap's
     * signature rather than a preference: `setTargetRange` takes both edges
     * and Home Assistant sends them one at a time. The OTHER edge is read
     * from `getStatus` — the provider's own current answer — and a `null`
     * there is REFUSED, because a dual-setpoint device that reports no range
     * has no range to move one edge of, and substituting the single `target`
     * would silently collapse the band to a point.
     */
    case 'climate-target-edge':
      return call(device.climateControl, 'climate-control', async (climate) => {
        const status = await climate.getStatus({})
        if (status === null) {
          throw new Error('the device reports no climate status, so setTargetRange has no range')
        }
        const low = command.edge === 'low' ? command.value : status.targetLow
        const high = command.edge === 'high' ? command.value : status.targetHigh
        if (low === null || high === null) {
          throw new Error(
            `the device reports no ${command.edge === 'low' ? 'high' : 'low'} setpoint, so setTargetRange has nothing to preserve`,
          )
        }
        await climate.setTargetRange({ targetLow: low, targetHigh: high })
      })
    case 'climate-target-humidity':
      return call(device.climateControl, 'climate-control', (climate) =>
        climate.setTargetHumidity({ targetHumidity: command.targetHumidity }),
      )
    case 'climate-swing':
      return call(device.climateControl, 'climate-control', (climate) =>
        command.axis === 'vertical'
          ? climate.setSwingVertical({ on: command.on })
          : climate.setSwingHorizontal({ on: command.on }),
      )
    case 'fan-percentage':
      return call(device.fanControl, 'fan-control', (fan) =>
        fan.setPercentage({ percentage: command.percentage }),
      )
    case 'fan-preset':
      return call(device.fanControl, 'fan-control', (fan) =>
        fan.setPreset({ preset: command.preset }),
      )
    case 'fan-oscillating':
      return call(device.fanControl, 'fan-control', (fan) =>
        fan.setOscillating({ oscillating: command.oscillating }),
      )
    case 'fan-direction':
      return call(device.fanControl, 'fan-control', (fan) =>
        fan.setDirection({ direction: command.direction }),
      )
    case 'humidifier-on':
      return call(device.humidifier, 'humidifier', (humidifier) =>
        humidifier.setOn({ on: command.on }),
      )
    case 'humidifier-humidity':
      return call(device.humidifier, 'humidifier', (humidifier) =>
        humidifier.setTargetHumidity({ humidity: command.humidity }),
      )
    case 'humidifier-mode':
      return call(device.humidifier, 'humidifier', (humidifier) =>
        humidifier.setMode({ mode: command.mode }),
      )
    case 'water-heater-temp':
      return call(device.waterHeater, 'water-heater', (heater) =>
        heater.setTargetTemp({ temp: command.temp }),
      )
    case 'water-heater-away':
      return call(device.waterHeater, 'water-heater', (heater) =>
        heater.setAway({ on: command.on }),
      )
    case 'water-heater-mode':
      return call(device.waterHeater, 'water-heater', (heater) =>
        heater.setOperationMode({ mode: command.mode }),
      )
    case 'valve-position':
      return call(device.valve, 'valve', (valve) =>
        valve.setPosition({ position: command.position }),
      )
    case 'valve-verb':
      return call(device.valve, 'valve', (valve) => {
        switch (command.verb) {
          case 'open':
            return valve.open({})
          case 'close':
            return valve.close({})
          case 'stop':
            return valve.stop({})
        }
      })
    case 'vacuum-verb':
      return call(device.vacuumControl, 'vacuum-control', (vacuum) => {
        switch (command.verb) {
          case 'start':
            return vacuum.start({})
          case 'pause':
            return vacuum.pause({})
          case 'stop':
            return vacuum.stop({})
          case 'return-to-base':
            return vacuum.returnToBase({})
          case 'locate':
            return vacuum.locate({})
        }
      })
    case 'vacuum-fan-speed':
      return call(device.vacuumControl, 'vacuum-control', (vacuum) =>
        vacuum.setFanSpeed({ speed: command.speed }),
      )
    case 'mower-verb':
      return call(device.lawnMowerControl, 'lawn-mower-control', (mower) => {
        switch (command.verb) {
          case 'start':
            return mower.startMowing({})
          case 'pause':
            return mower.pause({})
          case 'dock':
            return mower.dock({})
        }
      })
    case 'media-verb':
      return call(device.mediaPlayer, 'media-player', (media) => {
        switch (command.verb) {
          case 'play':
            return media.play({})
          case 'pause':
            return media.pause({})
          case 'stop':
            return media.stop({})
          case 'next':
            return media.next({})
          case 'previous':
            return media.previous({})
        }
      })
    case 'media-volume':
      return call(device.mediaPlayer, 'media-player', (media) =>
        media.setVolume({ volumeLevel: command.volumeLevel }),
      )
    case 'media-mute':
      return call(device.mediaPlayer, 'media-player', (media) =>
        media.setMute({ muted: command.muted }),
      )
    case 'media-shuffle':
      return call(device.mediaPlayer, 'media-player', (media) =>
        media.setShuffle({ shuffle: command.shuffle }),
      )
    case 'media-repeat':
      return call(device.mediaPlayer, 'media-player', (media) =>
        media.setRepeat({ repeat: command.repeat }),
      )
    case 'media-source':
      return call(device.mediaPlayer, 'media-player', (media) =>
        media.selectSource({ source: command.source }),
      )
    case 'color-mireds':
      return call(device.color, 'color', (color) =>
        color.setColor({ color: { mode: 'mired', mireds: command.mireds } }),
      )
    case 'script-verb':
      return call(device.scriptRunner, 'script-runner', (script) =>
        command.verb === 'run' ? script.run({}) : script.stop({}),
      )
    case 'automation-enabled':
      return call(device.automationControl, 'automation-control', (automation) =>
        command.enabled ? automation.enable({}) : automation.disable({}),
      )
    case 'automation-trigger':
      return call(device.automationControl, 'automation-control', (automation) =>
        automation.trigger({}),
      )
    case 'dishwasher-verb':
      return call(device.dishwasher, 'dishwasher', (dishwasher) => {
        switch (command.verb) {
          case 'start':
            return dishwasher.start({})
          case 'pause':
            return dishwasher.pause({})
          case 'resume':
            return dishwasher.resume({})
          case 'stop':
            return dishwasher.stop({})
        }
      })
    case 'dishwasher-switch':
      return call(device.dishwasher, 'dishwasher', (dishwasher) => {
        switch (command.control) {
          case 'power':
            return dishwasher.setPower({ on: command.on })
          case 'child-lock':
            return dishwasher.setChildLock({ on: command.on })
          case 'half-load':
            return dishwasher.setHalfLoad({ on: command.on })
          case 'hygiene-plus':
            return dishwasher.setHygienePlus({ on: command.on })
          case 'extra-dry':
            return dishwasher.setExtraDry({ on: command.on })
          case 'intensive-zone':
            return dishwasher.setIntensiveZone({ on: command.on })
          case 'vario-speed-plus':
            return dishwasher.setVarioSpeedPlus({ on: command.on })
        }
      })
    case 'consumable-reset':
      return call(device.consumables, 'consumables', (consumables) =>
        consumables.reset({ key: command.key }),
      )
  }
}

/**
 * One capability call, with the two outcomes that are not success.
 *
 * `no-provider` is a device that DECLARES the cap and serves nothing —
 * distinct from a throw, which is the device REFUSING. The distinction is the
 * whole reason `alarm-panel` grew its own try/catch first: an arm the panel
 * turns down (`NcAlarmArmRefusedError`, a contact the mode covers is open) is
 * the operator's answer and must reach them with the panel's own words, not
 * as an optimistic success. Every Tier A method can refuse the same way — a
 * cover already moving, a vacuum with an empty tank, a climate mode the unit
 * does not have in `availableModes` — so the handling is here rather than
 * repeated per branch.
 */
async function call<TSlice>(
  slice: TSlice | undefined,
  capName: string,
  make: (slice: TSlice) => Promise<void>,
): Promise<CapCommandOutcome> {
  if (slice === undefined) return { ok: false, reason: 'no-provider', capName }
  try {
    await make(slice)
  } catch (err) {
    return {
      ok: false,
      reason: 'refused',
      capName,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return { ok: true }
}
