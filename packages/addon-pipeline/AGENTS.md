# packages/addon-pipeline — media and vision

Six addon manifests in one package. It absorbed the former
`addon-detection-pipeline`, `addon-pipeline-runner` and `addon-motion-wasm`
packages, so references to those are stale.

| Manifest | Source | Group |
| --- | --- | --- |
| `pipeline-runner` | `src/pipeline-runner/` | `detection` |
| `detection-pipeline` | `src/detection-pipeline/` | `detection` |
| `motion-wasm` | `src/motion-wasm/` | `detection` |
| `stream-broker` | `src/stream-broker/` | — |
| `recorder` | `src/recorder/` | — |
| `audio-analyzer` | `src/audio-analyzer/` | — |

The first three share the `detection` co-location group, so they run in **one
process** and their capability calls resolve in-process at zero copy. Changing one
respawns all three ([D2](../../docs/decisions/adr-0002.md)).

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed addon or manifest entry; `camstack deploy` → `camstack-addon` (`.claude/skills/camstack-addon/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Read before editing

`docs/design/decode-path.md` — **required** for `stream-broker/**`, the decoders
or `session-decode/**`. Then `docs/architecture/data-planes.md` for the summary.

## The rule that matters most

**Frames never cross a process boundary at frame-rate.** On the UDS plane a
child↔child call transits the hub-main parent router, which buffered raw RGB
detection frames until hub-main OOM'd and took the node with it.

Permitted: in-process via the `detection` group, or a compressed payload (binary
JPEG). Cross-process media is an event plus an on-demand **compressed** fetch by
handle — `pipelineRunner.getNativeCrop`, routed by `handle.nodeId`.
([D9](../../docs/decisions/adr-0009.md), [D18](../../docs/decisions/adr-0018.md))

The `detection` group exists for exactly this reason. Dissolving it means
reintroducing compression on that hop, not accepting a slowdown.

A change that passes a frame buffer to a sibling addon will look fine in a
single-camera test.

## Other traps

- **shm is gone from this plane.** No `FrameRingReaderCache`, no
  `decoder.getFrame`, and the broker has no frame-handle plane any more
  (`subscribeFrames` & co. removed, D762) — the broker decodes nothing. The
  `decoder` cap has no session surface either, and `@camstack/shm-ring` and
  `decoder-ffmpeg` are deleted (D763).
- **The native lease is NOT the detail plane's only pixel source.** `resolveCrop`
  walks `frameHandle` → `frameJpeg` → `cropJpeg`, and rung 2 fires often: the
  worker lease TTL runs against a 1 s dispatcher tick plus a 500-900 ms
  inference, so the handle misses on many dispatches and the retained full frame
  (3 s floor) covers. A caller with pixels sends a FULL frame and the runner
  cuts; `cropJpeg` means already-cut, verbatim
  ([D52](../../docs/decisions/adr-0052.md), [D73](../../docs/decisions/adr-0073.md)).
  The TTL, the RAM ceiling, the demand window and **which frames are leased at
  all** are cluster-wide orchestrator settings, not constants — read the numbers
  off a worker's `native lease knobs` spawn line, never off this page.
- **The lease keeps only what reached inference** (`nativeLeaseAdmission`). A
  frame the runner never enqueued cannot be named by a crop, because the only
  way a frameId leaves the runner is on a `FrameHandle` riding an inference
  result. If you add a caller that can name a frame some other way, it will show
  up as `leaseUnmarkedCrops` on the session-decode metrics line — that counter is
  the premise, and it must stay 0.
  See `docs/design/decode-path.md` → "Lease admission".
- **Recorded media is byte-range only, with no fallback** ([D31](../../docs/decisions/adr-0031.md)).
  `embed/src/playback/**` and `embed/src/scrub/**` resolve a moment to a FRAGMENT
  through the segment's own `mfra`. There is no whole-segment fetch and no scrub
  pack to fall back to, so a defect there reads as "the player is dead" — which
  is the point. Two traps live in that arithmetic and both cost a session:
  the decoder init must be cut at `moov` (a fixed-size head read overruns into
  the first `moof`, and carrying that truncated fragment makes every later
  fragment decode at the segment's start), and a fragment's start tick must be
  converted to ms with `ceil` (rounding produces a start that re-selects the
  previous fragment, so playback re-loads what it holds and freezes). Neither is
  visible to the fixture tests — verify with `scratchpad/_e2e-walk.mts` against
  real segments.

- **On-demand pull lifecycle.** RTSP / RTMP / RFC4571 brokers dial only with a
  consumer attached and tear down on idle. `sourceProvider` re-derives URLs per
  dial — that is what makes Reolink rfc4571 republishes work.
- **WebRTC has five specific gotchas**, each of which cost a session (access-unit
  merging, SPS in the IDR check, explicit `video.play()`, headed Chrome for H.265,
  never re-packetizing H.265 from scratch). All in
  `docs/architecture/data-planes.md#webrtc-gotchas`. Read them before debugging a
  black video element.
- **vaapi works on the hub.** A silent fall back to software decode is a flow bug,
  not a capability limit.
- **A mock socket must `Object.defineProperty` its `writableLength`.**
  `Object.assign(emitter, { get writableLength() {…} })` copies the getter's
  current VALUE, so the fake reports 0 forever and every backpressure assertion
  written against it is vacuously true. The RTSP session specs shipped with that
  hole. Same failure shape as the pre-seeding fake: the test passed because the
  fake supplied what production forgot to fetch.
