# Adopting an LLM library — census of what was done by hand and evaluation of the candidates

> Status: **Phases 0-4 executed** (2026-08-14). The analysis below describes the
> world BEFORE the adoption and is kept because it is the motivation: the numbers in
> §1 are the census of the deleted code. The operator's question:
> *"esiste una libreria o struttura concreta per la comunicazione con LLM, così
> ci wrappiamo sopra invece di ricreare il mondo?"* [is there a library or
> concrete structure for communicating with LLMs, so that we wrap it instead of
> recreating the world?]
>
> **What changed relative to §1:** `adapters/**`, `http/execute-plan.ts` and
> `test-chat/chat-completions-stream.ts` **no longer exist**. The only point that
> imports the library is `packages/addon-ai/src/client/llm-client.ts`, and
> `scripts/check-llm-library-boundary.ts` enforces it. Read before touching
> that file.
> Companion: [`../architecture/post-analysis.md`](../architecture/post-analysis.md)
> (NcConfirmGate), [`../architecture/capabilities.md`](../architecture/capabilities.md)
> (the `llm` cap).

## 1. What we built by hand

`packages/addon-ai/src` — **4,461 lines** of source, **2,901 lines** of tests.
It is not all transport: most of it is our own stuff that no library
replaces. The split matters more than the total.

### 1.1 The transport — what a library would replace

| File | Lines | What it does |
| --- | ---: | --- |
| `adapters/adapter.ts` | 105 | pure `buildRequest → plan` seam, HTTP error taxonomy, `retry-after`, base64/JSON helpers |
| `adapters/openai-compatible.ts` | 198 | `/v1/chat/completions` wire (≈60 lines are the `ConfigUISchema`, which stays ours) |
| `adapters/openai.ts` | 46 | same wire, default baseURL |
| `adapters/anthropic.ts` | 165 | Messages wire: top-level `system`, mandatory `max_tokens`, `x-api-key`, images before text, structured output via forced tool |
| `adapters/google.ts` | 157 | `generateContent` wire: key in query, `contents`/`parts`, `systemInstruction`, `responseSchema` |
| `http/execute-plan.ts` | 45 | abortable fetch, outcome union (never throws) |
| `test-chat/chat-completions-stream.ts` | 198 | SSE parser + delta normalisation → `StreamChunk` |
| **Total** | **914** | of which ≈**854** purely "differences between vendors" |

Plus the tests that cover them: `__tests__/adapters/*` 399, `execute-plan.spec.ts` 57,
and the SSE half of `test-chat-stream.spec.ts` — **≈500 lines of tests** that exist
only to assert that our JSON looks like the vendor's JSON.

**Real coverage of this layer, feature by feature:**

| Feature | State today |
| --- | --- |
| Streaming | **only `openai` + `openai-compatible`**, only in the test chat. Anthropic, Google and `managed-local` return `unsupported` and fall back to a unary call (`streamed: false` declared to the user) |
| Vision | yes, all 3 wires, inline base64 |
| Structured output | yes, but **three different implementations**: `response_format.json_schema` (OpenAI), forced `respond` tool (Anthropic), `responseSchema` (Google). No validation of the response against the schema: text comes back |
| Abort | yes on the streaming path (chained `AbortSignal`, separate connect controller). On the unary path **no**: `execute-plan` creates its own controller only for the timeout, the caller cannot cancel |
| Timeout | yes, `profile.timeoutMs` + the three test-chat bounds (connect 10 s / first-token 120 s / idle 60 s) |
| Usage/token | hand-written per-vendor parsing (`prompt_tokens`/`input_tokens`/`promptTokenCount`), normalised into `{inputTokens, outputTokens}` |
| **Retry** | **none.** `retryAfterMs` is parsed from the `retry-after` header, put in the result… and **nobody reads it**: `grep retryAfterMs` finds only the adapter that writes it and the Zod schema that declares it. A 429 is a hard error |
| Tool calls / function calling | **absent** (except the Anthropic tool used as a trick for JSON) |
| Multi-turn | **absent**: `renderTranscript` flattens the conversation into **a single user turn** |
| Cached tokens / reasoning tokens | absent from the usage schema |
| Model list | yes, 3 wires (`/v1/models`, `/v1/models`, `/v1beta/models`) |

