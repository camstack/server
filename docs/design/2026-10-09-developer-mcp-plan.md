# CamStack developer MCP and skill pack: audit and plan

## Summary

1. **There is one CamStack MCP server: `@camstack/mcp-develop`.** It lives in `packages/mcp-develop/src/server.ts` and is a single 205-line file. It runs over stdio only, has no auth, and exposes 13 tools. It has no resources and no prompts: `resources/list` returns -32601.
2. **The server is a thin wrapper over `@camstack/develop`,** the library the `camstack develop` CLI also uses. Its tools are an addon and cap catalogue, `find_example` (13 curated examples), `validate_addon`, `scaffold_addon`, `scaffold_cap_stub`, `extend_addon`, and `list_skills` / `get_skill`.
3. **It works.** The develop tests pass (13 of 13) and the mcp-develop test passes (1 of 1). Both typechecks are clean. A `tsc` build into scratch succeeded. I started it over stdio and listed and called its tools: `get_capability recording` and `find_example notifier` answered correctly.
   - The only test covers the library, not the MCP server itself.
   - Both packages are already on npm at 0.1.1, even though the roadmap and `docs/reference/packages.md` say "not shipped".
   - It is not registered in the repo's `.mcp.json`, which only lists `code-review-graph`.
4. **The skill pack has three layers that overlap and drift:**
   - 4 sanitized public skills in `packages/develop/skills/`;
   - 6 skills in the repo's `.claude/skills/`, plus 4 single-file skills (`debug-issue.md` and three others) that need the code-review-graph MCP server;
   - 6 user-level `camstack-*` skills in `~/.claude/skills`. `camstack-api-reference` is stale: it dates from 16 July and says 136 caps, against 167 today. It also duplicates the generated `docs/reference/api.md`.
5. **Knowledge sources** (about 20 MB in all):
   - 768 ADRs. 753 of them have `applies-to:` paths in their frontmatter, which makes "which decision covers this file" a direct lookup.
   - 23 architecture docs (`ui.md` alone is 1,986 lines).
   - 9 generated reference docs, including api, guards (158), subsystems and coverage.
   - 11 AGENTS.md files.
   - 165 memory files, private and not in the repo. They hold the most valuable lessons about traps.
6. **Gaps in the biggest wishlist areas:**
   - **Knowledge:** no search or ADR tools.
   - **UI:** no ui-library catalogue or style checker. 46 primitives and 187 composites exist, but the only per-component docs are 188 `.prompt.md` files in the gitignored `ds-bundle/`. Baseline drift: 10 admin-ui `.tsx` files use raw hex colours, 38 addon `.tsx` files use Tailwind palette classes, and 24 admin-ui files use `style={{…}}`. No guard catches any of this.
   - **Caps:** the scaffold only understands scope × mode. It knows nothing about deviceNative, wrapper/defaultActive, internal/mount, or deviceTypes. It also never mentions the method-tier baseline or the force-publish of `@camstack/system`.
7. **Gaps in ops, models, CI and auth:**
   - **Ops:** none exists.
   - **Models:** none exists.
   - **CI:** none exists.
   - **Auth:** today's ops scripts break the "agents never log in with credentials" rule. `scripts/hub/hub.mjs` logs in with a password, hard-codes the hub IP and turns TLS checks off.
8. **Recommendation: one binary with toolsets, registered as two MCP entries.**
   - `camstack-dev` is offline. It reads and writes only the working tree and has no network.
   - `camstack-ops` runs the same binary with `--toolsets ops,models`. It reads the hub through the CLI's credential chain and starts read-only.
   - Two entries make the network and credential surface a separate thing to approve, without a second codebase.
9. **Phases:**
   - **P1, about 5–7 days:** knowledge, UI catalogue and checker, cardinality-aware cap scaffold, CI helpers.
   - **P2, about 4–5 days:** read-only ops tools on the cached session and the new admin scoped token.
   - **P3, about 3–4 days:** models and eval, release description, mutating tools behind confirmation.
   - **P4, about 2 days:** consolidating the skills, and freshness guards.
10. **Six questions for you are at the end,** covering memory exposure, the server split, ops auth, the Loki route, a committed UI catalogue, and a styling guard.

---

## 1. What exists today

### 1.1 The MCP server: `@camstack/mcp-develop` 0.1.1

**Launch and configuration**
- It runs over stdio (`server.ts:196-199`) and the bin is `camstack-mcp-develop`, which points at `dist/server.js`.
- The workspace comes from `CAMSTACK_WORKSPACE` or is found by walking up from the current directory (`server.ts:40-44`, `develop/src/workspace.ts:9-27`).
- There is no auth and no network.
- The server reports version `'0.1.0'` (`:48`) while the package is 0.1.1.
- It uses the older `server.tool(...)` overload.

