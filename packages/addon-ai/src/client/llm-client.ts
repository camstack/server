/**
 * `LlmClient` — the ONE file in this repo allowed to import the LLM library.
 *
 * Everything above it (`provider.ts`, the test chat, the consumers' gates)
 * speaks only our own types: `LlmProfile` in, `LlmGenerateResult` /
 * `StreamChunk` out. That is the whole point of the seam — the library ships a
 * major every ~6 months with wide renames, and this boundary makes that cost
 * one file instead of the addon (`docs/design/llm-library-adoption.md` §2.4).
 * `scripts/check-llm-library-boundary.ts` fails CI if a second file imports it.
 *
 * ## Three properties this module owes its callers
 *
 * 1. **It never throws.** Every failure becomes an `LlmGenerateResult` carrying
 *    an `LlmErrorCode` of ours. `no-profile` and `unavailable` are ordinary
 *    RESULTS for a gate that must keep running.
 * 2. **`signal` is not optional.** The unary path used to be uncancellable —
 *    `execute-plan` made its own controller for the timeout and the caller had
 *    no way in — so a gate that stopped waiting at 8 s left a generation
 *    running for 60 (§1.4.5). A mandatory parameter is what stops that shipping
 *    again.
 * 3. **A model is ALWAYS a provider instance, never a bare id string.** Passing
 *    `'openai/gpt-4o'` routes the call to Vercel's hosted AI Gateway and fails
 *    with `Unauthenticated request to AI Gateway`. That default is silent, so
 *    it is also a CI guard, not just this paragraph (§2.3.2).
 *
 * ## Two wire edges that are asserted by tests, not trusted
 *
 * - `createOpenAICompatible` only emits a real `json_schema` when built with
 *   `supportsStructuredOutputs: true`; without it the schema NEVER reaches the
 *   server and the request silently degrades to `{"type":"json_object"}`
 *   (measured, §2.3.3). This is the exact class of bug this repo pays for most,
 *   so `llm-client.spec.ts` asserts the request BODY.
 * - `createOpenAI(...)(id)` returns a **Responses API** model, not
 *   chat-completions. `llama-server` does not implement `/v1/responses`
 *   (ggml-org/llama.cpp#19138) and the wire differs, so we always call
 *   `.chat(id)` explicitly.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type {
  LlmErrorCode,
  LlmGenerateResult,
  LlmImage,
  LlmProfile,
  LlmRetryPolicy,
} from '@camstack/types'
import {
  APICallError,
  generateText,
  InvalidPromptError,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  NoSuchToolError,
  Output,
  RetryError,
  streamText,
  TypeValidationError,
} from 'ai'
import { descriptorOf } from '../kinds/descriptors.js'
import {
  apiKeyOf,
  explicitBaseUrl,
  extraHeadersOf,
  httpConnectionOf,
} from '../kinds/http-connection.js'
import type { OpenStreamOutcome, StreamChunk } from '../test-chat/run-stream.js'
import {
  type ConnectImpl,
  defaultConnectImpl,
  probeTcpConnect,
  type TcpEndpoint,
  tcpEndpointOf,
} from './connect-probe.js'
import { OPENAI_DEFAULT_BASE_URL } from './list-models.js'

/**
 * Every kind. There is no longer a wire this client cannot speak, which is what
 * removed `streamed: false` from the test chat: Anthropic and Google used to
 * report `unsupported` and fall back to one unary call.
 */
const SUPPORTED_KINDS: ReadonlySet<LlmProfile['kind']> = new Set<LlmProfile['kind']>([
  'openai',
  'openai-compatible',
  'managed-local',
  'anthropic',
  'google',
])

export interface LlmCallRequest {
  readonly profile: LlmProfile
  readonly system?: string
  readonly prompt: string
  readonly images?: readonly LlmImage[]
  readonly jsonSchema?: Readonly<Record<string, unknown>>
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly retry?: LlmRetryPolicy
  /** Mandatory. See property 2 in the header. */
  readonly signal: AbortSignal
}

/**
 * The two bounds {@link LlmClient.openStream} works under, and what each one
 * is allowed to measure.
 *
 * They are NOT two halves of the same wait. `connectTimeoutMs` covers the TCP
 * handshake only; `firstTokenTimeoutMs` covers everything from "the endpoint
 * accepted" to "the model said something", RESPONSE HEADERS INCLUDED. That
 * second sentence is the fix: a cold LM Studio accepts the socket, reads the
 * request, spends minutes loading the model, and writes its status line last —
 * so a header wait under the connect bound reported a loading model as a dead
 * endpoint. See `connect-probe.ts` for the full account.
 */
