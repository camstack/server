import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { RemoteConfigSchema, RemotePowerModeSchema } from '../remote/remote-config.js'
import { RemoteRoleSchema } from '../remote/remote-roles.js'

/**
 * remote — a button panel over a device (D963). The operator binds a ROLE
 * (`power`, `volume_up`, `custom:source_hdmi_1`, …) to an action — a cap method
 * called on a device, the shape an Action step has — and picks a layout
 * template that places the roles on a grid. What a button does is the action's
 * business: an infrared code is `ir-transmitter.send` on the transmitter, a smart
 * TV is whatever cap drives it.
 *
 * It is a Customize extension (D944) of a media player: the configuration is
 * the operator's, stored per device, and the editor is derived from the
 * `config` target below. A media-player command whose role is bound here goes
 * through the binding for EVERY caller (UI, automation, exporter); an unbound
 * role falls back to the native cap.
 *
 * `sendCommand` answers a typed result and never throws for an expected
 * refusal, so a caller tells "that role is not bound" from "the board is off"
 * without parsing text. How many times a command is sent is the CALLER's
 * (`repeat`, volume steps), never a stored setting.
 */

export const REMOTE_MAX_REPEAT = 50

export const RemoteBoundCommandSchema = z.object({
  role: RemoteRoleSchema,
  /** The operator's name for a custom button; absent for a known role. */
  label: z.string().optional(),
  custom: z.boolean(),
})
export type RemoteBoundCommand = z.infer<typeof RemoteBoundCommandSchema>

export const RemoteCommandListSchema = z.object({
  layoutTemplateId: z.string().nullable(),
  power: z.object({ mode: RemotePowerModeSchema }),
  /** Only the roles that are BOUND — the ones a press can reach. */
  commands: z.array(RemoteBoundCommandSchema),
})
export type RemoteCommandList = z.infer<typeof RemoteCommandListSchema>

export const REMOTE_REFUSAL_REASONS = ['no-remote', 'unbound-role', 'action-failed'] as const
export const RemoteRefusalReasonSchema = z.enum(REMOTE_REFUSAL_REASONS)
export type RemoteRefusalReason = z.infer<typeof RemoteRefusalReasonSchema>

export const RemoteSendResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('sent'),
    /** How many times the action ran. */
    sends: z.number().int().min(1),
  }),
  /** A power command the device is already in the state of: nothing was sent. */
  z.object({ status: z.literal('skipped'), reason: z.literal('already-in-state') }),
  z.object({
    status: z.literal('refused'),
    reason: RemoteRefusalReasonSchema,
    detail: z.string().optional(),
  }),
])
export type RemoteSendResult = z.infer<typeof RemoteSendResultSchema>

/** The media-player commands a bound remote role takes over (precedence, D963). */
export const REMOTE_MEDIA_COMMANDS = [
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'setMute',
  'selectSource',
] as const
export const RemoteMediaCommandSchema = z.enum(REMOTE_MEDIA_COMMANDS)
export type RemoteMediaCommand = z.infer<typeof RemoteMediaCommandSchema>

/** A send result, or `not-routed`: the role is not bound, so the native cap answers. */
export const RemoteMediaCommandResultSchema = z.discriminatedUnion('status', [
  ...RemoteSendResultSchema.options,
  z.object({ status: z.literal('not-routed') }),
])
export type RemoteMediaCommandResult = z.infer<typeof RemoteMediaCommandResultSchema>

export const REMOTE_CONFIG_REFUSALS = ['unknown-template', 'not-a-media-player'] as const
export const RemoteSetConfigResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved') }),
  z.object({
    status: z.literal('refused'),
    reason: z.enum(REMOTE_CONFIG_REFUSALS),
    detail: z.string(),
  }),
])
export type RemoteSetConfigResult = z.infer<typeof RemoteSetConfigResultSchema>

const deviceInput = z.object({ deviceId: z.number().int().nonnegative() })

/** The remote is offered on a media player (D944: an extension names its device types). */
const REMOTE_CUSTOMIZE_DEVICE_TYPES = [DeviceType.MediaPlayer] as const

const remoteCustomize = {
  version: 1,
  targets: [
    {
      id: 'remote',
      cardinality: 'config',
      vocabulary: { cap: 'remote' },
      deviceTypes: REMOTE_CUSTOMIZE_DEVICE_TYPES,
      apply: 'add',
      readMethod: 'getConfig',
      writeMethod: 'setConfig',
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const remoteCapability = {
  name: 'remote',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getConfig: method(deviceInput, RemoteConfigSchema, { auth: 'admin' }),
    setConfig: method(
      deviceInput.extend({ config: RemoteConfigSchema }),
      RemoteSetConfigResultSchema,
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    listCommands: method(deviceInput, RemoteCommandListSchema, { auth: 'protected' }),
    sendCommand: method(
      deviceInput.extend({
        role: RemoteRoleSchema,
        /** Sends in a row (volume steps). */
        repeat: z.number().int().min(1).max(REMOTE_MAX_REPEAT).default(1),
      }),
      RemoteSendResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
    /**
     * A media-player command, offered to the remote first. Answers `not-routed`
     * when the command's role is not bound, so the caller runs the native cap.
     * The dispatch redirect calls this for every caller (UI, automation,
     * exporter); `repeat` is the caller's count where it has one.
     */
    sendMediaCommand: method(
      deviceInput.extend({
        command: RemoteMediaCommandSchema,
        muted: z.boolean().optional(),
        source: z.string().optional(),
        repeat: z.number().int().min(1).max(REMOTE_MAX_REPEAT).default(1),
      }),
      RemoteMediaCommandResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  customize: remoteCustomize,
} as const satisfies CapabilityDefinition

export type IRemoteProvider = InferProvider<typeof remoteCapability>
