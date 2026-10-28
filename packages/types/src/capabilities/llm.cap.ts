/**
 * `llm` — consumer-facing LLM surface (spec §1-§3). Collection-mode: array
 * methods concat-fan across providers; single-row methods route to ONE
 * provider by the `addonId` in the call input (the notification-output
 * posture, notification-output.cap.ts:215-250). Provided by `addon-ai`
 * (hub-placed); the cap stays open for future providers.
 *
 * Profiles are ROWS (data), not addons: one row = one usable model endpoint.
 * A row is common fields plus `providerConfig`, which the provider owning the
 * row's kind declares (`connectionSchema`) and validates. The kind is an open
 * id declared by that provider (D893). A `password` field of the provider's
 * schema is a secret — providers REDACT it on read and merge on write; a
 * stored key NEVER round-trips to a client.
 */
import { z } from 'zod'
import { AI_CAP_TRANSPORT_TIMEOUT_MS } from './ai-cap-timeouts.js'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import {
  AppleFmAvailabilitySchema,
  LlmNodeModelSchema,
  LlmRuntimeDiskUsageSchema,
  LlmRuntimeStatusSchema,
  ManagedModelRefSchema,
} from './llm-runtime.cap.js'
import {
  RawSecretMigrationInputSchema,
  RawSecretMigrationReportSchema,
} from './raw-secret-migration.js'
import {
  LlmGenerateBaseInputSchema,
  LlmGenerateResultSchema,
  LlmImageSchema,
  LlmRetryPolicySchema,
} from './llm-shared.js'

/**
 * A profile kind is an OPEN id, declared by the provider that serves it
 * (`listProfileKinds`). The cap names no kind: a new provider ships a new kind
 * without a framework change. Lower-case, digits and dashes, so it stays safe
 * as a URL segment, a record field and a CSS hook.
 */
export const LLM_PROFILE_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const LlmProfileKindSchema = z
  .string()
  .regex(LLM_PROFILE_KIND_PATTERN, 'a kind id is lower-case letters, digits and dashes')
export type LlmProfileKind = z.infer<typeof LlmProfileKindSchema>

/** What a model (or, by default, every model of a kind) can do. */
export const LlmModelFeaturesSchema = z.object({
  vision: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
})
export type LlmModelFeatures = z.infer<typeof LlmModelFeaturesSchema>

/** One model a provider offers. `features` overrides the kind's defaults, per field. */
export const LlmModelInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  features: LlmModelFeaturesSchema.partial().optional(),
})
export type LlmModelInfo = z.infer<typeof LlmModelInfoSchema>

/**
 * The provider-specific part of a profile, validated by the provider that owns
 * the kind (`upsertProfile` refuses what it does not accept). A field its
 * `connectionSchema` declares `type: 'password'` is a secret: it is held in the
 * keychain, never in the row, and reads back as the redaction marker.
 */
export const LlmProviderConfigSchema = z.record(z.string(), z.unknown())
export type LlmProviderConfig = z.infer<typeof LlmProviderConfigSchema>

export const LlmProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The provider-declared kind (`LlmProfileKindDescriptor.kind`). */
  kind: LlmProfileKindSchema,
  /** Stamped by the provider — keeps the fanned catalog routable. */
  addonId: z.string(),
  enabled: z.boolean(),
  /** Vendor model id, or the managed runtime's loaded model. */
  model: z.string(),
  /** Vision on/off. A vision call against a `false` profile is REFUSED, never
   *  degraded to text — that shipped once and produced a confident answer to a
   *  question about a picture nobody sent. */
  supportsVision: z.boolean(),

  // ── sampling ────────────────────────────────────────────────────────
  temperature: z.number().min(0).max(2).optional(),
  /** Nucleus sampling. Every wire we speak has it. */
  topP: z.number().min(0).max(1).optional(),
  /** Top-k sampling. Carried only by the wires that have it — a kind offers the
   *  field in its editor only when its descriptor lists it in `profileFields`. */
  topK: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  /** How hard the model "thinks" before it answers. Omitted = the model's own
   *  default. `off` matters for structured output: a thinking model can spend
   *  the whole completion on reasoning and return an empty `content`. Carried
   *  only by the wires that have it — a kind offers the field in its editor
   *  only when its descriptor lists it in `profileFields`. */
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).optional(),
  /** Prompt context window. Advisory for cloud kinds (they enforce their own). */
  contextLength: z.number().int().positive().optional(),
  /** Default system prompt. A caller's `system` REPLACES it (never appends —
   *  two system prompts fighting is worse than either alone). */
  systemPrompt: z.string().optional(),

  // ── the four bounds (LlmTimeoutDefaults) ────────────────────────────
  /** Total generation bound — the only one a unary call has. */
  timeoutMs: z.number().int().positive().default(60_000),
  /** The TCP handshake only — "is the port even open". NOT the wait for
   *  response headers: on the LM Studio / llama-server wire those are written
   *  once the model has finished loading, so they belong to the bound below. */
  connectTimeoutMs: z.number().int().positive().default(10_000),
  /** Accepted, but no output yet — response headers included, because a cold
   *  GPU load is exactly what happens before them. */
  firstTokenTimeoutMs: z.number().int().positive().default(120_000),
  /** Output started then stopped. */
  idleTimeoutMs: z.number().int().positive().default(60_000),

  // ── policy ──────────────────────────────────────────────────────────
  /** Profile-level default. The per-consumer table and a per-call override
   *  both beat it — see `resolveRetryPolicy`. */
  retry: LlmRetryPolicySchema.default({ enabled: false, maxAttempts: 1 }),
  /** Whether this profile may use tools. The tool-call plumbing rides the
   *  library; the REGISTRY of callable tools is ours and is empty in v1, so a
   *  `true` here buys the wiring, not behaviour, until tools are registered. */
  toolsEnabled: z.boolean().default(false),

  /** Everything the kind's provider owns (endpoint, key, node, runtime…). */
  providerConfig: LlmProviderConfigSchema.default({}),
})
export type LlmProfile = z.infer<typeof LlmProfileSchema>

