/**
 * `llm` provider core — a plain object closure over its deps (the
 * `createNotificationOutputProvider` shape). Dispatch resolves a profile,
 * routes to the right adapter (or a node's runtime via nodePin), and writes ONE
 * usage row per profile actually called (ok or error) — one per call, except a
 * guardrail fallback, where the refused attempt keeps its own row. Secrets are
 * redacted on read and merged on write; a stored key never round-trips.
 */
import type {
  AppleFmAvailability,
  ILlmProvider,
  IScopedLogger,
  LlmGenerateBaseInput,
  LlmGenerateResult,
  LlmImage,
  LlmListModelsResult,
  LlmNodeModel,
  LlmProfile,
  LlmProviderConfig,
  LlmRuntimeAppleCompleteInput,
  LlmRuntimeCompleteInput,
  LlmRuntimeDiskUsage,
  LlmRuntimeNode,
  LlmRuntimeStatus,
  ManagedModelCatalogEntry,
  ManagedModelRef,
  ManagedRuntimeConfig,
} from '@camstack/types'
import { LlmProfileSchema } from '@camstack/types'
import {
  isIdentityConsumer,
  type AppleNodeView,
  stampAppleProfile,
  withAppleVision,
} from './apple-profile.js'
import { listHttpModels } from './client/list-models.js'
import type { LlmClient } from './client/llm-client.js'
import { resolveRetryPolicy } from './client/retry-policy.js'
import { DefaultsStore } from './defaults-store.js'
import { AI_KIND_DESCRIPTORS, descriptorOf } from './kinds/descriptors.js'
import { httpConnectionFrom, isHttpKind } from './kinds/http-connection.js'
import {
  appleNodeIdOf,
  managedRuntimeOf,
  secretFieldOf,
  validateProviderConfig,
} from './kinds/provider-config.js'
import { ProfileStore } from './profile-store.js'
import { type LlmPurpose, nextFallbackProfile, resolveProfile } from './resolve-profile.js'
import { CancelRegistry } from './runtime/cancel-registry.js'
import { resolveHfReference } from './runtime/hf-ref.js'
import {
  keepsStoredSecret,
  markSecretSet,
  mergeProfileSecrets,
  profileSecretOf,
  REDACTED_MARKER,
  redactProfileForRead,
} from './secrets.js'
import { allowAllBudgetGate, type BudgetGate, type UsageRecorder } from './usage/usage-port.js'

export const AI_ADDON_ID = 'ai'

/** Node-side runtime seam — implemented over nodePin in Task 17. */
export interface RuntimeClient {
  complete(nodeId: string, input: LlmRuntimeCompleteInput): Promise<LlmGenerateResult>
  completeApple(nodeId: string, input: LlmRuntimeAppleCompleteInput): Promise<LlmGenerateResult>
  /** Idempotent on the node; forwarded by `llm.cancel` for node-side generations. */
  cancel(nodeId: string, requestId: string): Promise<void>
  appleAvailability(nodeId: string): Promise<AppleFmAvailability>
  ensureStarted(nodeId: string, runtime: ManagedRuntimeConfig): Promise<LlmRuntimeStatus>
  stopRuntime(nodeId: string): Promise<void>
  status(nodeId: string): Promise<LlmRuntimeStatus>
  installModel(nodeId: string, model: ManagedModelRef): Promise<void>
  deleteModel(nodeId: string, file: string): Promise<void>
  listLocalModels(nodeId: string): Promise<LlmNodeModel[]>
  getDiskUsage(nodeId: string): Promise<LlmRuntimeDiskUsage>
  listRuntimeNodeIds(): Promise<string[]>
  /** From the capability REGISTRY (a local read) — not the topology walk. */
  listRegisteredRuntimeNodeIds(): Promise<string[] | null>
}

