---
id: D763
title: The decoder cap is a node's hwaccel answer — it has no session surface, and shm-ring and decoder-ffmpeg are deleted
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/decoder.cap.ts
  - packages/types/src/capabilities/__tests__/no-decoder-session-surface.spec.ts
  - packages/addon-decoder-nodeav/src/addon/index.ts
  - packages/addon-decoder-nodeav/src/decode-hwaccel-rank.ts
  - packages/system/src/kernel/host-externals.ts
  - server/backend/src/single-copy-cleanup.ts
---

## Context

[D762](adr-0762-the-stream-broker-has-no-frame-plane.md) removed the stream
broker's frame-handle plane, which was the only in-repo caller of the `decoder`
cap's session surface: `createSession`, `destroySession`, `pushPacket`,
`openStream`, `pullFrames`, `pullHandles`, `getFrame`, `getShmStats`,
`updateConfig`, `getStats`, `listActiveSessions`, `supportsCodec`. Video decoding
had already moved to the pipeline runner's session-decode workers (2026-07-16).
Those workers use node-av directly and never call the cap.

Three things were left that described a design no longer running:

- **The session surface.** Two providers implemented it in full: a 1 600-line
  `NodeAvDecoderSession` and the ffmpeg-subprocess `FfmpegDecoderSession` with an
  hwaccel cascade and GOP replay. `pullHandles`, `getFrame` and `getShmStats`
  were already stubs that answered `[]` / `null`.
- **`decoder-ffmpeg`.** Its registration gate called `resolveDecoderBackend`,
  which has returned `nodeav` unconditionally since the Decoder Backend
  selector was removed. So it never registered `decoder`. Its `audio-codec`
  provider was the inactive side of a singleton whose active provider was
  `decoder-nodeav` on every node. It still ran a runner on every node.
- **`@camstack/shm-ring`.** It had left the closure with
  [D184](adr-0184-the-closure-carries-no-package-nothing-imports.md). It stayed
  a host-external, a closure-provided cleanup entry, a vite external, an nx
  implicit dependency of addon-pipeline, a Checks prebuild step and a prebuild
  workflow, all "so an addon deployed before D18 still resolves it". No source
  module imported it. In the latest npm tarballs of addon-pipeline,
  decoder-nodeav, decoder-ffmpeg and post-analysis, the only mention was
  addon-pipeline's `nx.implicitDependencies`.

Proof the surface was dead, taken on 2026-10-08:

- **Static.** No call outside the generated routers, proxies and hooks in
  `packages/**`, `server/**`, `scripts/**` or the viewer (`camstack/` src, app
  and embed). Checked the paths that handle frames or media: the session-decode
  worker, recorder, clip ring, snapshot builtin, post-analysis, face and plate
  crops, timelapse and digests, HomeKit and Alexa egress, benchmark.
- **The notification centre's media.** Stills come from post-analysis's own
  MediaStore. Its writer is fed by `pipelineRunner.getNativeCrop`, which serves
  the runner's native hold, subject and scene tiles and retained frames.
  Clips come from the broker's packet ring (`produceEventMedia` /
  `renderPreBufferClip`) or `recordingExport`. Fallback stills come from the
  `snapshot` cap. None of these touch the decoder cap or shm.
- **Live (read-only hub API).** `decoder.listActiveSessions` returned `[]` on
  the hub, the Mac agent and agent-a. `decoder.getInfo` answered
  `decoder-nodeav` on all three. `addons.listCapabilityProviders` showed the
  decoder-ffmpeg `audio-codec` provider inactive on every node.

## Decision

The `decoder` cap answers one question: what is this node's decode hwaccel. It
has two methods, `getInfo` (identity, the operator's `hwaccel` and
`probedBestHwaccel`, read pinned to the node by the egress transcode, HomeKit
and the load view) and `reprobeHwaccel`. `decoder-nodeav` is its only provider
and also the node's `audio-codec`. Nothing in the cluster decodes video except
the runner's session-decode worker.

`decoder-ffmpeg` and `@camstack/shm-ring` are deleted from the repository with
everything that existed only to build, publish, prebuild or resolve them.
`EventCategory.PipelineAgentHwaccelChanged` (no emitter; its last subscriber was
the D762 rotation) is removed with them. A capability, package or event that
nothing calls is removed, not kept "for wire compatibility". Keeping it is what
made D762's dead fields read as measurements.

## Alternatives rejected

- **Keep the session surface for an out-of-repo caller.** None exists on the
  fleet (`listActiveSessions` was `[]` everywhere). The hub-served viewer embed
  bundle carries the generated proxy entries until its next build and never
  calls them.
- **Keep `decoder-ffmpeg` as a selectable fallback.** It could not be selected:
  the gate is hard-wired to `nodeav` and the UI selector is gone. Making it
  selectable again would mean re-growing the session surface this record
  removes.
- **Keep the `shm-ring` host-external for a pre-D18 addon.** No published
  version of any addon imports it, so the entry routed a specifier nobody asks
  for. A stale copy under `addons/` is inert without it.
- **Merge decoder-nodeav into another addon now.** It still owns the
  `audio-codec` cap, which is live: the hub carries continuous AAC decode
  sessions for the broker's audio legs. That is an operator call, not part of a
  dead-code removal.

## Consequences

- A client built against the old cap that calls `decoder.createSession` and the
  other removed methods gets a not-found procedure.
- **Deployed copies keep running until an operator acts.** `decoder-ffmpeg` is
  still installed on the hub, the Mac agent and agent-a. Its runner keeps
  serving an inactive `audio-codec` provider until it is uninstalled. Its
  published versions, and shm-ring's, stay on npm. Deprecate them rather than
  unpublish.
- An older hub receiving a newer `decoder-nodeav` is fine: the provider only
  shrank. A newer hub calling an older `decoder-nodeav` is fine too: `getInfo`
  only lost optional fields. Cap and router ship together in `@camstack/server`.
- `reprobeHwaccel` keeps its vaapi-above-qsv ranking in
  `packages/addon-decoder-nodeav/src/decode-hwaccel-rank.ts`. It is a copy of
  the broker's ranking in `packages/addon-pipeline/src/shared/ffmpeg-decode-args.ts`,
  because addons do not import each other.

## Enforcement

`packages/types/src/capabilities/__tests__/no-decoder-session-surface.spec.ts`
fails in five cases: the cap has any method beyond `getInfo` / `reprobeHwaccel`;
`getInfo` reports `isPullMode` / `priority`; a session, packet, frame or shm
schema is exported; the hwaccel-changed event exists; or `packages/shm-ring` or <!-- drift-ok: the guard asserts these stay deleted -->
`packages/addon-decoder-ffmpeg` reappears. `decoder-nodeav-per-node-settings.spec.ts` <!-- drift-ok: the guard asserts these stay deleted -->
fails if the addon grows a session method back. The method-tier guard fails on
any new decoder method until it is recorded, and `host-externals.spec.ts` fails
if `@camstack/shm-ring` returns to the host-external list.
