/**
 * What an expression's named bindings READ from.
 *
 * Salvaged verbatim from the deleted device-link mechanism. Wiring's source
 * kinds were the one part of it worth keeping: addressing a device field by
 * re-sync-stable `stableId`, a per-device constant, and a sibling-accessory
 * read are the vocabulary any cross-device derivation needs, and they were
 * already correct. What wiring got wrong was the DESTINATION — a field on
 * somebody else's device, with no identity — not the source.
 *
 * These shapes are therefore kept, re-homed next to the engine that consumes
 * them, and are the binding type of a composition recipe (the source picker
 * stays `deviceManager.getWireableFields`). They deliberately do NOT nest: a
 * binding is a read, never another expression.
 *
 * Schemas are authoritative; every type is `z.infer` of one, so a wire shape and
 * a TypeScript shape cannot drift apart (`scripts/check-schema-type-twins.ts`).
 */

import { z } from 'zod'
import { validateExpressionSource } from './expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from './limits.js'

/** Read a sibling accessory's status field, addressed by the sibling's key.
 *  `kind` is optional for wire compatibility — absent means `'field'`. */
export const ExpressionFieldBindingSchema = z.object({
  kind: z.literal('field').optional(),
  sourceKey: z.string(),
  cap: z.string(),
  fieldPath: z.string(),
})

/** A constant. No device is read. */
export const ExpressionLiteralBindingSchema = z.object({
  kind: z.literal('literal'),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})

/** Read ANY device's status field, addressed by its re-sync-stable `stableId` —
 *  never by numeric id, which a re-adoption reissues. */
export const ExpressionGlobalBindingSchema = z.object({
  kind: z.literal('global'),
  sourceStableId: z.string(),
  cap: z.string(),
  fieldPath: z.string(),
})

export const ExpressionBindingSourceSchema = z.union([
  ExpressionFieldBindingSchema,
  ExpressionLiteralBindingSchema,
  ExpressionGlobalBindingSchema,
])

/**
 * An expression plus the bindings its free identifiers resolve against.
 *
 * The `superRefine` runs the SAME author-time validation as
 * `validateExpressionSource` — compiles the expression, checks binding names,
 * checks identifier coverage — so every boundary that parses one
 * validates-at-write rather than discovering the problem at read time.
 * Compiles are LRU-cached, so repeated validation of the same string is a hit.
 */
export const ExpressionSourceSchema = z
  .object({
    expr: z.string().min(1).max(MAX_EXPRESSION_SOURCE_LENGTH),
    bindings: z.record(z.string().regex(EXPRESSION_IDENTIFIER_RE), ExpressionBindingSourceSchema),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
  })

export type ExpressionFieldBinding = z.infer<typeof ExpressionFieldBindingSchema>
export type ExpressionLiteralBinding = z.infer<typeof ExpressionLiteralBindingSchema>
export type ExpressionGlobalBinding = z.infer<typeof ExpressionGlobalBindingSchema>
export type ExpressionBindingSource = z.infer<typeof ExpressionBindingSourceSchema>
export type ExpressionSource = z.infer<typeof ExpressionSourceSchema>