export interface OpenStreamOptions {
  /** The socket. Short on purpose — being told a port is shut should be fast. */
  readonly connectTimeoutMs: number
  /** The model. Generous on purpose — a cold GPU load lives entirely here. */
  readonly firstTokenTimeoutMs: number
  /**
   * Called once, the instant the endpoint accepts — i.e. when the wait stops
   * being about the network and starts being about the model. The caller uses
   * it to say so on screen; nothing here depends on it.
   *
   * Not called when the profile carries no probe-able URL either: in that case
   * the phase boundary is genuinely unknown and claiming one would be a guess.
   */
  readonly onConnected?: () => void
}

export interface LlmClient {
  /** Unary. Returns the RESULT, never throws. */
  generate(request: LlmCallRequest, timeoutMs: number): Promise<LlmGenerateResult>
  /** Streaming. `unsupported` = this profile has no token stream here. */
  openStream(request: LlmCallRequest, opts: OpenStreamOptions): Promise<OpenStreamOutcome>
  /** True when {@link generate} can serve this profile at all. */
  supports(kind: LlmProfile['kind']): boolean
}

export interface LlmClientDeps {
  /** Injected so a test can assert the request BODY on the wire. */
  readonly fetchImpl?: typeof fetch
  /** Injected so a test can hold a TCP handshake open — the one connect fault
   *  loopback cannot reproduce. Production always dials a real socket. */
  readonly connectImpl?: ConnectImpl
}

// ── profile → model ───────────────────────────────────────────────────

/**
 * The base URL for the OpenAI-family wires only. Anthropic and Google carry
 * their own defaults inside their providers, so an unset `baseUrl` there is
 * normal rather than a configuration fault.
 */
function baseUrlFor(profile: LlmProfile): string | null {
  const explicit = explicitBaseUrl(httpConnectionOf(profile))
  if (explicit !== null) return explicit
  return profile.kind === 'openai' ? OPENAI_DEFAULT_BASE_URL : null
}

/**
 * Where to knock, for the connect probe.
 *
 * Wider than {@link baseUrlFor}: an Anthropic or Google profile with an
 * explicit `baseUrl` (a LAN proxy, a gateway) is just as probe-able as an
 * openai-compatible one. Only a profile that relies on a vendor's built-in
 * endpoint yields `null` — the client never learns that URL, and inventing one
 * to probe would be probing a different host from the one the call uses.
 */
function probeEndpointFor(profile: LlmProfile): TcpEndpoint | null {
  const baseUrl = explicitBaseUrl(httpConnectionOf(profile)) ?? baseUrlFor(profile)
  return baseUrl === null ? null : tcpEndpointOf(baseUrl)
}

/**
 * Build the provider instance for a profile.
 *
 * Returns `null` when the profile cannot be served — a missing base URL on an
 * openai-compatible row is a CONFIGURATION fault, and it must surface as a
 * result the caller can name, not as a throw from inside a vendor SDK.
 */
