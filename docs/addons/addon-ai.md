---
title: addon-ai — package notes
covers:
  - packages/addon-ai/**
---

# addon-ai — package notes

Moved verbatim from `packages/addon-ai/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## The hub/agent split decides what exists

Every node running this addon registers `llm-runtime`. **Only the hub** also
registers `llm` — profiles, adapters, api keys and usage need outbound internet
and a settings store. Anything you add that reads `assembly.llmProvider` or
`assembly.store` must therefore handle `undefined` and say so, not throw: on an
agent those are legitimately absent, and a stack trace there reads as a bug.

## The test chat is a DATA-PLANE STREAM, not a cap method and not a custom action

`POST /addon/ai/test-chat` — the addon binds a `127.0.0.1` listener via
`ctx.dataPlane.serve`, the hub authenticates and reverse-proxies. NDJSON, one
event per line.

**Do not move it back onto a unary RPC.** It shipped as an `addons.custom`
action first and the operator's very first real use failed with
`UDS request timed out after 60000ms`. That is structural, not a tuning miss:
`LocalChildRegistry.callAddonOnChild` passes NO options, so an addon-level call
takes `DEFAULT_UDS_REQUEST_TIMEOUT_MS` (60 s) and — unlike the cap plane, which
has `capRequestOpts` — there is no per-call override on that path. A cold LM
Studio loading qwen3-vl into GPU goes past 60 s routinely, and the vision turn
is the slower one, so the interesting case was the one that always failed.

Consequences to keep in mind:

- **Compression is the classic way to break this.** The hub's
  `/addon/:addonId/*` route is `{ compress: false }` and a data-plane hit is
  `reply.hijack()`ed and piped raw, so nothing compresses it today — but the
  handler still sends `content-encoding: identity`, `x-no-compression` and
  `cache-control: no-transform`, and calls `res.flushHeaders()`. A buffered
  stream is invisible until someone waits two minutes for a first token that was
  already sitting in a Brotli window. This repo has paid for it twice.
- **The three timeouts are three sentences.** connect (10 s, "the endpoint did
  not accept the connection"), first token (120 s default, configurable, "a cold
  load can take minutes"), idle between tokens (60 s, "the answer stopped
  mid-stream"). The bound SWITCHES at the first token, because a first token is
  proof the model finished loading. One shared number cannot say which fault
  happened, and each has a different remedy.
- **Abort goes all the way down.** Browser aborts its `fetch` → the hub's
  `clientRes` closes → `proxyToUpstream` destroys the upstream → the handler's
  `res` emits `close` → the provider fetch is aborted. Never leave a generation
  running for a client that left; it keeps a GPU warm for nobody.
- **The request schema is `.strict()`, deliberately.** A request that named the
  attachment field `imageRef` against a schema calling it `attachment` was
  accepted, the key was STRIPPED, and a vision question came back answered
  text-only at `inputTokens: 10` — no error, no log, indistinguishable from a
  model that looked and saw nothing. An unknown key is now a 400 naming it.
- **Only the chat-completions wire streams here** (`openai-compatible`,
  `openai`). Anthropic/Google/managed-local return `unsupported` and fall back
  to one unary call, with `meta.streamed: false` said out loud rather than
  faked.
- **The streamed path writes its own usage row**, because it never passes
  through `llmProvider.generate`. Exactly one row per run, ok or not.

## Rules for anything that consumes media here

- **An image reference is resolved SERVER-SIDE, always.** A caller names a
  `deviceId` or a `trackId`; bytes never enter through tRPC. The admin already
  paid for the other design once (`useDeviceSnapshotImage`).
- **Ask the cheap question first (D54).** Resolve and validate the profile —
  including `supportsVision` — *before* reading any media. Dialling a camera to
  produce a frame a text-only profile will refuse is pure waste, and on a battery
  camera it is worse than waste.
- **`snapshot.getSnapshot` is called WITHOUT `force`.** `force` is contractually
  an operator signal that walks past the wrapper's battery-camera sleep gate.
  Nothing in this addon is that signal; a stale-but-honest frame plus an honest
  age is the right answer.
- **A branch that drops work logs it**, and a line about a device carries
  `tags: { deviceId }` — always that key, always the numeric id.
- **A requested picture that cannot be resolved ENDS the run.** Never degrade to
  a text-only answer: a vision model replies to a missing image with confident
  prose, and nothing downstream can tell that from a real answer.
- **Sanity-check the bill.** A turn carrying an image that the provider prices
  under `TEST_CHAT_MIN_VISION_INPUT_TOKENS` almost certainly did not deliver it
  — warn. Only when the provider actually reported a count: a streamed
  completion without `stream_options.include_usage` reports none, and 0 means
  unknown, not ten.

## Kinds, providerConfig and the model list — [D893](../../docs/decisions/adr-0893-an-llm-profile-kind-is-an-open-id-its-provider-declares-and-a-profile-is-common-fields-plus-providerconfig.md)

- The kinds this addon serves are DATA in `src/kinds/descriptors.ts`; what each
  keeps in `providerConfig` and the save-time validator are
  `src/kinds/provider-config.ts`. Read the two together: a field in one and not
  the other is invisible or unsaveable. The admin editor has no kind branch.
- HTTP kinds read their endpoint through `httpConnectionOf(profile)`
  (`src/kinds/http-connection.ts`), never off the bag. `managed-local` keeps a
  whole `ManagedRuntimeConfig` (`managedRuntimeOf`); `apple-foundation` a
  `nodeId` (`appleNodeIdOf`).
- The one secret field of a kind lives in the row's `apiKey` keychain slot,
  moved in and out by `profile-store.ts`. Flat pre-D893 rows are rewritten at
  boot by `migrateLegacyRows` (keychain untouched) and read correctly before.
- `llm.listModels` per wire is `src/client/list-models.ts`: Gemini's key goes
  in `x-goog-api-key`, never `?key=`; every message is scrubbed of the key. A
  vendor's refusal carries the vendor's own reason (`list-models-http.ts`): a
  bare "HTTP 400" left an Anthropic failure undiagnosable.
- A listed model carries its own features, so the editor never falls back to
  the kind's defaults when the endpoint said more. Anthropic
  (`anthropic-models.ts`): `vision` ← `capabilities.image_input`,
  `contextLength` ← `max_input_tokens`; `tools` and `streaming` are not in the
  capability tree and default to `true` (every Messages-API model has both); a
  `null` tree claims nothing. Local OpenAI-compatible servers
  (`local-model-features.ts`): llama.cpp's `meta.n_ctx_train`; Ollama's
  `/api/show` `capabilities` (`vision`, `tools`) and `*.context_length`, probed
  only when `/api/tags` answers, best-effort, never failing the list.
  Response shapes are pinned as fixtures in `src/__tests__/fixtures/list-models/`.

## Testing

`runTestChatStream` takes every seam as an injected dep (`TestChatStreamDeps`),
so the whole decision tree — including all three timeouts, under fake timers —
is testable without a hub, a camera or a model. The chunk-boundary tests in
`chat-completions-stream.spec.ts` are not ceremony: a parser that assumes one
frame per read works perfectly on localhost and corrupts the first answer that
crosses a slow link. Use
`createTestLogger()` from `src/__tests__/support/logger.ts` when the assertion is
about a log line — the no-op `makeTestLogger()` cannot prove a drop was reported.

## Apple Foundation Models (`apple-foundation`) — [D639](../../docs/decisions/adr-0639-apple-foundation-models-runs-as-a-supervised-child-behind-llm-runtime.md)

A prebuilt Swift helper, `native/afm/camstack-afm`, run by THIS node's
`llm-runtime` as a supervised child on darwin only (`src/runtime/apple/`).
Line-delimited JSON over stdio; the Swift source and `afm-protocol.ts` are one
contract and change together.

- **The binary is committed and shipped (`files`).** A Mac node may have only
  the Command Line Tools with an older SDK, so it never compiles. Rebuild with
  `npm run build:native` on a Mac with SDK 26+. `camstack-afm.source-sha256`
  and `camstack-afm.binary-sha256` stamp the source and the binary it produced;
  `afm-binary.spec.ts` fails when either moved, and checks the PACKED tarball
  carries the binary at 0755.
- **The child's stdin has an error listener, always.** EPIPE into a dead helper
  is otherwise an uncaughtException that exits the whole `ml` runner. A probe
  timeout or 3 generation timeouts in a row kill the helper (it is wedged), and
  that kill counts against the crash bound.
- **Availability is a mirrored slice with four states** — a read never waits
  on a probe, a probe that did not answer is `unknown` (never unavailable), and
  only static facts (not darwin, Darwin < 25) gate a generation. The helper
  checks Apple's own availability on every call.
- **Only a GENERATION reply proves the helper alive** for the wedge count; a
  cancel ack or probe reply comes from its reader thread even while every
  generation is stuck.
- **Cancel is streamed.** `respond(to:)` ignores cancellation until the answer
  is complete (16 s measured); the helper streams and checks per snapshot.
- **A guardrail refusal is `refusalSource: 'guardrail'`**, logged on the node
  and on the hub. The hub falls back to the caller's next profile ONLY when the
  caller named none — an explicit `profileId` (and `testProfile`) gets the
  refusal, never a silent re-send to a cloud default. Apple refuses
  surveillance-framed prompts in 0.1 s; describe events, not cameras.
- **Text only.** Images are refused (`unavailable`) until a helper built with a
  macOS 27 SDK reports `imageInput: true`; `supportsVision` on the row is what
  the node last reported — never taken from the form. Intel Macs are
  `unsupported-platform`.
- **The hub never awaits a node's Apple state on a dispatch or read path.**
  `AppleNodeMirror` (`src/apple-node-mirror.ts`) is read synchronously and
  refreshes itself in the background; it asks only nodes the capability
  REGISTRY lists, each under a 5 s deadline (the registry read itself under
  3 s; a failed or empty-entry read changes nothing and backs off a period). A
  node is offline only after TWO answered reads without it — one absence is a
  runner re-registering, re-checked within seconds. The first version awaited a live
  nodePin inside every vision call: with the Mac offline that is a 30 s
  discovery wait on every notification gate, cloud profiles included.
- **A cancel can arrive before the call registered** (it was still in its
  budget check); the hub keeps a short tombstone, as the node does. Identity/biometric
  consumers are refused before dispatch (Apple acceptable use).