**Tools** (`server.ts:51-194`). All of them are file-system only:

| Tool | What it does |
|---|---|
| `list_addons` / `get_addon` | Packages that declare `camstack.addons[]` (`develop/src/catalogue/addons.ts`) |
| `list_capabilities` / `get_capability` | Regex parse of `*.cap.ts` for name, scope, mode and export only (`catalogue/capabilities.ts:31-53`). Accurate on all 167 caps (I checked: names match file names, no duplicates), but it carries no methods, auth, kind, deviceNative or internal |
| `who_provides` | Addons whose manifest declares a cap name |
| `list_examples` / `find_example` | 13 curated core examples with keyword ranking (`examples/catalogue.ts`, `find.ts`) |
| `validate_addon` | Manifest, vite entries and known caps (`validate/addon.ts`, `entries.ts`) |
| `scaffold_addon` | `packages/addon-<name>/` with a kind of empty, provider, notifier, osd or post-analysis, and a dry-run option |
| `scaffold_cap_stub` | Writes the `.cap.ts` stub only. Scope is system or device and mode is singleton or collection (`scaffold/cap-stub.ts:15-16`). It does not edit `index.ts`, run codegen or update method tiers (`:66-73`) |
| `extend_addon` | Adds a manifest entry, a source file and a vite key to an existing package |
| `list_skills` / `get_skill` | The 4 bundled markdown skills, hard-coded list (`develop/src/skills.ts:16-25`) |

**Health**
- Tests pass: `develop` 13 of 13, `mcp-develop` 1 of 1.
- Both typechecks are clean.
- The build works.
- `packages/mcp-develop/dist` does not exist locally, so the server has to be built before anyone can use it.
- The mcp-develop test (`__tests__/tools.spec.ts:4-14`) only exercises the library. No test speaks MCP to the server.
- The roadmap's remaining items (the MCP follow-ups in `docs/roadmap.md`) are hub read-only tools, publish plus public URLs, and a codegen-drift check. Publishing has in fact already happened: npm shows 0.1.1 for both packages. <!-- drift-ok: moved to the private planning repo -->

**Other MCP**
- `.mcp.json` registers only `code-review-graph`, through uvx.
- The repo skills `debug-issue.md`, `explore-codebase.md`, `refactor-safely.md` and `review-changes.md` depend on it.

### 1.2 Skills

**Public pack, `packages/develop/skills/`**
- `add-addon` (126 lines), `add-capability` (89), `sync-docs` (59), `architecture` (79).
- These are sanitized copies of the repo skills, and they already lag them: the repo's `add-addon` is 358 lines against the pack's 126.

**Repo `.claude/skills/`**

| Skill | Lines | Covers |
|---|---|---|
| `add-addon` | 358 | New addon or manifest entry |
| `add-capability` | 130 | Cap definition, codegen, hand-edits, docs |
| `sync-docs` | 147 | Which docs to update, generated vs prose |
| `audit-debug-tracks` | 299 | Track media audit |
| `camstack-hub-image-deploy` | 536 | Shipping server-side changes; private hosts |
| `camstack-publish-ci` | 205 | Release train through CI |
| `camstack-server-api` | 92 | Calling the hub with curl |

Plus the 4 code-review-graph single-file skills. `.claude/agents/frontend-architect.md` is the only repo agent. <!-- drift-ok: a local agent file, not tracked in git -->

**User-level `~/.claude/skills`**

| Skill | Lines | Notes |
|---|---|---|
| `camstack-architecture` | 265 | |
| `camstack-homelab-ops` | 502 | SSH, tokens, image builds |
| `camstack-api-reference` | 116 + 400 KB of references | Stale: 16 July, "136 caps" |
| `camstack-track-audit` | 63 + `track-audit.mjs` | The script hard-codes the hub IP and `scratchpad/.tok` (lines 40-43) |
| `camstack-viewer` | 234 | |
| `loki-logs`, `grafana-query` | | Generic homelab; the `hl` helper times out from the laptop, according to memory |

**Overlaps and drift**
- add-addon and add-capability exist three times: the pack, the repo and memory.
- api-reference duplicates the generated `docs/reference/api.md`.
- homelab-ops overlaps hub-image-deploy and publish-ci.
- `add-capability` §7 "Ship it" (`SKILL.md:126-130`) says to deploy `packages/types`. Memory is newer and says a cap change needs a force-publish of `@camstack/system`, and `deploy packages/system`.
- The skill never mentions `scripts/check-method-tiers.ts --update`, the `CAP_INPUT_DEFAULTS` Zod-defaults trap, or the hand-written cap interfaces that rot.