export function languageModelFor(
  profile: LlmProfile,
  deps: LlmClientDeps = {},
): LanguageModel | null {
  const conn = httpConnectionOf(profile)
  const headers = extraHeadersOf(conn)
  const apiKey = apiKeyOf(conn) ?? ''
  const explicit = explicitBaseUrl(conn)

  if (profile.kind === 'anthropic') {
    const provider = createAnthropic({
      apiKey,
      ...(explicit !== null ? { baseURL: explicit } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
    })
    // The Messages wire. `max_tokens` is REQUIRED there, and the library
    // supplies its own default when the profile leaves it unset — one of the
    // three per-vendor quirks the hand-written adapter carried.
    return provider.messages(profile.model)
  }

  if (profile.kind === 'google') {
    const provider = createGoogleGenerativeAI({
      apiKey,
      ...(explicit !== null ? { baseURL: explicit } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
    })
    return provider.chat(profile.model)
  }

  const baseURL = baseUrlFor(profile)
  if (baseURL === null) return null

  if (profile.kind === 'openai') {
    const provider = createOpenAI({
      apiKey,
      baseURL,
      ...(headers !== undefined ? { headers } : {}),
      ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
    })
    // `.chat` — NOT `provider(id)`, which is the Responses API. See header.
    return provider.chat(profile.model)
  }

  // `openai-compatible` and `managed-local` are the same wire; the managed one
  // is simply a llama-server this cluster started on 127.0.0.1.
  const provider = createOpenAICompatible({
    name: profile.kind,
    baseURL,
    ...(apiKey.length > 0 ? { apiKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
    // Without this the json_schema never reaches the server. Asserted by test.
    supportsStructuredOutputs: true,
  })
  return provider.chatModel(profile.model)
}

// ── request shaping ───────────────────────────────────────────────────

/**
 * The kinds whose wire actually carries top-k.
 *
 * Neither OpenAI wire does — `chat/completions` has no `top_k`, and the library
 * DROPS the field with a runtime warning rather than sending it (measured: the
 * request body contains `top_p` and no `top_k`). Anthropic and Google do have
 * it. The kind's descriptor (`profileFields`) is the single owner of that
 * list — the same list keeps the profile editor honest: a knob is offered only
 * where turning it changes the request.
 */
export function supportsTopK(kind: LlmProfile['kind']): boolean {
  return descriptorOf(kind)?.profileFields.includes('topK') === true
}

/**
 * Sampling + bounds, profile defaults under per-call overrides.
 */
interface CallSettings {
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly maxRetries: number
  readonly providerOptions?: Record<string, Record<string, string>>
}

/**
 * The provider-options key the openai-compatible provider reads for a kind: its
 * name in camelCase (`openai-compatible` -> `openaiCompatible`).
 */
function providerOptionsKeyOf(kind: string): string {
  return kind.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}

/**
 * `reasoning_effort` for the kinds whose descriptor offers `reasoningEffort`.
 * The top-level `reasoning` call option cannot carry `none` on this wire (the
 * library drops it), so the provider option is the only way to switch thinking
 * off. `off` is the wire's `none`.
 */
function reasoningOptionsFor(
  profile: LlmProfile,
): { providerOptions: Record<string, Record<string, string>> } | Record<string, never> {
  const effort = profile.reasoningEffort
  if (effort === undefined) return {}
  if (descriptorOf(profile.kind)?.profileFields.includes('reasoningEffort') !== true) return {}
  return {
    providerOptions: {
      [providerOptionsKeyOf(profile.kind)]: { reasoningEffort: effort === 'off' ? 'none' : effort },
    },
  }
}

export function callSettingsFor(request: LlmCallRequest): CallSettings {
  const { profile } = request
  const temperature = request.temperature ?? profile.temperature
  const topP = request.topP ?? profile.topP
  const topK = supportsTopK(profile.kind) ? (request.topK ?? profile.topK) : undefined
  const maxOutputTokens = request.maxTokens ?? profile.maxTokens
  const retry = request.retry ?? profile.retry
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...reasoningOptionsFor(profile),
    // The library counts RETRIES; we configure ATTEMPTS. `enabled: false` and
    // `maxAttempts: 1` both mean "call once".
    maxRetries: retry.enabled ? Math.max(0, retry.maxAttempts - 1) : 0,
  }
}

/**
 * Structured output, or nothing.
 *
 * `Output.object` is what makes the schema reach the WIRE — on the
 * openai-compatible provider built with `supportsStructuredOutputs: true` it
 * emits a real `response_format: {type:'json_schema', json_schema:{schema}}`,
 * which is what our three hand-written adapters each did their own way. The
 * three implementations collapse to this one call.
 */
function structuredOutputFor(
  request: LlmCallRequest,
): { output: ReturnType<typeof Output.object> } | Record<string, never> {
  if (request.jsonSchema === undefined) return {}
  return { output: Output.object({ schema: jsonSchema(request.jsonSchema) }) }
}

/**
 * The system turn.
 *
 * It is a TOP-LEVEL option (`instructions`), not a `role: 'system'` message —
 * the library rejects a system message inside `messages` outright ("Use the
 * instructions option instead"). It reads like a rename but it is enforced, and
 * it is the shape each provider then maps to its own wire (a `system` message
 * for chat-completions, a top-level `system` for Anthropic, `systemInstruction`
 * for Google), which is precisely the per-vendor difference we stopped writing.
 *
 * A caller's `system` REPLACES the profile default; it never appends. Two system
 * prompts arguing with each other is worse than either one alone.
 */
function instructionsFor(
  request: LlmCallRequest,
): { instructions: string } | Record<string, never> {
  const system = request.system ?? request.profile.systemPrompt
  return system !== undefined && system.length > 0 ? { instructions: system } : {}
}

/**
 * The user turn.
 *
 * The image goes in the SAME user message as the text — a separate message
 * loses the association on several wires. `file` (not the deprecated `image`
 * part) is the current content type for binary media.
 */
export function messagesFor(request: LlmCallRequest): ModelMessage[] {
  const images = request.images ?? []
  if (images.length === 0) {
    return [{ role: 'user', content: request.prompt }]
  }
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: request.prompt },
        ...images.map((image) => ({
          type: 'file' as const,
          data: image.bytes,
          mediaType: image.mimeType,
        })),
      ],
    },
  ]
}

