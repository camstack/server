/**
 * The admin AI page's **test chat** — request shape and streaming wire.
 *
 * ## Why this is a data-plane route and not a cap method or a custom action
 *
 * It shipped first as an `addons.custom` action that awaited the whole
 * generation, and the operator's FIRST real use failed with
 * `UDS request timed out after 60000ms`. That is not a tuning miss: a custom
 * action reaches its addon through `LocalChildRegistry.callAddonOnChild`, which
 * passes no options and therefore takes `DEFAULT_UDS_REQUEST_TIMEOUT_MS` (60 s)
 * with **no per-call override on that path** (unlike the cap plane, which has
 * `capRequestOpts`). A unary RPC is simply the wrong shape for a generation
 * that legitimately takes minutes on a cold GPU load — and the error it
 * produced named the transport, not the model and not the endpoint.
 *
 * `ctx.dataPlane.serve` is the primitive this repo already has for exactly
 * this: the addon binds a `127.0.0.1` listener and streams to a real
 * `ServerResponse`; the hub authenticates and reverse-proxies in front
 * (`/addon/ai/test-chat`). Recorder playback and the nc-artifact planes are the
 * precedents. UDS is out of the generation path entirely — it carries only the
 * hub↔addon control traffic, which is fast.
 *
 * ## Why NDJSON and not SSE
 *
 * `EventSource` cannot POST, so a browser consuming SSE here would use
 * `fetch` + `ReadableStream` anyway — which is the same code that reads NDJSON,
 * minus the `data:`/blank-line framing. And SSE's one real advantage,
 * automatic reconnection, is actively WRONG for a one-shot generation: a
 * reconnect would re-run the prompt and spend the tokens again.
 *
 * One JSON object per line, `\n`-terminated. Compression is not a hazard on
 * this path — the hub's `/addon/:addonId/*` route is registered
 * `{ compress: false }` and a data-plane hit is `reply.hijack()`ed and piped
 * raw — but the handler still declares `content-encoding: identity` and
 * `x-no-compression`, because "no proxy in front of this today" is a fact with
 * a shelf life and a buffered stream is invisible until someone waits 60 s for
 * a first token. Brotli over a stream has already broken a pull in this repo
 * with `TypeError: terminated`.
 */
import { z } from 'zod'

/** Longest transcript a single test turn may carry. A test chat that needs
 *  more than this is not a test chat. */
export const TEST_CHAT_MAX_MESSAGES = 40
/** Per-message cap — the prompt is flattened, so this bounds the whole call. */
export const TEST_CHAT_MAX_CONTENT_CHARS = 8_000

/** The data-plane prefix under `/addon/ai/`. */
export const TEST_CHAT_PREFIX = 'test-chat'
/** The usage tag every test turn is billed under (`llm.getUsage`). */
export const TEST_CHAT_CONSUMER = 'adhoc-ui'

// ── The three timeouts ───────────────────────────────────────────────
//
// Three, because they are three different faults with three different
// remedies, and one number cannot say which happened:
//
//   CONNECT      THE TCP HANDSHAKE, and not one byte further. LM Studio is not
//                running, the base URL is wrong, the box is off. A closed port
//                fails at once (ECONNREFUSED); only a black hole burns the
//                whole bound. Short on purpose — waiting two minutes to be
//                told a port is closed is a worse answer than ten seconds.
//   FIRST TOKEN  the endpoint accepted and the model has produced nothing yet.
//                THE RESPONSE HEADERS COUNT AS NOTHING YET: on the LM Studio /
//                llama-server wire the status line is written once the model
//                has finished loading, so waiting for it IS waiting for a cold
//                GPU load — minutes for qwen3-vl, ~5 s warm on the same
//                profile. Headers and first token draw on this ONE budget.
//                Generous, configurable, and the page says the number.
//   IDLE         tokens started and then stopped. A stalled stream, not a cold
//                load — the model already proved it was loaded.
//
// The connect bound used to be armed around the header wait, which put a cold
// load in the "the box is off" bucket and answered it with
// `unavailable: the endpoint did not accept the connection within 10s` —
// against an endpoint that had accepted, was working, and was busy loading.
// The operator hit it twice. Three faults are only worth three numbers if each
// number measures its own fault.
export const TEST_CHAT_CONNECT_TIMEOUT_MS = 10_000
export const TEST_CHAT_DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000
export const TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS = 600_000
export const TEST_CHAT_IDLE_TIMEOUT_MS = 60_000

export const TestChatRoleSchema = z.enum(['user', 'assistant'])
export type TestChatRole = z.infer<typeof TestChatRoleSchema>

export const TestChatMessageSchema = z.object({
  role: TestChatRoleSchema,
  content: z.string().max(TEST_CHAT_MAX_CONTENT_CHARS),
})
export type TestChatMessage = z.infer<typeof TestChatMessageSchema>

/**
 * WHAT to look at, never the pixels themselves.
 *
 * `snapshot` is the camera's current frame through the snapshot wrapper (cache
 * + coalescing + the battery-camera sleep gate all still apply — this is a test
 * surface and has no business setting `force`).
 *
 * `track` is a stored best-shot: the addon picks ONE media row the pipeline
 * already wrote (see `TRACK_MEDIA_PREFERENCE`) and sends it verbatim. No crop
 * rectangle is computed here — D52 keeps that in the runner, and a test chat
 * that derived its own would be judging a rectangle nothing else ever sees.
 */
export const TestChatImageRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), deviceId: z.number().int().positive() }),
  z.object({
    kind: z.literal('track'),
    trackId: z.string().min(1),
    /** Owning device — `getTrackMedia` requires it as the read's scope. */
    deviceId: z.number().int().positive(),
  }),
])
export type TestChatImageRef = z.infer<typeof TestChatImageRefSchema>