/**
 * The common profile fields a kind's editor offers. The editor owns how each
 * one is drawn; the provider says which of them mean something on its wire.
 */
export const LlmProfileFieldSchema = z.enum([
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'reasoningEffort',
  'contextLength',
  'systemPrompt',
  'timeoutMs',
  'connectTimeoutMs',
  'firstTokenTimeoutMs',
  'idleTimeoutMs',
  'retry',
  'toolsEnabled',
])
export type LlmProfileField = z.infer<typeof LlmProfileFieldSchema>

/**
 * A provider-drawn part of the editor, by a generic widget id the admin UI
 * registers (`ai/apple-node`). `placement: 'model'` replaces the generic model
 * picker: that widget owns the model choice.
 */
export const LlmProviderWidgetSchema = z.object({
  id: z.string(),
  placement: z.enum(['connection', 'model']),
  /** `providerConfig` keys this widget must fill before the profile can be saved. */
  requires: z.array(z.string()).optional(),
})
export type LlmProviderWidget = z.infer<typeof LlmProviderWidgetSchema>

/** ConfigUISchema tree passed through untyped on the wire (the
 *  notification-output `ConfigSchemaPassthrough` precedent at
 *  notification-output.cap.ts:151); the exported TS type re-tightens it. */
const ConfigSchemaPassthrough = z.unknown()

export const LlmProfileKindDescriptorSchema = z.object({
  kind: LlmProfileKindSchema,
  label: z.string(),
  /** A generic icon name (`cloud`, `plug`, `cpu`) — never a glyph or a logo. */
  icon: z.string(),
  /** Stamped by each provider so the concat-fanned catalog stays routable. */
  addonId: z.string(),
  /** The provider's own fields (`providerConfig`); `password` fields are keychain-held. */
  connectionSchema: ConfigSchemaPassthrough,
  /** Provider fields that belong under "Advanced" (extra headers, runtime tuning). */
  advancedSchema: ConfigSchemaPassthrough.optional(),
  /** The kind's defaults; a model from `listModels` may override any of them. */
  features: LlmModelFeaturesSchema,
  /** `false` = the provider stamps `supportsVision` itself (from what a node reports). */
  visionEditable: z.boolean(),
  /** Where the model list comes from: `listModels`, `staticModels`, or nowhere. */
  modelCatalog: z.enum(['fetch', 'static', 'none']),
  staticModels: z.array(LlmModelInfoSchema).optional(),
  /** The common fields that mean something on this kind's wire. */
  profileFields: z.array(LlmProfileFieldSchema),
  providerWidgets: z.array(LlmProviderWidgetSchema).optional(),
})
export type LlmProfileKindDescriptor = Omit<
  z.infer<typeof LlmProfileKindDescriptorSchema>,
  'connectionSchema' | 'advancedSchema'
> & {
  readonly connectionSchema: ConfigUISchema
  readonly advancedSchema?: ConfigUISchema
}

/**
 * `listModels` input. `connection` is an UNSAVED draft of `providerConfig`
 * (the editor's form); with `profileId` too, a secret the draft leaves
 * untouched (absent or the redaction marker) is resolved server-side from the
 * stored profile — the browser never receives it.
 */
