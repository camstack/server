---
id: D166
title: The connect bound measures the SOCKET; every byte the provider owes belongs to the first-token bound
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-ai/src/client/connect-probe.ts
  - packages/addon-ai/src/client/llm-client.ts
  - packages/addon-ai/src/test-chat/run-stream.ts
  - packages/addon-ai/src/test-chat/contract.ts
---

## Context

The AI test chat declares three bounds — connect (10 s), first token (120 s,
configurable), idle (60 s) — on the stated grounds that they are three different
faults with three different remedies. The taxonomy was right. The implementation
measured the wrong things, and the operator paid for it twice:

> `unavailable: the endpoint did not accept the connection within 10s — check
> that the provider is running and the base URL is right`

against an LM Studio that was running, at a base URL that was correct, loading
`qwen/qwen3-vl-8b` into the GPU. The remedy the message named did not exist.

Two separate mistakes produced it, and the second was not visible from the code:

1. **The connect timer was armed around the wait for the provider's response.**
   A comment in `openStream` said it covered "ONLY the wait for response
   headers" — but on the LM Studio / llama-server wire the status line is the
   LAST thing that happens before the first token: the server accepts, reads the
   request, loads the model for minutes, and only then writes a byte. Waiting
   for headers *is* waiting for a cold load, so bounding it at 10 s put a
   loading model in the bucket labelled "the box is off".

2. **`stream.response` is not a header edge — it is the END of the generation.**
   Measured against a local server that wrote headers at 125 ms, a token at
   325 ms and closed at 925 ms, `await stream.response` resolved at **935 ms**.
   So the awaited call under the 10 s bound was in fact "the whole answer must
   finish within ten seconds", and every token was withheld from the browser
   until it had — the streaming test chat did not stream. A warm 5 s reply hid
   both facts completely.

An earlier proposal was to keep the header wait where it was and give it a real
socket bound underneath by injecting a `fetch` backed by an undici
`Agent({ connect: { timeout } })`. It was rejected: addons build
`externals: 'self-contained'`, so undici would be inlined into the addon bundle
— a second HTTP stack shipped per addon — and a dispatcher option still cannot
tell the caller *when* the handshake completed, which is the moment the page has
to change what it says.

## Decision

`connectTimeoutMs` bounds a TCP handshake and nothing else. `LlmClient.openStream`
probes the profile's endpoint with `node:net` first (`connect-probe.ts`): a
refused port fails at once and keeps its `ECONNREFUSED`, only an unanswered
handshake spends the bound. Everything after the handshake — response headers
included — is charged to `firstTokenTimeoutMs`, and "open" means the first
chunk of the token stream is in hand, not that `stream.response` settled. The
headers and the first token draw on ONE budget, because the page promises the
operator one number.

A provider that answers and refuses (401, 404, 500) returns `provider-error`
carrying its own `LlmErrorCode`; `unavailable` is reserved for a socket that
failed. `first-token-timeout` is its own outcome and never borrows the connect
sentence.

## Consequences

- The test chat streams for real. Before this, tokens reached the browser in one
  burst after the generation ended.
- A cold load can no longer be reported as an unreachable endpoint, and a wrong
  API key can no longer be reported as one either.
- The socket probe is a second, short-lived connection to the endpoint, made
  microseconds before the real one. The gap is a theoretical race; a port that
  shuts inside it surfaces as the ordinary network error it is.
- A profile with no base URL (a vendor default endpoint) is not probed at all —
  the client never learns that URL, and probing a guessed host would be probing
  a different machine from the one the call uses. Those profiles keep the whole
  wait under the first-token bound.
- The page must know the first-token bound BEFORE `meta` arrives, because the
  phase now flips at the handshake — minutes earlier on a cold box. It seeds it
  from the selected profile and sends that same number, which is also what makes
  the Profiles tab's "First token" field the remedy the error message names.

## Enforcement

`packages/addon-ai/src/__tests__/llm-client-connect-bound.spec.ts` — real
listeners on `127.0.0.1`, because an injected `fetch` cannot tell a socket that
never connects from one that connects and stays silent. It asserts: headers
300 ms late with a 40 ms connect bound still open; a closed port fails inside a
second naming `ECONNREFUSED`; an accepting-but-mute endpoint yields
`first-token-timeout`; a 401 keeps `auth`; and an answer longer than the
first-token bound drains in full. Each half of the fix was re-broken and the
corresponding tests confirmed to fail. `run-stream.ts` owns the sentences and is
covered by `test-chat-stream.spec.ts`; no guard script — review only.
