import { z } from 'zod'
import {
  systemMethod,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * power-source — a device that hangs is powered by a smart switch, and the
 * operator picks that switch in the device's Customize. The device then offers
 * power on, power off and a forced restart (switch off, wait, switch on).
 *
 * Manual by default: nothing here restarts a device by itself. The one
 * exception (D997) is a device's OWN provider calling `forceRestart` for its own
 * device as a bounded self-recovery (unreachable for a long stretch, linked,
 * one attempt per cooldown, never with a live session); Velux is the first. It
 * is not the native `reboot` cap and never replaces or wraps it: `reboot` talks
 * to the device, this cuts the power of the device that no longer answers.
 *
 * The link is a Customize extension (`add`): one scalar target whose source is
 * the switch. The stored composition is the ONE copy of the link and of
 * `offSeconds` (`powerSourceLinkOfComposition`, D676); the composed slice only
 * mirrors the switch state for the UI. The methods are served by the
 * `core-blocks` system provider, so they are `systemMethod`s and carry a
 * top-level `deviceId`.
 *
 * Every action answers a typed result and never throws for an expected
 * refusal, so a caller tells "the switch is offline" from "a restart is
 * already running" without parsing text.
 */

/** Bounds of the off time of a forced restart, in seconds. */
export const POWER_SOURCE_OFF_SECONDS_MIN = 3
export const POWER_SOURCE_OFF_SECONDS_MAX = 120
export const POWER_SOURCE_OFF_SECONDS_DEFAULT = 10

export const PowerSourceRefusalReasonSchema = z.enum([
  /** The device has no power source linked. */
  'no-power-source',
  /** The linked switch device cannot be found. */
  'switch-missing',
  /** The linked switch reports offline: the command could not reach it. */
  'switch-offline',
  /** The linked switch state is not known (never reported). */
  'switch-unknown',
  /** A forced restart of this device is already running. */
  'restart-in-progress',
  /** The switch call itself failed. */
  'switch-call-failed',
])
export type PowerSourceRefusalReason = z.infer<typeof PowerSourceRefusalReasonSchema>

export const PowerSourceActionResultSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }),
  z.object({
    accepted: z.literal(false),
    reason: PowerSourceRefusalReasonSchema,
    /** One line for the operator, naming the switch. */
    message: z.string(),
  }),
])
export type PowerSourceActionResult = z.infer<typeof PowerSourceActionResultSchema>

export const PowerSourceInfoSchema = z.object({
  /** False when the device has no power source linked; the rest is then empty. */
  linked: z.boolean(),
  switchDeviceId: z.number().nullable(),
  switchName: z.string().nullable(),
  /** The switch's on/off state, or null when it is unknown. Never false for unknown (D393). */
  switchOn: z.boolean().nullable(),
  switchOnline: z.boolean().nullable(),
  restartInProgress: z.boolean(),
  offSeconds: z.number().int(),
})
export type PowerSourceInfo = z.infer<typeof PowerSourceInfoSchema>

/** The composed slice: the switch state the link mirrors, plus the stored off time. */
export const PowerSourceStateSchema = z.object({
  /** Null while the switch has not reported: unknown is never `false` (D393). */
  switchOn: z.boolean().nullable(),
  offSeconds: z.number().int(),
  lastFetchedAt: z.number(),
})
export type PowerSourceState = z.infer<typeof PowerSourceStateSchema>

const POWER_SOURCE_DEVICE_TYPES = [
  DeviceType.Gateway,
  DeviceType.Hub,
  DeviceType.Camera,
  DeviceType.Sensor,
  DeviceType.MediaPlayer,
  DeviceType.Vacuum,
  DeviceType.Generic,
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
  DeviceType.PetFountain,
  DeviceType.Fan,
  DeviceType.Humidifier,
  DeviceType.Climate,
  DeviceType.WaterHeater,
] as const

const powerSourceCustomize = {
  version: 1,
  targets: [
    {
      id: 'switch',
      cardinality: 'scalar',
      vocabulary: { cap: 'power-source', stateField: 'switchOn' },
      deviceTypes: POWER_SOURCE_DEVICE_TYPES,
      apply: 'add',
      path: 'switchOn',
      sources: [{ kind: 'switch', transforms: [{ kind: 'identity' }] }],
      companions: [
        {
          kind: 'constant',
          path: 'offSeconds',
          value: POWER_SOURCE_OFF_SECONDS_DEFAULT,
          when: 'add',
          // The retired appliance helper (D1004) linked a plug with no off time.
          formerValues: [0],
        },
        { kind: 'clock', path: 'lastFetchedAt', when: 'always' },
      ],
      sourceReport: { status: 'assignment-status' },
    },
  ],
} as const satisfies CapabilityCustomizeSpec

const deviceInput = z.object({ deviceId: z.number().int().nonnegative() })

export const powerSourceCapability = {
  name: 'power-source',
  scope: 'device',
  mode: 'singleton',
  deviceTypes: POWER_SOURCE_DEVICE_TYPES,
  methods: {
    getStatus: systemMethod(deviceInput, PowerSourceInfoSchema, {
      auth: 'protected',
    }),
    powerOn: systemMethod(deviceInput, PowerSourceActionResultSchema, {
      kind: 'mutation',
      auth: 'protected',
    }),
    powerOff: systemMethod(deviceInput, PowerSourceActionResultSchema, {
      kind: 'mutation',
      auth: 'protected',
    }),
    forceRestart: systemMethod(deviceInput, PowerSourceActionResultSchema, {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  runtimeState: PowerSourceStateSchema,
  customize: powerSourceCustomize,
  /**
   * Runtime-state durability: **session** — mirrored from the linked switch on
   * its next report; a restored value would outlive the reading it names.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

export type IPowerSourceProvider = InferProvider<typeof powerSourceCapability>
