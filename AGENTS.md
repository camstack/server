# AGENTS.md — camstack-server

CamStack is a kernel plus addons. The kernel owns processes, transport and
registries; every feature is an addon. Node.js 24+, TypeScript 5.7+, Fastify 5,
tRPC v11, Zod 4, npm workspaces + nx.

This is the cross-agent instruction file. `CLAUDE.md` beside it is a one-line
`@AGENTS.md` import for Claude Code, and so is each package's; edit only the
`AGENTS.md`.

**Facts live in generated docs, not here.** This file holds rules and pointers.
Anything derivable from the workspace is generated on commit — do not restate it
here, it will rot:

| Question | Read |
| --- | --- |
| What packages exist, and how does each reach a node? | `docs/reference/packages.md` |
| What addons exist, in which process group? | `docs/reference/addons.md` |
| What capabilities exist, who declares them? | `docs/reference/capabilities.md` |
| What does this system CONSIST of, and what is undocumented? | `docs/reference/subsystems.md` (start here when you do not know where something lives) |
| Which tRPC method, with what input/output? | `docs/reference/api.md` |
| What will the repo refuse to let me commit? | `docs/reference/guards.md` |
| Which SQLite tables exist, and who owns each? | `docs/reference/storage.md` |
| Why is it like this? | `docs/decisions/index.md` |
| Everything else | `docs/README.md` |

## Before you start

Read the page for what you are touching:

| Area | Page |
| --- | --- |
| Orientation | `docs/architecture/overview.md` |
| `kernel/transport`, `kernel/moleculer`, agent, cross-node calls | `docs/architecture/transport.md` **and** `docs/design/transport-and-cross-node-routing.md` (required) |
| Adding or changing a capability | `docs/architecture/capabilities.md` |
| Addon boot, forking, crashes | `docs/architecture/addon-lifecycle.md` |
| `stream-broker/**`, decoders, frames | `docs/architecture/data-planes.md` **and** `docs/design/decode-path.md` (required) |
| The ffmpeg binary: which build, the override, changing the version | `docs/architecture/ffmpeg.md` |
| Windows agent: Node, Python, ffmpeg, the service | `docs/architecture/windows-agent.md` |
| Device providers, runtime state | `docs/architecture/device-model.md` |
| A camera whose stream is BUILT on demand (battery, cloud relay): the lazy source | `docs/architecture/device-model.md` § "A camera whose stream is BUILT on demand" |
| Notification rules, outbox, attachments, notifiers | `docs/architecture/notifications.md` |
| Detection thresholds, gating, why a detection feature seems off | `docs/architecture/object-detection.md` |
| Frame → detection: engines, per-node devices, how a step reaches one | `docs/architecture/detection-execution.md` |
| What happens AFTER the pipeline emits a frame; every tuning knob | `docs/architecture/post-analysis.md` |
| Publishing, deploying, "why isn't my change running" | `docs/architecture/update-and-release.md` |
| Admin UI architecture (mounting, data flow, where a schema lands) | `docs/architecture/ui.md` |
| A password / token / key field, `secretStatePaths`, the keychain | `docs/architecture/secrets-keychain.md` |
| Cloud training, the trainer, a training provider | `docs/architecture/cloud-training.md` |
| System backups, restore, backup encryption | `docs/architecture/backups.md` |
| SQLite files, serving threads, `database` on `declareCollection` | `docs/architecture/storage-files.md` |
| Device history, a cap `history` block, rollups, retention | `docs/architecture/device-history.md` |
| What was already tried | sibling clone `../planning` (`sessions/<YYYY-MM>.md`) |

## Commands

```bash
npm run dev:full                                  # watch all + server + admin-ui
npm run serve -w server/backend                   # server only (tsx watch)
npm run build                                     # build all
npm run codegen                                   # regenerate cap routers + types + DeviceProxy
npm run typecheck                                 # packages and specs, against the pinned spec debt (D695)
npm run typecheck:raw                             # raw nx sweep (red while pinned spec debt exists)
npm run test                                      # all packages
npm run lint && npm run format:check
npm run docs:check                                # docs generated + no dead paths
```