export interface LlmProviderDeps {
  readonly store: ProfileStore
  readonly defaults: DefaultsStore
  /** The transport. There is no second one — every kind goes through it. */
  readonly client: LlmClient
  readonly usage: UsageRecorder
  readonly budget?: BudgetGate
  readonly runtime?: RuntimeClient
  readonly catalog?: readonly ManagedModelCatalogEntry[]
  readonly addonId?: string
  readonly logger?: IScopedLogger
  /** Egress-restricted-node relay: hub tars a locally-resident model and pushes
   *  it to the target node via the reused model-distributor cap (spec §4.2).
   *  Used as a fallback when a direct per-node install fails. */
  readonly distributeModel?: (nodeId: string, model: ManagedModelRef) => Promise<void>
  /** The hub's mirror of each node's Apple availability. Absent = all unknown. */
  readonly appleNodes?: AppleNodeView
  /** Injected so a test can answer `listModels` without a network. */
  readonly listModelsFetch?: typeof fetch
}

/** A model list is a GET; a vendor that takes longer than this is down. */
const LIST_MODELS_TIMEOUT_MS = 15_000

/**
 * The profile's sampling defaults under the caller's per-call values. The HTTP
 * client applies these itself from the profile it is handed; a generation that
 * runs on a node receives only this input, so the hub resolves them here.
 */
