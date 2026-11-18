/**
 * Identity links (planning#594, D1063): a RELATION between two devices of
 * different integrations, decided from the identifiers their providers declared
 * (D1059) — never from location, never from a name.
 *
 * A link is not a merge: both devices keep their provider, their id and their
 * bindings. What a link adds to one of them is a Customize feature, stamped
 * with the link's id (`CompositionFieldsFeature.contributedBy`), so the
 * operator's switch for it is the feature's own `enabled` (D62, D676) and the
 * link record never holds a second copy of it.
 *
 * | Kind          | Sides                                        | Evidence                                 |
 * | ------------- | -------------------------------------------- | ---------------------------------------- |
 * | `same-device` | two views of ONE object, unordered           | `identifiers` ↔ `identifiers`            |
 * | `poe-power`   | `a` = the PoE port, `b` = the device it feeds | port `attachedIdentifiers` ↔ `identifiers` |
 *
 * The row id names the two sides by `<addonId>/<stableId>`, so a link survives
 * a device re-registered under a new numeric id. A symmetric kind sorts its two
 * refs; a directional kind keeps `a` as the attaching side.
 */

import { z } from 'zod'
import { DeviceRole } from './device-type.js'
import { IdentityMatchedKeySchema } from './device-identity-candidates.js'

export const IDENTITY_LINK_KIND_NAMES = ['same-device', 'poe-power'] as const
export const IdentityLinkKindSchema = z.enum(IDENTITY_LINK_KIND_NAMES)
export type IdentityLinkKind = z.infer<typeof IdentityLinkKindSchema>

/**
 * - `proposed` — one strong key matched: waits for the operator;
 * - `linked` — confirmed by the operator, or auto-linked on strong evidence;
 * - `dismissed` — the operator said no (or unlinked): sticky, never re-proposed.
 */
export const IdentityLinkStateSchema = z.enum(['proposed', 'linked', 'dismissed'])
export type IdentityLinkState = z.infer<typeof IdentityLinkStateSchema>

/** Who decided the current state: the matcher (`auto`) or the operator. */
export const IdentityLinkOriginSchema = z.enum(['auto', 'operator'])
export type IdentityLinkOrigin = z.infer<typeof IdentityLinkOriginSchema>

/** One side: the device ref that survives re-registration, plus its current numeric id. */
export const IdentityLinkSideSchema = z.object({
  addonId: z.string().min(1),
  stableId: z.string().min(1),
  deviceId: z.number().int(),
})
export type IdentityLinkSide = z.infer<typeof IdentityLinkSideSchema>