## ⚠️ Your edit is probably not running

Editing `packages/<addon>/src/…` and rebuilding `dist/` has **no runtime effect**.
The running node loads addons from `<dataDir>/addons/@camstack/<addon>/dist/`
until you deploy.

```bash
camstack deploy packages/addon-pipeline-orchestrator   # or: camstack deploy pipeline-orchestrator
camstack deploy <pkg> -n <nodeId>                      # to an agent (hub is default)
```

Framework packages (`types`, `system`, `sdk`, `ui-library`) travel inside the
`@camstack/server` closure, so a fix there is live only after that closure is
installed. Procedure: `docs/architecture/update-and-release.md`.

## Rules

Each links to the record that explains what it prevents. If a rule seems wrong,
change the record — do not quietly work around it.

**Architecture**

- One addon = one process. Co-location only via a shared `execution.group`, and
  the runner id comes only from `resolveRunnerId`. (D2)
- Grouping addons **purely to reclaim runner RAM** is confined to non-live,
  frame-free, low-crash addons (the `ml` group). Never group device providers or
  data-plane runners — a co-located crash respawns the whole runner. (D29)
- Capability registration is one atomic `registerNode` RPC. No timers, no retry
  backoffs, no registry scans to "wait for" a node. No shadow registries. (D3)
- Behavioural cap metadata (`kind`, `defaultActive`, `mode`) lives **only** in the
  `*.cap.ts`. A manifest declares a capability by name. (D4)
- Lifecycle = respawn a runner. No in-process hot-reload. (D5)
- `CrashSupervisor` bounds respawns and marks a runner terminally `failed`. Never
  an infinite loop. (D6)
- Emit only through `ctx.eventBus`, with the `EventCategory` enum. Events are
  **telemetry and may be dropped** — if loss would corrupt durable state, use RPC
  (or an event plus an RPC reconcile). (D8, D11)
- **A one-shot event never gates on a fallible read.** The gate is in-memory state refreshed off the event path; a failed read changes nothing, and a read that would DESTROY work must be confirmed by a second read. (D49)
- **An addon reaching another addon's BYTES uses `ctx.peerBytes`.** No base64 byte field on a cap method, and no private `http.createServer` plus token map. The producer offers one body and returns a one-shot ticket from a cap method it already gates; a consumer cannot address a producer. A ticket is same-host and is refused `cross-node` by name. (D613)
- **Frames never cross a process boundary at frame-rate.** In-process via the
  `detection` group, or compressed. Cross-process media is fetched on demand,
  compressed, by handle. This OOM'd hub-main. (D9, D18)
- **Media a later pass depends on is retried until it LANDS, under a bound.** Gate on "did it persist", never on a peak signal most subjects raise once, and never dispatch a by-handle fetch at a node the registry already called offline. (D60)
- **A consumer is served the history it ASKED for, and an unstated ask is zero.** The broker decides how much history exists (D381); the dial names how much it wants on `/preroll-<ms>`, and that amount is required everywhere it travels. Every attach reports what it got and what it cost (`restream attach live-edge`). (D382)
- **One vector index = one crop derivation.** `deriveDetailCropRect` is the only
  place a detail/CLIP crop rectangle is computed, and only the RUNNER calls it: a
  caller with stored pixels sends a full frame (`runDetailSubtree({ frameJpeg })`)
  — `cropJpeg` means "already cut, used verbatim, no padding". The convention is
  one cluster-wide orchestrator setting, never per-node. (D52)
- **Bulk work over STORED media never requires a live session.** It runs through
  `pipelineRunner.runStatelessStep`, node-pinned, under ONE `modelId` pinned for
  the whole pass — a node that cannot serve that exact model REFUSES rather than
  substituting a format default. And the cheap question comes first: never load
  media before knowing the work can run. (D56)