// ── error mapping ─────────────────────────────────────────────────────

/**
 * Vendor failure → our taxonomy.
 *
 * `RetryError` is the wrapper the library returns when the attempts are spent;
 * the interesting error is the LAST one inside it, so the envelope is unwrapped
 * before anything is classified (§2.3, "chi classifica gli errori deve
 * scartare l'involucro" [whoever classifies errors must discard the envelope]).
 */
export function mapLibraryError(error: unknown): { code: LlmErrorCode; message: string } {
  if (RetryError.isInstance(error)) {
    const last = error.errors.at(-1)
    if (last !== undefined) {
      const mapped = mapLibraryError(last)
      return {
        code: mapped.code,
        message: `${mapped.message} (after ${error.errors.length} attempts)`,
      }
    }
    return { code: 'unavailable', message: error.message }
  }

  if (isAbortLike(error)) return { code: 'timeout', message: 'the call was cancelled' }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    const message = (error.responseBody ?? error.message).slice(0, 500)
    if (status === 401 || status === 403) return { code: 'auth', message }
    if (status === 429) return { code: 'rate-limited', message }
    if (status === 400 || status === 404 || status === 422) return { code: 'bad-request', message }
    if (status !== undefined && status >= 500) return { code: 'unavailable', message }
    // No status at all = the socket never produced a response.
    return { code: 'unavailable', message }
  }

  if (InvalidPromptError.isInstance(error) || NoSuchToolError.isInstance(error)) {
    return { code: 'bad-request', message: error.message }
  }
  if (TypeValidationError.isInstance(error)) {
    return { code: 'adapter-error', message: error.message }
  }
  return {
    code: 'adapter-error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError')
  )
}

/**
 * A server that omits `usage` yields `undefined`, not `0` (§2.3). Every usage
 * row is written from these numbers, so an undefined must land as 0 here rather
 * than as `NaN` three layers up in the rollup.
 */
function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// ── the client ────────────────────────────────────────────────────────

/**
 * Chain the caller's signal to a total-time bound.
 *
 * `AbortSignal.any` is what makes the caller's cancellation reach the socket:
 * the returned signal aborts when EITHER the deadline fires or the caller gives
 * up, and the library forwards it all the way into `fetch`.
 */
function boundedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

