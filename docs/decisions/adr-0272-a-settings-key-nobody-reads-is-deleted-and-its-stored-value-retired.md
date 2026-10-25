---
id: D272
title: A settings key nobody reads is deleted, and its stored value is retired
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/addon.ts
  - packages/addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts
  - packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts
  - packages/types/src/capabilities/audio-analyzer.cap.ts
  - scripts/check-settings-key-has-reader.ts
---

## Context

The 2026-08-28 cluster settings census
(`docs/design/2026-08-28-cluster-settings-census.md`) traced all 158 declared
settings fields from declaration to every reference. Nine wrote a store nobody
reads. They were not subtle bugs: they were forms.

- `stream-broker` shipped a whole **"Reconnection"** section — two fields and a
  description promising exponential backoff — over a ladder that has always run
  on two module constants, `INITIAL_RECONNECT_DELAY_MS` and
  `MAX_RECONNECT_DELAY_MS`. Beside it, `maxDecodeFps` promised *"maximum frames
  per second for decoded stream subscribers"* and capped nothing.
- `embedding-encoder` offered a **Backend** select with CUDA and CoreML options.
  Its only reference was `logger.withTags({ backend: this.config.backend })`.
  Embedding inference has always been ONNX in the embedded portable Python;
  there is no CUDA path and no CoreML path. An operator picking "CUDA" got a
  differently-labelled log line and the same CPU inference.
- `audio-analyzer`'s **Classification model** select had the same shape:
  `createAudioPipeline` takes a backend and no model id, so the value reached a
  `logger.info` meta field and stopped.
- `pipeline-analytics`'s `mediaAttachPolicy` was not even resolved — absent from
  `MediaSettingsSchema`, so it was never read into anything.

The repo already knew about two of them. `docs/architecture/post-analysis.md`
said *"One form knob is dead: `mediaAttachPolicy` has no reader"* and left it
there. And the file nearest to the defect,
`pipeline-analytics/__tests__/settings-schema-dead-knobs.spec.ts`, asserted the
ABSENCE of two names — `trackTtlMs` and `maxPositionHistory` — that had already
been deleted. An absence assertion over a fixed list can only re-prove someone
else's fix. `mediaAttachPolicy` was dead three sections away in the very schema
that spec guarded, and the spec had nothing to say about it.

A second defect of the same family sat on `embeddingEnabled`: the schema
declared `default: false`, the addon's durable handle declared `true`. One store
key, two defaults. An operator who had never touched it saw **OFF while the
dispatcher was running**, under a label that read *"Leave OFF; it only burns
CPU"* — and a Save on that form would have written the lie back as truth.

## Decision

**A declared settings key must have a reader. A key that does not is deleted
from the schema, its resolved config property / default / type member goes with
it, and its stored value is retired through `RETIRED_SETTINGS_KEYS` so the hub
store converges instead of carrying residue that still LOOKS like
configuration.**

Three rules follow from it.

**A section dies with its fields.** Deleting `initialReconnectDelayMs` and
`maxReconnectDelayMs` deletes the "Reconnection" section and its description.
A section header that describes a mechanism the code does not have is the same
lie as the fields were, in prose.

**One store key has exactly ONE default.** Where a field and a durable handle
address the same key, one exported constant is declared once and imported by
both — `EMBEDDING_ENABLED_DEFAULT` is the pattern. Two defaults that disagree
is the defect, independent of which value is right.

**`keys` vs `perNodeKeys` in a retirement spec is a data-loss decision.**
`perNodeKeys` matches `<key>` AND `<key>@<nodeId>`. That is correct for the
decoder `backend`, where every node's copy is dead. It is wrong for
`probedBestHwaccel` / `probedBestAudioBackend`, where the bare key is
unreachable residue but each `@<nodeId>` copy is that node's live probe result.
Those go under exact-match `keys`.

## Consequences

Seven fields, one section and one cap type member are gone; six retirement
specs delete their stored values on the next hub boot, logged once each.
`embeddingEnabled` now renders ON, which is what the cluster was already doing.

**This deletes operator data**, so the boundary was drawn at *confirmed*
orphans. Two census claims did not survive verification and were left alone:

- **`recorder.recordingPlacement` is NOT deprecated.** The census listed it as
  an orphan. `placement-store.ts` reads and writes it through a `DurableState`
  on every writer run, and `recorder/addon/retired-root-keys.ts` states in as
  many words that it stays a blob key. Retiring it would have destroyed every
  camera's storage assignment. It is now pinned by name in the retirement spec's
  "never retires a live key" test.
- **`bufferMaxPerDevice` and `tokenExpiry`** were both fixed earlier the same
  day (D267 for the latter) and are not dead any more.

The census's own R5 overclaims what a guard can do: it proposes a check that
"would have failed on all nine". It would not, and saying so is the point —
see Enforcement.

## Enforcement

`scripts/check-settings-key-has-reader.ts`, in the CI repository-guards loop.
It collects every declared field key from every addon schema (479 today) and
fails when a key's ONLY appearances in the workspace are declaration-shaped:
`key: 'name'`, or `name:` as an object property / interface member / Zod field.
Tests are excluded — a key only a test reads is still dead in production, and
all nine had test coverage.

**What it cannot catch, stated so nobody trusts it further than it goes.**
Reachability is textual, and three of the nine died with a property access as
their only reference: `runtime`, `backend` and `selectedAudioModel` were all
read into a log field. No static rule separates a log tag from a consumer
without deciding what a "real" consumer is, and a rule that decides that fires
falsely on the first legitimate diagnostic read. So the guard is the narrow one:
it never fires on a key referenced at all, and fires with certainty on a key
that is not. It would have caught four of the nine — including
`mediaAttachPolicy`, sitting inside the file the old spec guarded — and it
caught a tenth nobody had reported: `verifyTls` in
`addon-notifiers/src/adapters/gotify.ts`, a "Verify TLS certificate" switch
defaulting ON whose name appears exactly once in the workspace, its own
declaration.

`verifyTls` sits in the guard's `KNOWN_UNREAD` set, which is **shrink-only**:
the guard fails if a name in it stops being unread, so it cannot outlive its
contents, and a new dead knob can never be added to it — a new knob simply
fails. That is the difference from the two-name list this replaces, which
asserted absence and could therefore never fail on anything new.

The three log-only shapes are covered by discipline, not machinery: a select
whose options name a capability — a runtime, a device, a model — must be traced
to the code that switches on it before it ships.