- **A storage location has ONE typed state, interpreted in ONE place.** `StorageLocation.mode` is `active | readonly | drain | disabled`, and only `storage-location-mode.ts` may read it — nothing else touches `config['readOnly']` or compares `enabled`. A `drain` shrinks at the pace the active locations of its class grew, from a persisted cap, with no operator rate knob. How much a location holds (`storage-occupancy`; absence means unknown, never zero) is separate from what may be evicted, and two locations of one type never share a physical root. (D385, D386, D388, D389)
- **A per-camera function switch stores NOTHING.** It reads and writes the authority that already owned the function (`setDisabled`, `setWrapperActive`, `RecordingConfig.enabled`, the notification mute) and names it in `CameraSwitch.authority`. An off switch is reported off (`CameraStatus.switchedOff`): disabled must never look like broken. (D62)
- **A camera links only what the operator picked.** Same-location devices are suggested by the picker, never linked on their own; a container is never a pick, its children are, named after it. (D356)
- **A UI claims something is ABSENT only from a query that ANSWERED with nothing.** Not-yet-known must never look like not-installed (`data ?? []` hides an unanswered query). Ask through `useCapabilityPresence` (`pending | present | absent | unknown`) and `capabilities.getCapability`, never `nodes.topology`. (D315)
- **A measurement that FAILED is `null`, never `0`**, and the type says so through to the decision. A structural twin of the result that drops the `error` field is the same bug (`PlacementCapacity` vs `LocationCapacity`). (D393)
- **Occupancy of a storage class that shares a disk is the class subtree**,
  never any non-dot entry at the shared root. `eventMedia` → `events/`,
  `recordingsLow` → `low/`, `recordings` → `high|mid`. A drained location
  looked full because high footage was writing next to it. (D327)
- **The live SQLite file is the `sqlite-settings` bind**, identified by `docker inspect`, never a sibling `camstack.db`. Never sqlite3 while CamStack runs. Never `@camstack/system` under `/data/addons`. (D328, D147)
- **A live SQLite file is reached only through its owner's connection.** No `fs` open/read/close of a `.db`/`-wal`/`-shm` in the owning process (closing any descriptor drops SQLite's locks), and no second connection from another process, not even a PASSIVE checkpoint. A live database is never backed up as files: the owner writes a verified snapshot (`database-snapshot`) and the archive carries that. (D679, D693, guard `check-sqlite-files-not-opened-by-fs`)
- **A device fact is kept fresh in the addon that owns the device — a consumer never keeps a second copy.** The freshness window belongs to the reader (`OPERATOR_WRITTEN_STALE_MS`, `serve-and-revalidate` on a polled cap). Every read the cap exposes gets the same discipline, and a read never joins a refresh already in flight: it answers from the slice, empty included. (D224, supersedes D221)
- **The motion area bar judges a merged SUBJECT, relative to the motion view.** Components are merged first; the group's rectangle is the union of the original boxes; the bar is a fraction of the view. A group over `maxCoverageFraction` is weather, and its components are re-judged individually. Per camera, opt-in: a positive `minArea` keeps the legacy per-component rule, `0` moves that camera. One `WasmMotionDetector` serves every camera on a node and is resized per frame (`ensureSize`). (D394)
- **The best shot is ranked on what is DELIVERED, and a term that cannot be ordered against the others is a FACTOR, not a tier.** `compareBestFrame` is the one ordering (square, semantic, edge, effective score, canvas-fill, centeredness). Canvas-fill is bounded so it cannot outrank a larger subject. A clipping penalty scales by the subject's surviving aspect, never by its span across the frame. (D400)
- **A branch that fails to produce media names the reason, per kind, on the record.** One capture failure is one cause (no keyFrame implies no keyFrameSmall and no lastFrame `copy`). A promotion attempt that fired is logged next to one that did not. (D400)
- **An aggregate the system asks of `hub/sqlite-settings` on a schedule is served from an index that carries every column it reads**, proved by `EXPLAIN` on the statement the store prepares (spy `prepare`, not hand-spelled SQL). **A raw HTTP stream reads no chunk the socket has not taken:** honour `write()`'s return, await `drain`, cut the peer that never drains, and log every exit. (D447)
- **The hub's address is the `local-network` palette, never an env var.** Read it per role through `local-network.getAddresses().roles` (`appConnections`, `notificationTaps`, `publicEndpoint`, `internal` — the address flagged on the Network page, else automatic; meanings in `packages/types/src/capabilities/hub-address.ts`). Never rank the palette yourself and never hand anyone `127.0.0.1`. (D729, D732, D734, guard `check-no-hub-address-env`)
- **A seed never overwrites.** The first-boot admin (`admin` / `changeme`,
  no longer configurable) is seeded only when no admin exists; the old
  `CAMSTACK_ADMIN_PASS` reset a UI-changed password on every boot. (D728, D797)
