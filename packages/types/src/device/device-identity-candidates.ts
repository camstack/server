/**
 * Cross-integration identity candidates (planning#593, step 2 of D1059's epic).
 *
 * Two devices brought by DIFFERENT integrations that share provider-declared
 * identifiers ({@link DeviceIdentifiers}) are candidates for being the same
 * physical object. This module holds the answer's shape; the device-manager
 * keeps the index that finds the pairs and the ONE rule that grades a match
 * (`classifyIdentityMatch`, `device-identity-index.ts`).
 *
 * The rule (operator, planning#590):
 *
 * | Matched keys                                   | Confidence  |
 * | ---------------------------------------------- | ----------- |
 * | two strong KINDS (e.g. `mac` + `serial`)       | `auto`      |
 * | `mac` + `ip`                                   | `auto`      |
 * | exactly one strong kind                        | `proposal`  |
 * | weak keys only (`hostname`, `ip`)              | no candidate|
 *
 * Strength counts distinct KINDS, not values: two MACs of one device matching
 * the other's two MACs are still one kind of evidence, so a proposal. In doubt,
 * no match.
 *
 * Read-only: a candidate is NOT a link. Links are step 3.
 */

import { z } from 'zod'
import { DeviceIdentifierKeySchema } from './device-identifiers.js'

export const IdentityConfidenceSchema = z.enum(['auto', 'proposal'])
export type IdentityConfidence = z.infer<typeof IdentityConfidenceSchema>

/** One identifier both devices declared, with the same normalised value. */
export const IdentityMatchedKeySchema = z.object({
  key: DeviceIdentifierKeySchema,
  value: z.string(),
})
export type IdentityMatchedKey = z.infer<typeof IdentityMatchedKeySchema>

/** One side of a pair: the device and the integration that brought it. */
export const IdentityCandidateDeviceSchema = z.object({
  deviceId: z.number().int(),
  addonId: z.string(),
  /** The integration instance (`int_NNNN`) that adopted it; `null` when none was stamped. */
  integrationId: z.string().nullable(),
})
export type IdentityCandidateDevice = z.infer<typeof IdentityCandidateDeviceSchema>

/** Two devices of different integrations sharing at least one strong identifier. `a.deviceId < b.deviceId`. */
export const IdentityCandidatePairSchema = z.object({
  a: IdentityCandidateDeviceSchema,
  b: IdentityCandidateDeviceSchema,
  /** Every identifier the two share, weak ones included, ordered by key then value. */
  keys: z.array(IdentityMatchedKeySchema).readonly(),
  confidence: IdentityConfidenceSchema,
})
export type IdentityCandidatePair = z.infer<typeof IdentityCandidatePairSchema>

/**
 * The answer of `device-manager.listIdentityCandidates`.
 *
 * - `unknown` — the index has not loaded yet: nothing can be said, and it is
 *   NOT an empty list (D315).
 * - `answered` — `pairs` holds every candidate. `undeclaredDeviceIds` are the
 *   devices with no identifiers on record: whether they match anything is
 *   UNKNOWN, never "no match" (D393). A device absent from both lists declared
 *   identifiers and matched nobody.
 */
export const IdentityCandidatesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown'), reason: z.string() }),
  z.object({
    status: z.literal('answered'),
    pairs: z.array(IdentityCandidatePairSchema).readonly(),
    undeclaredDeviceIds: z.array(z.number().int()).readonly(),
  }),
])
export type IdentityCandidates = z.infer<typeof IdentityCandidatesSchema>