### 1.3 Knowledge sources

**ADRs, `docs/decisions/`**
- 771 files and 6.8 MB.
- Frontmatter: `id`, `title`, `status`, `date` on all 768 records; `applies-to` on 753; `supersedes` on 685; `superseded-by` on 13; `covers` on 42; `last-verified` on 57.
- `index.md` is generated.
- Code comments cite `(D9)`, which maps to `adr-0009`, so a D-number can be resolved straight to its file.

**Architecture, `docs/architecture/`**
- 23 docs and 1.1 MB.
- `ui.md`, `capabilities.md`, `transport.md`, `benchmark.md` (the eval section starts at line 142), `update-and-release.md`, `deploying.md`, `secrets-keychain.md`, and others.

**Generated reference, `docs/reference/`**
- `api.md` (4,297 lines): every method with its kind, auth and input/output.
- `api-schemas.md`, `capabilities.md`.
- `guards.md`: 158 guards, each with a one-line description of what it refuses.
- `subsystems.md` and `coverage.md`, built from `docs/subsystems.yaml`.
- `packages.md`, `storage.md`, `addons.md`.

**AGENTS.md files**
- Root (368 lines), `camstack/` (the viewer), and `packages/{types, system, addon-pipeline, addon-ai, addon-provider-{hikvision, reolink, homeassistant}, addon-export-{google, alexa}}`.
- `.claude/worktrees/*` holds copies; any indexer must exclude them. <!-- drift-ok: a glob or a file this plan proposes -->

**Memory**
- 165 files (34 feedback, 127 project, 3 reference) and 808 KB.
- Private. They mix English and Italian and contain hostnames and token locations.

**Other docs**
- (planning repo: sessions/sessions.md) (54k lines), `docs/design` (119 files), (planning repo: superpowers) (11 MB of plans and handovers). <!-- drift-ok: moved to the private planning repo -->

**Scripts**
- 153 `scripts/check-*.ts` guards.
- `npm run codegen` / `codegen:check`, `docs:check`, `typecheck`, `test:affected`, `lint`.
- `scripts/hub/{hub.mjs, retrain-census, model-pin-census, keyframe-presence}.mjs`.
- `scripts/eval/` (Python, with pytest): `evaluate.py` compares a baseline and a candidate on the hub's annotated export using D739 floors; `evaluate_variants.py` handles COCO, pseudo-GT or the export, with a detections cache.
- `scripts/ops/keychain-migrate-hub.mjs`.

**ui-library**
- `packages/ui-library/src/{primitives (46), composites (187), widgets, theme, tailwind/camstack-theme.css (73 tokens)}`.
- There is no Storybook.
- `ds-bundle/` holds 188 `*.prompt.md`, `.d.ts`, `.jsx` and `.html` files plus a token README. It is the best per-component documentation, but it is gitignored (`.gitignore:2`).
- `.design-sync/NOTES.md` warns that this directory has already been wiped once by `git clean`.

**Viewer**
- The viewer has its own React Native kit: `camstack/src/components/ui/*` (about 30 components) and `src/theme/tokens.ts`.

### 1.4 Auth plumbing already available

- **CLI credential chain** (`packages/cli/src/commands/credentials.ts:1` (header) and `:120`): `--token`, then `--token-file`, then `$CAMSTACK_TOKEN`, then the cached `~/.camstack/<host>.json` session from `camstack login` (0600, `auth.ts:44`). <!-- drift-ok: moved to packages/develop/src/hub/credentials.ts by D835 -->
- **Scoped admin token:** the "admin-capable expiring audited token, max 90 days" is in progress (`roadmap.md:95`).
- **The problem:** `hub.mjs` uses a password (`:21,46`), turns TLS off (`:7`) and hard-coded the hub LAN IP (`:15`; moved to `CAMSTACK_HUB_URL` / `scratchpad/.hub-url` on 2026-10-09). It is not a model to follow.

## 2. Gap analysis against the wishlist

**Knowledge**
- There is no search across ADRs, architecture, AGENTS, guards and reference.
- There is no "which ADR applies to this path", although `applies-to` already supports it.
- There is no D-number resolver, no traps lookup and no subsystem lookup.
- Memory lessons are invisible to anyone other than this user's Claude.

**UI**
- There is no component catalogue (name, path, props, variants, example usage, consumers).
- There are no token listings for the admin Tailwind theme or the viewer tokens.
- There is no "find a component for this need".
- There is no divergence checker for raw hex, palette classes, inline styles, hand-rolled buttons and dialogs, or class names missing from the host CSS (D747 covers that last one only at the package level).
- There is no ui-library scaffold that does the component, the barrel export, a spec and the admin-ui `@source`.
- None of the `ui.md` conventions are served: table rules, narrow viewports, `scroll="body"`, the two node selectors, the one smart picker.

