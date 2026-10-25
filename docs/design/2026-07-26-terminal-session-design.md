---
title: Terminal sessions, and streaming one as a camera
status: deployed and live-verified
date: 2026-07-26
applies-to:
  - packages/addon-terminal/src/**
  - packages/types/src/capabilities/terminal-session.cap.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/stream-broker/webrtc/session.ts
  - packages/addon-pipeline/src/stream-broker/addon.ts
  - packages/types/src/interfaces/addon-data-plane.ts
last-verified: 2026-10-03
---

# Terminal sessions, and streaming one as a camera

Two requirements, one dependent on the other:

1. A real TTY session in the Admin UI, good enough to run a full-screen program.
2. Stream that session **as if it were a camera**.

**Status: both requirements are deployed. The end-to-end run on the three-node
cluster dates from 2026-08-14 and has not been repeated since; everything below
was re-read against the code on 2026-09-15.** What exists now:

| Piece | Where |
| --- | --- |
| the capability | `packages/types/src/capabilities/terminal-session.cap.ts` |
| the addon (pty, session manager, allowlist, data plane) | `packages/addon-terminal/src` |
| the Admin UI page | `packages/addon-admin-ui/src/pages/system/Terminal.tsx`, `packages/addon-admin-ui/src/components/TerminalPanel.tsx` |
| the browser side of the transport | `packages/addon-admin-ui/src/lib/terminal-io.ts` |
| cluster-safe byte transport | `pullOutput` / `writeInput` in `terminal-session` |
| operator-created camera instances (one per camera) | `packages/addon-terminal/src/terminal-instances.ts` |
| per-instance camera declaration and relay | `packages/addon-terminal/src/terminal-camera-*.ts` |
| the authoritative cell grid, and `styledLines()` | `packages/addon-terminal/src/xterm-screen.ts` |
| terminal rasterizer | `packages/addon-terminal/src/terminal-frame-renderer.ts`, `packages/addon-terminal/src/terminal-cell-runs.ts` |
| macOS curses repair for the managed Python | `packages/addon-terminal/src/curses-shim.ts` |
| the quiet-window gate before a cold render (`SNAPSHOT_SETTLE_QUIET_MS`) | `packages/addon-terminal/src/terminal-camera-relay.ts` |
| every analyzer switched OFF at camera creation | `packages/addon-terminal/src/silence-analysis.ts` |
| per-instance profile settings (Glances panels → argv) | `packages/addon-terminal/src/profile-settings.ts` |

**BUILT since 2026-08-11, and each item is a defect this design's own reasoning
predicted:**

- **The stream renders colour.** `styledLines()` reads per-cell
  fg/bg/inverse/invisible/dim and draws merged runs with background rects. The
  camera was monochrome until 2026-08-12 because `ScreenBuffer.lines()` returns
  escapes already interpreted.
- **Column alignment is preserved.** SVG `<text>` collapses runs of whitespace,
  and a terminal's column alignment *is* runs of whitespace — a line drew at
  roughly half its true width. Fixed by anchoring each run at its real glyph
  advance, because librsvg ignores `textLength`. This is exactly the class of
  hazard the §"rasteriser" blit argument names, arriving on the SVG path that
  shipped instead.
- **A cold snapshot is no longer a black frame.** A fresh session rendered at
  the first output event, which is the clear-screen; the relay now drains until
  300 ms of quiet.
- **Every analyzer is switched off at Terminal-camera creation** — and only at
  creation, so an operator who turns one back on wins. It had been running 19
  frames per 10 s at ~61 ms of inference each against `detections=0`, forever,
  on a rendered screen. `silence-analysis.ts` no longer keeps its own list:
  since 2026-09-18 `TERMINAL_SILENCED_CAP_NAMES` is an alias for
  `DERIVED_CAMERA_SILENCED_CAP_NAMES` in `@camstack/types`, which is
  `motion-detection`, `detection-pipeline`, `audio-analysis`,
  `pipeline-analytics` and `scene-monitor`. There were TWO lists — the
  Terminal's and the camera grid's — and both had drifted to the same three
  names, neither of them `pipeline-analytics`, which has no gate of its own
  except this binding (D529). Motion still sits first and still matters most now
  that the detection gate (D109) stops the detection producer, because it is the
  last thing asking for decoded frames. It writes the authority directly —
  `setWrapperActive` on the wrapper binding resolved from `getBindings`, never a
  guessed addon id ([D113](../decisions/adr-0113.md)) — after the
  `pipelineOrchestrator.setCameraSwitch` route it originally used (D62) became a
  deprecated compatibility shim on 2026-08-12. A resolution that fails THROWS;
  the previous warn-and-continue is how the full-detection tax gets silently
  re-created.
- **An idle Terminal camera costs nothing.** `pull-http` joined the lazy-dial
  set and is excluded from `isDefaultWarm`; a warm default is permanent
  synthetic demand, and it had pinned a libx264 transcode of the MJPEG relay at
  12 % of a core for ten hours.
- **The managed Python's curses is repaired by shadowing, not by patching the
  distribution** ([D112](../decisions/adr-0112.md)) — python-build-standalone's
  static ncurses on macOS has terminfo compiled out, so Glances ran colourless.
- **A camera is an operator-created instance, not an enabled profile.** Since
  2026-08-11 the operator creates named Terminal instances
  (`createInstance` / `updateInstance` / `deleteInstance` /
  `setInstanceEnabled`), each carrying its own node, profile, executable, argv,
  cwd, environment and `profileSettings`, and each declaring exactly one camera
  (`buildTerminalInstanceCameraDeclarations`). The v1 one-monitor-per-node
  camera keeps its stable id forever and is adopted, never replaced
  (`listLegacyCameras` / `adoptLegacyMonitor`).
- **Glances panels are a per-instance form, not an argv the operator types.**
  `profile-settings.ts` exports a FormBuilder schema and materialises
  `--disable-plugin` only for the panels that were turned off
  (`spawnArgsForInstance`). The default argv stays EMPTY, with the measurements
  next to the constant in `addon.ts`: the whole tuning range is worth ~0.4 % of
  one core, and `-t` is counter-productive because the camera renders at 2 fps
  while Glances already repaints every 2 s.
- **The addon's 13 per-node settings are hosted on the Terminal page**
  (`NodeAddonsSettingsPanel`, addonId `terminal`, at the node the page's own
  NodePicker selected), grouped one section per profile. The grouping is a VIEW
  only — persisted keys stay flat, because the store is physically
  `<key>@<nodeId>` and a rename would silently drop every node's value.
- **A missing import crash-looped the runner for a day, 2026-08-22 → 08-23.**
  `feat(terminal): per-instance Glances panel settings` (3a530757f) replaced the
  `createXtermScreen` import instead of adding beside it; vite/esbuild emit that
  ReferenceError happily because they do not typecheck. Init failed, the
  provider never registered, and the Admin UI 412'd on
  `terminalSession.listProfiles`. Fixed by 142304aa0, which also added the
  tripwire `packages/addon-terminal/src/__tests__/addon-xterm-import.spec.ts` —
  this package's ship path is vite, so `npm test` is the check that actually
  runs. The three-node live verification below predates this window and has not
  been redone.

**Still NOT done:** the end-to-end remote-node verification named at the bottom
of this page, and the pure-JS blitter, which remains an optimisation nobody has
needed.

The hub declares one camera per enabled Terminal INSTANCE — an operator-created
row pinning a node and a profile — not one per enabled profile per node. Each
camera exposes exactly that profile as its only stream. PTYs remain on their selected
nodes; the hub pulls ordered terminal output over the capability plane, renders
the screen, and exposes a loopback MJPEG source which the broker converts to
H.264.

BTM, Top and Glances are explicit built-in profiles with separate enable,
executable and argument settings. Glances is installed idempotently into
CamStack's embedded Python from the addon's manifest requirements and runs as
`python -m glances`; it never modifies system Python. Custom profiles retain
the same fixed executable/arguments/cwd/environment schema.

## Why (2) is not a gimmick

It inherits, at no extra cost, everything the camera plane already does:
recording, timeline scrubbing, snapshots, retention, the WebRTC viewer, remote
access, and detection. That is the entire argument for it, and it is a good one.

But (1) and (2) want different things — **(1) wants text, (2) wants pixels.**
Serving (1) from the pixels would give a blurry, unselectable terminal. So: one
session, one terminal state, **two independent renderers**.

```
pty ──► @xterm/headless  (authoritative cell grid)
          ├──► cursor batches ─────► xterm.js in the browser    text, crisp, selectable
          └──► cursor batches → hub raster → MJPEG → H.264      pixels, "a camera"
```

## The two constraints that decide the design

Both were found by reading the code, and both contradicted the obvious plan.

### C1 — an addon cannot push frames into the broker

`StreamBroker.pushEncodedPacket` (`packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts:2037`)
is a **live-object method**. `AdaptiveSession.writeVideoNals`
(`packages/addon-pipeline/src/stream-broker/webrtc/session.ts:3607`) is `private`.
And `stream-broker.cap.ts` contains **no ingest method at all** — verified, zero
occurrences. Every push producer in the repo is in-process with the broker: the
derived-stream feeder, the placeholder pump, `FfmpegPushReader`, the RTMP reader.

There is exactly one working out-of-process pattern, and Reolink already uses it:
**the addon hosts a loopback server and publishes a PULL source pointing at
itself** (`packages/addon-provider-reolink/src/synthetic-sdp.ts:42`). The broker
dials the addon like any camera.

### C2 — an addon cannot register a WebSocket

`/trpc` is the only upgraded path (`server/backend/src/main.ts:1427`), and the
addon reverse-proxy is `http.request` + `res.pipe` with **no `upgrade` handling**
(`packages/system/src/http/reverse-proxy.ts:40`) — verified, zero occurrences of
`upgrade` in that file. An addon also cannot host a tRPC subscription: the two
that exist are both `mount: 'server-provided'`, and the capability transport has
no subscription support.

What an addon *does* get is `ctx.dataPlane.serve()`
(`packages/types/src/interfaces/addon-data-plane.ts:38`): a **real Node
`req`/`res`** in the addon's own process, reverse-proxied by the hub, with
chunked/SSE streaming working natively. Precedent:
`packages/addon-pipeline/src/stream-broker/addon.ts:1008` mounts a `clientlog`
prefix exactly this way. This is what (1) was built on, and it held.

## Consequences

The two halves invert in cost from the naive reading.

**(1) is cheap.** pty + `@xterm/headless` + a data-plane SSE/POST pair +
xterm.js. No device, no encoder, no rasteriser, no new transport.

**(2) remains the expensive half**, but the built path avoids a second RTSP
implementation: a loopback MJPEG relay feeds the broker's existing ffmpeg
reader, which normalizes to low-latency H.264.

**So build (1) first and ship it.** It is independently useful, and (2) cannot
invalidate it. That is what happened: (1) shipped as `packages/addon-terminal`
and the cap's docblock states outright that phase 2 is a separate
`device-provider` concern which does not change the contract.

## Design

### The capability — SHIPPED

`packages/types/src/capabilities/terminal-session.cap.ts`, as built:

```
terminal-session          scope: system, mode: singleton, every method auth: 'admin'
  listProfiles       → TerminalProfileInfo[]
  listSessions       → TerminalSessionInfo[]
  openSession        { profileId, cols, rows, instanceId? } → TerminalSessionInfo
  resize             { sessionId, cols, rows }
  pullOutput         { sessionId, afterSeq } → ordered batch or reset snapshot
  writeInput         { sessionId, data }
  close              { sessionId }
  listInstances      → TerminalInstanceInfo[]
  createInstance     { nodeId, profileId, name?, executable?, args?, cwd?,
                       environment?, profileSettings? } → TerminalInstanceInfo
  updateInstance     { instanceId, … the same spawn fields } → TerminalInstanceInfo
  deleteInstance     { instanceId }
  setInstanceEnabled { instanceId, enabled }
  listLegacyCameras  → TerminalLegacyCamera[]
  adoptLegacyMonitor { stableId, name? }
```

Two divergences from the sketch above, both deliberate: `listProfiles` was added
because the client cannot be allowed to guess the allowlist, and `openSession`
returns the whole `TerminalSessionInfo` rather than a bare id so the caller needs
no follow-up `listSessions`. The instance half of the surface arrived later, when
"which cameras exist" became an operator decision rather than a function of which
profiles a node happens to enable; the spawn fields live on the instance, so
`openSession` resolves executable/argv/cwd/env from it and the request still
carries no free-form command.

Output and input now go through the capability so node routing is explicit.

**`profileId`, not a command string.** The capability accepts only pre-declared
profiles (`monitor` → `btm`, and whatever else is declared). A free-form command
would be remote code execution as the server's user, in a camera server. The
stated need is a monitoring view, which allowlisting satisfies completely. A shell
can be a separate, explicitly-labelled opt-in later; that direction is far easier
than walking it back.

That is exactly how it shipped: `packages/addon-terminal/src/profiles.ts` builds
the list, `monitor` is always in it, and `shell` (`/bin/bash -l`, labelled "Grants
command execution as the server user") is appended only when the addon's
`allowShell` config is on — OFF by default.

The addon is **not** a builtin and does not follow `loki-logging`'s
inert-until-configured shape: it is its own npm package with a native dependency,
so it is absent until somebody installs it (`camstack deploy`).
`execution.placement` is now `any-node`.

### Transport — SHIPPED, cluster revision built

| Direction | Mechanism |
| --- | --- |
| bytes out | `terminalSession.pullOutput({sessionId, afterSeq})`, node-pinned |
| keystrokes in | `terminalSession.writeInput({sessionId, data})`, node-pinned |

Historically, the `io` segment was the addon's data-plane `prefix`; the rest of the path reaches
the handler verbatim (`packages/addon-terminal/src/terminal-data-plane.ts`). Both
are admin-Bearer gated at the hub, and because native `EventSource` cannot carry
an `Authorization` header the browser consumes the stream with `fetch` +
`ReadableStream` and parses SSE frames by hand
(`packages/addon-admin-ui/src/lib/terminal-io.ts`). Each `data:` line is a
JSON-encoded event, so embedded newlines can never break framing.

The SSE/POST route remains a compatibility path. The Admin page now uses the
node-pinned capability methods above. Each output chunk receives a monotonic
sequence; a caller outside the bounded replay window receives `reset: true`
plus the authoritative serialized screen and resumes from the returned cursor.

This matters for a reason beyond convenience: **terminal output must never go over
the event bus.** [D8](../decisions/adr-0008.md) says events are telemetry and may
be dropped, and a dropped chunk desynchronises the vt parser — corrupting the
screen permanently until a full repaint. Cursor replay plus reset snapshots make
loss detectable and repairable. `@xterm/headless` remains authoritative.

A bidirectional WebRTC data channel already exists (`camstack-control`,
`session.ts:3572` neighbourhood — `onControlMessage` / `sendControl` are public)
and would have lower latency. It is private to the broker addon and hard-wired to
recorded-playback control, so using it means changing the broker. Not worth it for
typing.

### The pty — SHIPPED

`node-pty`, and it shipped that way: an `optionalDependency` behind a lazy import
and a small `PtyProcess` interface (`packages/addon-terminal/src/pty.ts`), so the
session manager's tests spawn no real process and the native module loads only
when a session actually opens.

The npm macOS prebuild can install `spawn-helper` without execute bits. That
causes every program, including `/bin/bash` and `/usr/bin/top`, to fail with
`posix_spawnp failed`. Addon initialization checks the active prebuild/source
layout and restores execute bits before loading node-pty. This was reproduced
locally and verified through a remote macmini session.

The alternative — wrapping `script(1)` — was tested and works:

```
plain spawn      → NOT-A-TTY
script -qec …    → TTY
stty rows/cols   → settable at start ✓   (COLUMNS/LINES env does NOT work → "0 0")
resize at runtime → no channel exists ✗
```

No live resize means resizing the browser pane cannot reflow the program without
restarting the session, and `script` does not exist on Windows. Not worth it.

On the native dependency: `node-pty` inside this addon is the same shape as
`node-av` inside the decoder addon — five addon packages already declare native
deps of their own. It is **not** a host-external, so it does not undo
[D18](../decisions/adr-0018.md).

Do **not** use `IManagedSubProcess` (`packages/types/src/interfaces/addon.ts:94`).
It has exactly the right shape — `write(data)`, `stdout: AsyncIterable<Buffer>` —
but the only implementation is a stub
(`packages/system/src/kernel/moleculer/process-context.ts:4`), its `spawn` spawns
an *addon runner* rather than a command, and it is not exposed on `AddonContext`.
Use `child_process.spawn`, as 20+ addons already do.

The existing REPL is not a starting point either: stateless one-shot JS in a `vm`,
5 s timeout, not a capability, and its UI is a hand-rolled line buffer with no ANSI.

### The program to run: `bottom` (`btm`)

Rust, v0.12.3 (Jan 2026), single static binary, no runtime deps, runs on 128 MB
RAM, TOML config so the layout can be pinned, and Linux/macOS/Windows — which
matters because a desktop app ships. `btop` is prettier but C++ and 1–2% CPU
against htop's <1%, and "prettier" is worth nothing when we own the rasteriser.
`glances` is Python: a runtime and a dependency tree in the image.

CPU matters more than usual here — raster and encode are already being paid per
session.

### The rasteriser

Measured, 120×40 grid → 960×640:

| Approach | ms/frame | Ceiling |
| --- | --- | --- |
| `sharp` + SVG | 97 | ~10 fps |
| pure-JS glyph blit | **1.54** | ~650 fps |

**63× apart, so blit.** The SVG route also requires XML-escaping arbitrary program
output — it crashed on a `&` while the benchmark was being written, and terminal
output is full of `&`, `<`, `>`. The blitter has no injection surface at all.

Modern TUIs draw graphs in **braille**, which no basic bitmap font carries. That
looked like it would force the slow path. It does not: braille needs **no font** —
the code point's low 8 bits *are* the dot pattern in a 2×4 grid. All 256 cells
generate algorithmically:

```
⣿ U+28FF     ⡇ U+2847     ⠁ U+2801
.#.#         .#..         ....
.#.#         .#..         .#..
.#.#         .#..         ....
.#.#         .#..         ....
```

The implemented camera runs at only 2 fps and renders only when the terminal
cursor changes, so it deliberately takes the simpler path: xterm interprets
ANSI into visible rows, then `sharp` rasterizes escaped text into a cached JPEG.
The pure blitter remains the optimization if profiling shows this path matters.

### Becoming a camera — DEPLOYED

The hub uses `DeclaredDevices` to own one fixed `DeviceType.Camera` per enabled
Terminal instance. The instance id is the stable id
(`terminal-camera-instance-<uuid>`); the operator may rename the device without
it being re-stamped, and the v1 per-node monitor id (`terminal-camera-<node>`)
is deliberately permanent, so a migration ENRICHES its config rather than minting
a replacement. Reconciliation mirrors topology liveness onto the camera's
ordinary `device-status` slice.

Each camera registers a native `stream-catalog` with exactly ONE entry: its own
instance's profile. Demand for it opens a dedicated fixed-size PTY on that
instance's node, with the instance's own executable/argv/cwd/env; the hub
consumes it with the same cursor/reset protocol as the browser.

The hub-side relay serves the rendered frames on a loopback-only MJPEG server:

```ts
{ camStreamId: profileId, kind: 'pull-http',
  url: 'http://127.0.0.1:<port>/stream/<instance>/<node>/<profile>.mjpeg',
  resolution: { width: 960, height: 640 }, fps: 2 }
```

`pull-http` is normalized by the broker's ffmpeg source reader to libx264,
ultrafast/zerolatency, yuv420p, with a four-frame GOP. This fixes the previous
dead `http-mjpeg` source discriminator, which selected the external-push
fallback and never consumed a byte. No agent listener is exposed: remote
terminal bytes cross the capability plane and only the hub loopback is dialed.
The dedicated PTY retires thirty seconds after the last stream client leaves.

## Recording: do not use video

For *recording*, video is the wrong format for text. One hour of a monitor at 2 fps:

| | Size |
| --- | --- |
| asciicast-style event log (zstd) | **3.7 MB** |
| H.264 @ 800 kbps | 360 MB |

~100×. The built path currently records through the normal camera plane so the
Viewer/timeline behavior is immediately consistent. A future storage
optimization should additionally record as
[asciicast v3](https://docs.asciinema.org/manual/asciicast/v3/) — delta timings,
captured theme, native zstd — to get seekable, greppable, tiny history without
removing the live camera projection.

## Resolved decisions and remaining verification

- **Identity:** one camera per operator-created instance, with one stream
  carrying that instance's profile. Two instances on the same node are two
  independent cameras, even on the same profile. Session ids remain runtime
  details and never become device identity.
- **Placement:** the Terminal provider is `any-node`; camera declarations and
  raster relay are hub-owned.
- **Remote media:** agents expose no HTTP listener. The hub pulls terminal text
  through the node-routable capability and owns the loopback media endpoint.
- **Cadence:** 2 fps while demanded, render-on-change with cached JPEG keepalive.
- **Security:** clients open only administrator-configured profile ids. File,
  argv, cwd and environment are validated settings, never request fields.

Deployment verification still has to prove one remote node end-to-end:
declaration, catalog, ffmpeg ingestion, WebRTC playback, snapshot, reconnect and
idle retirement.

## Alternative worth weighing first

Decided: both terminal and camera projection were requested and are now built.
The lower-cost alternative remains relevant for future dashboards, not as a
replacement for this feature.

`metrics-native` and `platform-probe` already collect this data. A native Admin UI
dashboard would need no pty, no binary, no rasteriser and no device — a fraction of
the work. It would not be a terminal and could not stream as a camera, so it does
not meet the requirements as stated. But if the real goal is "see system load
nicely", it is the cheaper answer and should be rejected deliberately rather than
by omission.
