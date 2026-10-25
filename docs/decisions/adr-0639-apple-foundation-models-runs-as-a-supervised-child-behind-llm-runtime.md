---
id: D639
title: Apple Foundation Models runs as a supervised child behind llm-runtime, its availability has four states, and a guardrail refusal falls back only for a caller that did not name a profile
status: accepted
date: 2026-09-25
supersedes:
applies-to:
  - packages/addon-ai/native/afm/camstack-afm.swift
  - packages/addon-ai/src/runtime/apple/**
  - packages/addon-ai/src/runtime/cancel-registry.ts
  - packages/addon-ai/src/apple-profile.ts
  - packages/addon-ai/src/provider.ts
  - packages/addon-ai/src/resolve-profile.ts
  - packages/types/src/capabilities/llm-runtime.cap.ts
  - packages/types/src/capabilities/llm.cap.ts
  - packages/types/src/capabilities/llm-shared.ts
---

## Context

The operator asked for the Mac node's on-device Apple Foundation Models as an
`llm` backend. Four facts measured on the way shaped the design.

- **Cancellation did not cross nodes, even before Apple.** `llm.cancel` only
  aborted the hub's own map. The managed-local branch never registered its
  `requestId`, and the node generated on `new AbortController().signal`. So a
  notification gate that gave up at 8 s left the node's model generating until
  its own timeout.
- **`LanguageModelSession.respond(to:)` honours `Task.cancel()` only after the
  whole answer exists.** A cancel sent at 0.5 s returned at 16 s. Streaming
  with a cancellation check on every snapshot returns in about 1 s.
- **Apple's guardrail refuses surveillance-framed prompts in 0.1 s**
  (`guardrailViolation`), while notification-style text passes. A refusal that
  reads like a generic error, or like an empty answer, is indistinguishable
  from a broken model.
- **A write into a helper that already died raises EPIPE on the child's
  stdin.** It arrives as an async `'error'` event, and with no listener it is an
  uncaughtException that exits the whole `ml` runner. That is exactly the
  failure the process boundary was chosen to avoid.

The first version of the fallback also re-sent the prompt of a caller that had
NAMED the Apple profile to the text default, which may be a cloud profile. As a
result, `testProfile` reported another profile passing.

## Decision

- **Where it runs.** Apple Foundation Models is reached only through the node's
  `llm-runtime.completeApple`. That method drives a prebuilt Swift helper
  (`camstack-afm`) as a separate, supervised child on arm64 darwin.
- **The binary.** It is committed, and shipped in the addon tarball. Its source
  and its bytes are both stamped. A node never compiles it.
- **Crashes and hangs.** The helper is bounded by `CrashPolicy`. A write
  failure, a stdin error, a probe timeout, or three generation timeouts in a
  row count as a crash.
- **Availability.** It is `available | unavailable(reason) |
  unsupported-platform | unknown`, never a boolean. A probe that did not answer
  is `unknown`.
- **Images.** `supportsVision` on an `apple-foundation` row is what its node
  REPORTS, refreshed on read.
- **Guardrail refusals.** A guardrail refusal is `refusalSource: 'guardrail'`
  and is logged. The provider tries the caller's next profile (consumer
  default, then purpose default) only when the caller did not name a profile.
  An explicit `profileId` and `testProfile` always get the refusal itself.
- **Cancellation.** `llm.cancel` forwards to the node running the generation,
  and a cancel that arrives first leaves a short-lived tombstone there.

Rejected:

- **An N-API addon inside the `ml` runner** (`@meridius-labs/apple-on-device-ai`).
  A native crash would respawn every co-located addon (D29), and the design
  would depend on a third party tracking `ai@7`'s provider spec.
- **An OpenAI-compatible HTTP helper, or macOS 27's `fm serve`.** It is more
  code, it adds a port to supervise, and `fm serve` is undocumented and absent
  on macOS 26.
- **Overloading `llmRuntime.complete`.** Its `runtime` carries a llama.cpp GGUF
  model reference, which Apple's backend does not have.

## Consequences

- **A framework change.** The new kind, the three `llm-runtime` methods and the
  new output fields ship only in a `@camstack/server` release. After that,
  addon-ai must be redeployed on every node.
- **Rebuilding the binary** needs a Mac with SDK 26 or newer. The build is a
  no-op when the stamps are current.
- **Usage rows.** Each profile actually called gets one usage row. A guardrail
  fallback therefore writes two rows for one call: the refused attempt counts
  as an error on the Apple profile, and rollups count that call twice.
- **Text only until a macOS 27 helper.** The Apple profile is text-only, hidden
  from notification rules (which need vision), and refuses images. It refuses
  identity/biometric consumers under Apple's acceptable-use terms.
- **Token counts.** `usage` and `truncated` are known only on macOS 26.4 or
  newer; below that, 0 means unknown. A structured answer cut short is an
  error, never `ok`.

## Enforcement

- **addon-ai specs:**
  - `afm-helper.spec.ts` covers the crash bound, the wedge kill, and EPIPE
    against a real child;
  - `afm-availability.spec.ts` covers the four states and that `unknown` is
    never reported as unavailable;
  - `runtime-cancel.spec.ts` covers the node and hub cancel, the tombstone, and
    no boot when already cancelled;
  - `apple-provider.spec.ts` covers the fallback, no fallback for an explicit
    profile or `testProfile`, the identity refusal, and live `supportsVision`;
  - `afm-binary.spec.ts` checks both stamps, the packed tarball entry with mode
    0755, and the real-binary protocol on darwin.
- **server:** `llm-runtime.router.spec.ts` checks that `refusalSource` survives
  output validation.
