/**
 * The streaming test chat, over injected seams.
 *
 * Reads as one straight line: validate the profile → resolve the picture →
 * open the provider stream → forward tokens → done. Every branch that stops
 * short emits ONE `error` event and logs the reason that distinguishes the
 * remedies, and every path writes exactly one usage row.
 *
 * ## The three bounds, and why they are three
 *
 * `connect` (10 s) — THE TCP HANDSHAKE, and nothing beyond it. Short: waiting
 * two minutes to be told a port is closed is a worse answer than ten seconds.
 *
 * `first token` (120 s, configurable) — accepted, but nothing produced yet.
 * This covers the RESPONSE HEADERS as well as the tokens: on the LM Studio /
 * llama-server wire the status line is what the server writes once the model
 * has finished loading, so the headers are part of the load, not part of the
 * connect. Putting them under the connect bound is precisely the bug this
 * shape replaces — a cold qwen3-vl reported as `unavailable: the endpoint did
 * not accept the connection within 10s`, twice, against an endpoint that was
 * up and working. The headers and the first token share ONE budget rather than
 * getting one each, because the page promises the operator a single number.
 *
 * `idle` (60 s) — tokens started and stopped. The model already proved it was
 * loaded, so the generous bound no longer applies and a stall is a stall.
 *
 * None of these is a transport timeout. The transport (`ctx.dataPlane`) is a
 * pipe the hub holds open; the only clocks in the generation path are the ones
 * this module sets, and each of them produces a sentence naming what happened.
 */
import type {
  IScopedLogger,
  LlmErrorCode,
  LlmGenerateResult,
  LlmProfile,
  MediaFileKind,
} from '@camstack/types'
import { httpConnectionOf } from '../kinds/http-connection.js'
import type { UsageRowInput } from '../usage/usage-port.js'
import {
  TEST_CHAT_CONNECT_TIMEOUT_MS,
  TEST_CHAT_CONSUMER,
  TEST_CHAT_IDLE_TIMEOUT_MS,
  TEST_CHAT_MIN_VISION_INPUT_TOKENS,
  type TestChatAttachment,
  type TestChatEvent,
  type TestChatRequest,
} from './contract.js'
import {
  type MediaDeps,
  renderTranscript,
  resolveImage,
  type SnapshotImage,
  type TrackMediaRow,
  type VisionImage,
} from './media.js'

/** One frame off the provider's own stream, already normalised. */
export type StreamChunk =
  | { readonly kind: 'token'; readonly text: string }
  | {
      readonly kind: 'end'
      readonly inputTokens: number
      readonly outputTokens: number
      readonly truncated: boolean
    }

export interface StreamRequest {
  readonly profile: LlmProfile
  readonly system?: string
  readonly prompt: string
  readonly images?: readonly VisionImage[]
  readonly maxTokens?: number
  readonly temperature?: number
}

export type OpenStreamOutcome =
  | { readonly kind: 'open'; readonly chunks: AsyncIterable<StreamChunk> }
  /** The TCP handshake never completed — a black hole, a dead route, a box off. */
  | { readonly kind: 'connect-timeout'; readonly timeoutMs: number }
  /**
   * The endpoint ACCEPTED and then wrote no response headers inside the
   * first-token budget. Its own kind, because the remedy is the opposite one:
   * this is a model that has not finished loading, not an endpoint that is
   * down, and telling the operator to go check the base URL is what made the
   * live failure take two sessions to understand.
   */
  | { readonly kind: 'first-token-timeout'; readonly timeoutMs: number }
  /**
   * The provider answered and REFUSED — a 401, a 404, a 500. It carries its own
   * `LlmErrorCode` because a wrong api key and an endpoint that is down have
   * nothing in common except that neither produced tokens, and this surface
   * exists to tell an operator which one they have.
   */
  | { readonly kind: 'provider-error'; readonly code: LlmErrorCode; readonly message: string }
  /** The socket itself failed — refused, unreachable, unresolvable. */
  | { readonly kind: 'network'; readonly message: string }
  /** This profile's wire has no token stream here — fall back to one call. */
  | { readonly kind: 'unsupported' }

export interface OpenStreamOpts {
  readonly signal: AbortSignal
  /** The socket only. */
  readonly connectTimeoutMs: number
  /** Response headers AND the first token — one budget, see the header. */
  readonly firstTokenTimeoutMs: number
  /** Fired once the endpoint has accepted, i.e. when the wait stops being
   *  about the network and starts being about the model. */
  readonly onConnected: () => void
}

