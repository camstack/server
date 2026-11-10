import { z } from 'zod'

/**
 * The match a notification rule fired on (D705). Carried as a command origin so an
 * Action the rule starts can press `alarm-panel.trigger` as that match, not as an
 * anonymous press (D735). The same fields a rule fire ref freezes.
 */
export const RuleFireOriginSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  deviceId: z.number().int(),
  sourceDeviceId: z.number().int().optional(),
  recordId: z.string(),
  timestamp: z.number(),
  trackId: z.string().optional(),
  eventId: z.string().optional(),
  className: z.string().optional(),
  label: z.string().optional(),
  zones: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  sensorChange: z.object({ name: z.string(), kind: z.string(), state: z.string() }).optional(),
  extraStills: z.array(z.object({ ownerId: z.string(), cameraId: z.number().int() })).optional(),
})
export type RuleFireOrigin = z.infer<typeof RuleFireOriginSchema>

/** Where a command's origin claim comes from: an addon states WHY it called, never WHO it is. */
export const CommandOriginClaimSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    actionId: z.string(),
    runId: z.string(),
    automationId: z.string().optional(),
    /** The rule fire that started this run, when one did (D705). */
    ruleFire: RuleFireOriginSchema.optional(),
  }),
  z.object({ kind: z.literal('scheduler'), schedulerId: z.string() }),
  /** `actions.run` was started by a notification-rule match. Not a device-command actor. */
  z.object({ kind: z.literal('rule'), fire: RuleFireOriginSchema }),
])
export type CommandOriginClaim = z.infer<typeof CommandOriginClaimSchema>

/** The rule fire a claim carries, if it carries one. */
export function ruleFireOfClaim(claim: CommandOriginClaim | undefined): RuleFireOrigin | undefined {
  if (claim === undefined) return undefined
  if (claim.kind === 'rule') return claim.fire
  if (claim.kind === 'action') return claim.ruleFire
  return undefined
}
