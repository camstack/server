import { z } from 'zod'
import {
  DeviceTransitionSchema,
  TransitionActorKindSchema,
  TransitionOutcomeSchema,
} from '../audit/device-transition.js'
import { DeviceType } from '../device/device-type.js'
import {
  type CapabilityDefinition,
  type InferProvider,
  method,
  systemMethod,
} from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * device-transitions - what was asked of a device and what it reported back
 * (D1022, D1084).
 *
 * Two sources, one time-ordered page. A STORED row is a command: the user,
 * token, addon, action or scheduler that asked, the arguments, and whether the
 * call returned (`ok`) or threw (`failed`). The hub kernel (device-manager)
 * writes it by batch through `record` when the call completes; device-history
 * owns the ledger, its retention and its removal hook. A DERIVED row (actor
 * `device`) is a change of an audited field read back from the device-history
 * raw series at read time and never stored: a field without a history block has
 * none. Reads answer from disk: an answered empty page is "no transitions".
 *
 * `null` is "unknown", never `0` (D393): a `from` that was not recorded, a
 * count not taken.
 */

export const DEVICE_TRANSITIONS_MAX_PAGE = 200

/** The most rows one `record` call may carry. */
export const DEVICE_TRANSITIONS_RECORD_BATCH_MAX = 500

/** Why a row of a `record` batch was not written. */
export const TransitionRefusalReasonSchema = z.enum(['not-kernel', 'invalid'])
export type TransitionRefusalReason = z.infer<typeof TransitionRefusalReasonSchema>

export const TransitionRecordResultSchema = z.object({
  written: z.number().int().nonnegative(),
  refused: z.array(z.object({ id: z.string(), reason: TransitionRefusalReasonSchema })).readonly(),
})
export type TransitionRecordResult = z.infer<typeof TransitionRecordResultSchema>

export const TransitionsStatusSchema = z.object({
  /** Rows in the ledger; `null` until counted. */
  rows: z.number().int().nullable(),
  lastWriteAt: z.number().nullable(),
  /** Refused rows since start, by reason. */
  refused: z.record(z.string(), z.number()),
})
export type TransitionsStatus = z.infer<typeof TransitionsStatusSchema>

/**
 * Every real device type. A Container is a place, not something that changes state.
 */
const DEVICE_TRANSITIONS_DEVICE_TYPES: readonly DeviceType[] = Object.values(DeviceType).filter(
  (type) => type !== DeviceType.Container,
)

export const deviceTransitionsCapability = {
  name: 'device-transitions',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: DEVICE_TRANSITIONS_DEVICE_TYPES,
  methods: {
    /**
     * Commands and derived device changes, newest first. `limit` is bounded; page with `cursor`
     * (stable across both sources). At most ONE of `capName`, `actorKind`, `outcome` per call;
     * `outcome` (`ok` | `failed`) and every actor kind but `device` select commands only,
     * `actorKind: 'device'` selects derived changes only.
     */
    listTransitions: method(
      z.object({
        deviceId: z.number().int(),
        capName: z.string().optional(),
        actorKind: TransitionActorKindSchema.optional(),
        outcome: TransitionOutcomeSchema.optional(),
        atFrom: z.number().optional(),
        atTo: z.number().optional(),
        limit: z.number().int().positive().max(DEVICE_TRANSITIONS_MAX_PAGE).default(50),
        cursor: z.string().optional(),
      }),
      z.object({
        transitions: z.array(DeviceTransitionSchema).readonly(),
        nextCursor: z.string().nullable(),
      }),
    ),
    /** Fetch one stored command by id; null when absent (a derived change has no stored row). */
    getTransition: method(
      z.object({ deviceId: z.number().int(), id: z.string() }),
      DeviceTransitionSchema.nullable(),
    ),
    /** The fleet page of stored commands, newest first (derived device changes are per device only). At most ONE of `actorKind`, `outcome` per call. */
    listRecentTransitions: systemMethod(
      z.object({
        actorKind: TransitionActorKindSchema.optional(),
        outcome: TransitionOutcomeSchema.optional(),
        atFrom: z.number().optional(),
        atTo: z.number().optional(),
        limit: z.number().int().positive().max(DEVICE_TRANSITIONS_MAX_PAGE).default(50),
        cursor: z.string().optional(),
      }),
      z.object({
        transitions: z.array(DeviceTransitionSchema).readonly(),
        nextCursor: z.string().nullable(),
      }),
      { auth: 'admin' },
    ),
    /** Kernel write: device-manager delivers a batch. Refused for any other caller. */
    record: systemMethod(
      z.object({
        transitions: z.array(DeviceTransitionSchema).max(DEVICE_TRANSITIONS_RECORD_BATCH_MAX),
      }),
      TransitionRecordResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The status of the device transitions tracker. */
    getStatus: systemMethod(z.object({}), TransitionsStatusSchema, {
      auth: 'admin',
    }),
  },
  vocabulary: { noun: t('Transitions', 'Transizioni'), order: 2140 },
} as const satisfies CapabilityDefinition

export type IDeviceTransitionsProvider = InferProvider<typeof deviceTransitionsCapability>