### 1.2 What is ours and stays ours

| Area | File | Lines | Why no library provides it |
| --- | --- | ---: | --- |
| Profiles + resolution | `profile-store.ts`, `resolve-profile.ts`, `defaults-store.ts`, `secrets.ts` | 270 | chain `profileId` → per-consumer default → per-purpose default; secret redaction/merge (a saved key never round-trips) |
| Dispatch + accounting | `provider.ts` | 334 | **one usage row for every call, ok or error**, on every branch — including budget-deny and no-profile |
| Usage store + budget gate | `usage/*` | 236 | declared collections, rollup per day/consumer/profile, 90 d prune, `BudgetGate` (v2) |
| Managed local runtime | `runtime/**` | ~800 | llama.cpp supervisor, GGUF catalog, sha256, crash policy, idle-stop, model distribution to egress-restricted nodes |
| Test chat: policy | `test-chat/run-stream.ts` | 431 | the three bounds and their **phrases**, the non-streaming fallback, the single usage row, the "image billed as text" warning |
| Test chat: media | `test-chat/media.ts` | 191 | **server-side** resolution of references (`deviceId`/`trackId` → bytes), `keyFrameSmall` preference |
| Test chat: data plane | `test-chat/plane.ts`, `contract.ts` | 377 | NDJSON over `ctx.dataPlane`, no-compression, `flushHeaders`, abort from the client's `close` |

### 1.3 The consumers, and the policy each one imposes

Three call sites, all on `ctx.api.llm.generateVision` (cap → **crosses a
process boundary**: addon-ai lives in the `ml` group, post-analysis has its own
runner, so the image bytes go through msgpack on every judgement):

| Consumer | File | Lines | Fail direction |
| --- | --- | ---: | --- |
| `NcConfirmGate` — the model looks at the photo that is about to go out in a notification | `addon-post-analysis/.../notification-center/confirm-gate.ts` | 412 | **fail-OPEN, and counted** (`failedOpen` goes up while `suppressed` stays 0 = broken gate) |
| `SceneConfirmGate` — CLIP proposes, the model adjudicates the flip | `.../pipeline-analytics/scene/scene-confirm-gate.ts` | 350 | **fail-CLOSED** (a latch is a stateful claim: do not flip) |
| `checkSceneLlm` — scenes in pure `llm` mode | `.../scene/scene-llm-adapter.ts` | 133 | `unavailable`, never a guess |

**The cost of doing it yourself is already visible here:** the permissive JSON parser
(`indexOf('{')` → `lastIndexOf('}')`) exists in **three identical copies** in the three
files, and `SceneConfirmGate` declares in its own header that it is copied "field
by field" from `NcConfirmGate` with a single inversion. Hardening prompt,
downscale to 448 px, 8 s timeout, per-device concurrency bound: all
duplicated. It is not a library defect — it is the proof that **a layer of
our own** is missing between the cap and the consumers.

### 1.4 The bugs that doing it yourself has already paid for

1. **Unary `testChat` → `UDS request timed out after 60000ms` on first real
   use.** Shipped as `addons.custom` that waited for the whole generation:
   `LocalChildRegistry.callAddonOnChild` passes no options, so it takes
   `DEFAULT_UDS_REQUEST_TIMEOUT_MS` with no per-call override. A unary RPC is
   the wrong shape for a generation that lasts minutes on a cold GPU — and
   the error named the **transport**, not the model or the endpoint. Rewritten on
   `ctx.dataPlane` + NDJSON (`test-chat/contract.ts`, file header).
   *Honesty: **no LLM library would have prevented this** — the wrong choice
   was the shape of the internal transport, which is ours. What a
   library with streaming as a primitive changes is the slope: the natural shape
   becomes "iterate me the tokens", and "wait for everything" has to be asked for.*

