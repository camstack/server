/**
 * "Do" actions an operator can pick for a device — presentation-free.
 *
 * The wire shape stays `{ cap, method, args }`. Since D920 this module no
 * longer HOLDS a catalogue: {@link DEVICE_DO_ACTIONS} is a projection of the
 * cap vocabulary (`cap-vocabulary/`), the one cap-keyed map of every action
 * and trigger — so a picker built on this module and one built on
 * `actionsForDevice` (the vocabulary resolver) can never disagree about what
 * a device can do. Ids, baked args and the matching of saved steps are the
 * vocabulary's; labels here are its English labels.
 *
 * Shared by the admin NC Sequences / rule Do editor and Automations; the
 * viewer can reuse the same catalogue once its step editor catches up.
 */
import { METHOD_ACCESS_MAP } from '../generated/method-access-map.js'
import type {
  LooseVocabAction,
  LooseVocabOffer,
  LooseVocabOpenArg,
} from './cap-vocabulary/types.js'
import { CAP_VOCABULARY_BY_NAME } from './cap-vocabulary/vocabulary.js'
import { DeviceType } from './device-type.js'

/** An arg the authoring UI collects (not baked into the catalogue entry). */
export interface DeviceDoOpenArg {
  readonly key: string
  readonly label: string
  readonly kind: 'string' | 'number'
  /** How the vocabulary says to offer values (enum, range, the device's own list). */
  readonly offer?: LooseVocabOffer
  /** The method accepts the call without it. */
  readonly optional?: boolean
}

/** One operator-facing action that becomes a cap method call. */
export interface DeviceDoAction {
  /** Stable id for the select value, e.g. `switch.on`. */
  readonly id: string
  /** Human label shown in the picker. */
  readonly label: string
  readonly cap: string
  readonly method: string
  readonly args?: Readonly<Record<string, unknown>>
  /**
   * Keys the operator fills after picking the action (e.g. `presetId` for
   * `ptz.goToPreset`). Matching ignores these — only baked {@link args} must
   * agree — so a saved step with a filled preset still selects this entry.
   */
  readonly openArgs?: readonly DeviceDoOpenArg[]
}

function openArgKind(offer: LooseVocabOffer): DeviceDoOpenArg['kind'] {
  if (offer.kind === 'number') return 'number'
  if (offer.kind === 'dynamic' && offer.valueKind === 'number') return 'number'
  if (offer.kind === 'enum' && offer.values.every((v) => typeof v.value === 'number'))
    return 'number'
  return 'string'
}

function projectOpenArg(arg: LooseVocabOpenArg): DeviceDoOpenArg {
  return {
    key: arg.key,
    label: arg.label.en,
    kind: openArgKind(arg.offer),
    offer: arg.offer,
    ...(arg.optional === true ? { optional: true } : {}),
  }
}

function projectAction(cap: string, action: LooseVocabAction): DeviceDoAction {
  const open = action.openArgs ?? []
  return {
    id: action.id,
    label: action.label.en,
    cap,
    method: action.method,
    args: action.args ?? {},
    ...(open.length > 0 ? { openArgs: open.map(projectOpenArg) } : {}),
  }
}

/**
 * The catalogue: every device-cap action of the vocabulary, in the
 * vocabulary's order (the order the select draws). Args are baked in so the
 * authoring UI never asks for JSON for these.
 */
export const DEVICE_DO_ACTIONS: readonly DeviceDoAction[] = Object.entries(
  CAP_VOCABULARY_BY_NAME,
).flatMap(([cap, entry]) =>
  entry.scope === 'device' ? (entry.actions ?? []).map((a) => projectAction(cap, a)) : [],
)

/** True when METHOD_ACCESS_MAP still exposes this cap.method as actuatable. */
export function isDoActionActuatable(action: DeviceDoAction): boolean {
  for (const [path, record] of Object.entries(METHOD_ACCESS_MAP)) {
    if (record.capName !== action.cap) continue
    if (record.capScope !== 'device') continue
    if (record.access === 'view') continue
    const method = path.slice(path.indexOf('.') + 1)
    if (method === action.method) return true
  }
  return false
}

function valueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return left === right
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!valueEqual(left[i], right[i])) return false
    }
    return true
  }
  const a = left as Readonly<Record<string, unknown>>
  const b = right as Readonly<Record<string, unknown>>
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!valueEqual(a[key], b[key])) return false
  }
  return true
}

function argsEqual(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return valueEqual(left ?? {}, right ?? {})
}

/** Baked args only — open-arg keys the operator fills are ignored for matching. */
function bakedArgsEqual(
  action: DeviceDoAction,
  args: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (action.openArgs !== undefined) {
    const open = new Set(action.openArgs.map((a) => a.key))
    const baked = action.args ?? {}
    const actual = args ?? {}
    for (const key of Object.keys(baked)) {
      if (!valueEqual(baked[key], actual[key])) return false
    }
    for (const key of Object.keys(actual)) {
      if (open.has(key)) continue
      if (!(key in baked)) return false
    }
    return true
  }
  return argsEqual(action.args, args)
}

/**
 * Catalogue caps a `DeviceType` is expected to offer in the Do picker.
 *
 * Exhaustive over {@link DeviceType}: adding a new enum member without an
 * entry fails the TypeScript build here (same pattern as
 * {@link DEVICE_TYPE_CONTROL_KIND}). An empty list is a deliberate choice
 * for read-only / non-actuatable types — never "forgotten".
 *
 * Camera accessories (ptz, privacy-mask, …) are listed on Camera even though
 * a given camera may bind only a subset; {@link actionsForBoundCaps} still
 * filters to what the device actually binds.
 */
export const DEVICE_TYPE_DO_CAPS: Record<DeviceType, readonly string[]> = {
  [DeviceType.Camera]: [
    'ptz',
    'ptz-autotrack',
    'privacy-mask',
    'day-night',
    'reboot',
    'motion-trigger',
  ],
  [DeviceType.Hub]: [],
  [DeviceType.Light]: ['switch', 'brightness'],
  [DeviceType.Siren]: ['switch', 'motion-trigger'],
  [DeviceType.Switch]: ['switch', 'motion-trigger'],
  [DeviceType.Sensor]: [],
  [DeviceType.Thermostat]: ['climate-control'],
  [DeviceType.Climate]: ['climate-control'],
  [DeviceType.Button]: ['button'],
  [DeviceType.EventEmitter]: [],
  [DeviceType.Update]: [],
  [DeviceType.Generic]: [],
  [DeviceType.Notifier]: [],
  [DeviceType.Script]: ['script-runner'],
  [DeviceType.Automation]: ['automation-control'],
  [DeviceType.Lock]: ['lock-control'],
  [DeviceType.Cover]: ['cover'],
  [DeviceType.Valve]: ['valve'],
  [DeviceType.Humidifier]: ['humidifier'],
  [DeviceType.WaterHeater]: ['water-heater'],
  [DeviceType.Fan]: ['fan-control', 'switch'],
  [DeviceType.MediaPlayer]: ['media-player'],
  [DeviceType.AlarmPanel]: ['alarm-panel'],
  [DeviceType.Control]: [],
  [DeviceType.Presence]: [],
  [DeviceType.Weather]: [],
  [DeviceType.Vacuum]: ['vacuum-control'],
  [DeviceType.LawnMower]: ['lawn-mower-control'],
  // Container is a parent grouping node (HA device with entity-children), not
  // an actuatable target — kept as `[]` so the Record stays exhaustive, and
  // excluded from Do pickers via {@link isDoPickerDeviceType}.
  [DeviceType.Container]: [],
  [DeviceType.Image]: [],
  [DeviceType.PetFeeder]: ['pet-feeder'],
  [DeviceType.Dishwasher]: ['dishwasher'],
}

/**
 * Whether a device type belongs in a Do / automation action device picker.
 *
 * Containers stay in {@link DEVICE_TYPE_DO_CAPS} (empty, for exhaustiveness)
 * but must never appear as selectable targets — actuate the children instead.
 */
export function isDoPickerDeviceType(type: string): boolean {
  return type !== DeviceType.Container
}

/**
 * Do-picker family id — devices that share one may be multi-selected for
 * the same action (several locks, the climate family, cover+valve, …).
 *
 * Distinct from {@link DeviceControlKind}: humidifier / water-heater keep
 * their own control widgets but author with climate siblings.
 */