- **No secret through a node's environment** — not the session signing key,
  not a token. The hub's own secrets live in the keychain (owner `system`); an
  agent's `agent.json` (0600) holds its private mesh key, never a shared secret.
  A new secret is a `password` field. (D783, D797)
- **A node's identity is its mesh certificate — there is no cluster secret.** Admit a mesh peer through `TlsTcpTransporter.verifiedPeer` (chain to the mesh CA, CN = node id, not revoked), never through a string a human copied. An agent is paired from the hub: the operator types the six digits shown on the other screen on both sides, and the agent installs a certificate only after its own operator confirmed. (D857)
- **Per-device config lives only in `ctx.settings.*DeviceStore`; per-device DATA
  implements `device-removal-hook`,** driven by a tombstone — never by absence
  from a list or `DeviceUnregistered`. (D865, `check-device-settings-standard`)
- Per-device aggregation walks `getBindings(deviceId)` only — never the global cap
  list. Cap names are shared across vendors. (D12)
- Resolve a `(cap, device)` pair via `getProviderForDevice`. Never branch on
  `DeviceBindingEntry.kind`. (D13)
- A `deviceConfig` cap's UI is **derived**. No hand-written
  `getDeviceSettingsContribution` / `getDeviceLiveContribution` /
  `applyDeviceSettingsPatch`. (D14)
- Addons never import each other. `ctx.api` is the only cross-addon layer, even
  for existence checks — `ctx.capabilities` sees only the local process.
- `addonRegistry.getAddon()` never appears in a router. Use `CapabilityRegistry`.
- Codegen is authoritative. Touching a `*.cap.ts` without `npm run codegen` is
  silent drift.
- A document claims code with **`covers:`** and vouches for it with **`applies-to:`** — never one key for both. `covers` feeds the coverage index and arms no staleness; `applies-to` means "I checked this on `last-verified`". (D145)
- Cap mounts never compose addon output with backend state.
- **Identity is decided late (D683).** L1 never merges, resurrects or deletes a track on the fly — in doubt it splits. L2 fuses pieces 10–20 s later into one track, final, under the earliest id. A moving subject is a track; a still subject is the parked-object registry (promotion ends the track). A new tracker heuristic lands only with a reconstructed scene or a D681 case that moves. `scripts/check-no-legacy-tracker.ts` keeps the old mechanisms out.

**Logging**

- **Every log line about a device carries `tags: { deviceId }`.** Always that key, always the numeric id — never only in the message, never a `cameraName` in its place. A line without the tag cannot be grouped per camera. (Cost: a thumbnail gap and a media blackout were diagnosed by hand.)
- A branch that DROPS work silently (no media, no evaluation, no dispatch) logs it. Silence reads as "never happened". **A branch that ACCEPTS work and produces nothing is the same branch** — a refusal vocabulary that names only the gates saying "no" cannot see the ones that say "yes" and then throw the result away. (D391)