2. **The attachment silently lost (today).** A request that got the name of the
   attachment field wrong produced a **textual and self-confident** answer to a
   question about an image that nobody had sent, without a line anywhere.
   Now: `TestChatRequestSchema` is `.strict()` (unknown key = 400
   that **names** it) and an image that is requested but cannot be resolved **terminates
   the run** instead of degrading to text (`run-stream.ts` §2).
   *Half of this is boundary validation — ours, and Zod already provided it. The other
   half is the policy "vision requested ⇒ vision or nothing", which no library
   can decide for us.*

3. **`usage` NULL vs absent key.** `UsageRowSchema.safeParse` rejected
   **every** row written and `llm.getUsage` answered `[]` on a hub that had
   billed real calls — invisible because the in-memory fake returned
   exactly the object written. Fixed with `withoutNulls` + a warn that says
   how many rows were discarded (`usage-store.ts`).
   *It is not the transport's fault. It is the reminder that the usage store is ours
   and must be tested against the real backend.*

4. **`scene-llm-adapter` consumed a `{ ok, json }` envelope that the cap never
   produced**, with a spec that asserted the invented shape. A leftover that
   described the right design and therefore read as verification.
   *A single return type, imported from a single point, is exactly what
   the wrapper must guarantee.*

5. **The gates' concurrency bound does not limit what it thinks it limits — and
   the defect is still there.** `NcConfirmGate.raceTimeout` races the call against
   8 s; if the timer wins, the gate returns and **frees its own slot**, but the
   upstream `generateVision` **keeps running** until `profile.timeoutMs`
   (60 s by default), because the cap has no cancellation channel.
   On a busy camera against a single-threaded local model the bound
   "one in flight, two queued" counts the *waits*, not the *generations*: there can
   be more orphan generations in flight than the gate believes.
   *The library does not solve this: `AbortSignal` stops at the process
   boundary. See Phase 4.*

## 2. The candidates

Verified on 2026-08-14 with `npm view` and, for the main candidate, by trying
the published package against a fake OpenAI-compatible server — not just by
reading the documentation.

| Candidate | Version / date | Downloads/week | Open issues | License | Installed weight | Verdict |
| --- | --- | ---: | ---: | --- | --- | --- |
| **`ai` + `@ai-sdk/*`** (Vercel) | 7.0.65 · 2026-08-13 | 20.6 M | 775 (+956 PR) | Apache-2.0 | 9 pkg, **20 MB** | **candidate** |
| `openai` | 7.4.0 · 2026-08-13 | 32.0 M | 36 | Apache-2.0 | 1 pkg, 19 MB, **zero dependencies** | solid fallback |
| `@anthropic-ai/sdk` | 0.117.1 · 2026-08-13 | 29.8 M | 52 | MIT | 4 pkg, 13 MB | ok, not needed |
| `@google/genai` | 2.17.1 · 2026-08-13 | 17.5 M | 186 | Apache-2.0 | **29 pkg, 35 MB** (protobufjs + google-auth) | too heavy for 157 lines of fetch |
| `@google/generative-ai` | 0.24.1 · 2025-04-30 | 4.1 M | — | Apache-2.0 | — | **deprecated** (repo renamed `deprecated-generative-ai-js`) |
| `langchain` / `@langchain/*` | 1.5.9 · 2026-08-14 | 2.9 M | 503 | MIT | **12 pkg, 64 MB** before the providers | discarded |
| `llamaindex` | 0.12.1 · 2025-12-31 | 124 k | 149 | MIT | — | **dead** (repo archived 2026-04-30) |
| `token.js` | 0.7.1 · 2025-04-21 | **808** | 2 | MIT | — | **dormant**, and pins the exact SDKs |
| `ollama` | 0.6.3 · 2026-02-20 | 656 k | 84 | MIT | — | wrong protocol for us |
| `@mastra/core` | 1.59.0 | 1.3 M | 477 | Apache-2.0 | **122 pkg, 123 MB** | agent framework, not a client |
| LiteLLM (Python proxy) | — | — | 4,935 | NOASSERTION | service + Postgres + Redis | see below |

### 2.1 Why the discards are discards

- **LlamaIndex.TS is archived** since 2026-04-30 with a "read-only" notice: it is not
  a matter of taste.