**Caps**
- The scaffold misses the real cardinality archetypes. Counts from `*.cap.ts`:
  - system singleton (which can be per-agent selected through bindings);
  - system collection (32), with addonId pin and namespacing guards;
  - deviceNative (73), using `registerNativeCap`;
  - device-scoped system cap that dispatches on deviceId;
  - wrapper (13) with `defaultActive`;
  - internal (30), with or without `mount:{kind:'skip'}` and with the D240 admin floor.
- `per-node` exists in the type but is not wired (`filesystem-browse.cap.ts:31`).
- Nothing applies the `index.ts` re-export and `AnyCapability` union hand-edits.
- Nothing runs codegen, the method-tiers baseline update, or the agent `main.ts` hand-curated array check.
- There is no cap-router spec stub and no step for the sessions log or an ADR.
- There is no publish-implication note for force-publishing `@camstack/system`, or for cap updates that ship with no image.
- `get_capability` returns no methods, auth or events. The data is in `api.md` or could come from the definitions.

**Addons**
- The addon scaffold exists. Missing: kinds beyond the current 5 (device provider with BaseDevice, storage, log-destination, export), a page or widget scaffold, and the D747 `@source` wiring.
- `validate_addon` does not run `check-addon-entries`, icons-shipped or types-entry.

**Ops**
- There is nothing at all.
- The building blocks exist:
  - `nodes.*` and capability listings;
  - `pipelineAnalytics.listRecentTracks/getTrack/listBirthDecisions/getEventDensity`;
  - the core `logs` router (`trpc.router.ts:416`), which holds an in-RAM ring of about 20 seconds;
  - `logDestination.query` (admin);
  - Loki through Grafana (`{job="camstack",node=…}`);
  - the track-audit script.

**Auth**
- There is no MCP credential handling.
- The scripts use password and `.tok` files.

**Models**
- No tool wraps `scripts/eval/evaluate*.py`, the benchmark caps, `customModelRegistry`, `modelConvert` or the Model Studio import.

**Testing and CI**
- There is no mapping from "changed files" to the right `-w` tests, guards, codegen check or docs check.
- There is nothing to stop someone dispatching `checks.yml`, which must never happen (memory: it killed agent-a).

**Release**
- The train is described only in private skills and memory: publish through CI, `applyServerUpdate`, the "+1 restart" step, the viewer OTA and pin chain.
- No tool describes the train.

## 3. Proposed design

### 3.1 Shape
- **One package and binary,** keeping the `@camstack/mcp-develop` name and making `@camstack/develop` the library for everything. Logic stays in the library so the CLI and MCP keep parity.
- **Toolsets:** `knowledge`, `ui`, `caps`, `addons`, `ci`, `ops`, `models` and `release`, selected with `--toolsets`.
- **Two `.mcp.json` entries:**
  - `camstack-dev`: `knowledge`, `ui`, `caps`, `addons`, `ci` and `release` (describe only). It reads and writes the working tree, never calls the network, and needs no credentials.
  - `camstack-ops`: `ops` and `models`. It needs hub credentials and is read-only by default; a mutating tool exists only with `--allow-mutations` and asks every time.
- **Why this split:** permission prompts and blast radius differ completely between the two halves, and one codebase avoids drift.
- **Resources:** expose `camstack://adr/D###`, `camstack://arch/<doc>#<heading>`, `camstack://agents/<pkg>`, `camstack://ui/component/<Name>` and `camstack://skill/<id>`, so clients can attach them.
- **Prompts:** `new-capability`, `new-ui-surface`, `diagnose-camera`, `evaluate-model`. Each is a guided flow that chains the tools.
- **Public vs private split:** the npm package carries only public sources. Private overlays come from `~/.camstack/develop.json`:
  - extra knowledge roots: the memory dir, `~/.claude/skills/camstack-*`;
  - the hub URL list.
- Overlay results are labelled `private` and never written into generated files. `check-public-docs-private-data.ts` can be reused to refuse leaks into scaffold output.

### 3.2 Knowledge toolset (P1)
- **`search_knowledge(query, kinds?, limit?)`**
  - BM25 in memory: MiniSearch, or a hand-rolled index (no new SQLite).
  - Indexes ADRs (title, Decision, Context), architecture split by heading, AGENTS.md, `guards.md` rows, `subsystems.md`, and optionally memory.
  - Returns snippets with path:line, never whole files.
  - Built lazily and cached by mtime.
