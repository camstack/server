---
id: D169
title: The managed runtime is configured per NODE; a profile only picks a model to run on it
status: proposed
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-ai/src/runtime/llama-supervisor.ts
---

## Context

The operator stated the shape directly: *"the manager must be ONE runtime per
node only, where several defined profiles can run."*

D149 already decided the execution half of exactly that — one `LlamaManager`
per node owning `Map<modelKey, LlamaSupervisor>` under a RAM budget — so there
is **no conflict to resolve there**; D149 is this record's execution layer and
is still unimplemented. What D149 did not address is the half the operator is
actually looking at in the UI: **where the settings live**.

Today every setting lives on `ManagedRuntimeConfig`, which is embedded in each
`LlmProfile`. That is why two profiles pointed at the same node each carry their
own `nodeId`, their own `contextSize`, their own `gpuLayers` — and, if the
llama-server version and compute backend the operator asked for were added the
same way, their own *binary version* and *backend*. Two profiles on one node
could then demand `b10025/metal` and `b10375/cuda` simultaneously. There is one
binary per node. One of those profiles would silently lose, which is the exact
failure D62 names: a switch that writes a store nobody reads.

The distinction is not cosmetic. Some settings genuinely belong to the node —
there is physically one of them — and some genuinely belong to the model:

| Belongs to the NODE (one, physically) | Belongs to the MODEL/profile |
| --- | --- |
| llama-server binary version (`b10375`) | `contextSize` |
| compute backend (metal / cuda / vulkan / cpu) | `gpuLayers` |
| RAM budget (D149) | `parallel`, `batchSize`, `ubatchSize` |
| models directory, disk | `cacheTypeK` / `cacheTypeV`, `mlock`, `noMmap` |
| | `idleStopMinutes`, `autoStart`, `extraArgs` |

`extraArgs` is on the model side and shipped there, deliberately: `--jinja` is
the flag a VISION chat template needs and some language-only models dislike, so
it is a property of the model being run, not of the machine running it.

## Decision

Runtime configuration splits by **what there is physically one of**. Settings in
the left column above become a per-node `LlmRuntimeSettings` record, addressed
by `nodeId` and edited once on the Runtimes tab. Settings in the right column
stay on the profile, because a node runs several models at once (D149) and each
one wants its own.

A profile therefore stops carrying anything node-global. It names a node, names
a model, and tunes that model.

Within this split, the **"additional arguments" box may never re-set a flag a
typed field owns.** `OWNED_FLAGS` maps every such flag to its field and
`checkExtraArgs` rejects a collision at start, naming the owner, before a
binary is resolved or a model is downloaded. Both surfaces exist because
neither suffices — the typed fields give the common knobs validation and a
default, and llama.cpp has a hundred flags nobody will model — but a flag
settable from both is a control the operator watches do nothing.

## Consequences

- **Not yet implemented**, except `extraArgs` + `checkExtraArgs`, which shipped
  with this record. `LlmRuntimeSettings`, the version field and the backend
  field are the work this record authorises, not work it describes as done.
- The version field cannot be built the way the current pin is built.
  `ensureLlamaServer` verifies the downloaded tarball against a **hard-coded
  per-asset sha256** (`LLAMA_SERVER_ASSETS`), which is only possible for a
  version known at build time. An operator-chosen version has no pinned digest
  here, so it must verify against the digest GitHub publishes for that release
  asset, fetched over TLS from the releases API. Shipping an operator-chosen
  version WITHOUT that step would trade a verified download for an unverified
  one — a regression, and the reason the field is not in this change.
- The backend field must offer only what we actually ship. `LLAMA_SERVER_ASSETS`
  currently has two entries — `linux/x64` and `darwin/arm64`, both generic
  builds. macOS arm64 is Metal-enabled in the upstream release; there is no CUDA
  or Vulkan asset wired at all. The picker must be built from the asset table,
  so it can never offer a backend for which no asset exists.
- Moving `nodeId` off the profile touches `resolveManagedProfile`,
  `runtime-client`'s `nodePin`, and every `ManagedRuntimeConfig` fixture. It is
  train-bound with D149's `status` change and should move in the same release
  rather than in two.
- Until the split lands, the per-node settings that DO exist (the binary
  version) stay a build-time constant, which is honest: one node, one binary,
  nobody can disagree with anybody.

## Enforcement

`runtime-custom-model.spec.ts` asserts the owned-flag rejection per flag, in
both the `--flag value` and `--flag=value` spellings, and asserts that a
colliding config is refused **before** the supervisor is asked to spawn. A
matching UI test asserts that `SUGGESTED_EXTRA_ARGS` contains no flag any typed
field owns — a suggestion that produces a runtime which refuses to boot would be
worse than no suggestion.

`OWNED_FLAGS` is a hand-maintained map: a new typed field whose flag is not
added to it is not caught by anything. It sits directly above `buildLlamaArgs`,
which is the only place those flags are emitted, so the two are read together —
but this is review-only, and worth knowing.