- **LangChain.js**: 465 releases of `langchain`, 349 of `@langchain/core`, 64 MB
  before even adding a provider. And the detail that closes the discussion
  for us: `@langchain/google-genai` 2.2.0 **still depends on
  `@google/generative-ai`**, i.e. on the deprecated Google SDK. Adopting it
  would put us on an EOL by proxy.
- **`token.js`**: 808 downloads a week and no publication for 16 months,
  but the real problem is that it **pins exact** SDK versions
  (`openai@4.91.1` against the current 7.4.0, deprecated `@google/generative-ai@0.14.1`).
  Structurally it cannot see a new model.
- **`ollama`**: speaks `/api/chat`, Ollama's own protocol, not
  OpenAI-compatible. We run `llama-server` directly: it buys nothing.
- **LiteLLM**: there is no Node client and none is needed — it is an
  OpenAI-compatible proxy, so you point any client at it. It buys per-key
  budget applied *before* the request goes out, virtual key management,
  fallback between providers, dashboard. It costs **a Python service + Postgres +
  Redis** and a network hop on every inference, inside the critical path of a
  notification. For a single-tenant hub it is a terrible trade: `BudgetGate` already
  exists as a seam and costs us 40 lines. Against the repo's philosophy (D2: one addon =
  one process; nothing in the path of a notification that is not ours).
- **OpenRouter**: *hosted* unification with real adoption, but it is OpenAI-compatible
  HTTP (so already reachable today) and **cannot serve our
  managed llama.cpp** — which is exactly the case that motivates an abstraction.

### 2.2 Vercel AI SDK — what it really covers

Verified empirically against a fake server, not from the documentation:

| Requirement | Outcome |
| --- | --- |
| Streaming | `streamText().textStream` is **both** a `ReadableStream` **and** an `AsyncIterable`: `for await (const delta of …)` gives the string deltas **without any framework**. It maps onto our `StreamChunk` in ~20 lines |
| Abort | **real, down to the socket**, on both paths: abort mid-stream → the server sees the socket close. Not just a rejected promise |
| Timeout | `timeout: { totalMs, stepMs, firstChunkMs, chunkMs }`. **`firstChunkMs` and `chunkMs` are literally our first-token and idle bounds** — the most bespoke part of `run-stream.ts` has a supported equivalent |
| Vision | `{ type:'image', image: Uint8Array|base64, mediaType }`; on the openai-compatible wire it emits exactly our `image_url` data-URI |
| Structured output | `Output.object({schema})` with **Zod 3 and Zod 4** (peer `^3.25.76 \|\| ^4.1.8` — ours is **4.3.6**, within range). It uses the provider's native mechanism where one exists |
| Usage | normalised `{inputTokens, outputTokens, totalTokens}` + `inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`, available also on the stream (`await result.usage`) |
| Errors | exported typed classes with `.isInstance()` guards: `APICallError`, `RetryError`, `NoObjectGeneratedError`, `TypeValidationError`, … |
| Retry | `maxRetries` **default 2** with exponential backoff (measured: 3 attempts in 2,011 ms on a 429) |
| Model list | **absent** — no `/v1/models`. Our `listModels` stays ours |
| Telemetry | **none.** No `fetch` call on import (measured), no analytics endpoint in the dist. OpenTelemetry is a separate package (`@ai-sdk/otel`) to be installed and registered explicitly |
| Weight | no native dependency, **no React/Next/Vue at runtime** (`npm ls react next svelte vue` → empty). `ai` + `@ai-sdk/openai-compatible` = 20 MB installed |

### 2.3 The three edges, named

All three are manageable; none must be discovered in production.

1. **`ai@7` is ESM-only and requires Node ≥ 22.** Our addon loads
   `./dist/index.js`, i.e. the **CJS** output of the Vite preset
   (`formats: ['cjs','es']`). Bundling an ESM-only package into a CJS output
   normally works (rollup transpiles), **but a top-level await in the
   library makes it impossible**. This is the Phase 0 gate and it is not
   negotiable.
2. **`@ai-sdk/gateway` is a hard dependency of `ai@7`.** If a model id is passed as
   a **bare string** (`model: 'openai/gpt-4o'`) the call is
   routed to `https://ai-gateway.vercel.sh` and fails with
   `Unauthenticated request to AI Gateway`. Always passing a **provider
   instance** makes the gateway inert. It is a silent default: it deserves a guard,
   not a paragraph.
