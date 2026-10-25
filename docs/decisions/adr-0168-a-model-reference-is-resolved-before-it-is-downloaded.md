---
id: D168
title: A model reference is RESOLVED before it is downloaded, and an ambiguous repo is refused rather than guessed
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-ai/src/runtime/hf-ref.ts
  - packages/addon-ai/src/runtime/model-ops.ts
  - packages/addon-ai/src/runtime/llm-model-catalog.ts
---

## Context

The managed local runtime could only run what `LLM_MODEL_CATALOG` listed: three
GGUFs, hard-coded, each with a pinned digest. Anything else meant a code change
and a release. The operator asked the obvious question — *"how do we make the
managed local runtime use a model that is not in the picker? Can we paste a
Hugging Face URL?"*

`ManagedModelRef` already had a `{kind:'url'}` variant and `installModel`
already honoured it, so "paste a URL" was nearly free. Probing what an operator
would actually paste is what made it not free:

- **`unsloth/Qwen3.6-35B-A3B-GGUF` publishes 24 quantizations**, from 10 GB
  (`UD-IQ1_M`) to 50 GB (`BF16`, split across two shards) — and **none of them
  is named `Q4_K_M`**. They are `UD-Q4_K_M`, Unsloth's dynamic quant. Any
  "default to Q4_K_M" would have found nothing, and any "pick the closest" would
  have downloaded 22 GB of a model the operator did not choose.
- It is a **vision** repo. The weights are useless to llama-server without one
  of `mmproj-{F16,BF16,F32}.gguf`, which the reference the operator types does
  not mention. A download that fetches only what was named produces a model that
  loads and cannot see.
- Some quantizations are **split GGUFs** (`-00001-of-00002`). llama.cpp needs
  every shard present, named as published, in the same directory.
- huggingface.co answers **401 for a gated repo AND for a repo that does not
  exist** — it will not leak whether a private repo is there. Only
  `x-error-code: GatedRepo` separates them. Reading the status alone tells a
  typo'd repo name that it needs an access token, which is the wrong
  instruction and sends the operator to go create one.

And the existing download path was silent. `ensureModel` fetches `extraFiles`
FIRST and passes them **no progress callback** — invisible for a 40 kB labels
JSON, unacceptable for a 0.9 GB projector — while `installModel` logged nothing
at all, start to finish, for an operation that takes tens of minutes.

## Decision

An operator-supplied model reference is **resolved to a pinned download plan
before anything is downloaded**, and resolution is allowed to REFUSE.

`llm.resolveModelRef` runs on the HUB (it needs egress; the target node may not
have it) and performs a tree read plus a HEAD — never a GET of the weights. It
returns either a complete `ManagedModelRef` carrying every artifact, its size
and its sha256, or a refusal that the UI renders as an answer rather than an
error. The rules it enforces:

- host is `huggingface.co`; extension is `.gguf`; no `..` in any path segment;
- **more than one candidate quantization is a refusal that NAMES the tags**, and
  every tag it prints must resolve when pasted back as `<org>/<repo>:<TAG>`.
  There is no "closest match" and no default quantization, ever;
- the mmproj IS chosen for you (`F16` > `BF16` > `F32`) because that choice
  costs a few hundred MB of projector rather than a different model — and the
  file it picked is reported in the preview;
- split GGUFs are completed or refused: a missing shard is named;
- the TOTAL (weights + shards + projector) is checked against a ceiling
  (`DEFAULT_MAX_MODEL_BYTES`, 20 GiB) before the HEAD, and a `too-large`
  refusal carries `requiredBytes` so the operator can overrule it explicitly;
- sha256 comes from HF's LFS `oid`, cross-checked against `x-linked-etag` on the
  HEAD, and the HEAD size must agree with the tree size.

On the node, **every artifact whose digest the reference pinned is verified**,
not just the main file, and a mismatch discards the install. The download loop
moved into `model-ops.ts` — over the same shared `downloadFile` — so bytes are
aggregated across the whole install, the file currently moving is named, and
files already on disk are excluded from the total instead of counted as
instantly complete. `LlmRuntimeStatus.download` carries phase / file / index /
bytes, and `installModel` logs start, a line per 10%, the verify phase, and the
outcome.

## Consequences

- **The catalog is no longer the boundary of what can run.** It keeps two jobs
  that typing a reference cannot do: a digest nobody has to re-verify, and a
  `minRamBytes` / `contextSizeDefault` somebody checked. Add an entry only when
  both are true — otherwise the reference field is the answer.
- `ManagedModelRef`'s `url` variant now carries `label`, `sizeBytes` and
  `extraFiles`. It is the whole plan, so what the operator approved in the
  preview is exactly what the node fetches; nothing is re-derived at install
  time on a node that may see a different HF than the hub did.
- `mmprojFilename` may no longer read `extraFiles[0]`. With shards in the same
  list, index 0 is routinely a weights shard, and `--mmproj <shard>` starts
  llama-server against a file that is not a projector. It matches by name.
- `LlmNodeModel` gained `path`, so a GGUF on disk that matches no catalog entry
  — a custom install, or a file copied in by hand — is selectable as a
  `{kind:'path'}` ref instead of being listed and unusable.
- A gated repo produces an honest error naming `HF_TOKEN` /
  `HUGGING_FACE_HUB_TOKEN`, which the shared downloader **already** reads. The
  hub reads the same names for resolution, so there is one place to set it. A
  token stored per-profile in the settings store is NOT part of this and remains
  a follow-up.
- Resolution is a live network call in a tRPC mutation. It is bounded by the two
  requests it makes and returns a result on every failure path, but it is not
  cached: a repo with 24 quantizations is re-read on each Check.
- **No resume.** `downloadFile` restarts a cut transfer from zero. It is a CLEAN
  retry — the partial is unlinked, nothing truncated survives, and the next
  attempt succeeds — but a 22 GB pull over a flaky link can livelock on
  retries. Range-resume belongs in `packages/system` and would change the
  detection plane too, so it is deliberately out of scope here.

## Enforcement

`packages/addon-ai/src/__tests__/hf-ref.spec.ts` (41 cases) drives an injected
`fetch` with fixtures transcribed from live probes of huggingface.co on
2026-08-15 — including the two indistinguishable 401s. The invariant that makes
a refusal useful is asserted directly: **every tag offered in an `ambiguous`
error is re-resolved and must succeed**. That test caught the real bug that a
live probe found — `Qwen/Qwen2.5-1.5B-Instruct-GGUF` offered
`qwen2.5-1.5b-instruct-fp16.gguf` as a tag, and that string did not parse.

`model-ops-download.spec.ts` runs against a REAL `node:http` server on
`127.0.0.1` — redirect, HEAD, and a socket destroyed mid-body — because the
claim being made ("an interrupted transfer leaves no partial file") cannot be
established against a fake `fetch`. Both the companion-progress fix and the
mmproj-by-name fix were neutralised and confirmed to turn their tests red.

Nothing statically prevents a future caller from bypassing `resolveModelRef`
and hand-building a `{kind:'url'}` ref. That is acceptable: such a ref simply
carries no digest and no extras, and `installModel` treats it exactly as it did
before this record.