/**
 * `.strict()`, and it is load-bearing.
 *
 * Measured on the live hub: a request that named the attachment field
 * `attachment` against a schema that called it `imageRef` was accepted, the
 * unknown key was STRIPPED by the default object parse, and the run answered a
 * vision question with a text-only turn — "specify what you want described",
 * `inputTokens: 10`. No error, no log, no way to tell it from a model that
 * simply could not see. A stripped field is a silent behaviour change, which is
 * the one thing a diagnostic surface must never do; `.strict()` turns it into a
 * 400 naming the key.
 */
export const TestChatRequestSchema = z
  .object({
    /** Explicit profile — the test chat NEVER falls through to the default
     *  resolution chain, because "which model answered" is the whole question. */
    profileId: z.string().min(1),
    messages: z.array(TestChatMessageSchema).min(1).max(TEST_CHAT_MAX_MESSAGES),
    /** Optional system turn, authored by the operator in the page. */
    system: z.string().max(TEST_CHAT_MAX_CONTENT_CHARS).optional(),
    /** The picture to look at, BY REFERENCE. Named `attachment` because that is
     *  what every caller reaches for; the previous `imageRef` cost a live
     *  debugging session to the strip described above. */
    attachment: TestChatImageRefSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(8192).optional(),
    /** See the timeout block above. Applies to a VISION turn identically —
     *  vision inference is the slower one, so a bound tuned on text is a bound
     *  that only fails on the interesting case. */
    firstTokenTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS)
      .default(TEST_CHAT_DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
    /**
     * Persist this turn into the caller's private chat history. Omitted or
     * false is throwaway — today's behaviour, nothing written.
     */
    persist: z.boolean().optional(),
    /** Resume this conversation. Ignored unless `persist` is true. */
    conversationId: z.string().min(1).optional(),
  })
  .strict()
export type TestChatRequest = z.infer<typeof TestChatRequestSchema>

/**
 * Below this, a turn that CARRIED an image almost certainly did not deliver it.
 *
 * A vision model prices a picture in hundreds of input tokens (qwen3-vl bills a
 * 480 px crop at several hundred); a text-only turn of a short prompt bills
 * about ten. The live failure above reported exactly `10`. So when the provider
 * tells us the input count and an image was attached, a count this low is
 * evidence the picture did not reach the model — worth a warning line even
 * though the run "succeeded", because the answer will look like an answer.
 *
 * Only checked when the provider actually reported a count: a streamed
 * completion without `stream_options.include_usage` reports none, and 0 must
 * never be read as 10.
 */
export const TEST_CHAT_MIN_VISION_INPUT_TOKENS = 100

/**
 * What the server actually attached — metadata only, never the bytes.
 *
 * The operator has to be able to tell a vision answer about the wrong picture
 * from a vision answer about the right one, and the only way to do that from
 * the client is to be told which media row was used and how old it is.
 */
export const TestChatAttachmentSchema = z.object({
  kind: z.enum(['snapshot', 'track']),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Track attachments only: the `MediaFileKind` that won `TRACK_MEDIA_PREFERENCE`. */
  mediaKind: z.string().optional(),
  /** Epoch ms of the frame, when the source knows it. */
  capturedAt: z.number().optional(),
  /** JPEG of what was actually sent — present when reopening history. */
  thumbnailBase64: z.string().optional(),
})
export type TestChatAttachment = z.infer<typeof TestChatAttachmentSchema>

/**
 * What the run is doing right now — so a wait reads as progress, not as a hang.
 *
 * `first-token-wait` is the one that matters: it is the phase a cold model
 * spends minutes in, and the page renders it as "the model is loading…" rather
 * than as silence.
 */
export const TestChatPhaseSchema = z.enum([
  'resolving-image',
  'connecting',
  'first-token-wait',
  'streaming',
])
export type TestChatPhase = z.infer<typeof TestChatPhaseSchema>

/**
 * One NDJSON line. A discriminated union so the client narrows on `kind` and a
 * line this build does not understand is skipped rather than half-read.
 *
 * `meta` arrives BEFORE the first token: it is what the server committed to —
 * which profile, which model, which picture — and the page shows it while the
 * model is still loading, so a long wait is at least an informed one.
 */
export const TestChatEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), phase: TestChatPhaseSchema }),
  z.object({
    kind: z.literal('meta'),
    profileName: z.string(),
    model: z.string(),
    /**
     * WHAT MEDIA WAS ACTUALLY SENT — and the contract is that this is non-null
     * whenever the request carried an `attachment`.
     *
     * There is no path where a requested picture goes missing and the run
     * continues: a resolution failure ends the stream with an `error` event.
     * That rule exists because the opposite shipped — a vision question answered
     * text-only, indistinguishable from a model that looked and saw nothing.
     */
    mediaSent: TestChatAttachmentSchema.nullable(),
    /** False when the profile's wire has no token stream and the whole answer
     *  arrives at once. Said out loud rather than faked. */
    streamed: z.boolean(),
    /** Echoed so the page states the bound it is really working under. */
    firstTokenTimeoutMs: z.number(),
    /** Set when this turn was (or will be) persisted — so the page can resume. */
    conversationId: z.string().optional(),
  }),
  z.object({ kind: z.literal('token'), text: z.string() }),
  z.object({
    kind: z.literal('done'),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
    truncated: z.boolean(),
    conversationId: z.string().optional(),
  }),
  /** `code` is the `LlmErrorCode` taxonomy; `message` is already a sentence an
   *  operator can act on — never a transport string. */
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }),
])
export type TestChatEvent = z.infer<typeof TestChatEventSchema>

/** Serialise one event as an NDJSON line, terminator included. */
export function encodeEvent(event: TestChatEvent): string {
  return `${JSON.stringify(event)}\n`
}