/** The stored body of one `identity-links` record. */
export const IdentityLinkBodySchema = z.object({
  kind: IdentityLinkKindSchema,
  a: IdentityLinkSideSchema,
  b: IdentityLinkSideSchema,
  state: IdentityLinkStateSchema,
  origin: IdentityLinkOriginSchema,
  /** The identifiers that matched when the link was last evaluated, ordered by key then value. */
  evidence: z.array(IdentityMatchedKeySchema).readonly(),
  /** An operator-confirmed link whose evidence no longer matches: kept, flagged. */
  evidenceGone: z.literal(true).optional(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().optional(),
})
export type IdentityLinkBody = z.infer<typeof IdentityLinkBodySchema>

export const IdentityLinkSchema = IdentityLinkBodySchema.extend({ id: z.string().min(1) })
export type IdentityLink = z.infer<typeof IdentityLinkSchema>

/** A device ref as a link id names it. */
export interface IdentityLinkRef {
  readonly addonId: string
  readonly stableId: string
}

/** One Customize feature a link kind adds to one of its sides. */
export interface IdentityLinkContribution {
  /** The cap whose Customize target is filled. */
  readonly cap: string
  /** The scalar target of that cap. */
  readonly targetId: string
  /** The side that RECEIVES the feature. */
  readonly host: 'a' | 'b'
  /** The side the feature reads from. */
  readonly source: 'a' | 'b'
  /** What it reads on the source side. */
  readonly sourceCap: string
  readonly sourceField: string
}

export interface IdentityLinkKindSpec {
  /** A directional kind keeps `a` as the attaching side; a symmetric one sorts its refs. */
  readonly directional: boolean
  /** The role the attaching side (`a`) must have; `null` when any device may attach. */
  readonly attachingRole: DeviceRole | null
  /** What a `linked` link of this kind adds, by default. */
  readonly contributions: readonly IdentityLinkContribution[]
}

/** The one table of link kinds. */
export const IDENTITY_LINK_KINDS: Readonly<Record<IdentityLinkKind, IdentityLinkKindSpec>> = {
  'same-device': { directional: false, attachingRole: null, contributions: [] },
  'poe-power': {
    directional: true,
    attachingRole: DeviceRole.PoePort,
    // The camera gets supply on/off and a forced restart through the port (D1058).
    contributions: [
      {
        cap: 'power-source',
        targetId: 'switch',
        host: 'b',
        source: 'a',
        sourceCap: 'switch',
        sourceField: 'on',
      },
    ],
  },
}

/** Why a pair cannot be a link of a kind; `null` when it can. */
export type IdentityLinkSidesRefusal = 'attaching-side-role'

/** Whether the attaching side of `kind` may be a device of `aRole`. */
export function identityLinkSidesRefusal(
  kind: IdentityLinkKind,
  aRole: string | null | undefined,
): IdentityLinkSidesRefusal | null {
  const required = IDENTITY_LINK_KINDS[kind].attachingRole
  if (required === null) return null
  return aRole === required ? null : 'attaching-side-role'
}

function refKey(ref: IdentityLinkRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

/**
 * The record id of a link: `<kind>:<refA>|<refB>`. A symmetric kind sorts the
 * two refs, so either order names one row; a directional kind keeps `a` first.
 */
export function identityLinkId(
  kind: IdentityLinkKind,
  a: IdentityLinkRef,
  b: IdentityLinkRef,
): string {
  const x = refKey(a)
  const y = refKey(b)
  if (IDENTITY_LINK_KINDS[kind].directional || x <= y) return `${kind}:${x}|${y}`
  return `${kind}:${y}|${x}`
}

/**
 * The answer of `device-manager.listIdentityLinks`. `not-loaded` until the
 * links have been read — never an empty list (D315).
 */
export const IdentityLinksReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-loaded'), reason: z.string() }),
  z.object({ status: z.literal('answered'), links: z.array(IdentityLinkSchema).readonly() }),
])
export type IdentityLinksRead = z.infer<typeof IdentityLinksReadSchema>

/** Why an operator decision on a link was refused. */
export const IdentityLinkDecisionRefusalSchema = z.enum([
  'not-loaded',
  'unknown-link',
  'wrong-state',
])
export type IdentityLinkDecisionRefusal = z.infer<typeof IdentityLinkDecisionRefusalSchema>

/** The answer of `confirmIdentityLink` / `dismissIdentityLink` / `unlinkIdentity`. */
export const IdentityLinkDecisionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), link: IdentityLinkSchema }),
  z.object({
    ok: z.literal(false),
    reason: IdentityLinkDecisionRefusalSchema,
    message: z.string(),
  }),
])
export type IdentityLinkDecision = z.infer<typeof IdentityLinkDecisionSchema>

/** Why a link was lost. */
export const IdentityLinkLostReasonSchema = z.enum([
  'evidence-gone',
  'device-removed',
  'operator-unlinked',
])
export type IdentityLinkLostReason = z.infer<typeof IdentityLinkLostReasonSchema>

/** The payload of `identity-link.created` / `identity-link.lost` (telemetry; the record is the truth). */
export const IdentityLinkEventPayloadSchema = z.object({
  linkId: z.string(),
  kind: IdentityLinkKindSchema,
  aDeviceId: z.number().int(),
  bDeviceId: z.number().int(),
  origin: IdentityLinkOriginSchema,
  reason: IdentityLinkLostReasonSchema.optional(),
})
export type IdentityLinkEventPayload = z.infer<typeof IdentityLinkEventPayloadSchema>
