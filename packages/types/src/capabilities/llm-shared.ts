/**
 * Shared LLM generate contracts — imported by BOTH `llm.cap.ts` (consumer
 * surface) and `llm-runtime.cap.ts` (node-side managed executor) so the two
 * caps stay wire-compatible without a circular cap→cap import.
 *
 * Errors are a discriminated-union RESULT, never thrown: the shape survives
 * every transport tier structurally, and failed calls still write usage rows.
 * Token counts only in v1 — no costUsd (operator decision, 2026-07-15).
 */
import { z } from 'zod'

export const LlmUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
})
export type LlmUsage = z.infer<typeof LlmUsageSchema>

export const LlmErrorCodeSchema = z.enum([
  'timeout',
  'rate-limited',
  'auth',
  'refusal',
  'bad-request',
  'unavailable',
  'no-profile',
  'budget-exceeded', // enforcement is v2 — code reserved (spec §6)
  'adapter-error',
])
export type LlmErrorCode = z.infer<typeof LlmErrorCodeSchema>

export const LlmGenerateOkSchema = z.object({
  ok: z.literal(true),
  text: z.string(),
  model: z.string(),
  usage: LlmUsageSchema,
  truncated: z.boolean(),
  latencyMs: z.number(),
})
/**
 * WHO refused, on a `refusal`. `guardrail` = a safety filter in front of the
 * model rejected the request before it answered (Apple Foundation Models
 * refuses surveillance-framed prompts in 0.1 s); `model` = the model itself
 * declined. They are different faults: a guardrail refusal is a property of
 * the BACKEND, so the provider falls back to the next profile; a model refusal
 * is an answer. Absent on every other code, and on a refusal a wire cannot
 * attribute.
 */
export const LlmRefusalSourceSchema = z.enum(['guardrail', 'model'])
export type LlmRefusalSource = z.infer<typeof LlmRefusalSourceSchema>

export const LlmGenerateErrSchema = z.object({
  ok: z.literal(false),
  code: LlmErrorCodeSchema,
  message: z.string(),
  retryAfterMs: z.number().optional(),
  refusalSource: LlmRefusalSourceSchema.optional(),
})
export const LlmGenerateResultSchema = z.discriminatedUnion('ok', [
  LlmGenerateOkSchema,
  LlmGenerateErrSchema,
])
export type LlmGenerateOk = z.infer<typeof LlmGenerateOkSchema>
export type LlmGenerateErr = z.infer<typeof LlmGenerateErrSchema>
export type LlmGenerateResult = z.infer<typeof LlmGenerateResultSchema>

/**
 * `Uint8Array` is the sanctioned binary convention — superjson + the UDS
 * MsgPack channel round-trip typed arrays (embedding-encoder.cap.ts:29,
 * notification-output.cap.ts:27-31 precedents).
 */
export const LlmImageSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  mimeType: z.string(),
})
export type LlmImage = z.infer<typeof LlmImageSchema>

/**
 * Retry policy. `enabled: false` is NOT the same as `maxAttempts: 1` in intent —
 * the flag is what a consumer table flips, the count is what the operator tunes.
 * A retry doubles the wall time of a call, so the two gates that run inside a
 * notification's budget keep it off (see `CONSUMER_RETRY_POLICY` in addon-ai).
 */
export const LlmRetryPolicySchema = z.object({
  enabled: z.boolean().default(false),
  /** Total attempts INCLUDING the first. 1 = no retry. */
  maxAttempts: z.number().int().min(1).max(5).default(1),
})
export type LlmRetryPolicy = z.infer<typeof LlmRetryPolicySchema>

/**
 * The four bounds, as ONE vocabulary.
 *
 * These were three magic constants inside the test chat (`connect` 10 s,
 * `first token` 120 s, `idle` 60 s) plus a separate `timeoutMs` on the profile.
 * They are the same four questions on every call path, so they are profile
 * fields with defaults — and each still names a DIFFERENT failure:
 *   - `connect`      — the endpoint never accepted the request (port closed).
 *   - `firstToken`   — accepted, nothing produced yet (cold model loading).
 *   - `idle`         — tokens started then stopped (a stall, model proven up).
 *   - `total`        — the whole generation, the only bound a unary call has.
 */
export const LlmTimeoutDefaults = {
  totalMs: 60_000,
  connectMs: 10_000,
  firstTokenMs: 120_000,
  idleMs: 60_000,
} as const

export const LlmGenerateBaseInputSchema = z.object({
  /** Collection routing (the notification-output posture). */
  addonId: z.string().optional(),
  /** Explicit profile; else the resolution chain (spec §3). */
  profileId: z.string().optional(),
  /** MANDATORY usage tag: 'ai-summary', 'notifier-rules', 'adhoc-ui', … */
  consumer: z.string(),
  system: z.string().optional(),
  /** v1: single-turn. `messages[]` is a v2 additive field. */
  prompt: z.string(),
  /** Structured output — adapter-mapped (response_format / forced tool / responseSchema). */
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  /** Per-call override of the profile default. */
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  /** Per-call override of the profile default (nucleus sampling). */
  topP: z.number().min(0).max(1).optional(),
  /** Per-call override of the profile default (top-k sampling). */
  topK: z.number().int().positive().optional(),
  /** Per-call override of `profile.timeoutMs` — the total generation bound. */
  timeoutMs: z.number().int().positive().optional(),
  /** Per-call override; beats both the consumer table and the profile. */
  retry: LlmRetryPolicySchema.optional(),
  /**
   * Caller-minted id that makes this generation CANCELLABLE.
   *
   * Without it a caller that stops waiting cannot stop the work: the gates race
   * the call against 8 s and free their own slot when the timer wins, while the
   * generation upstream keeps running to `profile.timeoutMs` — 60 s by default,
   * on a single-threaded local model. The per-camera bound then counts WAITS,
   * not generations, and the real load is unbounded.
   *
   * `AbortSignal` cannot cross a process boundary; an id can. Pass one here and
   * `llm.cancel({ requestId })` tears the socket down.
   */
  requestId: z.string().optional(),
})
export type LlmGenerateBaseInput = z.infer<typeof LlmGenerateBaseInputSchema>
