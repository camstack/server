/**
 * The `camstack-afm` stdio protocol, TS side: one JSON object per line, every
 * reply echoes the request `id`. The Swift source is
 * `native/afm/camstack-afm.swift`; the two must be edited together.
 *
 * Replies are EXTERNAL data — a helper built from another revision, or one
 * that printed something unexpected, must be refused by a schema here rather
 * than trusted into a typed field.
 */
import {
  AppleFmAvailabilitySchema,
  LlmErrorCodeSchema,
  LlmRefusalSourceSchema,
  LlmUsageSchema,
} from '@camstack/types'
import { z } from 'zod'

export const AFM_PROTOCOL_VERSION = 1

/** `LlmProfile.model` of every `apple-foundation` row: the OS's own model. */
export const APPLE_SYSTEM_MODEL = 'apple-system'

export interface AfmProbeRequest {
  readonly op: 'probe'
}

export interface AfmGenerateRequest {
  readonly op: 'generate'
  readonly prompt: string
  readonly system?: string
  readonly jsonSchema?: Readonly<Record<string, unknown>>
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
}

export interface AfmCheckSchemaRequest {
  readonly op: 'checkSchema'
  readonly jsonSchema: Readonly<Record<string, unknown>>
}

export type AfmRequest = AfmProbeRequest | AfmGenerateRequest | AfmCheckSchemaRequest

/** Enough of a line to route it; the op-specific schema below reads the rest. */
export const AfmEnvelopeSchema = z.object({ id: z.string(), ok: z.boolean() }).loose()

export const AfmProbeReplySchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  protocol: z.number().int(),
  availability: AppleFmAvailabilitySchema,
})
export type AfmProbeReply = z.infer<typeof AfmProbeReplySchema>

export const AfmGenerateOkReplySchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  text: z.string(),
  usage: LlmUsageSchema,
  truncated: z.boolean(),
  latencyMs: z.number(),
})

/** `cancelled` is the helper's own word for a generation we stopped. */
export const AfmFailureCodeSchema = z.union([LlmErrorCodeSchema, z.literal('cancelled')])

export const AfmFailureReplySchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  code: AfmFailureCodeSchema,
  message: z.string(),
  /** Apple's own error case name (`guardrailViolation`, `rateLimited`, …). */
  appleError: z.string().optional(),
  refusalSource: LlmRefusalSourceSchema.optional(),
})

export const AfmGenerateReplySchema = z.discriminatedUnion('ok', [
  AfmGenerateOkReplySchema,
  AfmFailureReplySchema,
])
export type AfmGenerateReply = z.infer<typeof AfmGenerateReplySchema>
