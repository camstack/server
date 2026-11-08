import { z } from 'zod'

/**
 * One recorded device transition (D1022): a status field of a device went from
 * one value to another, with who or what asked for it.
 *
 * `from` is `null` when the hub mirror had not seen the field before (unknown,
 * never a made-up value - D393). `outcome` says how the actor was decided:
 * a command matched the change (`confirmed`), nothing asked so the device did it
 * (`device`), the command found the target already held (`already`), the command
 * produced no change in its window (`unconfirmed`) or threw (`failed`).
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
  z.object({ kind: z.literal('addon'), addonId: z.string(), nodeId: z.string().optional() }),
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

export const TransitionOutcomeSchema = z.enum([
  'confirmed',
  'device',
  'already',
  'unconfirmed',
  'failed',
])
export type TransitionOutcome = z.infer<typeof TransitionOutcomeSchema>

/** The command a transition is attributed to. `args` are redacted and capped before they get here. */
export const TransitionCommandSchema = z.object({
  commandId: z.string(),
  method: z.string(),
  args: z.record(z.string(), z.unknown()),
  requestedAt: z.number(),
  /** Milliseconds from the command to the change it caused; `null` when no change was seen. */
  matchedAfterMs: z.number().nullable(),
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
  outcome: TransitionOutcomeSchema,
  actor: TransitionActorSchema,
  command: TransitionCommandSchema.optional(),
})
export type DeviceTransition = z.infer<typeof DeviceTransitionSchema>

// Its own module so the runner closure can parse a claim without the transition schemas (D28).
export { CommandOriginClaimSchema } from './command-origin-claim.js'
export type { CommandOriginClaim } from './command-origin-claim.js'

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