function withProfileDefaults(
  input: LlmGenerateBaseInput,
  profile: LlmProfile,
): LlmGenerateBaseInput {
  const system = input.system ?? profile.systemPrompt
  const temperature = input.temperature ?? profile.temperature
  const topP = input.topP ?? profile.topP
  const topK = input.topK ?? profile.topK
  const maxTokens = input.maxTokens ?? profile.maxTokens
  return {
    ...input,
    ...(system !== undefined ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  }
}

function requireRuntime(runtime: RuntimeClient | undefined): RuntimeClient {
  if (runtime === undefined) throw new Error('llm-runtime client not wired')
  return runtime
}

/** The wire view of a profile: a stored key (even an unreadable one) shows as set. */
function redactForWire(store: ProfileStore, profile: LlmProfile): LlmProfile {
  return store.lockedReason(profile.id) !== null
    ? markSecretSet(profile)
    : redactProfileForRead(profile)
}

/**
 * The connection `listModels` dials: the draft (or the stored bag), with an
 * untouched secret (absent or the redaction marker) resolved from the STORED
 * profile of the same kind. The value goes to the vendor, never back to the
 * caller. `null` = the stored key exists but the keychain cannot serve it.
 */
function connectionForListing(
  kind: string,
  draft: LlmProviderConfig,
  stored: LlmProfile | null,
  storedLocked: boolean,
): LlmProviderConfig | null {
  const field = secretFieldOf(kind)
  if (field === null) return draft
  const incoming = draft[field]
  if (incoming !== undefined && incoming !== REDACTED_MARKER) return draft
  const { [field]: _untouched, ...rest } = draft
  if (stored === null) return rest
  if (storedLocked) return null
  const secret = profileSecretOf(stored)
  return secret !== undefined ? { ...rest, [field]: secret } : rest
}

export function createLlmProvider(deps: LlmProviderDeps): ILlmProvider {
  const addonId = deps.addonId ?? AI_ADDON_ID
  const budget = deps.budget ?? allowAllBudgetGate

  /**
   * Generations a caller can still stop.
   *
   * An `AbortSignal` dies at the process boundary, so the id is what crosses it
   * and this map is where it lands. Entries are removed in a `finally`, which
   * matters more than it looks: a leak here is a controller per notification,
   * forever, on the hub's longest-lived addon.
   */
  const inFlight = new Map<string, AbortController>()
  /**
   * Generations running on ANOTHER node, by `requestId` → the node they were
   * pinned to. An `AbortController` here would abort nothing: the work is
   * behind a nodePin, so `cancel` forwards `llmRuntime.cancel` to that node.
   */
  const remoteInFlight = new Map<string, string>()
  /**
   * A cancel for an id nothing has registered YET — it arrived while the call
   * was still in the budget check or reading the profile store. Kept as a
   * short-lived tombstone so the call is stopped the moment it would start.
   */
  const earlyCancels = new CancelRegistry()

  async function onNode(
    requestId: string | undefined,
    nodeId: string,
    run: () => Promise<LlmGenerateResult>,
  ): Promise<LlmGenerateResult> {
    if (requestId === undefined) return run()
    remoteInFlight.set(requestId, nodeId)
    try {
      return await run()
    } finally {
      if (remoteInFlight.get(requestId) === nodeId) remoteInFlight.delete(requestId)
    }
  }

  async function resolveById(profileId: string): Promise<LlmProfile | null> {
    return deps.store.getById(profileId)
  }

  /** One profile, one attempt. Never writes usage — `dispatch` owns that. */
  async function runOn(
    profile: LlmProfile,
    input: LlmGenerateBaseInput,
    images: readonly LlmImage[] | undefined,
  ): Promise<LlmGenerateResult> {
    if (input.requestId !== undefined && earlyCancels.takeTombstone(input.requestId)) {
      return { ok: false, code: 'timeout', message: 'the call was cancelled' }
    }
    if (profile.kind === 'managed-local') {
      const runtime = deps.runtime
      const managed = managedRuntimeOf(profile)
      if (runtime === undefined || managed === null) {
        return { ok: false, code: 'unavailable', message: 'managed runtime not configured' }
      }
      return onNode(input.requestId, managed.nodeId, () =>
        runtime.complete(managed.nodeId, {
          ...input,
          ...(images !== undefined ? { images: [...images] } : {}),
          runtime: managed,
          timeoutMs: profile.timeoutMs,
        }),
      )
    }

    if (profile.kind === 'apple-foundation') {
      if (isIdentityConsumer(input.consumer)) {
        deps.logger?.warn('llm identity consumer refused on Apple Foundation Models', {
          meta: { consumer: input.consumer, profileId: profile.id },
        })
        return {
          ok: false,
          code: 'bad-request',
          message: 'Apple Foundation Models is never used for identity or biometric work',
        }
      }
      const runtime = deps.runtime
      const nodeId = appleNodeIdOf(profile)
      if (runtime === undefined || nodeId === null) {
        return { ok: false, code: 'unavailable', message: 'apple-foundation profile has no node' }
      }
      if (deps.appleNodes?.isKnownOffline(nodeId) === true) {
        // Never dial a node the registry already calls offline: a nodePin
        // there waits out discovery (30 s) before it fails.
        deps.logger?.info('llm apple-foundation node is offline; not dispatched', {
          meta: { consumer: input.consumer, profileId: profile.id, nodeId },
        })
        return { ok: false, code: 'unavailable', message: `node "${nodeId}" is offline` }
      }
      return onNode(input.requestId, nodeId, () =>
        runtime.completeApple(nodeId, {
          ...withProfileDefaults(input, profile),
          ...(images !== undefined ? { images: [...images] } : {}),
          timeoutMs: input.timeoutMs ?? profile.timeoutMs,
        }),
      )
    }

    const lock = deps.store.lockedReason(profile.id)
    if (lock !== null) {
      // The key is stored in the keychain and the keychain cannot serve it:
      // say so, never send the call out unauthenticated.
      deps.logger?.warn('llm profile API key unavailable; call not dispatched', {
        meta: { profileId: profile.id, consumer: input.consumer, reason: lock },
      })
      return {
        ok: false,
        code: 'unavailable',
        message: `the API key of profile "${profile.id}" is in the keychain and cannot be read (${lock}); unlock it on System -> Secrets`,
      }
    }

    const timeoutMs = input.timeoutMs ?? profile.timeoutMs
    // A call with no `requestId` is simply not cancellable — the bound is still
    // the backstop. Callers that gate on a deadline SHOULD send one.
    const controller = new AbortController()
    const requestId = input.requestId
    if (requestId !== undefined) inFlight.set(requestId, controller)
    try {
      return await deps.client.generate(
        {
          profile,
          ...(input.system !== undefined ? { system: input.system } : {}),
          prompt: input.prompt,
          ...(images !== undefined ? { images } : {}),
          ...(input.jsonSchema !== undefined ? { jsonSchema: input.jsonSchema } : {}),
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.topP !== undefined ? { topP: input.topP } : {}),
          ...(input.topK !== undefined ? { topK: input.topK } : {}),
          retry: resolveRetryPolicy(input.consumer, profile.retry, input.retry),
          signal: controller.signal,
        },
        timeoutMs,
      )
    } finally {
      if (requestId !== undefined) inFlight.delete(requestId)
    }
  }

  /**
   * Resolve, run, and write ONE usage row per profile actually called.
   *
   * A GUARDRAIL refusal is the backend declining the request, not an answer to
   * it — Apple refuses surveillance-framed prompts in 0.1 s — so the caller's
   * next profile in the chain gets the request (`nextFallbackProfile`). The
   * refused attempt keeps its own row: it was a real call on that profile, and
   * its error rate is how the operator sees how often that happens.
   */
  async function dispatch(
    input: LlmGenerateBaseInput,
    images: readonly LlmImage[] | undefined,
  ): Promise<LlmGenerateResult> {
    const purpose: LlmPurpose = images !== undefined && images.length > 0 ? 'vision' : 'text'

    const record = async (
      result: LlmGenerateResult,
      profile: LlmProfile | undefined,
      startedAt: number,
    ): Promise<LlmGenerateResult> => {
      await deps.usage.record({
        ts: startedAt,
        consumer: input.consumer,
        ...(profile !== undefined
          ? { profileId: profile.id, kind: profile.kind, model: profile.model }
          : {}),
        inputTokens: result.ok ? result.usage.inputTokens : 0,
        outputTokens: result.ok ? result.usage.outputTokens : 0,
        latencyMs: result.ok ? result.latencyMs : Date.now() - startedAt,
        ok: result.ok,
        ...(result.ok ? {} : { errorCode: result.code }),
        imageCount: images?.length ?? 0,
      })
      return result
    }

    const startedAt = Date.now()
    const budgetErr = await budget.check(input.consumer)
    if (budgetErr !== null) return record(budgetErr, undefined, startedAt)

    const stored = await deps.store.list()
    // Only a vision question reads `supportsVision`; a text call does not pay
    // a per-node hop for a field it never looks at.
    const profiles = purpose === 'vision' ? withAppleVision(stored, deps.appleNodes) : stored
    const defaults = await deps.defaults.list()
    const selector = { profileId: input.profileId, consumer: input.consumer, purpose }
    const resolved = resolveProfile(profiles, defaults, selector)
    if (!resolved.ok) return record(resolved.err, undefined, startedAt)

    const tried = new Set<string>()
    let profile = resolved.profile
    for (;;) {
      tried.add(profile.id)
      const attemptStartedAt = Date.now()
      const result = await record(await runOn(profile, input, images), profile, attemptStartedAt)
      if (result.ok || result.refusalSource !== 'guardrail') return result
      if (input.profileId !== undefined) {
        // A caller that NAMED a profile pinned it — for privacy (on-device
        // only) or because it is testing that profile. Re-sending its prompt to
        // a default it did not choose, possibly a cloud one, is not ours to do.
        deps.logger?.warn('llm guardrail refusal on an explicitly chosen profile; no fallback', {
          meta: { consumer: input.consumer, profileId: profile.id, requestId: input.requestId },
        })
        return result
      }
      const next = nextFallbackProfile(profiles, defaults, selector, tried)
      if (next === null) {
        deps.logger?.warn('llm guardrail refusal; no fallback profile left', {
          meta: { consumer: input.consumer, profileId: profile.id, requestId: input.requestId },
        })
        return result
      }
      deps.logger?.info('llm guardrail refusal; falling back to the next profile', {
        meta: {
          consumer: input.consumer,
          profileId: profile.id,
          fallbackProfileId: next.id,
          requestId: input.requestId,
        },
      })
      profile = next
    }
  }

  async function resolveManagedProfile(profileId: string): Promise<{
    profile: LlmProfile
    runtime: ManagedRuntimeConfig
  }> {
    const profile = await resolveById(profileId)
    if (profile === null) throw new Error(`profile "${profileId}" not found`)
    const runtime = managedRuntimeOf(profile)
    if (runtime === null) {
      throw new Error(`profile "${profileId}" is not a managed-local profile`)
    }
    return { profile, runtime }
  }

  /** `managed-local`: the curated catalogue, plus the GGUFs already on the node. */
  async function listManagedModels(config: LlmProviderConfig): Promise<LlmListModelsResult> {
    const catalog = (deps.catalog ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      contextLength: entry.contextSizeDefault,
      features: { vision: entry.purpose === 'vision' },
    }))
    const nodeId = typeof config.nodeId === 'string' && config.nodeId !== '' ? config.nodeId : null
    if (nodeId === null || deps.runtime === undefined) return { ok: true, models: catalog }
    try {
      const onNode = await deps.runtime.listLocalModels(nodeId)
      // Only files the catalogue does not already account for.
      const files = onNode
        .filter((m) => m.catalogId === undefined)
        .map((m) => ({ id: m.file, label: m.file }))
      return { ok: true, models: [...catalog, ...files] }
    } catch (err: unknown) {
      return {
        ok: false,
        code: 'network',
        message: `node "${nodeId}" did not list its models: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return {
    generate: (input) => dispatch(input, undefined),
    generateVision: ({ images, ...input }) => dispatch(input, images),

    listProfileKinds: async () => AI_KIND_DESCRIPTORS.map((d) => ({ ...d, addonId })),

    listProfiles: async () =>
      withAppleVision(await deps.store.list(), deps.appleNodes).map((p) =>
        redactForWire(deps.store, { ...p, addonId }),
      ),

    upsertProfile: async ({ profile }) => {
      if (descriptorOf(profile.kind) === null) {
        throw new Error(`this provider serves no kind "${profile.kind}"`)
      }
      const existing = await deps.store.getById(profile.id)
      // A key that is stored but cannot be read must survive a save that does
      // not carry a new one: merging against "no key" would erase it.
      const keepStoredKey =
        keepsStoredSecret(profile) && deps.store.lockedReason(profile.id) !== null
      const merged = mergeProfileSecrets(existing, { ...profile, addonId })
      // The provider owns `providerConfig`: refuse what this kind does not accept.
      const checked = validateProviderConfig(merged.kind, merged.providerConfig)
      if (!checked.ok) throw new Error(`profile "${profile.name}": ${checked.message}`)
      const parsed = LlmProfileSchema.parse({ ...merged, providerConfig: checked.config })
      const validated =
        parsed.kind === 'apple-foundation' ? stampAppleProfile(parsed, deps.appleNodes) : parsed
      await deps.store.upsert(validated, { keepStoredKey })
      return keepStoredKey ? markSecretSet(validated) : redactProfileForRead(validated)
    },

    migrateRawSecrets: async ({ apply }) => deps.store.migrateRawKeys(apply),

    deleteProfile: async ({ profileId }) => {
      await deps.store.delete(profileId)
    },

    testProfile: async ({ profileId }) => {
      const profile = await resolveById(profileId)
      if (profile === null || !profile.enabled) {
        return {
          ok: false,
          code: 'no-profile',
          message: `profile "${profileId}" not found or disabled`,
        }
      }
      return dispatch(
        {
          consumer: 'profile-test',
          profileId,
          prompt: 'Reply with the single word: ok',
          maxTokens: 8,
        },
        undefined,
      )
    },

    /**
     * A saved profile or an unsaved draft. The answer is models or a typed
     * failure — never the key: a stored secret is resolved here, sent to the
     * vendor in a header, and nothing the vendor or the network says back
     * carries it (`list-models.ts` scrubs every message).
     */
    listModels: async ({ kind, profileId, connection }): Promise<LlmListModelsResult> => {
      const descriptor = descriptorOf(kind)
      if (descriptor === null) {
        return { ok: false, code: 'invalid', message: `this provider serves no kind "${kind}"` }
      }
      if (descriptor.modelCatalog === 'static') {
        return { ok: true, models: [...(descriptor.staticModels ?? [])] }
      }
      if (descriptor.modelCatalog === 'none') {
        return { ok: false, code: 'unsupported', message: `kind "${kind}" has no model list` }
      }
      const stored = profileId !== undefined ? await resolveById(profileId) : null
      if (profileId !== undefined && stored === null && connection === undefined) {
        return { ok: false, code: 'invalid', message: `profile "${profileId}" not found` }
      }
      // A stored profile of ANOTHER kind lends nothing — least of all its key.
      const sameKind = stored !== null && stored.kind === kind ? stored : null
      const config = connectionForListing(
        kind,
        connection ?? sameKind?.providerConfig ?? {},
        sameKind,
        sameKind !== null && deps.store.lockedReason(sameKind.id) !== null,
      )
      if (config === null) {
        return {
          ok: false,
          code: 'auth',
          message:
            'the stored key is in the keychain and cannot be read right now; unlock it on System -> Secrets',
        }
      }
      if (isHttpKind(kind)) {
        return listHttpModels(kind, httpConnectionFrom(config), {
          timeoutMs: LIST_MODELS_TIMEOUT_MS,
          ...(deps.listModelsFetch !== undefined ? { fetchImpl: deps.listModelsFetch } : {}),
        })
      }
      if (kind === 'managed-local') return listManagedModels(config)
      return { ok: false, code: 'unsupported', message: `kind "${kind}" has no model list` }
    },

    /**
     * Idempotent by construction and never throws, because a caller that has
     * given up must not have to handle an error from giving up. An id nothing
     * runs under yet leaves a short-lived tombstone (the call may still be in
     * its budget check); the running ids are deleted by the dispatch's own
     * `finally`, never here — one owner.
     */
    cancel: async ({ requestId }) => {
      const controller = inFlight.get(requestId)
      if (controller !== undefined) {
        controller.abort()
        deps.logger?.debug('llm generation cancelled by its caller', { meta: { requestId } })
        return
      }
      const nodeId = remoteInFlight.get(requestId)
      if (nodeId === undefined) {
        // Nothing running under this id yet: stop it when it arrives.
        earlyCancels.cancel(requestId)
        return
      }
      if (deps.runtime === undefined) return
      try {
        await deps.runtime.cancel(nodeId, requestId)
        deps.logger?.debug('llm node-side generation cancelled by its caller', {
          meta: { requestId, nodeId },
        })
      } catch (err) {
        // Giving up must never throw at the caller; the node's own bound is
        // the backstop. Said out loud, because the model is still busy.
        deps.logger?.warn('llm cancel could not reach the node running the generation', {
          meta: { requestId, nodeId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    },

    getDefaults: async () => deps.defaults.list(),
    setDefault: async ({ selector, profileId }) => {
      await deps.defaults.set(selector, profileId)
    },

    getUsage: async (filter) => deps.usage.rollup(filter),

    listModelCatalog: async () => [...(deps.catalog ?? [])],

    listRuntimeNodes: async () => {
      const runtime = requireRuntime(deps.runtime)
      const nodeIds = await runtime.listRuntimeNodeIds()
      const nodes = await Promise.all(
        nodeIds.map(async (nodeId): Promise<LlmRuntimeNode> => {
          const [statusRes, diskRes, appleRes] = await Promise.allSettled([
            runtime.status(nodeId),
            runtime.getDiskUsage(nodeId),
            runtime.appleAvailability(nodeId),
          ])
          // This page asks every node anyway; its answer keeps the mirror warm.
          if (appleRes.status === 'fulfilled') deps.appleNodes?.observe(nodeId, appleRes.value)
          if (statusRes.status === 'rejected') {
            return {
              nodeId,
              reachable: false,
              error:
                statusRes.reason instanceof Error
                  ? statusRes.reason.message
                  : String(statusRes.reason),
            }
          }
          return {
            nodeId,
            reachable: true,
            status: statusRes.value,
            ...(diskRes.status === 'fulfilled' ? { disk: diskRes.value } : {}),
            // A node that did not answer carries no `apple`: unknown, not absent.
            ...(appleRes.status === 'fulfilled' ? { apple: appleRes.value } : {}),
          }
        }),
      )
      return nodes
    },

    listNodeModels: async ({ nodeId }) => requireRuntime(deps.runtime).listLocalModels(nodeId),

    /**
     * Hugging Face reference → a pinned `ManagedModelRef`, on the HUB.
     *
     * Never throws: a refusal ("this repo has 24 quantizations", "this is
     * gated", "23 GB is over the ceiling") is an ANSWER the operator has to
     * read and act on, and turning it into a tRPC error would reduce all of
     * them to a red toast with no candidate list and no override.
     */
    resolveModelRef: async ({ ref, maxBytes }) => {
      // Anonymous: CamStack never sends a Hugging Face credential.
      const outcome = await resolveHfReference(ref, {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      })
      if (!outcome.ok) {
        deps.logger?.info('llm model reference refused', {
          meta: { ref, code: outcome.error.code },
        })
        return {
          ok: false,
          code: outcome.error.code,
          message: outcome.error.message,
          ...(outcome.error.candidates !== undefined
            ? { candidates: [...outcome.error.candidates] }
            : {}),
          // `too-large` is the only refusal the operator can overrule, and it
          // is the only one that carries the number to overrule it WITH.
          ...(outcome.error.requiredBytes !== undefined
            ? { requiredBytes: outcome.error.requiredBytes }
            : {}),
        }
      }
      const { resolution } = outcome
      deps.logger?.info('llm model reference resolved', {
        meta: {
          ref,
          repo: resolution.repo,
          quantization: resolution.quantization,
          purpose: resolution.purpose,
          totalBytes: resolution.totalBytes,
        },
      })
      return {
        ok: true,
        model: {
          kind: 'url',
          url: resolution.main.url,
          ...(resolution.main.sha256 !== undefined ? { sha256: resolution.main.sha256 } : {}),
          label: resolution.label,
          sizeBytes: resolution.main.sizeBytes,
          extraFiles: resolution.extras.map((e) => ({
            url: e.url,
            filename: e.filename,
            sizeBytes: e.sizeBytes,
            ...(e.sha256 !== undefined ? { sha256: e.sha256 } : {}),
          })),
        },
        label: resolution.label,
        repo: resolution.repo,
        quantization: resolution.quantization,
        purpose: resolution.purpose,
        totalBytes: resolution.totalBytes,
        extraFilenames: resolution.extras.map((e) => e.filename),
      }
    },

    installModel: async ({ nodeId, model }) => {
      const runtime = requireRuntime(deps.runtime)
      try {
        await runtime.installModel(nodeId, model)
      } catch (err) {
        // Egress-restricted node: the target could not fetch the artifact.
        // Fall back to the hub→node model-distributor relay (spec §4.2).
        if (deps.distributeModel === undefined) throw err
        deps.logger?.warn('direct install failed; relaying via model-distributor', {
          meta: { nodeId, error: err instanceof Error ? err.message : String(err) },
        })
        await deps.distributeModel(nodeId, model)
      }
    },

    deleteModel: async ({ nodeId, file }) => {
      await requireRuntime(deps.runtime).deleteModel(nodeId, file)
    },

    getRuntimeStatus: async ({ profileId }) => {
      const { runtime } = await resolveManagedProfile(profileId)
      return requireRuntime(deps.runtime).status(runtime.nodeId)
    },

    startRuntime: async ({ profileId }) => {
      const { runtime } = await resolveManagedProfile(profileId)
      return requireRuntime(deps.runtime).ensureStarted(runtime.nodeId, runtime)
    },

    stopRuntime: async ({ profileId }) => {
      const { runtime } = await resolveManagedProfile(profileId)
      await requireRuntime(deps.runtime).stopRuntime(runtime.nodeId)
    },
  }
}