- **`get_decision(id)`**: resolves D9, 9 or adr-0009 to frontmatter, Decision and Enforcement, and follows `superseded-by`.
- **`decisions_for_path(path|glob)`**: matches `applies-to` and `covers`, plus a grep for `(Dnn)` comments in the file.
- **`traps_for(topic|path)`**: a union of:
  - the "silent when missed" sections of the skills;
  - the guards whose descriptions match;
  - memory feedback and project files tagged by topic.
- **`subsystem_of(path)` / `subsystem_map()`**: from `subsystems.yaml` and `coverage.md`.
- **`guards_for(paths)`**: guards whose header or `applies-to` ADR references the path, with the exact command to run each one.
- **`get_skill`**: reads from every layer. The pack is the canonical public layer; the repo and user layers are overlays.
- **`read_section(id)`**: the text of one indexed section, using the `id` `search_knowledge` returns (`arch:<page>#<heading>`, `Dnn`, `skill:<id>`). Truncated past 12 KB with a note, so a client never reads a whole architecture page.
- **`next_adr_number()`**: the next free decision number and the `docs/decisions/adr-NNNN-<slug>.md` pattern, from the `adr-*.md` files in `docs/decisions/`. Ignores the generated `index.md`, which lags concurrent branches.

### 3.3 UI toolset (P1)
- **Source of truth:** a new generated `docs/reference/ui-components.json` and `.md`, made by `docs:generate` from the ui-library barrel. <!-- drift-ok: a glob or a file this plan proposes -->
  - It contains export name, file, props (through ts-morph, already a dev dependency), variants, the TSDoc summary, and consumers (import graph).
  - It also lists the tokens from `camstack-theme.css` and the viewer's `theme/tokens.ts`.
  - `ds-bundle` `.prompt.md` files are used when present.
  - Committing this file removes the dependency on the gitignored bundle.
- **`list_ui_components(area?: primitives|composites|widgets|viewer)`** and **`get_ui_component(name)`**: props, variants and 1–2 real usage sites.
- **`find_ui_component(need)`**: ranks by name, TSDoc, props and the `ui.md` conventions, for example "table" pointing to DataTable plus the conventions in `ui.md:1433`.
- **`list_ui_tokens(platform)`**: the semantic utilities table, the same one as in the ds README.
- **`check_ui_file(path)`**: flags
  - raw hex/rgb colours;
  - Tailwind palette classes (`bg-zinc-*` and the like);
  - `style={{}}` colours and spacing;
  - `<button>`, `<dialog>`, `<table>` or `<select>` elements where a library primitive exists;
  - local re-implementations whose names collide with library exports;
  - a page package not in the admin-ui `@source` (D747).
  - It returns suggestions mapped to tokens and components.
  - The same rules can become a ratcheted guard with a baseline (see Q6).
- **`scaffold_ui_component(name, area, baseOn?)`**: writes the component in ui-library with tokens only, adds the barrel export, a spec, and the `ui-components.json` entry through regeneration, and returns the next steps (publish ui-library and its consumers).

### 3.4 Caps toolset (P1)
- **`get_capability`** is upgraded to load the definition through tsx or ts-morph and return methods with kind, auth (from `resolveMethodAuth`), events, deviceTypes, the mount kind (from the existing mount resolver) and providers.
- **`plan_capability({purpose, archetype})`**:
  - It first answers "do you need one?" using the skill's §0 and similar existing caps.
  - Then it picks the archetype: `system-singleton | system-collection | device-native | device-dispatch | wrapper | internal`.
  - Each archetype brings its required fields, the guards it triggers (collection pin, namespacing, wrapper mounts, D240) and an existing example cap.
- **`scaffold_capability(...archetype)`**: a dry run by default; with apply, it
  - writes the `.cap.ts`;
  - applies both `index.ts` hand-edits (the `check-capability-union-complete` guard verifies them);
  - writes a provider stub (`registerProvider` or `registerNativeCap` in a BaseDevice);
  - adds the manifest declaration by name;
  - writes a cap-router spec stub under `server/backend/src/__tests__/cap-routers/`;
  - flags the agent `main.ts` array if the cap must exist on agents.
- **`run_codegen({check?})`**: runs `npm run codegen` or `codegen:check` and returns a summarised diff and guard failures.
- **`method_tiers_diff()`**: runs `check-method-tiers.ts` and shows widened tiers. `--update` only on request.
- **`cap_ship_plan(changedCaps)`**:
  - Says whether a force-publish of `@camstack/system` is needed.
  - Says whether it is an additive field (redeploy the addon only) or a new method (publish, then `applyServerUpdate` and `deploy packages/system`, plus the "+1 restart and toggle-verify" step).
  - This is description only.