3. **Structured output degrades silently on the openai-compatible wire.** With
   the default settings `Output.object({schema})` sends only
   `response_format: {"type":"json_object"}` — **the schema never reaches the
   server** — with a runtime warning. `createOpenAICompatible({ supportsStructuredOutputs: true })`
   is needed to emit the real `json_schema`, which is what our adapters always do today. This is
   *exactly* the class of error this repo pays for most: it must be asserted by
   a test on the request body, not taken on trust.

Plus two mapping details: a server that omits `usage` produces
`inputTokens: undefined` (not `0`), and exhausted retries arrive as
**`RetryError`, not `APICallError`** — whoever classifies errors must unwrap
the envelope.

### 2.4 The real risk is not death, it is churn

`ai` is not at risk of abandonment: 26.2 k stars, 614 contributors, a real team
(9 committers with over 90 commits in 90 days), 587 issues closed in 90 days,
stable Apache-2.0. **The risk is the cadence of the majors:** v3 (2024-02) → v4
(2024-11) → v5 (2025-07) → v6 (2025-12) → v7 (2026-06), i.e. **one every 5-7
months and accelerating**, each with wide-reaching renames (`system` →
`instructions`, `onFinish` → `onEnd`, `fullStream` → `stream`, restructuring
of the usage fields). That Mastra keeps **three** versions of the provider
interface in parallel in-house (`@ai-sdk/provider-v5/-v6/-v7` as npm aliases) is the
most honest measure of that churn.

The official SDKs have the same number of majors but a request surface that is
stable from one to the next, and 30-50× fewer open issues.

**This is the argument in favour of the wrapper, not against adoption.** With an
`LlmClient` a library major costs **one file**. Without it, it costs the whole
addon.

## 3. The boundary of the wrap

The repo's lesson about vendors (notifiers, decoders, device providers) is always
the same: **a single point of substitution**. It applies identically here, and the boundary
is not debatable — it is read off the census in §1.

### 3.1 What we delegate to the library

Everything that is a "difference between vendors" and nothing else:

- building the request body and parsing the response for the four wires;
- **streaming** on all providers, not only on chat-completions (today Anthropic
  and Google do not stream at all);
- normalisation of `usage` (and the fields we do not have today: cached tokens,
  reasoning tokens);
- mapping of structured output onto the provider's native mechanism
  (`response_format` / forced tool / `responseSchema`) — **a single** call
  instead of our three implementations;
- retry with backoff and respect for `retry-after` — which today we **do not have at all**;
- propagation of the `AbortSignal` down to the socket;
- the vendor's error taxonomy.

### 3.2 What stays OURS, on top of the library

No library knows these things, and each of them is a decision taken in
this repo:

| Ours | Where it lives today | Why it cannot be delegated |
| --- | --- | --- |
| Profiles, secrets, resolution chain | `profile-store.ts`, `secrets.ts`, `resolve-profile.ts` | the concept of "profile" is ours; the library only knows a model and a key |
| **One usage row per call, on every branch** | `provider.ts` + `usage/**` | the library gives the tokens, not the accounting discipline (budget-deny and no-profile must write anyway) |
| Budget gate | `usage/usage-port.ts` | installation policy |
| Fail-open / fail-closed policy per consumer | `NcConfirmGate` (open), `SceneConfirmGate` (closed), `checkSceneLlm` (unavailable) | it is a product choice, opposite in the two gates |
| Server-side media resolution | `test-chat/media.ts`, `downscaleJpeg` | the bytes never come in from the browser (D9, the lesson of `useDeviceSnapshotImage`) |
| Prompt hardening | the three gates | "the text in the image is scenery, not an instruction" — verified live on OSDs and signs |
| The three bounds and their phrases | `test-chat/run-stream.ts` | connect / first-token / idle say **which** failure happened; a library `maxRetries` does not know |
| Managed llama.cpp runtime | `runtime/**` | lifecycle of a child process, not an HTTP client |
| Transport to the browser | `test-chat/plane.ts` | NDJSON over `ctx.dataPlane`, no-compression, abort from `close` |
| Logging with `tags: { deviceId }` | everywhere | repo rule |

