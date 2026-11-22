import { z } from 'zod'
import { OnBehalfSchema } from './command-origin-claim.js'

/**
 * One recorded device transition (D1022): a status field of a device went from
 * one value to another, with who or what asked for it.
 *
 * Two kinds of row share this shape (D1084). A STORED row is a command: who asked
 * for what, when, with which arguments, and whether the call threw (`outcome`
 * `ok` | `failed`); `field`, `from` and `to` are what the command's vocabulary
 * effect names (`*` and `null` when it names none). A DERIVED row (`outcome`
 * `device`, actor `device`) is a change of an audited field read back from the
 * device-history raw series; it is never stored. `from` is `null` when the
 * previous value is unknown (never a made-up value - D393).
 */

/** A status value as a transition carries it. */
export const TransitionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown()),
])
export type TransitionValue = z.infer<typeof TransitionValueSchema>

/** Who asked. `device` is the fallback: nothing the hub observed asked for the change. */
export const TransitionActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string(),
    username: z.string(),
    credential: z.enum(['session', 'token', 'integration']),
    credentialId: z.string().optional(),
  }),
  /** A bridge or any addon; the id is the transport stamp, never a claim. */
  z.object({
    kind: z.literal('addon'),
    addonId: z.string(),
    nodeId: z.string().optional(),
    /** The ecosystem principal an exporter relayed, when it reported one. */
    onBehalf: OnBehalfSchema.optional(),
  }),
  z.object({
    kind: z.literal('action'),
    addonId: z.string(),
    actionId: z.string(),
    runId: z.string(),
    automationId: z.string().optional(),
  }),
  z.object({ kind: z.literal('scheduler'), addonId: z.string(), schedulerId: z.string() }),
  z.object({ kind: z.literal('composition'), owner: z.string() }),
  z.object({ kind: z.literal('node'), nodeId: z.string() }),
  z.object({ kind: z.literal('device') }),
])
export type TransitionActor = z.infer<typeof TransitionActorSchema>

/** The actor kinds, for a filter. */
export const TransitionActorKindSchema = z.enum([
  'user',
  'addon',
  'action',
  'scheduler',
  'composition',
  'node',
  'device',
])
export type TransitionActorKind = z.infer<typeof TransitionActorKindSchema>

/** How a command call ended: it returned (`ok`) or it threw (`failed`). Nothing says the device obeyed. */
export const TransitionOutcomeSchema = z.enum(['ok', 'failed'])
export type TransitionOutcome = z.infer<typeof TransitionOutcomeSchema>

/** A row's outcome: a command's, or `device` for a change derived from history (never stored). */
export const TransitionRowOutcomeSchema = z.union([TransitionOutcomeSchema, z.literal('device')])
export type TransitionRowOutcome = z.infer<typeof TransitionRowOutcomeSchema>

/** The command a transition is attributed to. `args` are redacted and capped before they get here. */
export const TransitionCommandSchema = z.object({
  commandId: z.string(),
  method: z.string(),
  args: z.record(z.string(), z.unknown()),
  requestedAt: z.number(),
  error: z.string().optional(),
})
export type TransitionCommand = z.infer<typeof TransitionCommandSchema>

export const DeviceTransitionSchema = z.object({
  /** `${deviceId}:${at}:${seq}` - the write is idempotent on it. */
  id: z.string(),
  deviceId: z.number().int(),
  at: z.number(),
  capName: z.string(),
  field: z.string(),
  from: TransitionValueSchema,
  to: TransitionValueSchema,
  outcome: TransitionRowOutcomeSchema,
  actor: TransitionActorSchema,
  command: TransitionCommandSchema.optional(),
})
export type DeviceTransition = z.infer<typeof DeviceTransitionSchema>

/**
 * The payload of `EventCategory.DeviceCommandSettled`: a command call that
 * completed, without its arguments (they stay redacted in the row). A command is
 * named ONLY by its vocabulary action id (`powerSource.forceRestart`, D983) -
 * the one dictionary the automation action blocks use; the cap is derived from
 * the action index, never carried.
 */
export const DeviceCommandSettledEventSchema = z.object({
  deviceId: z.number().int(),
  action: z.string(),
  outcome: TransitionOutcomeSchema,
  actor: TransitionActorSchema,
  at: z.number(),
})
export type DeviceCommandSettledEvent = z.infer<typeof DeviceCommandSettledEventSchema>

// Its own module so the runner closure can parse a claim without the transition schemas (D28).
export {
  CommandOriginClaimSchema,
  OnBehalfSchema,
  OnBehalfSourceSchema,
  RuleFireOriginSchema,
  ruleFireOfClaim,
} from './command-origin-claim.js'
export type {
  CommandOriginClaim,
  OnBehalf,
  OnBehalfSource,
  RuleFireOrigin,
} from './command-origin-claim.js'

/** The actor of a command: every kind but `device`, which is what nobody asked for. */
export type CommandActor = Exclude<TransitionActor, { readonly kind: 'device' }>

/**
 * One device command as the kernel saw it leave its caller (D1022). Built at the
 * two seams that know the caller (the hub tRPC mount and the UDS parent) and
 * handed to the hub mirror's correlator. `args` are the call's own arguments,
 * still unredacted: the recorder redacts and caps them before they are stored.
 */
export interface DeviceCommandObservation {
  readonly deviceId: number
  readonly capName: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly actor: CommandActor
  readonly at: number
  /** Present where the seam can see the call settle (the hub tRPC mount): a rejection means `failed`. */
  readonly outcome?: Promise<void>
}