export function createLlmClient(deps: LlmClientDeps = {}): LlmClient {
  const modelFor = (profile: LlmProfile): LanguageModel | null => languageModelFor(profile, deps)

  return {
    supports: (kind) => SUPPORTED_KINDS.has(kind),

    async generate(request, timeoutMs) {
      const startedAt = Date.now()
      if (!SUPPORTED_KINDS.has(request.profile.kind)) {
        return {
          ok: false,
          code: 'adapter-error',
          message: `no client wire for kind ${request.profile.kind}`,
        }
      }
      const model = modelFor(request.profile)
      if (model === null) {
        return {
          ok: false,
          code: 'bad-request',
          message: `profile "${request.profile.name}" has no base URL`,
        }
      }

      try {
        const result = await generateText({
          model,
          messages: messagesFor(request),
          ...instructionsFor(request),
          ...callSettingsFor(request),
          ...structuredOutputFor(request),
          abortSignal: boundedSignal(request.signal, timeoutMs),
        })
        return {
          ok: true,
          text: result.text,
          model: request.profile.model,
          usage: {
            inputTokens: tokenCount(result.usage.inputTokens),
            outputTokens: tokenCount(result.usage.outputTokens),
          },
          truncated: result.finishReason === 'length',
          latencyMs: Date.now() - startedAt,
        }
      } catch (error) {
        // A schema mismatch is NOT a failed call. The library validates the
        // reply against the schema and throws, but every consumer of this cap
        // parses the text permissively anyway (local models fence their JSON),
        // and turning "slightly-off JSON" into an error would flip a fail-open
        // gate into suppressing a real notification. The text the model DID
        // produce is carried on the error for exactly this purpose.
        if (NoObjectGeneratedError.isInstance(error) && error.text !== undefined) {
          return {
            ok: true,
            text: error.text,
            model: request.profile.model,
            usage: {
              inputTokens: tokenCount(error.usage?.inputTokens),
              outputTokens: tokenCount(error.usage?.outputTokens),
            },
            truncated: error.finishReason === 'length',
            latencyMs: Date.now() - startedAt,
          }
        }
        // A timeout must read as a timeout even though it arrives as an abort:
        // if OUR deadline fired and the caller is still waiting, it is ours.
        //
        // The sentence names the cold load on purpose. This is the ONE bound a
        // unary call has, so it covers the model loading as well as the
        // generation — and `testProfile`, the other surface an operator probes
        // a new profile with, lands here. `timed out after 60000ms` sent the
        // reader looking at the network; the fault is almost always a model
        // that has not finished loading.
        if (isAbortLike(error) && !request.signal.aborted) {
          return {
            ok: false,
            code: 'timeout',
            message: `no answer within ${String(
              Math.round(timeoutMs / 1000),
            )}s — a cold model can take minutes to load; warm it or raise the profile's total timeout`,
          }
        }
        const mapped = mapLibraryError(error)
        return { ok: false, code: mapped.code, message: mapped.message }
      }
    },

    async openStream(request, opts) {
      if (!SUPPORTED_KINDS.has(request.profile.kind)) return { kind: 'unsupported' }
      const model = modelFor(request.profile)
      if (model === null) return { kind: 'unsupported' }

      // ── 1. the SOCKET, under the connect bound ──────────────────────
      //
      // The handshake is the only thing that answers "is this endpoint even
      // there" without ambiguity. The header wait used to sit here, and it is
      // exactly the wrong measurement: LM Studio accepts, reads the request,
      // loads the model for minutes, and writes its status line LAST — so a
      // cold load was reported as an endpoint that never accepted anything.
      const endpoint = probeEndpointFor(request.profile)
      if (endpoint !== null) {
        const probe = await probeTcpConnect(
          endpoint,
          opts.connectTimeoutMs,
          request.signal,
          deps.connectImpl ?? defaultConnectImpl,
        )
        if (probe.kind === 'timeout') {
          return { kind: 'connect-timeout', timeoutMs: opts.connectTimeoutMs }
        }
        if (probe.kind === 'error') {
          // ECONNREFUSED / EHOSTUNREACH / ENOTFOUND — a real endpoint fault,
          // named, and reported the instant the kernel says so rather than at
          // the end of the bound.
          return {
            kind: 'network',
            message: request.signal.aborted ? 'the call was cancelled' : probe.message,
          }
        }
        opts.onConnected?.()
      }

      // ── 2. the FIRST CHUNK, under the FIRST-TOKEN bound ─────────────
      //
      // What "open" means here is "the model has produced something", and it
      // is the FIRST PULL of the token stream that establishes it — not
      // `stream.response`.
      //
      // That distinction is the second half of the live bug. `stream.response`
      // reads like a header edge and is not one: measured against a local
      // server that wrote headers at 125 ms, a token at 325 ms and closed at
      // 925 ms, it resolved at 935 ms — the END of the generation. Awaiting it
      // under the 10 s connect bound therefore required the WHOLE answer to
      // finish inside ten seconds, and held every token back until it had.
      // A warm 5 s reply hid that; a cold load did not. `zz`-free proof lives
      // in `llm-client-connect-bound.spec.ts`.
      //
      // Its own controller, chained to the caller's — aborting the caller
      // aborts this one, never the reverse — and the timer is CLEARED the
      // moment the first chunk lands, so a long answer is never cut short by
      // the bound that was only ever about starting.
      const firstChunkBound = new AbortController()
      const onOuterAbort = (): void => firstChunkBound.abort()
      request.signal.addEventListener('abort', onOuterAbort, { once: true })
      const firstChunkTimer = setTimeout(() => firstChunkBound.abort(), opts.firstTokenTimeoutMs)
      firstChunkTimer.unref?.()

      // `streamText` DOES NOT THROW — measured, not assumed. A 401 ends the
      // token stream with a plain `{done:true}` and hands the real
      // `APICallError` to `onError`; an abort ends it the same silent way and
      // hands nothing to anyone. Both look exactly like "the model politely
      // said nothing". So the failure is captured here, and a pull that
      // finishes is only believed once this is still empty.
      let streamFailure: unknown
      try {
        const stream = streamText({
          model,
          messages: messagesFor(request),
          ...instructionsFor(request),
          ...callSettingsFor(request),
          ...structuredOutputFor(request),
          abortSignal: AbortSignal.any([request.signal, firstChunkBound.signal]),
          onError: ({ error }) => {
            streamFailure = error
          },
        })

        // `streamText` is lazy: nothing is dialled until the stream is pulled.
        // THIS pull is what dials and waits out the load.
        const iterator = chunksFrom(stream)[Symbol.asyncIterator]()
        const first = await iterator.next()

        if (streamFailure !== undefined) {
          // A refusal the provider stated: 401, 404, a 500. Carried with its
          // own code, because "your key is wrong" and "your box is off" are
          // not the same sentence and this surface exists to tell them apart.
          const mapped = mapLibraryError(streamFailure)
          return { kind: 'provider-error', code: mapped.code, message: mapped.message }
        }
        if (firstChunkBound.signal.aborted) {
          return request.signal.aborted
            ? { kind: 'network', message: 'the call was cancelled' }
            : { kind: 'first-token-timeout', timeoutMs: opts.firstTokenTimeoutMs }
        }
        return { kind: 'open', chunks: resumeFrom(first, iterator) }
      } catch (error) {
        // Reached only by the faults the library raises eagerly — an invalid
        // prompt, a model the provider cannot build.
        if (isAbortLike(error) && !request.signal.aborted) {
          return { kind: 'first-token-timeout', timeoutMs: opts.firstTokenTimeoutMs }
        }
        const mapped = mapLibraryError(error)
        return { kind: 'provider-error', code: mapped.code, message: mapped.message }
      } finally {
        clearTimeout(firstChunkTimer)
        request.signal.removeEventListener('abort', onOuterAbort)
      }
    },
  }
}