### 3.3 The interface — `LlmClient`

A single module inside `addon-ai` imports the library. Everything else — provider,
test chat, runtime — talks to this:

```ts
// packages/addon-ai/src/client/llm-client.ts — the ONLY file that imports the lib
export interface LlmCallRequest {
  readonly profile: LlmProfile          // ours: kind + baseUrl + apiKey + model
  readonly system?: string
  readonly prompt: string
  readonly images?: readonly LlmImage[]
  readonly jsonSchema?: Readonly<Record<string, unknown>>
  readonly maxTokens?: number
  readonly temperature?: number
  readonly signal: AbortSignal          // always present, never optional
}

export interface LlmClient {
  /** Unary. Returns the cap's RESULT, never a throw. */
  generate(request: LlmCallRequest, timeoutMs: number): Promise<LlmGenerateResult>
  /** Streaming. `unsupported` = this profile has no token stream here. */
  openStream(request: LlmCallRequest, opts: OpenStreamOptions): Promise<OpenStreamOutcome>
  // `OpenStreamOutcome` is already defined in test-chat/run-stream.ts.
  // NB: the shape above is the one PROPOSED in phase 3 and is no longer the one
  // that shipped. `opts` carries two distinct bounds — `connectTimeoutMs` (only
  // the TCP handshake) and `firstTokenTimeoutMs` (everything else, headers included) —
  // plus `onConnected`. See D164: the single `connectTimeoutMs` of this draft
  // is exactly the bug that made a cold model pass for a dead
  // endpoint.
  /** Model list, or `null` if the wire does not expose it. */
  listModels(profile: LlmProfile, timeoutMs: number): Promise<readonly string[] | null>
}
```

Three properties that the wrapper must guarantee, and that no library guarantees
on its own:

1. **Never a throw.** Every error becomes an `LlmGenerateResult` with an
   `LlmErrorCode` from our enum. It is the same discipline as today's adapter seam
   (`adapters/adapter.ts`) and the reason `no-profile` is a normal result
   for the gates instead of an exception.
2. **`StreamChunk` is already our shape.** `{kind:'token'|'end'}` —
   `run-stream.ts` must not change by a line, only who produces the
   iterable changes. Any library that exposes an `AsyncIterable<string>` of deltas
   plus a final usage maps onto it in ~20 lines.
3. **The `signal` is mandatory in the signature.** Today the unary path is not
   cancellable; making it a non-optional parameter is what prevents
   re-shipping that hole.

And, above the cap, **one** shared utility for the consumers:

```ts
// packages/types (or addon-post-analysis/shared): the end of the three copies
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): T | null
```

The three gates have three identical copies of `indexOf('{')` → `lastIndexOf('}')` →
`JSON.parse` → field-by-field check. With `jsonSchema` already requested from the
provider, the permissive parse remains necessary (local models add fences), but
it must be **one**, validated with Zod, instead of three by hand.

## 4. Migration plan

Incremental, and each phase is shippable on its own. **No consumer changes before
Phase 3**: `provider.ts` keeps exposing `LlmGenerateResult` and the three gates
notice nothing.

### Phase 0 — the spike that can reject everything (2 hours, GO/NO-GO)

It is not a formality: it is the gate.

1. `npm i ai @ai-sdk/openai-compatible -w packages/addon-ai`, a real call
   against LM Studio, `npm run build -w packages/addon-ai`.
2. **Verify that `dist/index.js` (CJS) loads in the runner.** If the
   library contains a top-level await, rollup cannot emit CJS and the plan
   changes (see fallback in §5).
3. Measure `du -sh packages/addon-ai/dist` before/after (today 2.3 MB; for
   reference addon-post-analysis is 6.5 MB and addon-pipeline 7.6 MB).
4. Verify that `zod` stays **a single copy**: it is an external of the preset in
   `framework` mode, but addon-ai is `self-contained` and inlines it — the
   library takes it as a peer, so it must resolve to our 4.3.6.
5. Assert on the request body that with `supportsStructuredOutputs: true`
   a real `json_schema` goes out (edge §2.3.3).