export const LlmListModelsInputSchema = z.object({
  addonId: z.string(),
  kind: LlmProfileKindSchema,
  profileId: z.string().optional(),
  connection: LlmProviderConfigSchema.optional(),
})
export type LlmListModelsInput = z.infer<typeof LlmListModelsInputSchema>

export const LlmListModelsErrorCodeSchema = z.enum([
  /** The endpoint refused the credentials (401/403). */
  'auth',
  /** Unreachable, timed out, or answered something that is not a model list. */
  'network',
  /** This kind has no model list to fetch. */
  'unsupported',
  /** The draft is not a connection this kind accepts (missing base URL, unknown kind…). */
  'invalid',
])
export type LlmListModelsErrorCode = z.infer<typeof LlmListModelsErrorCodeSchema>

/** A RESULT, never a throw: "wrong key" is an answer the editor renders inline. */
export const LlmListModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(LlmModelInfoSchema) }),
  z.object({ ok: z.literal(false), code: LlmListModelsErrorCodeSchema, message: z.string() }),
])
export type LlmListModelsResult = z.infer<typeof LlmListModelsResultSchema>

export const LlmDefaultSelectorSchema = z.union([
  z.object({ consumer: z.string() }),
  z.object({ purpose: z.enum(['text', 'vision']) }),
])
export type LlmDefaultSelector = z.infer<typeof LlmDefaultSelectorSchema>

export const LlmDefaultSchema = z.object({
  selector: LlmDefaultSelectorSchema,
  profileId: z.string(),
})
export type LlmDefault = z.infer<typeof LlmDefaultSchema>

/** Server-side rollup row — getUsage never dumps raw call rows (spec §6). */
export const LlmUsageRollupSchema = z.object({
  day: z.string(), // YYYY-MM-DD (UTC)
  consumer: z.string(),
  profileId: z.string(),
  calls: z.number(),
  okCalls: z.number(),
  errorCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  avgLatencyMs: z.number(),
})
export type LlmUsageRollup = z.infer<typeof LlmUsageRollupSchema>

/** LLM-facing view over the reused ModelCatalogEntry mechanism (spec §4.2). */
export const ManagedModelCatalogEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  family: z.string(),
  purpose: z.enum(['text', 'vision']),
  url: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  quantization: z.string(), // 'Q4_K_M', …
  /** Load-time guidance shown in the picker. */
  minRamBytes: z.number(),
  contextSizeDefault: z.number().int(),
  /** Vision models: companion projector file. */
  mmprojUrl: z.string().optional(),
})
export type ManagedModelCatalogEntry = z.infer<typeof ManagedModelCatalogEntrySchema>

/**
 * The outcome of turning one operator-typed Hugging Face reference into a
 * download plan. A RESULT, never a throw: "this repo has 24 quantizations and
 * I will not pick for you" is a normal answer the UI has to render, not an
 * exception.
 *
 * `candidates` is the whole reason the refusal is usable — every string in it
 * is a tag that resolves when pasted back as `<org>/<repo>:<TAG>`.
 */
export const HfModelResolutionSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Ready to hand to `installModel` unchanged. */
    model: ManagedModelRefSchema,
    label: z.string(),
    repo: z.string(),
    quantization: z.string(),
    purpose: z.enum(['text', 'vision']),
    totalBytes: z.number(),
    /** mmproj + shards, for the preview: an operator approving 23 GB should
     *  see that 0.9 GB of it is a projector they did not name. */
    extraFilenames: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    candidates: z.array(z.string()).optional(),
    /** Set when the refusal was only the ceiling: re-calling with
     *  `maxBytes: requiredBytes` is the operator's explicit override. */
    requiredBytes: z.number().optional(),
  }),
])
export type HfModelResolution = z.infer<typeof HfModelResolutionSchema>

export const LlmRuntimeNodeSchema = z.object({
  nodeId: z.string(),
  reachable: z.boolean(),
  status: LlmRuntimeStatusSchema.optional(),
  disk: LlmRuntimeDiskUsageSchema.optional(),
  error: z.string().optional(),
  /** Absent = the node did not answer the question (render as unknown). */
  apple: AppleFmAvailabilitySchema.optional(),
})
export type LlmRuntimeNode = z.infer<typeof LlmRuntimeNodeSchema>

const GenerateVisionInputSchema = LlmGenerateBaseInputSchema.extend({
  images: z.array(LlmImageSchema).min(1),
})
const ProfileRefInputSchema = z.object({
  addonId: z.string(),
  profileId: z.string(),
})