export interface TestChatStreamDeps extends MediaDeps {
  readonly getProfile: (profileId: string) => Promise<LlmProfile | null>
  readonly openStream: (request: StreamRequest, opts: OpenStreamOpts) => Promise<OpenStreamOutcome>
  /** The non-streaming fallback — the `llm` provider's own dispatch. */
  readonly generateOnce: (request: StreamRequest) => Promise<LlmGenerateResult>
  readonly recordUsage: (row: UsageRowInput) => Promise<void>
  readonly logger: IScopedLogger
  readonly now: () => number
}

export type EmitEvent = (event: TestChatEvent) => void

interface Ending {
  readonly code: LlmErrorCode
  readonly message: string
}

/** Race `promise` against a timer; `null` means the timer won. */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ readonly timedOut: true } | { readonly timedOut: false; readonly value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      expiry,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Pull the next chunk under a deadline.
 *
 * The iterator is NOT abandoned on a timeout — the caller stops reading and the
 * signal tears the socket down, which is what actually frees the provider. A
 * dangling `next()` promise here would keep the generator alive.
 */
async function nextChunk(
  iterator: AsyncIterator<StreamChunk>,
  ms: number,
): Promise<
  | { readonly kind: 'chunk'; readonly value: StreamChunk }
  | { readonly kind: 'end' }
  | { readonly kind: 'timeout' }
> {
  const raced = await withDeadline(iterator.next(), ms)
  if (raced.timedOut) return { kind: 'timeout' }
  return raced.value.done === true ? { kind: 'end' } : { kind: 'chunk', value: raced.value.value }
}

export async function runTestChatStream(
  deps: TestChatStreamDeps,
  request: TestChatRequest,
  emit: EmitEvent,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = deps.now()
  // Tags every line about this run so a per-camera question is answerable.
  const tags =
    request.attachment?.kind === 'snapshot' ? { deviceId: request.attachment.deviceId } : undefined
  const withTags = <T extends Record<string, unknown>>(
    meta: T,
  ): { tags?: { deviceId: number }; meta: T } => (tags !== undefined ? { tags, meta } : { meta })

  let profileForUsage: LlmProfile | null = null
  let imageCount = 0
  let finished = false

  const finish = async (
    ending: Ending | null,
    counts: { readonly inputTokens: number; readonly outputTokens: number },
  ): Promise<void> => {
    if (finished) return
    finished = true
    const latencyMs = deps.now() - startedAt
    // ONE row per run, ok or not — the provider's discipline, and the only
    // durable trace a test call leaves.
    await deps
      .recordUsage({
        ts: startedAt,
        consumer: TEST_CHAT_CONSUMER,
        ...(profileForUsage !== null
          ? {
              profileId: profileForUsage.id,
              kind: profileForUsage.kind,
              model: profileForUsage.model,
            }
          : {}),
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        latencyMs,
        ok: ending === null,
        ...(ending !== null ? { errorCode: ending.code } : {}),
        imageCount,
      })
      .catch(() => undefined)
    if (ending !== null) emit({ kind: 'error', code: ending.code, message: ending.message })
  }

  const fail = async (ending: Ending, logMessage: string, meta: Record<string, unknown> = {}) => {
    deps.logger.warn(logMessage, withTags({ profileId: request.profileId, ...meta }))
    await finish(ending, { inputTokens: 0, outputTokens: 0 })
  }

  if (signal.aborted) {
    deps.logger.info('ai test chat: client had already left before the run started', withTags({}))
    return
  }

  // ── 1. the profile ────────────────────────────────────────────────
  const profile = await deps.getProfile(request.profileId)
  if (profile === null || !profile.enabled) {
    await fail(
      { code: 'no-profile', message: `profile "${request.profileId}" not found or disabled` },
      'ai test chat: profile missing or disabled — turn dropped',
    )
    return
  }
  profileForUsage = profile

  // ── 2. the picture, before anything expensive (D54) ───────────────
  let attachment: TestChatAttachment | null = null
  let images: readonly VisionImage[] | undefined

  if (request.attachment !== undefined) {
    // THE CHEAP QUESTION FIRST — refuse before dialling a camera.
    if (!profile.supportsVision) {
      await fail(
        { code: 'bad-request', message: `profile "${profile.name}" is not vision-capable` },
        'ai test chat: profile is not vision-capable — image turn refused',
        { model: profile.model },
      )
      return
    }
    emit({ kind: 'status', phase: 'resolving-image' })
    const outcome = await resolveImage(deps, request.attachment)
    if (!outcome.ok) {
      // A requested picture that cannot be resolved ENDS the run. It must never
      // degrade into a text-only answer — that shipped once and produced a
      // confident reply to a question about an image nobody sent.
      await fail(
        outcome.failure,
        'ai test chat: attachment could not be resolved — vision turn refused',
        { attachmentKind: request.attachment.kind },
      )
      return
    }
    attachment = {
      ...outcome.resolved.attachment,
      thumbnailBase64: Buffer.from(outcome.resolved.image.bytes).toString('base64'),
    }
    images = [outcome.resolved.image]
    imageCount = 1
  }

  if (signal.aborted) {
    deps.logger.info('ai test chat: client aborted before the provider was called', withTags({}))
    return
  }

  const streamRequest: StreamRequest = {
    profile,
    prompt: renderTranscript(request.messages),
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }

  // ── 3. open the provider stream ───────────────────────────────────
  //
  // `connecting` really is the socket now, and it lasts milliseconds on a LAN.
  // The MINUTES are spent in the phase after it — waiting for a model to load
  // — and the page has to be told the moment that boundary is crossed, because
  // an unlabelled wait is the silence that made this look like a hang.
  emit({ kind: 'status', phase: 'connecting' })
  let modelWaitStartedAt: number | null = null
  const opened = await deps.openStream(streamRequest, {
    signal,
    connectTimeoutMs: TEST_CHAT_CONNECT_TIMEOUT_MS,
    firstTokenTimeoutMs: request.firstTokenTimeoutMs,
    onConnected: () => {
      modelWaitStartedAt = deps.now()
      emit({ kind: 'status', phase: 'first-token-wait' })
    },
  })

  /**
   * What is LEFT of the first-token budget.
   *
   * The response headers and the first token are one wait spent two ways, so
   * they draw on one budget: the page says "up to Ns" and that has to be the
   * whole truth, not N per stage.
   */
  const remainingFirstTokenMs = (): number =>
    modelWaitStartedAt === null
      ? request.firstTokenTimeoutMs
      : Math.max(1, request.firstTokenTimeoutMs - (deps.now() - modelWaitStartedAt))

  if (opened.kind === 'connect-timeout') {
    await fail(
      {
        code: 'unavailable',
        message: `the endpoint did not accept the connection within ${String(
          Math.round(opened.timeoutMs / 1000),
        )}s — check that the provider is running and the base URL is right`,
      },
      'ai test chat: provider endpoint unreachable (connect timeout) — turn dropped',
      { baseUrl: httpConnectionOf(profile).baseUrl ?? '', connectTimeoutMs: opened.timeoutMs },
    )
    return
  }
  if (opened.kind === 'network') {
    await fail(
      { code: 'unavailable', message: `the endpoint could not be reached: ${opened.message}` },
      'ai test chat: provider endpoint unreachable (network error) — turn dropped',
      { baseUrl: httpConnectionOf(profile).baseUrl ?? '', error: opened.message },
    )
    return
  }
  if (opened.kind === 'provider-error') {
    await fail(
      { code: opened.code, message: opened.message },
      'ai test chat: provider refused the request — turn dropped',
      { code: opened.code, error: opened.message },
    )
    return
  }
  if (opened.kind === 'first-token-timeout') {
    // The socket was accepted and the server then wrote nothing. Same sentence
    // as a stream that opens and stays mute, because it is the same fault and
    // the same remedy — and emphatically NOT `unavailable`.
    await failFirstToken()
    return
  }

  const streamed = opened.kind === 'open'
  emit({
    kind: 'meta',
    profileName: profile.name,
    model: profile.model,
    mediaSent: attachment,
    streamed,
    firstTokenTimeoutMs: request.firstTokenTimeoutMs,
  })

  const warnIfPictureLikelyMissing = (inputTokens: number): void => {
    if (attachment === null || inputTokens <= 0) return
    if (inputTokens >= TEST_CHAT_MIN_VISION_INPUT_TOKENS) return
    deps.logger.warn(
      'ai test chat: image turn billed like a text turn — the picture may not have reached the model',
      withTags({
        profileId: profile.id,
        model: profile.model,
        inputTokens,
        expectedAtLeast: TEST_CHAT_MIN_VISION_INPUT_TOKENS,
        attachmentBytes: attachment.sizeBytes,
      }),
    )
  }

  // ── 4a. the non-streaming fallback ────────────────────────────────
  if (!streamed) {
    emit({ kind: 'status', phase: 'first-token-wait' })
    const raced = await withDeadline(deps.generateOnce(streamRequest), remainingFirstTokenMs())
    if (signal.aborted) {
      deps.logger.info('ai test chat: client aborted mid-generation', withTags({}))
      return
    }
    if (raced.timedOut) {
      await failFirstToken()
      return
    }
    const result = raced.value
    if (!result.ok) {
      await fail(
        { code: result.code, message: result.message },
        'ai test chat: provider returned an error — turn dropped',
        { code: result.code, error: result.message },
      )
      return
    }
    warnIfPictureLikelyMissing(result.usage.inputTokens)
    emit({ kind: 'token', text: result.text })
    emit({
      kind: 'done',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: deps.now() - startedAt,
      truncated: result.truncated,
    })
    await finish(null, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })
    return
  }

  async function failFirstToken(): Promise<void> {
    await fail(
      {
        code: 'timeout',
        message: `the model produced no output within ${String(
          Math.round(request.firstTokenTimeoutMs / 1000),
        )}s — a cold load can take minutes; warm the model or raise the first-token timeout`,
      },
      'ai test chat: no first token before the bound — model probably still loading',
      { firstTokenTimeoutMs: request.firstTokenTimeoutMs },
    )
  }

  // ── 4b. forward the tokens ────────────────────────────────────────
  // The phase was already announced by `onConnected`, before the headers; this
  // repeats it only for the paths that never got there (a profile whose URL
  // could not be probed), and a repeated status line costs nothing.
  emit({ kind: 'status', phase: 'first-token-wait' })
  const iterator = opened.chunks[Symbol.asyncIterator]()
  let sawFirstToken = false
  let inputTokens = 0
  let outputTokens = 0
  let truncated = false

  for (;;) {
    if (signal.aborted) {
      deps.logger.info('ai test chat: client aborted mid-stream — provider call torn down', {
        ...withTags({ sawFirstToken }),
      })
      return
    }
    // THE BOUND SWITCHES AT THE FIRST TOKEN. Before it, we may be waiting on a
    // model loading into GPU; after it, the model is demonstrably up and a gap
    // is a stall.
    const budget = sawFirstToken ? TEST_CHAT_IDLE_TIMEOUT_MS : remainingFirstTokenMs()
    const next = await nextChunk(iterator, budget)

    if (next.kind === 'timeout') {
      if (!sawFirstToken) {
        await failFirstToken()
        return
      }
      await fail(
        {
          code: 'timeout',
          message: `the answer stopped mid-stream — no further output for ${String(
            Math.round(TEST_CHAT_IDLE_TIMEOUT_MS / 1000),
          )}s`,
        },
        'ai test chat: stream stalled after the first token — turn cut short',
        { idleTimeoutMs: TEST_CHAT_IDLE_TIMEOUT_MS, outputTokens },
      )
      return
    }

    if (next.kind === 'end') break

    if (next.value.kind === 'token') {
      if (!sawFirstToken) {
        sawFirstToken = true
        // A first token IS the "model loaded" signal — say so, once.
        emit({ kind: 'status', phase: 'streaming' })
      }
      emit({ kind: 'token', text: next.value.text })
      continue
    }

    inputTokens = next.value.inputTokens
    outputTokens = next.value.outputTokens
    truncated = next.value.truncated
  }

  if (signal.aborted) {
    deps.logger.info('ai test chat: client aborted before the stream finished', withTags({}))
    return
  }
  if (!sawFirstToken) {
    // The stream closed cleanly having said nothing. Not a timeout — a refusal
    // or an empty completion, and it must not read as an empty bubble.
    await fail(
      {
        code: 'adapter-error',
        message: 'the provider closed the stream without producing any output',
      },
      'ai test chat: provider closed an empty stream — turn dropped',
      {},
    )
    return
  }

  warnIfPictureLikelyMissing(inputTokens)
  emit({
    kind: 'done',
    inputTokens,
    outputTokens,
    latencyMs: deps.now() - startedAt,
    truncated,
  })
  await finish(null, { inputTokens, outputTokens })
}

export type { MediaFileKind, SnapshotImage, TrackMediaRow }
