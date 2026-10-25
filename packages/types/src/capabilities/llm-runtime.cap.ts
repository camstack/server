/**
 * `llm-runtime` — node-side managed llama.cpp executor (spec §4). Registered
 * on EVERY node where `addon-ai` is installed; the hub `llm` provider reaches
 * a specific node's runtime with `nodePin(profile.runtime.nodeId)` — normal
 * cap routing, zero bespoke plumbing. `internal: true`: the operator reaches
 * this only through the `llm` cap's methods.
 *
 * One running llama-server child per node in v1 (models are RAM-heavy).
 * Resource ceiling = llama-server flags + idleStopMinutes ONLY (no RSS
 * watchdog — operator decision #3).
 */
import { AI_CAP_TRANSPORT_TIMEOUT_MS, AI_MODEL_INSTALL_TIMEOUT_MS } from './ai-cap-timeouts.js'
import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import {
  LlmGenerateBaseInputSchema,
  LlmGenerateResultSchema,
  LlmImageSchema,
} from './llm-shared.js'

/**
 * A companion artifact that MUST land beside the main GGUF: the `mmproj`
 * projector of a vision model, or shards 2..N of a split GGUF. Carried on the
 * REF rather than looked up at install time, so what the operator approved in
 * the preview is exactly what the node downloads.
 */
export const ManagedModelExtraFileSchema = z.object({
  url: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  sha256: z.string().optional(),
})
export type ManagedModelExtraFile = z.infer<typeof ManagedModelExtraFileSchema>

export const ManagedModelRefSchema = z.discriminatedUnion('kind', [
  /** Curated preset (spec §4.2). */
  z.object({ kind: z.literal('catalog'), catalogId: z.string() }),
  /**
   * Arbitrary GGUF URL — in practice a Hugging Face `resolve` URL produced by
   * `llm.resolveModelRef`. Everything past `url` is the PINNED plan that
   * resolution computed: it is what makes the install verifiable (sha256),
   * observable (sizeBytes → a real percentage) and complete (extraFiles).
   */
  z.object({
    kind: z.literal('url'),
    url: z.string(),
    sha256: z.string().optional(),
    /** Picker/status label; the file basename when absent. */
    label: z.string().optional(),
    sizeBytes: z.number().optional(),
    extraFiles: z.array(ManagedModelExtraFileSchema).optional(),
  }),
  /** Pre-provisioned file on the node. */
  z.object({ kind: z.literal('path'), path: z.string() }),
])
export type ManagedModelRef = z.infer<typeof ManagedModelRefSchema>

export const ManagedRuntimeConfigSchema = z.object({
  /** WHERE the runtime lives — hub or any agent. */
  nodeId: z.string(),
  /** Closed for v1; 'ollama' is a v2 candidate. */
  engine: z.enum(['llama-cpp']),
  model: ManagedModelRefSchema,
  contextSize: z.number().int().default(4096),
  /** 0 = CPU-only. */
  gpuLayers: z.number().int().default(0),
  /** Default: cpus-2, clamped ≥1 (resolved node-side). */
  threads: z.number().int().optional(),
  /** Concurrent slots (`--parallel`). */
  parallel: z.number().int().default(1),
  /** Logical batch size (`-b`). Larger = faster prompt ingest, more RAM. */
  batchSize: z.number().int().positive().optional(),
  /** Physical batch / micro-batch (`-ub`). */
  ubatchSize: z.number().int().positive().optional(),
  /**
   * `--flash-attn`. Cuts KV-cache memory on the backends that implement it and
   * is a no-op elsewhere, so it is offered rather than assumed.
   */
  flashAttention: z.boolean().default(false),
  /**
   * `--mlock`. Pins the weights in RAM so the OS cannot page them out mid
   * inference. Costs the full model size in resident memory — which is exactly
   * what the RAM budget is counting.
   */
  mlock: z.boolean().default(false),
  /**
   * `--no-mmap`. Reads the whole GGUF up front instead of mapping it. Slower to
   * start, but avoids the page-fault stalls a network or spinning-disk model
   * store produces on every first token.
   */
  noMmap: z.boolean().default(false),
  /** `--cache-type-k` / `--cache-type-v` — quantising the KV cache is the
   *  cheapest way to fit a longer context in the same RAM. */
  cacheTypeK: z.enum(['f32', 'f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0']).optional(),
  cacheTypeV: z.enum(['f32', 'f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0']).optional(),
  /**
   * Escape hatch for llama-server flags this schema does NOT model — `--jinja`
   * (which most vision chat templates need and some language-only models
   * dislike), `--cont-batching`, `--rope-scaling`, …
   *
   * It is NOT a second place to set the flags above. A token that collides
   * with a typed field is REJECTED at start, naming the field that owns it
   * (`assertNoOwnedFlags`), because two knobs writing the same argv is exactly
   * the "two switches that disagree" failure this repo has already shipped
   * twice (D62).
   */
  extraArgs: z.array(z.string()).default([]),
  /** Else lazy: first generate boots it. */
  autoStart: z.boolean().default(false),
  /** 0 = never; frees RAM after quiet periods. */
  idleStopMinutes: z.number().int().default(30),
})
export type ManagedRuntimeConfig = z.infer<typeof ManagedRuntimeConfigSchema>