export function deviceDoFamily(type: string): string {
  switch (type) {
    case DeviceType.Climate:
    case DeviceType.Thermostat:
    case DeviceType.Humidifier:
    case DeviceType.WaterHeater:
      return 'climate-family'
    case DeviceType.Cover:
    case DeviceType.Valve:
      return 'cover-family'
    case DeviceType.Switch:
    case DeviceType.Siren:
    case DeviceType.Light:
      return 'switch-family'
    case DeviceType.Vacuum:
    case DeviceType.LawnMower:
      return 'robot-family'
    default:
      return type
  }
}

/** True when two device types may share one multi-target Do step. */
export function sameDoFamily(leftType: string, rightType: string): boolean {
  return deviceDoFamily(leftType) === deviceDoFamily(rightType)
}

/**
 * Actions offered for a device that binds the given caps.
 *
 * Only catalogue entries whose cap is bound AND still actuatable in
 * METHOD_ACCESS_MAP. Empty bindings → empty list (pick a device first).
 */
export function actionsForBoundCaps(boundCaps: readonly string[]): readonly DeviceDoAction[] {
  if (boundCaps.length === 0) return []
  const set = new Set(boundCaps)
  return DEVICE_DO_ACTIONS.filter((action) => set.has(action.cap) && isDoActionActuatable(action))
}

/**
 * Catalogue actions for a wire `DeviceType` string — the fallback when
 * bindings have not answered yet (or answered empty for a typed actuator).
 * Unknown type strings → empty.
 */
export function actionsForDeviceType(type: string): readonly DeviceDoAction[] {
  if (!Object.values(DeviceType).includes(type as DeviceType)) return []
  return actionsForBoundCaps(DEVICE_TYPE_DO_CAPS[type as DeviceType])
}

/**
 * Union of bound-cap actions with the type's expected catalogue caps.
 *
 * Bindings win for filtering (a lock without `lock-control` bound still
 * offers nothing from bindings alone); the type map fills gaps when the
 * binding read is empty so a Lock / Valve / Climate never shows
 * "No actions for this device" solely because getBindings lagged.
 */
export function actionsForDevice(input: {
  readonly boundCaps: readonly string[] | undefined
  readonly deviceType: string | undefined
}): readonly DeviceDoAction[] {
  const fromBound =
    input.boundCaps !== undefined && input.boundCaps.length > 0
      ? actionsForBoundCaps(input.boundCaps)
      : []
  if (fromBound.length > 0) return fromBound
  if (input.deviceType !== undefined && input.deviceType.length > 0) {
    return actionsForDeviceType(input.deviceType)
  }
  return []
}

/**
 * Intersection of {@link actionsForDevice} across several targets — what a
 * multi-select same-family Do step may offer.
 */
export function actionsForDevices(
  targets: readonly { readonly boundCaps?: readonly string[]; readonly deviceType?: string }[],
): readonly DeviceDoAction[] {
  if (targets.length === 0) return []
  let common: readonly DeviceDoAction[] | null = null
  for (const target of targets) {
    const offered = actionsForDevice({
      boundCaps: target.boundCaps,
      deviceType: target.deviceType,
    })
    if (common === null) {
      common = offered
      continue
    }
    const ids = new Set(offered.map((a) => a.id))
    common = common.filter((a) => ids.has(a.id))
  }
  return common ?? []
}

/** The whole catalogue (still actuatable) — for a `{$var}` automation target. */
export function allDoActions(): readonly DeviceDoAction[] {
  return DEVICE_DO_ACTIONS.filter(isDoActionActuatable)
}

/**
 * Match a saved wire step to a catalogue entry, or null when it is outside
 * the catalogue (legacy / custom). Args must agree when the entry bakes them.
 */
export function matchDoAction(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): DeviceDoAction | null {
  for (const action of DEVICE_DO_ACTIONS) {
    if (action.cap !== cap || action.method !== method) continue
    if (!bakedArgsEqual(action, args)) continue
    return action
  }
  return null
}

/** Select value for a saved step: catalogue id, or a synthetic custom key. */
export function doActionSelectValue(
  cap: string,
  method: string,
  args: Readonly<Record<string, unknown>> | undefined,
): string {
  const hit = matchDoAction(cap, method, args)
  if (hit !== null) return hit.id
  return `custom:${cap}.${method}`
}