### Phase 1 — the transport under testChat and ConfirmGate, without touching the consumers (1 day)

- New file `packages/addon-ai/src/client/llm-client.ts` <!-- drift-ok: proposed path, does not exist yet -->
  — **the only file that imports `ai`**. Interface §3.3.
- Covers `openai`, `openai-compatible` and `managed-local` (which is
  openai-compatible on `127.0.0.1`): **3 of the 5 kinds, and the two that the operator uses
  for real.**
- `provider.ts` calls `client.generate` instead of `execute(adapter.buildRequest(…))`;
  `chat-completions-stream.ts` is replaced by `client.openStream`.
  `run-stream.ts` **does not change**: it already consumes `AsyncIterable<StreamChunk>`.
- Delete `adapters/openai.ts`, `adapters/openai-compatible.ts` (minus the
  `ConfigUISchema`, which stays), `test-chat/chat-completions-stream.ts` and the
  related SSE tests: **≈380 lines of source and ≈240 of tests**.
- Anthropic and Google **stay on the hand-written fetches**. They are 322 lines that
  work, and the alternative via the official SDK would drag protobufjs +
  google-auth into a self-contained bundle.
- **Guard** (`scripts/`, per the repo rule): no `from 'ai'` or
  `from '@ai-sdk/…'` outside `src/client/`; and no model id as a bare string
  passed to `generateText`/`streamText` (edge §2.3.2). Wired into
  `.github/workflows/ci.yml`.

**Verification, not trust:** remove the `usage` mapping and confirm that the test
fails — the repo has already had two green suites because the fake supplied the value
that production forgot to read.

### Phase 2 — Anthropic and Google through the library (half a day)

Only after Phase 1 runs in production. The gain is precise: **`streamed:
false` disappears**, the test chat streams on all four wires, and another
≈322 lines of source + ≈211 of tests fall away. To be done in this phase and not earlier
because it is the only part that changes behaviour visible to the operator.

### Phase 3 — the consumers: one parser, not three (half a day)

- A shared `parseModelJson(text, schema)`, with Zod, in place of the three copies of
  `indexOf('{')`.
- Extract `LlmVisionJudge` — downscale, prompt hardening, per-device bound,
  schema — with the **fail direction as a parameter**. `NcConfirmGate` (open),
  `SceneConfirmGate` (closed) and `checkSceneLlm` become three configurations of
  one mechanism, not three copies of a file.

### Phase 4 — end-to-end cancellation (out of library scope, cap change)

The hole exists **today** and no library closes it: `NcConfirmGate.raceTimeout`
stops waiting after 8 s and frees its own slot, but **the upstream generation
continues** until `profile.timeoutMs` (60 s by default) because the cap
`llm.generateVision` has no cancellation channel. On a single-threaded
local model the "one in flight, two queued" bound per camera **does not limit the
real load**: it limits only how many waits there are, not how many generations.
A `requestId` + an `llm.cancel` are needed, or moving the judgement onto
a data plane. It is a change to the cap surface, with codegen and release train —
so it must be planned separately.

### Estimate and risks

| | |
| --- | --- |
| Total | **2.5-3 days**, of which 2 hours of spike that can stop everything |
| Lines deleted | ≈700 of source + ≈450 of tests (Phase 1+2), ≈180 of duplication in the consumers (Phase 3) |
| Lines added | ≈200 (`llm-client.ts`) + ≈60 (guard) |
| **Lock-in** | mitigated by the interface: the library appears in no public signature. `LlmGenerateResult` and `StreamChunk` stay ours |
| **Library breaking change** | one major every ~6 months, **cost = one file**, with an official codemod available. To be pinned exactly and updated deliberately, never in an automatic bump |
| **Bundle** | to be measured in Phase 0. addon-ai's `dist` would go from 2.3 MB to an estimated 3.5-4 MB, against the 6.5-7.6 MB of the two neighbouring addons: acceptable, but it must be measured because `camstack deploy` ships it to every node |
| **Silent degradation** | openai-compatible structured output (§2.3.3) is the only one that resembles the bugs this repo pays for. Test on the request body, mandatory |
| **CJS/ESM** | the most concrete risk and the first one to be measured |