/**
 * Where a multi-GB install currently is. A single 0..1 fraction cannot answer
 * "is it stuck?" for an install that is three files (shards + mmproj) followed
 * by a sha256 pass over 22 GB — during which the fraction sat at 1.0 and the
 * node looked hung. Phase + file + bytes is the smallest shape that does.
 */
export const LlmDownloadProgressSchema = z.object({
  phase: z.enum(['downloading', 'verifying']),
  /** The artifact currently moving, e.g. `mmproj-F16.gguf`. */
  file: z.string(),
  fileIndex: z.number().int(),
  fileCount: z.number().int(),
  /** Across the WHOLE install, not the current file. */
  downloadedBytes: z.number(),
  totalBytes: z.number().optional(),
})
export type LlmDownloadProgress = z.infer<typeof LlmDownloadProgressSchema>

export const LlmRuntimeStatusSchema = z.object({
  /** Status is ALWAYS node-qualified. */
  nodeId: z.string(),
  state: z.enum(['stopped', 'downloading', 'starting', 'ready', 'crashed', 'failed']),
  pid: z.number().optional(),
  port: z.number().optional(),
  modelPath: z.string().optional(),
  modelId: z.string().optional(),
  downloadProgress: z.number().min(0).max(1).optional(),
  /** Detail behind `downloadProgress`; present for the same lifetime. */
  download: LlmDownloadProgressSchema.optional(),
  lastError: z.string().optional(),
  crashesInWindow: z.number(),
  /** Child RSS (sampled best-effort). */
  memoryBytes: z.number().optional(),
  vramBytes: z.number().optional(),
})
export type LlmRuntimeStatus = z.infer<typeof LlmRuntimeStatusSchema>

export const LlmNodeModelSchema = z.object({
  file: z.string(),
  sizeBytes: z.number(),
  catalogId: z.string().optional(),
  installedAt: z.number().optional(),
  /**
   * Absolute path on the node. Present so a file that is on disk but matches
   * no catalog entry — a custom Hugging Face install, or a GGUF the operator
   * copied in by hand — is still SELECTABLE, as a `{kind:'path'}` ref. Without
   * it the picker could list such a file and do nothing with it.
   */
  path: z.string().optional(),
})
export type LlmNodeModel = z.infer<typeof LlmNodeModelSchema>

export const LlmRuntimeDiskUsageSchema = z.object({
  nodeId: z.string(),
  modelsBytes: z.number(),
  freeBytes: z.number().optional(),
})
export type LlmRuntimeDiskUsage = z.infer<typeof LlmRuntimeDiskUsageSchema>

export const LlmRuntimeCompleteInputSchema = LlmGenerateBaseInputSchema.extend({
  images: z.array(LlmImageSchema).optional(),
  runtime: ManagedRuntimeConfigSchema,
  /** The managed profile's timeout, threaded by the hub provider. */
  timeoutMs: z.number().int().positive().optional(),
})
export type LlmRuntimeCompleteInput = z.infer<typeof LlmRuntimeCompleteInputSchema>

/**
 * Why Apple Foundation Models cannot run on a node that has it in principle.
 * The first three are Apple's own `UnavailableReason`s, verbatim; the rest are
 * ours: the OS predates the framework (macOS < 26), the helper binary is not
 * in the installed addon, or it crashed past the respawn bound.
 */
export const AppleFmUnavailableReasonSchema = z.enum([
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'osTooOld',
  'helperMissing',
  'helperCrashed',
])
export type AppleFmUnavailableReason = z.infer<typeof AppleFmUnavailableReasonSchema>

/**
 * Apple Foundation Models on ONE node — four states, never a boolean (D315).
 *
 *   - `available`            — the helper probed it; what it CAN do is reported
 *                              here (`imageInput`, `contextSize`, languages),
 *                              never typed by an operator.
 *   - `unavailable`          — a known absence, with the reason to act on.
 *   - `unsupported-platform` — not a Mac; there is nothing to enable.
 *   - `unknown`              — the probe did not answer (not yet run, timed
 *                              out, helper crashed mid-probe). A failed
 *                              measurement is NEVER `unavailable` (D393).
 */