export const llmCapability = {
  name: 'llm',
  scope: 'system',
  mode: 'collection',
  internal: false,
  providerKind: 'ai',
  /** `nodeId` inputs below are DATA (the hub provider pins itself), never routing. */
  nodeIdMode: 'data',
  methods: {
    generate: method(LlmGenerateBaseInputSchema, LlmGenerateResultSchema, {
      kind: 'mutation',
      timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
    }),
    generateVision: method(GenerateVisionInputSchema, LlmGenerateResultSchema, {
      kind: 'mutation',
      timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
    }),
    /**
     * Stop a generation started with a `requestId`.
     *
     * Idempotent and always successful: cancelling an id that already finished,
     * never existed, or was cancelled a moment ago is a no-op. A caller that has
     * given up must never have to handle an error from giving up.
     */
    cancel: method(
      // `addonId` optional for the same reason `generate` has it optional: the
      // caller knows the id it minted, not which provider picked it up.
      z.object({ addonId: z.string().optional(), requestId: z.string() }),
      z.void(),
      { kind: 'mutation' },
    ),
    // NOTE: embedText is OUT of v1 (operator decision #6).
    listProfileKinds: method(z.object({}), z.array(LlmProfileKindDescriptorSchema)),
    listProfiles: method(z.object({}), z.array(LlmProfileSchema)),
    upsertProfile: method(z.object({ profile: LlmProfileSchema }), LlmProfileSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * D878: move every profile's plaintext `apiKey` into the keychain (owner
     * `ai`), leaving a marker in the row. Dry run unless `apply`; idempotent;
     * counts only. The plaintext is cleared only after the keychain read-back
     * matched.
     */
    migrateRawSecrets: method(RawSecretMigrationInputSchema, RawSecretMigrationReportSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    deleteProfile: method(ProfileRefInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    testProfile: method(ProfileRefInputSchema, LlmGenerateResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      // Runs a REAL generation, so it is as slow as the thing it is testing.
      timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
    }),
    /**
     * The models a kind offers, for a SAVED profile or an unsaved draft
     * (`connection`). A mutation, not a query: a draft may carry a key, and a
     * query's input travels in the URL. Admin: it dials whatever endpoint the
     * draft names and may resolve a stored key to do it. The answer never
     * carries a secret — failures are a typed result, never a throw.
     */
    listModels: method(LlmListModelsInputSchema, LlmListModelsResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    getDefaults: method(z.object({}), z.array(LlmDefaultSchema)),
    setDefault: method(
      z.object({
        selector: LlmDefaultSelectorSchema,
        profileId: z.string().nullable(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    getUsage: method(
      z.object({
        since: z.number().optional(),
        until: z.number().optional(),
        consumer: z.string().optional(),
        profileId: z.string().optional(),
      }),
      z.array(LlmUsageRollupSchema),
    ),
    // managed runtime — operator surface (hub provider fans/pins to llm-runtime, spec §4)
    listModelCatalog: method(z.object({}), z.array(ManagedModelCatalogEntrySchema)),
    listRuntimeNodes: method(z.object({}), z.array(LlmRuntimeNodeSchema)),
    listNodeModels: method(z.object({ nodeId: z.string() }), z.array(LlmNodeModelSchema)),
    /**
     * One typed Hugging Face reference → a pinned, verified `ManagedModelRef`.
     *
     * Runs on the HUB, not on the target node: resolution needs egress to
     * huggingface.co, and an agent that cannot reach it still installs fine
     * through the model-distributor relay. Nothing is downloaded here — this is
     * a tree read plus a HEAD, so the operator sees the size, the quantization
     * and the mmproj BEFORE approving a multi-GB pull.
     */
    resolveModelRef: method(
      z.object({
        /** `https://huggingface.co/<org>/<repo>/resolve/main/<f>.gguf`,
         *  `<org>/<repo>/<f>.gguf`, `<org>/<repo>` or `<org>/<repo>:<QUANT>`. */
        ref: z.string(),
        /** Explicit ceiling override, in bytes. Absent = the built-in ceiling. */
        maxBytes: z.number().positive().optional(),
      }),
      HfModelResolutionSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    installModel: method(z.object({ nodeId: z.string(), model: ManagedModelRefSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    deleteModel: method(z.object({ nodeId: z.string(), file: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    getRuntimeStatus: method(ProfileRefInputSchema, LlmRuntimeStatusSchema),
    startRuntime: method(ProfileRefInputSchema, LlmRuntimeStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    stopRuntime: method(ProfileRefInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ILlmProvider = InferProvider<typeof llmCapability>
