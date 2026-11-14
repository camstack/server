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
 * device-transitions - the audit of what changed on a device and who asked
 * for it (D1022).
 *
 * A transition is a FACT about one status field: it went from `from` to `to`
 * at `at`, and the actor is the user, token, addon, action or scheduler whose
 * command the hub mirror matched to the change, or `device` when nothing
 * asked. The hub kernel (device-manager) writes the rows by batch through
 * `record`; device-history owns the ledger, its retention and its removal
 * hook. Reads answer from disk: an answered empty page is "no transitions".
 *
 * `null` is "unknown", never `0` (D393): a `from` the mirror had not seen, a
 * `matchedAfterMs` of a command that produced no change, a count not taken.
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
     * Transitions of a device, newest first. `limit` is bounded; page with `cursor`.
     * At most ONE of `capName`, `actorKind`, `outcome` per call - each is served by its own index.
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
    getTransition: method(
      z.object({ deviceId: z.number().int(), id: z.string() }),
      DeviceTransitionSchema.nullable(),
    ),
    /** The fleet page, newest first. At most ONE of `actorKind`, `outcome` per call. */
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
    getStatus: systemMethod(z.object({}), TransitionsStatusSchema, {
      auth: 'admin',
    }),
  },
  vocabulary: { noun: t('Transitions', 'Transizioni'), order: 2140 },
} as const satisfies CapabilityDefinition

export type IDeviceTransitionsProvider = InferProvider<typeof deviceTransitionsCapability>