### 3.5 Addons toolset (P1/P2)
- Keep `scaffold_addon`, `extend_addon` and `validate_addon`.
- Add kinds for device-provider (BaseDevice), log-destination, storage, exporter and page/widget.
- `validate_addon` also runs `check-addon-entries`, `check-addon-icons-shipped`, `check-addon-types-entry` and `check-addon-page-css` for that package.

### 3.6 CI and testing toolset (P1)
- **`affected_checks(paths|gitDiff)`**: maps changed files to the right commands:
  - package `-w` tests and typecheck;
  - guards from `guards_for`;
  - `codegen:check` if any `*.cap.ts` changed;
  - `docs:check`;
  - the viewer's `ts-check` and `test:v2` for `camstack/**`.
- **`run_checks(plan)`**: runs locally with a streamed summary.
- Never `gh workflow run checks.yml`. The tool is deny-listed in code.

### 3.7 Ops toolset (P2, `camstack-ops`, read-only)
- **Credentials:** resolved by reusing the CLI chain. `credentials.ts` and the session lookup are extracted into `@camstack/develop` (or `@camstack/sdk/node`).
  - The order is `--token-file` (an explicit override only), then the `~/.camstack` session (superseded 2026-10-21: no admin-token file; one token format, refreshed automatically).
  - `$CAMSTACK_TOKEN` is used only if you decide to keep it.
  - Never passwords, never `.pw`, never `hub.mjs`.
  - TLS is pinned or uses the hub CA instead of `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **`hub_query(path, input)`**: generic, but limited to methods whose generated `kind` is `query`. It refuses admin-tier queries unless the credential is admin-scoped. Output is truncated and secret fields are redacted using the secret-field declarations.
- **Curated tools:**
  - `topology()`: nodes, agents, versions and pids;
  - `cap_providers(cap)`: providers, the active singleton and per-node bindings, which covers "Deploy ≠ capabilities re-registered";
  - `recent_tracks(deviceId, window)`, `track(deviceId, id)`, `birth_decisions`, `event_density`;
  - `audit_tracks(window)`, porting `track-audit.mjs`;
  - `hub_logs(filter, since)`, using the ring for the last ~20 s and `logDestination.query` or Loki beyond that;
  - `loki_query(logql, range)`, with the Grafana token taken from the keychain, never printed and never from the environment;
  - `prom_query(promql)`, for example hub RAM as 24-hour means.
- **Mutations:** none in P2. Later, each one comes in behind `--allow-mutations` with confirmation (MCP elicitation, or a two-step `confirm_token`). The classifier traps (uninstallPackage) stay operator-only.

### 3.8 Models toolset (P3)
- **`eval_model({export, baseline, candidate, sizes, holdout})`**: wraps `evaluate.py` and `evaluate_variants.py` in a local venv from `requirements.txt` and returns the summary table plus the report path.
- **`fetch_retrain_export`**: read-only download of the annotated export.
- **`benchmark_run(model, node)`**: a mutation that loads the hub. Confirmation required; then poll `benchmark.progress`.
- **`model_studio_import(bundle)`**: a mutation, behind confirmation, and only after the training work lands `importModelBundle`.
- **`model_floors(modelId)`**: reads `docs/benchmarks/model-floors.json` and D739.

### 3.9 Release toolset (P3, describe only)
- **`release_plan(changes)`**: builds the ordered train from `camstack-publish-ci`, `hub-image-deploy` and the memory traps:
  - publish through CI, then `applyServerUpdate`, then the builtins and `system` addon deploy, then verifying the pid and capabilities;
  - the viewer OTA, then `build:orchestrator`, then the deploy, then the submodule pin.
- **`release_status()`**: read-only. npm versions and hub and agent versions.
- Publish, deploy and `applyServerUpdate` are never executed by MCP in v1. The tool prints the commands for a human to run.

### 3.10 Safety rules (all toolsets)
- Every tool is tagged with MCP annotations: `readOnlyHint`, `destructiveHint` and `openWorldHint`.
- Writes are always dry-run first and show a diff.
- Writes are confined to the workspace root.
- Outputs are scrubbed of tokens, `glsa_`/`cst_` prefixes and JWT patterns.
- Credential paths are never echoed.
- No SQLite opens of hub data. No `git add -A`, commits or pushes from tools.
- Deny-list: dispatching Checks, `npm publish`, `docker`, and SSH.
- Every ops call is logged to the hub audit trail under the scoped token.

## 4. Phased plan

**P1, about 5–7 days**
- Knowledge index and tools (2 days).
- `ui-components.json` generator plus the 4 UI read tools and `check_ui_file` (2 days).
- Cap archetype `plan_capability` and `scaffold_capability`, `run_codegen`, `method_tiers_diff`, `cap_ship_plan` (2 days).
- `affected_checks` and `run_checks` (half a day).
- An MCP-level test that spawns the server, lists tools and calls each read tool against the repo (half a day).
- Register `camstack-dev` in `.mcp.json`.

**P2, about 4–5 days**
- Extract the credential chain.
- `camstack-ops` toolset: topology, cap providers, `hub_query` (query-only), tracks and audit, logs, Loki and Prometheus.
- Port `track-audit.mjs` and the `scripts/hub/*census` scripts. <!-- drift-ok: a glob or a file this plan proposes -->
- Retire the password path in `hub.mjs`.
- This needs the scoped admin token for admin-tier reads.

**P3, about 3–4 days**
- `eval_model`, `fetch_retrain_export`, `model_floors`.
- `benchmark_run` and `model_studio_import` with confirmation.
- `release_plan` and `release_status`.
- Extend `scaffold_ui_component` and the addon kinds.

**P4, about 2 days**
- Consolidate the skills:
  - the pack becomes the canonical public text;
  - the repo skills become thin overlays;
  - delete `camstack-api-reference` in favour of the generated `api.md` and tools;
  - fix the stale `add-capability` §7.
- Add guards:
  - pack skill matches repo skill on the public sections;
  - `ui-components.json` drift;
  - the styling ratchet (Q6).
- Update the roadmap and `packages.md`, which say "not shipped" for packages that are on npm.

## 5. Questions for you

1. **Should private memory be served?** I recommend yes, as a read-only overlay from `~/.camstack/develop.json`, only in the local `camstack-dev` entry and never shipped. Over time, move the durable lessons into ADRs and architecture docs so the public layer improves too.
2. **One server or two?** I recommend one binary with two `.mcp.json` entries (offline dev, and credentialed ops), so network and credential tools need their own approval.
3. **Ops auth before the scoped admin token lands?** I recommend allowing the cached `camstack login` session for protected-tier reads now. Gate admin-tier reads (logs, footprints) on the scoped token. Remove the password login path from the tooling.
4. **Where should log history come from?** I recommend the hub's `logDestination.query` as the target, so tools don't depend on Grafana. Until then, query Loki through Grafana with the token read from the macOS keychain, never from the environment and never printed.
5. **Should the UI component catalogue be committed?** I recommend yes: a generated `docs/reference/ui-components.json` and `.md`, guarded for drift, instead of relying on the gitignored `ds-bundle`. Also decide whether the viewer's React Native kit belongs in the same catalogue (I recommend yes, as a separate section). <!-- drift-ok: a glob or a file this plan proposes -->
6. **Should there be a styling guard?** I recommend yes: a ratcheted baseline guard for raw hex colours, palette classes and inline colour styles in `addon-*/src` and `ui-library`. The current counts are 10, 38 and 24 files. It would share its rules with `check_ui_file`, so new divergence fails while the existing cases are paid down.

---

## Operator decisions (2026-10-09) — override the plan above where they differ

1. **Private, not public.** The tool for developing CamStack itself is a PRIVATE MCP server or specialised tool, always run from the operator's machine. It is not the public `@camstack/mcp-develop` npm package. The private one can serve memory, the private skills and hub access freely. The public package stays as is for third-party plugin authors.
2. One binary, two entries (offline dev vs credentialed ops): OK.
3. Ops auth: OK. Use the cached `camstack login` session for protected-tier reads; the admin expiring audited token for admin-tier reads; never passwords.
4. **Log fetching asks WHICH log provider.** Do not assume Grafana/Loki: a user may only have the onboard winston destination, or another `log-destination`. List the configured log-destination providers and query the chosen one, e.g. through `logDestination.query` per provider.
5. Commit the UI component catalogue, viewer kit included: YES.
6. **NO styling guard / CI check for now.** It would block CI again. `check_ui_file` stays a tool the developer runs, not a gate.

**Status (2026-10-13): P1–P4 landed (P1 first; see the later entries).** Private package `@camstack/mcp-dev` (`camstack-dev` binary, `"private": true`, never published, run only from the operator's machine; registered in `.mcp.json`) — NOT the public `@camstack/mcp-develop`. Offline toolsets knowledge / ui / caps / addons / ci. The UI tools wrap the existing `scripts/ui/cli.ts` and the committed `docs/reference/ui-components.json` (one catalogue, no second generator); `check_ui_file` is a tool only, with no styling CI guard (decision 6). Open from P1: the viewer's React Native kit components are not in the catalogue (only its tokens are); P2 ops, P3 models/release and P4 skills/guards are not started.

**Status (2026-10-13, later): P2 landed.** The ops toolset is the `camstack-ops` entry of the same binary (`--toolsets ops`, registered in `.mcp.json`), read-only by construction. Credential chain, session cache, hub address and TLS trust were extracted into `@camstack/develop` (`src/hub`, D835); the CLI and `scripts/hub/hub.mjs` import them, and `hub.mjs` lost its password `login` and its certificate bypass. Tools: `ops_status`, `hub_query` (generated `kind: query` only, secret-bearing methods refused, admin tier needs a `csa_` token, output redacted and bounded), `topology`, `cap_providers`, `recent_tracks`, `track`, `audit_tracks`, `log_providers`, `hub_logs` (asks which log-destination provider), `loki_query` (only when an unauthenticated Loki provider is configured), `model_pin_census`, `retrain_census`, `keyframe_presence`. The three hub census scripts (model-pin, retrain, keyframe presence) are retired in favour of tools. Every tool, P1 included, now carries MCP annotations. Not in P2: `birth_decisions` / `event_density` (reachable through `hub_query`), a Prometheus tool (the repo has no Prometheus provider), the disk half of the pin census (it needed SSH). Finding: the cached `camstack login` session is scoped to `capability:addons` only, so protected-tier reads on it reach `addons.*` routes; everything else wants an admin token. P3 (models, release) and P4 (skills, guards) remain, **not to be started without the operator**.

**Status (2026-10-13, latest): P3 landed.** The `models` toolset joined `camstack-ops` and `release` is real. Read-only on the cluster: `model_floors` (the committed floor tables with the method and D739), `fetch_retrain_export` (admin token; streams the annotated tar into `scratchpad/retrain-export/`), `eval_model` (`scripts/eval` in `scratchpad/eval-venv`, workspace-confined inputs, venv only with `setupVenv:true`), `benchmark_status`, `birth_decisions`, `event_density` (the two P2 gaps), `release_status` (repository state, `gh run list`, `npm view`, node versions when a credential allows) and `release_plan` (the ordered train for changed paths, with the traps; replaces the P1 stub). Mutating, only with `--allow-mutations` and never executed in tests or smoke: `benchmark_run` and `model_studio_import`, behind a dry run and a one-shot `confirm_token` bound to the exact arguments (D836). Two departures from the sketch above: `model_studio_import` is not an upload (the bundle import takes a same-host peer-bytes ticket, D806/D613) but the gated convert-and-distribute of a model Model Studio already holds; and `release_status` lives in the `ops` entry because it reads `gh` and the registry, which the offline `camstack-dev` entry must not. `scaffold_ui_component` is new (file + spec + barrel line, the dry run is a diff), `scaffold_capability` and `scaffold_addon` now show diffs and default to dry run, and the addon kinds gained `model-studio` and `admin-ui`. P4 (skills, guards) remains, **not to be started without the operator**.


**Status (2026-10-21, superseded by one token format):** `camstack login <host>` once; every tool uses that session (refreshed automatically); `--token-file` is an explicit override only. The `<host>.admin-token` file, its `.meta` and `$CAMSTACK_ADMIN_TOKEN_FILE` are removed, and the tier comes from the token's claims, not a `csa_` prefix. The paragraph below is the history.

**Status (2026-10-13, admin token): one command for every MCP credential.** `camstack login --admin [--admin-days N]` also mints the `csa_` admin token (D816) in the same interactive session (re-authentication D813 with the password just typed; TOTP is asked at the login leg) and writes it to `~/.camstack/<host>.admin-token` (0600, atomic) plus a secret-free `.meta` with the expiry. `camstack whoami` reports its presence and expiry. When an ops tool needs the admin tier and there is no live admin token (missing, expired by the meta, or the hub answers 401/403), `ops_status`, `topology` and the refused `hub_query` carry the exact command; the MCP still never handles a password and installs nothing.

**Status (2026-10-13, final): P4 landed — P1–P4 landed.** D837 reverses the direction of the skills plan's section 4: the public pack (`packages/develop/skills/`) is the canonical text of `camstack-addon`, `camstack-capability` and `camstack-secrets`, and the repo skills are overlays that point at it. `camstack-docs` stays whole in the repo beside the pack's generic one. `camstack-api-reference` was a user-level skill, never in the repo or the pack, and is gone: `docs/reference/api.md` and the tools replace it. The stale `add-capability` shipping text is fixed in the pack. Guards, Checks only: `check-skill-pack-sync` and `check-ui-catalogue-current`; no styling guard (decision 6). The UI catalogue gained a `viewerEntries` section for the viewer kit (`camstack/src/components/ui`), read when the submodule is checked out and carried verbatim, with a notice, when it is not. `docs/reference/packages.md` derives "npm, standalone tool" from `private` (the Publish workflow skips exactly `private: true`) instead of "not shipped".
