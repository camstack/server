/**
 * Record kinds owned by the AI addon (records plan phase 2, steps 2-6).
 *
 * Each kind replaced the legacy `ai:*` collection of the same name; the records
 * migration that copied them is closed (D900).
 */
import { z } from 'zod'
import {
  defineRecordKinds,
  LlmDefaultSchema,
  LlmErrorCodeSchema,
  LlmProfileKindSchema,
  LlmProfileSchema,
  RECORD_MAX_DATA_BYTES,
} from '@camstack/types'
import { StoredConversationSchema } from './test-chat/chat-schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a usage row is kept; the engine's TTL sweep ages it out from its own `at`. */
export const USAGE_RETENTION_MS = 90 * DAY_MS

/**
 * An LLM profile row. The id is the record id (not repeated in the body) and the
 * `apiKey` is the row's ONE keychain-backed secret slot: the records facade
 * stores the value in the keychain and the row only ever holds a marker (D878,
 * D879). It holds whichever field the kind's schema declares `password` —
 * `providerConfig` never carries it (profile-store.ts moves it in and out), so
 * the slot keeps its record ref across the D893 reshape.
 */
export const LlmProfileBodySchema = LlmProfileSchema.omit({ id: true }).extend({
  apiKey: z.string().optional().meta({ secret: true }),
})
export type LlmProfileBody = z.infer<typeof LlmProfileBodySchema>

/** The first-boot seed marker: its PRESENCE is the fact. */
export const LlmMetaBodySchema = z.object({ at: z.number() })
export type LlmMetaBody = z.infer<typeof LlmMetaBodySchema>

/** One LLM call. The call time is the record's own `at` (the TTL clock), not a body field. */
export const UsageBodySchema = z.object({
  consumer: z.string(),
  profileId: z.string().optional(),
  kind: LlmProfileKindSchema.optional(),
  model: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number(),
  ok: z.boolean(),
  errorCode: LlmErrorCodeSchema.optional(),
  imageCount: z.number(),
})
export type UsageBody = z.infer<typeof UsageBodySchema>

export const aiRecordKinds = defineRecordKinds({
  'llm-meta': {
    schema: LlmMetaBodySchema,
    class: 'config',
    writeTrigger:
      'once, ever — the seededDefaults marker written after the first-boot profile seed',
    device: 'none',
    at: 'none',
    retention: {
      none: 'nothing deletes or rewrites it; its PRESENCE stops the seed running again, so losing it re-seeds a profile the operator may have deleted on purpose',
    },
  },
  'llm-defaults': {
    schema: LlmDefaultSchema,
    class: 'config',
    writeTrigger:
      'an operator (or a consumer default) pins a profile for a selector — the row id IS the selector key, so set() replaces',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row goes only on set(selector, null), the explicit unpin; bounded by the number of selectors the product defines',
    },
  },
  chats: {
    schema: StoredConversationSchema,
    class: 'audit',
    writeTrigger:
      'an operator sends a persistent test-chat turn — one row per conversation, messages[] replayed into the model each turn',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'user', fields: ['userId'] }],
    retention: {
      owner: 'ai',
      reason:
        'operator knob: max-age days and/or max-count per user (addon global settings), pruned on write and on the addon 24h sweep',
    },
    // A conversation embeds image thumbnails, so it can pass the 64 KiB default.
    maxDataBytes: RECORD_MAX_DATA_BYTES,
  },
  'llm-profiles': {
    schema: LlmProfileBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates or edits an LLM profile (endpoint, model, credentials); plus the one-shot LAN Ollama seed on first boot',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row goes only on an explicit operator delete; the apiKey is a keychain marker and goes with it',
    },
    entry: { title: 'LLM profiles' },
  },
  usage: {
    schema: UsageBodySchema,
    class: 'audit',
    writeTrigger:
      'one row per completed LLM call — consumer, profile, kind, token counts, latency and error code',
    device: 'none',
    at: 'required',
    retention: { ttlMs: USAGE_RETENTION_MS, from: 'at' },
  },
})