/**
 * The library's stream → our `StreamChunk`s. `run-stream.ts` is unchanged.
 *
 * Structurally typed on only what is read, so a major that adds fields to the
 * result object does not reach this function. `PromiseLike` (not `Promise`) is
 * deliberate: the library's deferred values are thenables, not real promises.
 */
interface LibraryTextStream {
  readonly textStream: AsyncIterable<string>
  readonly usage: PromiseLike<{
    inputTokens?: number | undefined
    outputTokens?: number | undefined
  }>
  readonly finishReason: PromiseLike<string>
}

/**
 * Hand back a stream whose first chunk has already been pulled.
 *
 * `openStream` has to consume one chunk to know the model started — that is
 * what its bound measures — and the caller must still receive it. Replaying it
 * here is what keeps "the first token is the load signal" true for the reader.
 */
async function* resumeFrom(
  first: IteratorResult<StreamChunk>,
  iterator: AsyncIterator<StreamChunk>,
): AsyncGenerator<StreamChunk, void, unknown> {
  if (first.done === true) return
  yield first.value
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return
    yield next.value
  }
}

async function* chunksFrom(stream: LibraryTextStream): AsyncGenerator<StreamChunk, void, unknown> {
  for await (const text of stream.textStream) {
    if (text.length > 0) yield { kind: 'token', text }
  }
  // A provider that reports no usage must still terminate the stream cleanly —
  // the `end` chunk is what writes the usage row, so losing it loses the row.
  const [usage, finishReason] = await Promise.all([
    Promise.resolve(stream.usage).catch(() => ({ inputTokens: 0, outputTokens: 0 })),
    Promise.resolve(stream.finishReason).catch(() => 'unknown'),
  ])
  yield {
    kind: 'end',
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    truncated: finishReason === 'length',
  }
}
