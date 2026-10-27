/**
 * One method table per actuator type (D944). A group offers a method only
 * when every member can take it, so a command never reaches a member that
 * lacks the surface: the cap must be bound by every member (the primary cap of
 * the type is the exception — a member that lacks it is simply not commanded),
 * and a row that names a device feature needs every member to advertise it.
 * Offline does not remove a method: capability is the binding, not liveness.
 */
import { DeviceFeature } from '../../device/device-type.js'

export const ACTUATOR_TEMPLATE_IDS = [
  'switch',
  'light',
  'fan',
  'cover',
  'valve',
  'lock',
  'media-player',
  'climate',
] as const
export type ActuatorTemplateId = (typeof ACTUATOR_TEMPLATE_IDS)[number]

export interface ActuatorMethodRow {
  readonly cap: string
  readonly method: string
  /** Every member must advertise this feature for the row to be shared. */
  readonly requires: DeviceFeature | null
  /** The call must say `confirm: true`; the group refuses it otherwise. */
  readonly confirm: boolean
}

function row(
  cap: string,
  method: string,
  requires: DeviceFeature | null = null,
  confirm = false,
): ActuatorMethodRow {
  return { cap, method, requires, confirm }
}

/** The first row's cap is the type's own: always offered, members without it are skipped. */
export const ACTUATOR_METHODS: Readonly<Record<ActuatorTemplateId, readonly ActuatorMethodRow[]>> =
  {
    switch: [row('switch', 'setState')],
    light: [
      row('switch', 'setState'),
      row('brightness', 'setBrightness'),
      row('color', 'setColor'),
    ],
    fan: [
      row('switch', 'setState'),
      row('fan-control', 'setPercentage', DeviceFeature.FanSpeed),
      row('fan-control', 'setPreset', DeviceFeature.FanPreset),
      row('fan-control', 'setDirection', DeviceFeature.FanDirection),
      row('fan-control', 'setOscillating', DeviceFeature.FanOscillating),
    ],
    cover: [
      row('cover', 'open'),
      row('cover', 'close'),
      row('cover', 'stop'),
      row('cover', 'setPosition', DeviceFeature.CoverPositionable),
      row('cover', 'setTiltPosition', DeviceFeature.CoverTilt),
    ],
    valve: [
      row('valve', 'open'),
      row('valve', 'close'),
      row('valve', 'setPosition', DeviceFeature.ValvePositionable),
    ],
    lock: [row('lock-control', 'lock'), row('lock-control', 'unlock', null, true)],
    'media-player': [
      row('media-player', 'play'),
      row('media-player', 'pause'),
      row('media-player', 'setVolume', DeviceFeature.MediaPlayerVolume),
    ],
    climate: [
      row('climate-control', 'setMode'),
      row('climate-control', 'setTarget'),
      row('climate-control', 'setFanMode', DeviceFeature.ClimateFanMode),
    ],
  }

export interface ActuatorMemberSurface {
  readonly caps: readonly string[]
  readonly features: readonly string[]
}

export function actuatorMethodRow(
  templateId: ActuatorTemplateId,
  cap: string,
  method: string,
): ActuatorMethodRow | null {
  return (
    ACTUATOR_METHODS[templateId].find((item) => item.cap === cap && item.method === method) ?? null
  )
}

/**
 * The rows every member can take. An empty member list shares nothing; the
 * caller passes a surface for every member it could read, or none at all.
 */
export function sharedActuatorMethods(
  templateId: ActuatorTemplateId,
  members: readonly ActuatorMemberSurface[],
): readonly ActuatorMethodRow[] {
  if (members.length === 0) return []
  const rows = ACTUATOR_METHODS[templateId]
  const primary = rows[0]?.cap
  return rows.filter((item) => {
    const bound = item.cap === primary || members.every((member) => member.caps.includes(item.cap))
    if (!bound) return false
    const needed = item.requires
    return needed === null || members.every((member) => member.features.includes(needed))
  })
}

/** The device features every member has, among those the table gates on, in table order. */
export function sharedActuatorFeatures(
  templateId: ActuatorTemplateId,
  featureLists: readonly (readonly string[])[],
): readonly DeviceFeature[] {
  if (featureLists.length === 0) return []
  const gated = ACTUATOR_METHODS[templateId].flatMap((item) =>
    item.requires === null ? [] : [item.requires],
  )
  const unique = [...new Set(gated)]
  return unique.filter((feature) => featureLists.every((features) => features.includes(feature)))
}

export const UNLOCK_CONFIRMATION: string =
  'unlocking a group of locks needs an explicit confirmation (confirm: true) — it was not given, so no lock was sent anything'

/**
 * Why a call must not be fanned out, or null. Only a confirmed row passes
 * without `confirm: true`; anything else is the caller's to refuse by name.
 */
export function methodRefusal(
  method: ActuatorMethodRow | null,
  args: Readonly<Record<string, unknown>>,
): string | null {
  if (method === null) return 'that method is not one this group shares'
  if (method.confirm && args.confirm !== true) return UNLOCK_CONFIRMATION
  return null
}