export const AppleFmAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    osVersion: z.string(),
    /** Tokens, as the framework reports it. Read at runtime, never assumed. */
    contextSize: z.number().int().positive(),
    /** BCP-47-ish tags (`it-IT`) of the languages the model supports. */
    languages: z.array(z.string()),
    /** Whether prompts may carry images. `false` on a macOS 26 build. */
    imageInput: z.boolean(),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: AppleFmUnavailableReasonSchema,
    osVersion: z.string().nullable(),
    detail: z.string(),
  }),
  z.object({ state: z.literal('unsupported-platform'), platform: z.string() }),
  z.object({ state: z.literal('unknown'), error: z.string() }),
])
export type AppleFmAvailability = z.infer<typeof AppleFmAvailabilitySchema>

/**
 * A generation on the node's Apple Foundation Models helper. A separate verb
 * from `complete`, whose `runtime` is a llama.cpp config: overloading it would
 * drag a GGUF model reference into a backend that has none. `images` is part
 * of the contract so vision needs no cap change later; a node whose model has
 * no image input REFUSES them (`unavailable`), never drops them.
 */
export const LlmRuntimeAppleCompleteInputSchema = LlmGenerateBaseInputSchema.extend({
  images: z.array(LlmImageSchema).optional(),
  /** The profile's timeout, threaded by the hub provider. */
  timeoutMs: z.number().int().positive().optional(),
})
export type LlmRuntimeAppleCompleteInput = z.infer<typeof LlmRuntimeAppleCompleteInputSchema>

export const LlmRuntimeCancelInputSchema = z.object({ requestId: z.string() })
export type LlmRuntimeCancelInput = z.infer<typeof LlmRuntimeCancelInputSchema>

export const llmRuntimeCapability = {
  name: 'llm-runtime',
  scope: 'system',
  // Spec declares per-node semantics; the registry literal `'per-node'` is
  // typed but unwired (no `getProviderForNode` route resolution), so this
  // follows the platform-probe convention: singleton + transport-level
  // nodePin. Each node's addon-ai instance registers its own provider
  // through the registerNode handshake; the hub provider reaches a specific
  // node with `nodePin(profile.runtime.nodeId)`.
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * `complete`, `status`, `listLocalModels` and `getDiskUsage` had NO
     * `auth` override — `internal: true` did not gate the mount (see the
     * 2026-08-26 note on `data-store-provider`), so they were reachable on
     * the AppRouter by ANY authenticated session at the default
     * `auth: 'protected'`, inconsistent with the rest of this cap (already
     * `auth: 'admin'`) and with this file's own docblock: "the operator
     * reaches this only through the `llm` cap's methods." The sole caller,
     * `addon-ai`'s `runtime-client.ts`, reaches every method here via
     * `ctx.api` + `nodePin` — never tRPC — so `auth: 'admin'` costs it
     * nothing; the public `llm` cap (which end users and non-admin sessions
     * legitimately call for chat/generation) is untouched.
     */
    complete: method(LlmRuntimeCompleteInputSchema, LlmGenerateResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
    }),
    ensureStarted: method(
      z.object({ runtime: ManagedRuntimeConfigSchema }),
      LlmRuntimeStatusSchema,
      // Loads model weights off disk — minutes on a cold cache, not seconds.
      {
        kind: 'mutation',
        auth: 'admin',
        timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
      },
    ),
    stop: method(z.object({}), z.void(), { kind: 'mutation', auth: 'admin' }),
    status: method(z.object({}), LlmRuntimeStatusSchema, { auth: 'admin' }),
    installModel: method(z.object({ model: ManagedModelRefSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
      // A multi-gigabyte download. An hour is not generous, it is honest.
      timeoutMs: AI_MODEL_INSTALL_TIMEOUT_MS,
    }),
    deleteModel: method(z.object({ file: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    listLocalModels: method(z.object({}), z.array(LlmNodeModelSchema), {
      auth: 'admin',
    }),
    getDiskUsage: method(z.object({}), LlmRuntimeDiskUsageSchema, {
      auth: 'admin',
    }),
    /**
     * Stop a node-side generation started with a `requestId` — `complete` or
     * `completeApple`. The hub's `llm.cancel` forwards here with the same
     * nodePin the generation took; before this existed a cancelled
     * managed-local generation kept running on the node to its own timeout.
     * Idempotent: an unknown or finished id is a no-op.
     */
    cancel: method(LlmRuntimeCancelInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    /**
     * This node's Apple Foundation Models state, answered from a mirror the
     * node refreshes in the background — it never waits on a probe.
     */
    appleAvailability: method(z.object({}), AppleFmAvailabilitySchema, { auth: 'admin' }),
    completeApple: method(LlmRuntimeAppleCompleteInputSchema, LlmGenerateResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: AI_CAP_TRANSPORT_TIMEOUT_MS,
    }),
  },
} as const satisfies CapabilityDefinition

export type ILlmRuntimeProvider = InferProvider<typeof llmRuntimeCapability>