**Types**

- No casts. No `as any`, `as unknown as X`, `as never`. Exceptions: `as const`, and
  a documented type boundary.
- Generics, discriminated unions and type guards instead.
- `z.infer<>` for Zod schemas — never duplicate a shape.
- Named types only; no inline types on signatures or return types.

**Never introduce**

`console.log` (use the injected `IScopedLogger`) · a base64 byte field on a cap
method (use `ctx.peerBytes`) · `process.send` for business
logic (UDS channels) · a new Moleculer action for business logic · nested
sub-objects on a cap provider · a parallel `private cachedX` field when the cap has
`runtimeState` · `setAll({ ...snapshot, ...patch })` (`setAll` already merges) · a
second generic runner or a grouping policy outside `resolveRunnerId` · a
hand-rolled `camstack.evt.*` topic.

## Working style

<!-- camstack-workflow-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
- **Any change → load `camstack-workflow` first**: phases, gates, definition of done. The skills below give the details.
<!-- camstack-workflow-pointer:end -->
- **Pure implementation runs on a smaller model**, through the project agents
  in `.claude/agents/` (`camstack-implementer`, `camstack-ui-engineer`,
  `camstack-test-fixer`, `camstack-docs-writer` …) — never `general-purpose`,
  which starts without these rules. Routing: `camstack-workflow`, "Who does
  the work".
- **A change to a published package adds a changelog line** with `npm run changelog:add -- <package> "<what changed for the operator, one line, English>"`; a publish without it is refused (`check-changelog-unreleased`).
- All documentation, comments and commit messages are written in English.
  `scripts/check-docs-english.ts` enforces it for `docs/**`. Working notes
  (superpowers, archive) live in the sibling planning repo.
- **Trace the real code path before proposing a fix.** One hypothesis at a time,
  and diff your changes before claiming what they do.
- **A green suite is not proof.** When you fix a gate, remove the fix and confirm
  the test fails — a fake can supply the value production forgot to fetch.
- **A leftover that describes the right design is worse than nothing** — it reads
  as verification. Delete orphaned comments, vestigial test wiring and pre-seeding fakes.
- **Prefer a guard to a paragraph.** A rule nothing checks has already been broken somewhere. New guards go in `scripts/` and get wired into `.github/workflows/checks.yml` — the on-demand workflow; automatic CI only builds and tests (D704). **Never dispatch Checks yourself** — only the operator does. Run the guards you touched locally (`npx tsx scripts/check-<name>.ts`).
- **A change to the container contract is mirrored by hand, in the same piece
  of work** — an env var the code reads, a port it binds, a volume, a device.
  Unraid templates, the Proxmox script and the Compose example live outside this
  repo, and nothing checks them. (D717, D822)
- When you learn something a future session would need, append it to
  `../planning/sessions/<YYYY-MM>.md` (private diary, sibling of the main
  checkout — not of a git worktree; index `../planning/sessions/sessions.md`).
  The backlog is private. When you decide something, add a record in
  `docs/decisions/` — copy `docs/decisions/template.md`.
- **Name mechanisms, not other products**, in code, comments and commits.

**Git and parallel agents**

- Work on `main`, no PRs: rebase on `origin/main` right before pushing (other
  agents push concurrently). Conventional commits (`feat:`, `fix:`, `docs:`…).
- **`npm run verify:push` is GREEN before every push** — it runs the CI
  gates themselves (TS7 typecheck against the pins, affected tests); a local
  `tsc` is not them. Main red when you start → fix it first. Then watch your
  CI run; red on your sha is yours (`camstack-workflow` §7).
- **Viewer (`camstack/`):** before every commit and push in that submodule,
  `npm run verify:push` GREEN there (TypeScript Check gates + `ui:check` on
  changed UI files) — `camstack-ui-viewer`.