## 5. Recommendation

**Yes to the wrap, and the library is the Vercel AI SDK — but our code that is
worth keeping stays ours, and Phase 0 can reject the library without rejecting the wrap.**

Three reasons, in order of weight:

1. **The wrapper has to be written anyway.** The three copies of the JSON parser and the two gates
   copied "field by field" say that today's problem is not the lack of
   a library: it is the lack of **a layer of our own**. `LlmClient` below and
   `LlmVisionJudge` above the cap must be built even if nothing is adopted.
2. **What is missing by hand is exactly what the library gives for free**, and they are
   all real holes: **zero retry** (we parse `retry-after` and nobody uses it),
   no abort on the unary path, streaming on one wire out of four,
   `firstChunkMs`/`chunkMs` which are our two bounds already implemented by
   somebody else. We are not buying elegance: we are closing a list of known
   defects.
3. **Churn is the cost, and the wrapper is the price that makes it bearable.**
   A major every six months on one file is ordinary maintenance; on the same
   code without a wrapper it would be a rewrite.

**What we deliberately do NOT adopt:** `@google/genai` (35 MB and protobufjs to
replace 157 lines of fetch inside a self-contained bundle), LangChain,
LlamaIndex, LiteLLM. And we do not touch `runtime/**`: the llama.cpp supervisor is
management of a child process, not an HTTP client.

**Fallback, if Phase 0 rejects CJS:** the official `openai@7.4.0` — 1 package,
**zero dependencies**, 32 M downloads a week, `baseURL` override, `maxRetries`
2, `signal`, `chat.completions` (mandatory: `llama-server` does not implement
`/v1/responses`, [issue #19138](https://github.com/ggml-org/llama.cpp/issues/19138))
— behind **the same `LlmClient` interface**, with Anthropic and Google staying
on the hand-written fetches. We lose the unified streaming and the stall bounds; we
keep everything else. The plan does not change shape, only what is inside one
file changes.

### Outcome — the 5 questions, closed by the operator and executed

| # | Question | Decision | State |
| --- | --- | --- | --- |
| 1 | Streaming on Anthropic/Google? | **Yes, right away** | Phase 2 done — `streamed: false` no longer exists |
| 2 | Retry, and for whom? | `adhoc-ui` + `ai-summary` yes, `notifier-rules` + `scene-monitor` no | `client/retry-policy.ts` |
| 3 | Budget: does it stay ours? | Yes | unchanged (`usage/usage-port.ts`) |
| 4 | Tool calling? | **Yes** — per-profile flag | `toolsEnabled` on the profile; our tool registry, still empty |
| 5 | Phase 4 planned? | Yes, full replace | done: `requestId` + `llm.cancel` |

**Phase 0 = GO.** Measured, not read: the CJS `dist/index.js` loads in the runner
(no top-level await that blocks rollup), `zod` stays a single copy (4.4.3
deduped), and addon-ai's `dist` goes from 2.4 MB to 4.7 MB with all four
vendors — against the 6.5 and 7.6 MB of the two neighbouring addons.

**Four edges, three not in the original plan.** All four asserted by
tests on the request body, not taken on trust:

1. `createOpenAICompatible` without `supportsStructuredOutputs: true` degrades to
   `{"type":"json_object"}` — the schema never leaves the process, and the
   request returns 200. (It was §2.3.3; confirmed to the letter.)
2. `createOpenAI(...)(id)` is the **Responses API**, not chat-completions.
   `llama-server` does not implement it: always `.chat(id)`.
3. A system prompt is `instructions`, **not** a `role:'system'` message — the
   library rejects the latter with an explicit error.
4. `top_k` **does not arrive** on any OpenAI wire: the library drops it. So
   the editor does not offer the knob there. A knob that changes nothing is
   worse than a missing one.

**What was NOT done:** the managed runtime is still ONE process per NODE,
not per model. The target design, the four cap signatures that make it
train-bound and the four traps found by reading the code are in
[D149](../decisions/adr-0149.md). The per-model llama.cpp flags, on the other hand, are
exposed and tested.