- **Never `git add -A` / `git add .`** — the untracked tree is huge and
  lint-staged then fails and reverts your working tree. Name every path.
- **Parallel agents get their own worktree.** One clone has one git index, so one
  committer per clone. Push `main` before spawning worktree agents (they branch
  from `origin/main`); a fresh worktree has no `node_modules`.
- Before removing a worktree, check its commits landed
  (`git log <base>..<branch>`) — an agent's "committed" is not evidence.

## Skills — follow these, do not improvise

Wiring points are silent when missed: follow the skill, do not improvise.

<!-- camstack-skills-table:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
| Doing this | Skill |
| --- | --- |
| ANY change (feature, fix, refactor, UI, server) — load FIRST; the definition of done | `camstack-workflow` |
| Any UI — admin-ui, ui-library, an addon page or widget, the viewer — load FIRST | `camstack-ui` |
| … then, for admin-ui / ui-library / addon pages | `camstack-ui-admin` |
| … or, for the viewer app and its embed player | `camstack-ui-viewer` |
| A new or changed addon or manifest entry; `camstack deploy` | `camstack-addon` |
| A new or changed `*.cap.ts`; picking a provider | `camstack-capability` |
| A change to `server/backend`, `system`, `types` or `sdk`: test, build, ship | `camstack-server-change` |
| A password / token / key, or a credential for a child process | `camstack-secrets` |
| Something is wrong on a running node: logs, API, where work ran | `camstack-diagnose` |
| Track media complaints (no photo, wrong thumbnail, ended too soon) | `audit-debug-tracks` |
| Publishing to npm or cutting a release, through CI | `camstack-publish-ci` |
| Putting a server closure on a node: `applyServerUpdate`, images | `camstack-hub-image-deploy` |
| Finishing any work: what to document, ADRs, generated files | `camstack-docs` |
| Filling DETECTOR_PERF / detector-latency for a node×device | `camstack-benchmark-detection` |
<!-- camstack-skills-table:end -->

Skills are `.claude/skills/<name>/SKILL.md` (Codex: open the file). For UI:

<!-- camstack-ui-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
**UI work** (admin-ui, ui-library, an addon page or widget, the viewer): load the `camstack-ui` skill first — `.claude/skills/camstack-ui/SKILL.md` — then `camstack-ui-admin` or `camstack-ui-viewer`. Claude Code and Cursor list them as skills; any other agent reads them as files.

- Search before building: `npm run ui:find -- "<need>"`, `npm run ui:show -- <Name>`, `npm run ui:tokens`.
- Library components and theme tokens only: no hex, no palette classes (`bg-red-500`), no colour or spacing in `style=`.
- Rules: `docs/ui/README.md` (conventions, need → component, admin patterns, viewer, anti-patterns).
- Done = the skill’s done-gate: `npm run ui:check -- <files>` with 0 new findings, plus `npm run ui:shots` before/after (dark + light, desktop 1440×900 + phone 390×844).
- After `ui:shots`: **Read the PNG files** under `scratchpad/ui-shots/<label>/` (Cursor `Read` accepts images) so before/after appear in the transcript — do not stop at `report.md` alone. Any agent / harness, not only Claude Code.
- Viewer layout changes are co-designed with the operator: ask first.
<!-- camstack-ui-pointer:end -->

- **Never a bare landing page.** A server route that ends a flow (OAuth
  callback, account link, sign-in, magic link) redirects to the existing
  CamStack result page with a status and a reason — never a hand-written "you
  can close this window". No tokens or codes in that URL.

## Graph tools

Prefer the `code-review-graph` MCP over Grep/Glob for exploration
(`semantic_search_nodes`, `query_graph` callers/callees/imports/tests,
`get_impact_radius`, `detect_changes`); Grep only where it falls short.
