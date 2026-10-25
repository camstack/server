# Repo-level skills (UI first) — analysis and plan (2026-10-09)

Status: **implemented 2026-10-09** (skills, docs split, pointers, local scripts, agent, viewer tooling — no MCP work; see "Implementation record" at the end). Target: EXTERNAL harnesses (Codex, Cursor, fresh Claude Code sessions) must discover and follow the UI conventions; ui.md becomes a proper skill. Related: [[2026-10-09-developer-mcp-plan]].

## Summary (~30 lines)

1. **Repo skills already work for Claude Code.** `.claude/skills/<name>/SKILL.md` is tracked (`.gitignore:74-75` re-includes `.claude/skills/`), auto-discovered, and invokable by name. Reference files placed next to `SKILL.md` load only when the skill points at them.
2. **The MCP can serve those same files with no copy.**
   - The private dev MCP reads `.claude/skills/*/SKILL.md` plus `references/*` straight from the workspace.
   - It exposes them three ways: as tools (`list_skills`/`get_skill`, the dependable path, because the model calls them itself), as resources (`camstack://skill/<id>[/<ref>]`), and as prompts (`new-ui-surface` etc., which the user triggers).
   - Today `develop/src/skills.ts:16-25` hard-codes 4 pack skills; that becomes a directory scan.
3. **Why the external agent did a poor job: a structural cause, plus a second one I found.**
   - The structural cause: agents outside Claude Code read `AGENTS.md`, not `.claude/skills`, and the `AGENTS.md` skill table (`:349-360`) has no UI entry.
   - **The second cause is worse.** The repo's own `.claude/agents/frontend-architect.md` (untracked, 261 lines) tells agents to *"AVOID generic fonts (Inter…)"*, *"Vary themes. Never converge on common choices"*, *"Break conventions: asymmetry, gradient meshes, noise textures"*, and *"Commit fully to distinctive visions"*.
   - That is the exact opposite of a closed design system. It also cites a `useApi()` hook (0 uses in admin-ui), a stale SDK rebuild step, and a memory path that doesn't exist (`Git/camstack-server/`, missing `camstack/`).
   - Any coordinator that sends UI work to this agent is asking for off-system UI. **Rewrite it first.**
4. **The fix for subagents uses three layers:**
   - the agent definition preloads the skill (the `skills:` frontmatter);
   - the coordinator's brief says "invoke skill `camstack-ui` first; finish with `check_ui_file` output";
   - `AGENTS.md` names the skill and the MCP tool, so non-Claude agents find it too.
5. **`camstack-ui` skill:** one `SKILL.md` of about 250 lines, plus about 6 reference files totalling about 1,200 lines.
   - It sets an 8-step workflow with hard gates: find, map, extend the library, compose, tokens, measure, test, document.
   - It carries decision tables taken from `ui.md` and real usages, an anti-pattern list with real file paths, and a split section for admin-ui (web) and the viewer.
   - It ends with a "done" checklist that requires the output of `check_ui_file` and screenshot measurements.
6. **Minimal MCP tools the skill needs:**
   - Phase A: the committed catalogue `docs/reference/ui-components.{json,md}` (generated), plus `find_ui_component`, `get_ui_component`, `list_ui_tokens` and `check_ui_file` (the developer runs it; it is not a CI gate, per decision 6).
   - Phase B: `scaffold_ui_component` and a screenshot harness.
7. **Measured drift today:**
   - 10 admin-ui `.tsx` files use raw hex.
   - About 120 `.tsx` files across `addon-*/src` and `ui-library/src` use Tailwind palette classes.
   - 24 admin-ui files use `style={{}}`.
   - Admin-ui files use raw `<button>` in 10, `<table>` in 15 and `<select>` in 4.
   - 29 viewer `.tsx` files use raw hex.
   - Two admin-local components duplicate library ones: `shared/StatusBadge.tsx` and `shared/DetectionOverlay.tsx`.
8. **Other skills:**
   - `add-capability`: rewrite it to know the cap's cardinality (singleton vs collection, device-native, wrapper, internal), and fix §7.
   - `add-addon`: consolidate.
   - `release`: new; merges publish-ci, hub-image-deploy, homelab-ops and the viewer chain.
   - `keychain-secrets`: new.
   - `sync-docs`: keep.
   - `diagnose`: new; it asks which log provider to use, and absorbs audit-debug-tracks and track-audit.
9. **Canonical location:** the repo's `.claude/skills/` holds the private, full truth. The public pack becomes a generated, sanitized projection with `<!-- public -->` section markers. User-level `camstack-*` skills are retired into the repo, or into an overlay the private MCP serves for host and token matters only.
10. **Effort:**
    - Phase 0: about 0.5 day (agent rewrite, `AGENTS.md` row, brief template).
    - Phase 1: about 3 days (UI skill, catalogue generator, 4 tools, MCP skill serving).
    - Phase 2: about 1.5 days (scaffold and screenshots).
    - Then the other skills, at 0.5–1 day each.
    - This replaces the "UI catalogue/checker" slice of P1 in `docs/design/2026-10-09-developer-mcp-plan.md` and pulls part of P4 (skills) forward.

---

## Full analysis

### 1. How repo skills work, and how to reuse them in the MCP

**What Claude Code does today**
- It discovers `.claude/skills/<name>/SKILL.md` (frontmatter `name` + `description`) in the repo.
- The `description` is what triggers it, so it has to name the trigger phrases ("admin-ui page", "viewer screen", "ui-library component", "redesign", "styling").
- Files beside `SKILL.md` (`references/*.md`, `scripts/*`) are read only when the body links to them. This is how a large skill stays cheap.
- The four single-file `.claude/skills/*.md` (debug-issue and the others) are the legacy form. Move them into `<name>/SKILL.md` directories, or drop them.

**One source, served to the MCP**
- The private dev MCP resolves the workspace (`CAMSTACK_WORKSPACE` or a walk up the tree) and scans `.claude/skills/*/SKILL.md` at call time. No build step and no copy.
- `list_skills()` returns `{id, description, refs[]}`.
- `get_skill(id, ref?)` returns the body or one reference file.
- Resources: `camstack://skill/<id>` and `camstack://skill/<id>/<ref>`.
- Prompts: `new-ui-surface`, `new-capability`, `release`, `diagnose`. Each prompt is the `SKILL.md` body with arguments (target UI, page name) filled in.
- Tools are what an autonomous agent can reach. Prompts are a user slash-entry. So ship both.

**Skills that call tools**
- The skill names the tools by name in its steps, for example "Step 1: call `find_ui_component({need})`; if the MCP is absent, run `node scripts/ui/find-component.mjs <need>`".
- Every tool is a function in `@camstack/develop` with a CLI twin (`camstack develop ui find …`). The skill therefore runs in Claude Code without the MCP, in Cursor or Codex through the CLI, and over MCP.
- A tool's result can say "next: step N of `camstack-ui`" to keep the agent on the workflow.

**Subagents: the real failure mode.** A spawned or external agent only follows conventions it actually loaded. Layer it:
- **(a) Agent definitions preload the skill.**
  - Claude Code subagent frontmatter accepts a `skills:` list that injects skills at start. Verify this on the installed version; if it is missing, inline "Your FIRST action is `Skill camstack-ui`" at the top of the body.
  - Rewrite `frontend-architect` as a CamStack-specific `camstack-ui-engineer`, tracked under `.claude/agents/`, which needs a `!.claude/agents/` gitignore re-include.
  - It sets `skills: [camstack-ui, sync-docs]` and drops the "distinctive aesthetic" doctrine entirely. In this repo the brief is "consistent with the system", not "memorable".
- **(b) Coordinator briefs include a fixed preamble.** "Load skill X before reading code. Done = the skill's checklist pasted with evidence (`check_ui_file` output, screenshot widths)." The coordinator then verifies the evidence block rather than trusting a summary. Put this template in root `AGENTS.md`.
- **(c) Root `AGENTS.md` and `camstack/AGENTS.md`** get a skills-table row: "Any admin-ui / ui-library / addon page / viewer screen → `camstack-ui` (`.claude/skills/camstack-ui/SKILL.md`; MCP `get_skill camstack-ui`)". This is the only layer non-Claude harnesses see.
- **(d) Tools re-assert the conventions.** `check_ui_file` is the backstop: even an agent that skipped the skill gets the violations, with the right component or token in each message.

### 2. The `camstack-ui` skill

**Layout** (about 1,450 lines; most of it lives in references and loads on demand):
```
.claude/skills/camstack-ui/
  SKILL.md                    ~250  workflow, gates, checklist, tool calls
  references/decision-table.md ~250  need → component (both UIs)
  references/page-patterns.md  ~300  IntegrationHub, AdminTabs, System tabs, Secrets, dialogs, tables
  references/tokens.md         ~120  Tailwind semantic utilities ↔ viewer tokens.ts, 1:1
  references/anti-patterns.md  ~200  real bad→good pairs from this repo
  references/viewer-rn.md      ~200  viewer kit, SheetModal/PickerSheet, RN specifics, embed
  references/extending-library.md ~130 how to add a primitive/composite properly
```
Generate `decision-table.md` and `tokens.md` from the catalogue where possible, and keep only the "why" columns hand-written.

**Mandatory workflow.** Each step has an exit condition the agent must state.
1. **Find.**
   - Call `find_ui_component(need)` per UI element, then `get_ui_component` on the hits to see props and 1–2 real usage sites.
   - Also read the relevant `ui.md` section (via `search_knowledge`, or the heading index in `decision-table.md`).
   - Exit: a table of element → component found (or "none").
2. **Map.** Fill the gaps from library primitives and composites. Forbidden: forking a composite (`ui.md:82-97`: "extend it or add a prop"). Exit: no element is left unmapped.
3. **Extend.**
   - If nothing fits, extend `packages/ui-library` (or `camstack/src/components/ui`) first.
   - That means tokens only, a barrel export in `src/{primitives,composites}/index.ts`, a spec, and a catalogue regeneration.
   - Never add a page-local look-alike. `shared/StatusBadge.tsx` vs the library's `StatusBadge` is the cautionary example.
   - Then note the publish implication: ui-library is host-provided (D15), so consumers need the new version.
4. **Compose with the established page patterns:**
   - `AdminPage` (title, subtitle, `nav` slot);
   - `AdminTabs` with `?tab=` (never nested inside another `?tab=` page, `ui.md:1671+`);
   - `IntegrationHub` for "integrations of a kind" (D774);
   - `SectionCard` / `SettingRow`;
   - `DataTable` with `maxBodyHeight={TABLE_SCROLL_MAX_H}` and `mobileMode="scroll"` for managed lists (`ui.md:1435`);
   - `DialogContent scroll="body" placement="sheet-on-mobile"` for tall dialogs;
   - a single notice region (the System → Secrets redesign, 2026-10-08);
   - reveal-in-dialog, and `PasswordInput` / `ConfigSecretField` for secrets (the one-input secret field, 2026-10-08);
   - `NodePicker` as the standard node selector;
   - the one smart device picker (D636);
   - selection in the URL (`?node=`, `replace: true`);
   - one control per option set: a control with a single option is not rendered.
5. **Tokens only.**
   - Web: semantic utilities (`bg-surface`, `text-foreground-muted`, `border-border`, `text-danger`…) from `camstack-theme.css`.
   - Viewer: `tokens.ts` `ColorTokens`, through the theme hook.
   - No hex, no palette classes, no `style={{color|margin}}`.
   - Charts follow `ui.md:1529` (no charting dependency, no dual axis).
6. **Measure.**
   - Take screenshots at 320, 768 and 1280 px, in dark and light.
   - Report horizontal overflow (`scrollWidth > clientWidth`) and the compounded padding at 320 px (`ui.md:1353+`).
   - The viewer adds iOS-sim / web at phone width.
   - Use the harness tool, or Chrome MCP against the Vite dev server.
7. **Test.**
   - Specs next to the existing ones (pattern: `secrets-page.spec.tsx`, `integration-hub.spec.tsx`, `system-page.spec.tsx`), pinning tabs, deep links and empty or unanswered states (`ui.md:240`).
   - Viewer: `npm run test:v2`.
   - Run `ts-check` / typecheck.
8. **Document.**
   - A `ui.md` section if a new convention or pattern was born.
   - An ADR if a real alternative was rejected.
   - A new page package needs `tsx scripts/check-addon-page-css.ts --write` (D747).
   - Then hand off to `sync-docs`.

**Decision table (excerpt; full version in the reference):**

| Need | Admin-ui / addon page | Viewer |
|---|---|---|
| Managed list | `DataTable` (+filter bar, `maxBodyHeight`, `mobileMode="scroll"`) | `Section` + `Row` list |
| Device table | `DeviceList` | — |
| Label/value setting | `SettingRow` in `SectionCard` | `Row`, `ToggleRow`, `SelectRow`, `StepperRow` |
| Tabs on a page | `AdminTabs` (`?tab=`) | `SegmentedControl` / `SegmentBlock` |
| Integrations of a kind | `IntegrationHub` + pills | — |
| Modal | `Dialog` (`scroll="body"` if tall), `ConfirmDialog`, `ConfirmActionButton` | `SheetModal`, `PickerSheet`, `confirm.tsx` |
| Secret | `PasswordInput` / `ConfigSecretField`; reveal in a dialog | — |
| Node | `NodePicker` (standard) | — |
| Device(s) | the smart picker (`device-picker/`, `DeviceSelectField`) | same rule (D636) |
| Status | `StatusBadge`, `BatteryBadge`, `ProviderBadge` | `ConnectingIndicator`, `ProgressStrip` |
| Empty / error | `EmptyState`, `ErrorBox` | `RenderErrorBoundary` |
| Schema-driven form | `ConfigFormBuilder` | — |
| Menu | `KebabMenu`, `Dropdown` | `AnchoredMenu`, `AnchoredDropdown` |
| Icon button | `IconButton` | — |

**Anti-patterns, with real files**
- Raw `<button onClick={onClose}>` as a dialog close: `NewExportModal.tsx:102`, `TokenModals.tsx:87`, `EditLocationModal.tsx:161`, `AddLocationWizard.tsx:171`. Use `DialogContent`'s own close / `IconButton`.
- Palette status colours: `AlertBell.tsx:61-64` (`text-blue-400`…), `ToastContainer.tsx:16-18`, `CopyUrlChips.tsx:73` (`emerald-*`), `NodeAddonsSettingsPanel.tsx:931` (`red-500/10` banner). Use `text-info/success/warning/danger` and the notice pattern.
- Raw hex: `LoadChart.tsx`, `AddonCard.tsx`, `Calendars.tsx`, `EventDetailPanel.tsx`.
- Local duplicates of library exports: `shared/StatusBadge.tsx`, `shared/DetectionOverlay.tsx`.
- `div` stacks for manageable lists (the Notification Center story, `ui.md:1435`).
- Rendering N heavy details at once instead of a selector (the Cluster story, `ui.md:729+`).
- Nested `?tab=` strips.
- Unconditional `sticky` / `truncate` / fixed label widths in shared components (D43).
- Viewer: 29 `.tsx` files with raw hex (for example `LogsModal.tsx`, `TotpSection.tsx`, `WorkspaceGrid.tsx`), and about 21 files on raw RN `Modal` where `SheetModal` exists. Verify each case; some may be legitimate (video overlays).

**Differences between the two UIs, spelled out in the skill**
- **Web**
  - Tailwind v4 with semantic utilities.
  - ui-library is host-provided (D15).
  - An addon page ships no CSS (D747), so a class works only if the admin-ui build scans the package. Pages mount through Module Federation and `mount-addon-page`.
  - Values from `@camstack/types/client`, never the bare barrel (viewer rule; the web equivalent is to check the barrel before importing by name).
- **Viewer**
  - React Native with `tokens.ts` (the same palette as the web theme; keep them 1:1, and `tokens.md` documents the mapping).
  - Its own kit under `src/components/ui`.
  - The `embed/` player is browser code that follows the web rules.
  - i18n en+it is mandatory.
  - Layout changes are co-designed with the operator (memory: viewer UX conservative), so the skill must stop and ask before restructuring a viewer screen.

**Forced "done" checklist.** The agent pastes it with evidence:
- the `check_ui_file` output for every touched file: 0 new findings;
- the find/map table;
- any library extension listed with its barrel export, spec and catalogue regeneration;
- screenshots at 3 widths × 2 themes, with no horizontal scroll, listed;
- specs and typecheck output;
- docs touched, or "none needed: reason".

**MCP tools that make the skill executable**
- `list_ui_components(area: primitives|composites|widgets|admin-local|viewer)`.
- `get_ui_component(name)`: props, variants, TSDoc and `.prompt.md` when present, plus 2 real consumers.
- `find_ui_component(need)`: BM25 over name, TSDoc, props and the `ui.md` headings, and returns the matching convention section.
- `list_ui_tokens(platform)`.
- `check_ui_file(path|diff)`:
  - checks hex, palette classes, inline colour/spacing styles, and raw `button|table|select|dialog` (or RN `Modal`/`TouchableOpacity`) where a kit equivalent exists;
  - checks local names colliding with library exports, nested `?tab=`, and a page package missing from `@source`;
  - each finding includes the replacement.
- `scaffold_ui_component(name, area)`: writes the component, barrel export, spec and catalogue entry.
- `ui_screenshots(url|route, widths, themes)`: Playwright against the dev server; returns overflow metrics and image paths.
- Catalogue: `docs/reference/ui-components.{json,md}`, generated by `docs:generate` (ts-morph), committed (decision 5), viewer kit included. Its drift check runs inside `docs:check` (already accepted); it is not a styling gate.

### 3. Other skills

| Skill | Purpose / trigger | Tools | State |
|---|---|---|---|
| `add-capability` | New or changed `*.cap.ts`, "do I need a cap?" | `plan_capability`, `scaffold_capability`, `run_codegen`, `method_tiers_diff`, `cap_ship_plan`, `get_capability` | **Rewrite.** Add the cardinality archetypes (singleton, collection 32, deviceNative 73, device-dispatch, wrapper 13, internal 30). Fix §7 (`SKILL.md:126-130` says "deploy packages/types"; the truth is force-publish `@camstack/system` + `deploy packages/system`). Add `check-method-tiers --update`, the `CAP_INPUT_DEFAULTS` trap, hand-written interfaces that rot, and the agent `main.ts` array |
| `add-addon` | New addon or manifest entry | `scaffold_addon` (+ device-provider/storage/log-dest/export/page kinds), `validate_addon` (+ entries/icons/types-entry/page-css guards) | **Consolidate.** The repo copy (369 lines) is canonical; the pack copy (126) becomes its projection. Add a UI hand-off: "a page → `camstack-ui`" |
| `release` | "Ship this", publish train, server-side change live, viewer OTA | `release_plan`, `release_status`, `cap_ship_plan` (describe-only) | **New, a merge of** `camstack-publish-ci`, `camstack-hub-image-deploy`, `~/camstack-homelab-ops` (deploy parts) and the viewer chain (`update:patch` → `build:orchestrator` → deploy → pin). Also: applyServerUpdate +1 restart, toggle-verify, pid and capabilities re-registration, and never dispatching Checks |
| `keychain-secrets` | Any password, token or key field; `secretStatePaths` | `check_ui_file` (secret field), `search_knowledge` | **New.** Covers the schema `secret` type, no env vars, migration (`scripts/ops/keychain-migrate-hub.mjs`), the `PasswordInput`/`ConfigSecretField` UI, and reveal-in-dialog. Source: `docs/architecture/secrets-keychain.md` |
| `sync-docs` | The end of any work | `affected_checks`, `docs:check` | **Exists; keep.** Add the UI catalogue regeneration and `ui.md` triggers |
| `diagnose` | "X is broken on the hub", track or media complaints | `topology`, `cap_providers`, `list_log_destinations` + `query_logs(provider)` (asks which provider: decision 4), `recent_tracks`/`audit_tracks` | **New.** Absorbs `audit-debug-tracks` and `~/camstack-track-audit` (its script hard-codes the IP and `.tok`). Needs the ops toolset (P2) |

`camstack-api-reference` (user-level, stale: 136 caps against 167) should be deleted in favour of the generated `docs/reference/api.md` + `get_capability`. `camstack-architecture` and `camstack-viewer` fold into the repo (`architecture`, and `camstack-ui/viewer-rn` + `release`).

### 4. Consolidation

- **Canonical:** the repo's `.claude/skills/<id>/` (tracked, private repo). This is the full text, including ops traps.
- **Public pack** (`packages/develop/skills/`): generated by `scripts/skills/export-public.mjs`. It keeps only `<!-- public -->…<!-- /public -->` sections from the canonical skills, then runs `check-public-docs-private-data.ts` over the output. A drift check runs in `docs:check`, not as a styling guard. Only the add-addon, add-capability, sync-docs, architecture and a sanitized `camstack-ui` (library usage only) are exported.
- **User-level `~/.claude/skills/camstack-*`:** retired. Anything genuinely machine-private (hostnames, token locations) moves to a private overlay dir (for example `~/.camstack/develop/skills/`), which the private MCP merges in, labelled `private`. Memory is served the same way (decision 1).
- **One `get_skill`** resolves overlay → repo → pack, and reports which layer answered.

### 5. Phasing

- **Phase 0, about 0.5 day, no MCP needed:**
  - rewrite `frontend-architect` into a tracked `camstack-ui-engineer`;
  - add the `AGENTS.md` row (root + viewer);
  - add the coordinator brief template.
  - This alone fixes most of the observed failure.
- **Phase 1, about 3 days (the UI slice of plan P1, done first):**
  - the `camstack-ui` skill and its references;
  - the catalogue generator + committed `ui-components.{json,md}`;
  - `find/get/list_ui_component`, `list_ui_tokens`, `check_ui_file` in `@camstack/develop` with CLI twins;
  - private-MCP skill serving (scan-based `list_skills`/`get_skill`, resources, the `new-ui-surface` prompt);
  - a `camstack-dev` entry in `.mcp.json`;
  - an MCP-level spawn test.
- **Phase 2, about 1.5 days:** `scaffold_ui_component`, `ui_screenshots`.
- **Then:** `add-capability` rewrite with the cap tools (plan P1 caps, about 2 days); `release` (about 1 day, describe-only tools); `keychain-secrets` (0.5 day); `diagnose` after the ops toolset (P2).
- **Roadmap:** the "NEXT TODO private developer MCP" item keeps its P1–P4. The UI slice + Phase 0 move to the front, and P4 consolidation starts with the export script once two skills are canonical. The item is still flagged "do not start without the operator".

### 6. Open questions (with a recommendation for each)

1. **Is the rewritten UI agent strictly conservative?** Recommended: yes, "consistency over distinction". New visual language only through an explicit operator-approved ui-library change.
2. **Track `.claude/agents/` in git** (gitignore re-include) so agent definitions are shared and reviewed like skills? Recommended: yes.
3. **Should the viewer get its own skill or one combined `camstack-ui`?** Recommended: one skill, with a `viewer-rn.md` reference and a hard "ask before changing viewer layout" gate.
4. **Should `check_ui_file` run in a local pre-commit hook (warn only, never blocking) for touched UI files?** Recommended: warn-only on staged files. This respects "no CI gate" while catching new drift at the source.
5. **Pay down the existing drift (about 120 palette-class files, the duplicate StatusBadge/DetectionOverlay, raw buttons in dialogs) as a dedicated batch,** or only on touch? Recommended: on touch, plus one small batch for the two duplicates and the dialog-close buttons, as cheap high-signal examples for the skill.

**Files referenced:**
- `.claude/agents/frontend-architect.md` (deleted 2026-10-09) <!-- drift-ok: removed by this plan -->
- `.claude/skills/`
- `packages/develop/skills/`
- `docs/architecture/ui.md`
- `docs/design/2026-10-09-developer-mcp-plan.md`
- `AGENTS.md` (skills table `:349`)
- `packages/ui-library/src/tailwind/camstack-theme.css`
- `camstack/src/theme/tokens.ts`

No code was changed and nothing was committed.
---

## Operator decisions (2026-10-09)

- **Target = external harnesses** (Codex, Cursor, fresh Claude Code sessions), not only this coordinator's subagents. Discovery goes through AGENTS.md (root + UI packages) plus `.claude/skills` plus the private MCP. One source.
- **Skill structure: THREE skills.**
  - `camstack-ui`: the umbrella. Common components and tokens shared by both UIs, the workflow gates, the decision of which sub-skill applies, and the shared token mapping (`camstack-theme.css` ↔ viewer `tokens.ts`).
  - `camstack-ui-admin`: admin-ui web, ui-library, addon pages (Module Federation, `@source`/D747), page patterns (AdminPage, AdminTabs, IntegrationHub, DataTable, Dialog, secret field…).
  - `camstack-ui-viewer`: viewer React Native kit, `tokens.ts`, SheetModal / PickerSheet, the embed player, i18n en+it, "ask the operator before changing viewer layout".
  - The umbrella links the two and owns what is common; each sub-skill links back.
- `docs/architecture/ui.md` is converted into these skills. It stays slim as architecture, with no duplication.
- No CI styling gate (`check_ui_file` is a developer tool only).
- Status: implemented 2026-10-09 (see "Implementation record").

## Revised design for external harnesses (2026-10-09, supersedes §2 where they differ)

### What is broken today

- **External harnesses cannot find the UI rules.**
  - There is no `AGENTS.md` in `packages/addon-admin-ui` or `packages/ui-library`, and no `.cursor/` folder.
  - The root `AGENTS.md` mentions `ui.md` only as one row of a docs table, and its skills table has no UI entry.
  - `docs/architecture/ui.md` is 2,025 lines that mix architecture with build rules, and it contains no workflow.
- **`.claude/agents/frontend-architect.md` works against the design system.** It says "vary themes, never converge" and asks for unusual fonts, gradient meshes and noise. It is untracked and refers to a stale `useApi()` hook.
- **Skills under `.claude/` escape the docs drift check** (`scripts/check-docs-drift.ts`). That is how the `add-capability` "Ship it" section went stale unnoticed.
- **Measured drift:**
  - about 120 component files use Tailwind palette classes;
  - 10 admin-ui files and 29 viewer files use raw hex;
  - `<button>` appears raw in 10 files, `<table>` in 15 and `<select>` in 4;
  - `shared/StatusBadge.tsx` and `shared/DetectionOverlay.tsx` duplicate library components.

### Structure (mapped onto the three-skill decision)

- **Workflow** lives in three skill files:
  - `.claude/skills/camstack-ui/SKILL.md`, the umbrella. It holds the common components, the tokens and the gates, and routes to a sub-skill.
  - `.claude/skills/camstack-ui-admin/SKILL.md`.
  - `.claude/skills/camstack-ui-viewer/SKILL.md`.
- **Rules and catalogue** live in `docs/ui/*.md`, so the drift check covers them:
  - `conventions.md`, `common-components.md`, `admin-patterns.md`, `viewer.md`, `need-x-use-y.md`, `anti-patterns.md`.
  - `ui.md` shrinks to about 1,150 lines of pure architecture.
- **Generated pointers**, 6–10 lines each, written by one script. Pointers are generated because copies drift and symlinks break on Windows and in npm tarballs. Targets:
  - the root, ui-library, admin-ui and viewer `AGENTS.md` files, plus every package that ships an addon page;
  - `.cursor/rules/camstack-ui.mdc`, set to auto-attach on UI globs.
- **Private developer MCP** serves the same skill and docs files with no copy, as phase 1 of that plan.
- **Scripts (no MCP needed):**
  - `npm run ui:find "<need>"` searches a committed catalogue that also covers the viewer kit;
  - `ui:show <Component>` prints a component's details;
  - `ui:tokens [admin|viewer]` prints the colour tokens for each UI;
  - `ui:check <files>` flags raw colours, palette classes, inline styles, and hand-rolled buttons, tables and dialogs, each with a suggested replacement. It runs locally only and is never a CI gate.
- **Done gate inside the skill:** paste the `ui:check` output and the screenshot measurements before claiming done.
- **Agent:** rewrite `frontend-architect` as a conservative, tracked `camstack-ui-engineer` that preloads the umbrella skill, or delete it.

### Effort

| Work | Estimate |
| --- | --- |
| Split `ui.md`, write the 3 skills and the pointers, rewrite the agent | ~1 d |
| Scripts and catalogue | ~2 d |
| MCP serving, scaffolding and screenshots | ~1.5 d |

### Open questions (recommendation in brackets)

1. Split `ui.md` into `docs/ui/*` as above? [yes]
2. Add `docs:check --pointers` to verify the pointers exist and are current? [yes; this is a docs check, not a styling gate]
3. Add a warn-only `ui:check` in pre-commit? [yes, never blocking]
4. Add a tracked `camstack-ui-engineer` agent, which means un-ignoring `.claude/agents`? [yes]
5. Give the viewer its own catalogue and `ui:check` inside the viewer repo? [yes, because the viewer is a separate repo]

Status: implemented 2026-10-09 — see below.

## Implementation record (2026-10-09)

### Answers to the five open questions (operator: yes to each)

1. **Split `ui.md` into `docs/ui/*`?** Yes. `docs/ui/` holds `README.md`,
   `conventions.md`, `common-components.md`, `need-x-use-y.md`,
   `admin-patterns.md`, `viewer.md` and `anti-patterns.md`. The build rules
   moved verbatim (library first, narrow viewports, overflow, the safe area,
   frozen-string tests, confirmation copy → conventions; addon-page CSS,
   tables, integration pages, System tabs, tall dialogs, destructive diffs →
   admin patterns). `docs/architecture/ui.md` went from 2,025 to ~1,440 lines
   of architecture and links to `docs/ui/`; each moved section's `applies-to`
   moved with it. The docs drift check covers `docs/ui/` (it is under
   `docs/`) and now also walks `.claude/skills/**` — which immediately found
   three dead paths in two older skills, fixed.
2. **`docs:check` verifies the pointers?** Yes. `npm run docs:check` now ends
   with `tsx scripts/ui/gen-ui-pointers.ts --check` (since the generic-skills batch below: `scripts/skills/gen-skill-pointers.ts --check`) and
   `tsx scripts/ui/gen-ui-catalogue.ts --check`. A docs check, not a styling
   gate.
3. **Warn-only `ui:check` in pre-commit?** Yes. `.husky/pre-commit` runs
   `scripts/ui/cli.ts check --staged --warn || true` on staged UI files, and
   regenerates `docs/reference/ui-components.json` when ui-library source, the
   theme or the need table is staged. Never in CI.
4. **Tracked `camstack-ui-engineer` agent?** Yes.
   `.claude/agents/camstack-ui-engineer.md` (frontmatter `skills: [camstack-ui,
   sync-docs]`, which Claude Code injects in full at subagent start).
   `.gitignore` re-includes `.claude/agents/` and then only that file by
   name. The untracked "distinctive aesthetics" agent was deleted.
5. **Viewer gets its own catalogue and `ui:check`?** Yes, in the viewer
   repository: `scripts/ui/` there, its own `.cursor/rules`, and an
   `AGENTS.md` pointer to the viewer skill.

### How each harness discovers the skills (verified 2026-10-09)

| Harness | Reads | Source |
| --- | --- | --- |
| Cursor | `.cursor/rules/*.mdc` with frontmatter `description`, `globs` (comma-separated string), `alwaysApply`; `alwaysApply: false` + `globs` = auto-attached when a matching file is in context, `description` only = agent-requested. A plain `.md` in `.cursor/rules` is ignored. A rule body's `@file` mention tells the agent where to look; it is not inlined. | <https://cursor.com/docs/context/rules> |
| Cursor | `AGENTS.md` at the root AND nested in subdirectories ("automatically applied when working with files in that directory or its children"; more specific wins). | <https://cursor.com/docs/context/rules> |
| Cursor | Agent Skills from `.agents/skills/`, `.cursor/skills/` and, for compatibility, `.claude/skills/` and `.codex/skills/` (plus the `~/` equivalents). `SKILL.md` needs `name` (= folder name) and `description`; optional `paths` restricts it to matching files. The agent picks skills by description, or the user types `/name`. | <https://cursor.com/docs/context/skills> |
| Codex | `AGENTS.md` from the repo root down to the working directory, concatenated (`AGENTS.override.md` first per directory), 32 KiB default cap; no `@import`. Skills only from `.agents/skills` (cwd up to the repo root) and `~/.agents/skills` — **not** `.claude/skills`. | <https://learn.chatgpt.com/docs/agent-configuration/agents-md>, <https://learn.chatgpt.com/docs/build-skills> |
| Claude Code | `.claude/skills/<name>/SKILL.md` natively; `CLAUDE.md` = `@AGENTS.md` at the root and per package (nested `CLAUDE.md` loads when files under it are read); subagent `skills:` preloads full skill content. | <https://code.claude.com/docs/en/sub-agents> |

So the wiring is:

- **One source:** `.claude/skills/camstack-ui{,-admin,-viewer}/SKILL.md` +
  `docs/ui/*.md`. Nothing else holds rule text.
- **Cursor** gets the skills directly (it reads `.claude/skills/`), plus three
  generated rules: `camstack-ui.mdc` (agent-requested, for planning before a
  file is open), `camstack-ui-admin.mdc` (auto-attached on
  `packages/addon-admin-ui/src/**`, `packages/ui-library/src/**`,
  `packages/addon-agent-ui/src/**`, every tree the admin-ui stylesheet
  `@source`s — page packages and widget folders — and
  `packages/addon-*/src/**/*.tsx`), `camstack-ui-viewer.mdc` (auto-attached on
  `camstack/src/**`, `camstack/app/**`, `camstack/embed/src/**`,
  `camstack/locales/**`). Each is a 6-line pointer plus `@` mentions of the
  skill files, and the nested `AGENTS.md` files apply as well.
- **Codex** gets the root `AGENTS.md` block and the skills-table rows, and a
  package `AGENTS.md` block when it runs inside a UI package. It opens the
  `SKILL.md` as a file. A generated `.agents/skills/` wrapper was NOT added:
  Cursor also scans `.agents/skills/`, so it would list every UI skill twice
  with unspecified precedence.
- **Claude Code** discovers the three skills natively; the root and package
  `CLAUDE.md` files import the same `AGENTS.md` blocks.
- The generator was `scripts/ui/gen-ui-pointers.ts` — now `scripts/skills/gen-skill-pointers.ts`, see "Generic skills batch" (targets: root,
  `addon-admin-ui`, `ui-library`, `addon-agent-ui`, and every package that
  declares an addon page — `addon-benchmark`, `addon-model-studio`,
  `addon-osd-manager`, `addon-training`; missing `AGENTS.md`/`CLAUDE.md` are
  created). Specs: `scripts/__tests__/ui-pointers.spec.ts` (now `skill-pointers-ui.spec.ts`),
  `ui-check.spec.ts`, `ui-catalogue.spec.ts`.

How it was verified: the Cursor and Codex facts above were read from the
vendor docs on 2026-10-09; the generated `.mdc` frontmatter is pinned by a
spec (description, comma-separated `globs`, `alwaysApply: false`); the
`--check` mode was run green; no Cursor or Codex session was driven
end-to-end from this machine.

### What differs from the plan above

- No MCP work (operator constraint). The scripts are `scripts/ui/*.ts` run
  with `tsx`, not `@camstack/develop` functions; the MCP can wrap them later.
- The catalogue is `docs/reference/ui-components.json` only (no `.md`), web
  library only; the viewer's kit has its own catalogue in its repository.
- `ConfigSecretField` (§2) does not exist; the secret field is
  `SecretFieldControl` (+ `PasswordInput`).
- `shared/DetectionOverlay.tsx` is a re-export of the library's, not a
  duplicate. The real local look-alikes `ui:check` finds are
  `shared/StatusBadge.tsx`, `device/FloatingPanel.tsx`, a `NodePicker` in
  `pages/system/scope-pickers.tsx`, a `StatCard` in the device overview
  adapters, and a `StatusBadge` in the new `access/credential-columns.tsx`.
- `ui:check` baseline (2,341 findings in 428 of 1,158 UI files, measured on
  the tree after the Tokens & sessions rework landed) is in
  `docs/ui/anti-patterns.md`. The drift is paid down on touch; nothing was
  fixed here.

## Generic skills batch (2026-10-09)

Status: **implemented 2026-10-09.** The UI pattern (one source in
`.claude/skills/`, long form in `docs/`, generated pointers for harnesses that
do not read `.claude/skills`) extended to every procedure an agent needs to
change this repository. Answers the "Other skills" and "Consolidation"
sections above.

### What exists now

| Skill | Was | Job |
| --- | --- | --- |
| `camstack-docs` | `sync-docs` (renamed, extended) | which docs exist, what is generated and how to regenerate it, the ADR ladder and numbering, `applies-to`/`covers`, generated-file conflicts (take a side, regenerate), skills and pointers |
| `camstack-capability` | `add-capability` (renamed, rewritten) | need-a-cap check, cardinality archetypes (node-hosted = `singleton`, never `per-node`), auth tiers, codegen, `CAP_INPUT_DEFAULTS`, provider selection by binding, generated-client typing, force-publish `@camstack/system`; its stale "Ship it" fixed |
| `camstack-server-change` | new | the server-side spine: three channels, typecheck ≠ build, `.d.ts` sweep, dev `deploy-server`, publish → `applyServerUpdate` per node → verify, registry lag, CI rules |
| `camstack-addon` | `add-addon` (renamed, extended) | runtime traps (`super({})`, two device stores, forked slice staleness, `declareCollection`), `camstack deploy` traps and proof the new code runs |
| `camstack-secrets` | new | declare by type, resolved reads and markers, no env/argv, 0600 files for children, the five secret guards |
| `camstack-diagnose` | new; absorbed `camstack-server-api` | calling the API, what is running, three log tiers, where work ran, instrument first, error-signature table |
| `camstack-publish-ci` | kept, rewritten | stale workflow/image/desktop names fixed; operator account removed; `force_packages` for caps; registry lag; tag rules |
| `camstack-hub-image-deploy` | kept, made generic | `applyServerUpdate` first; backups; the recurring traps; when an image is really needed; the dev overlay image. Hosts, Unraid scripts and the Mac app swap moved to the operator's user-level skill |
| `audit-debug-tracks`, `camstack-ui*` | unchanged | — |

`publish-ci` and `hub-image-deploy` overlapped on the publish half; the
publish half is now only in `publish-ci`, the node half only in
`hub-image-deploy`, and `camstack-server-change` routes between them. A
separate `release` skill (§3 above) was not created: the three are sharper
apart.

### Pointer generator

`scripts/ui/gen-ui-pointers.ts` became `scripts/skills/gen-skill-pointers.ts`
(`npm run docs:pointers`; `--check` inside `npm run docs:check`):

- `scripts/skills/lib/pointer-blocks.ts` — the engine (markers, splice, remove
  orphaned blocks, create `AGENTS.md` + `CLAUDE.md`, `.mdc`, Codex budget).
- `scripts/skills/lib/ui-pointers.ts` — the UI blocks, unchanged in content.
- `scripts/skills/lib/skill-registry.ts` — one entry per skill: the root-table
  cell, the package `AGENTS.md` it is listed in (`server/backend` — created —,
  `packages/system`, `packages/types`, every `packages/addon-*` that has an
  `AGENTS.md`), its `.cursor/rules/<id>.mdc` (glob-attached where a natural
  path set exists — `docs/**`, `packages/types/src/capabilities/**`,
  `.github/workflows/**` — agent-requested otherwise) and its long-form docs.
- The check fails on: a stale or missing pointer, an unregistered skill, a
  frontmatter `name` ≠ folder (Cursor requires them equal), a dead doc or rule
  glob, and a root `AGENTS.md` over 28 KiB of Codex's 32 KiB. A root + package
  chain over 32 KiB is reported, not failed: five package files
  (`addon-ai`, `addon-export-alexa`, `addon-export-google`,
  `addon-provider-hikvision`, `addon-provider-homeassistant`) were already
  over before this batch and `addon-provider-reolink` is ~200 bytes over
  after it. New package blocks are therefore inserted BEFORE the first section,
  so the tail Codex drops is never the pointer.
- Specs: `scripts/__tests__/skill-pointers.spec.ts`,
  `scripts/__tests__/skill-pointers-ui.spec.ts`.

### Inventory classification

Classes: (a) generic project procedure → repo skill · (b) operator / homelab
specific → stays user-level · (c) stale or superseded · (h) a historical or
state record with no reusable procedure → stays where it is.

| Source | Items | (a) | (b) | (c) | (h) | Where (a) went |
| --- | --- | --- | --- | --- | --- | --- |
| Repo `.claude/skills/*/` | 10 | 10 (2 partly b, 3 partly c) | — | — | — | renamed / rewritten above; `camstack-server-api` merged into `camstack-diagnose` |
| Repo single-file `.claude/skills/*.md` (graph-tool helpers) | 4 | — | — | 4 (not discovered by Claude Code; not CamStack-specific) | — | left in place, question to the operator |
| Repo `.claude/agents/` | 1 | 1 | — | — | — | preloads `camstack-ui` + `camstack-docs` |
| User-level `camstack-*` skills | 5 | 3 partly (architecture, homelab-ops, track-audit) | 3 partly (homelab-ops, track-audit, viewer) | 1 (api-reference, 136 of 167 caps) | — | architecture → `camstack-capability` / `camstack-diagnose` + docs; api-reference → `docs/reference/api.md`; viewer was already a pointer |
| User-level `homelab-*`, `grafana-query`, `loki-logs`, `homeassistant` | 7 | — | 7 | — | — | untouched (not CamStack) |
| Operator memory notes | 164 | 82 | 14 | 13 | 55 | below |
| `AGENTS.md` / `CLAUDE.md` | 18 + per-package `CLAUDE.md` | rules stay; skill tables now generated | the root D328 rule names this hub's DB paths | — | — | skills link into them |
| `docs/architecture`, `docs/decisions`, (planning repo: sessions/) | — | long form, linked not copied | — | 1 found (below) | sessions/shipped are history | every skill links its pages |

Memory (a) by primary target: `camstack-addon` 17, `camstack-capability` 14,
`camstack-server-change` 11, `camstack-diagnose` 7 (it also took the error
signatures of many (h) incident notes), `camstack-publish-ci` 5,
`camstack-hub-image-deploy` 3, `camstack-docs` 3, `camstack-secrets` 1,
UI/viewer 6 (already in the `camstack-ui*` skills or the viewer repository),
agent and git workflow 7 (worktrees, the shared index, never `git add -A`, no
external product names in code — not carried; candidates for the root
`AGENTS.md` "Working style"), subsystem internals 8 (pipeline, notifications,
recording — they belong in their architecture pages, not a workflow skill).
The lessons carried into a skill were checked against the code; four were not
carried because
the code no longer matches (a `DEVICE_SCOPED_NATIVE` allowlist that no longer
exists, a `deployment:generate` script that does not exist, the "+1 restart"
for builtins — both roles now load builtins from the closure — and the
custom-action ESM cache, fixed by `importAddonModuleFresh`).

### Found stale while verifying (not fixed here)

- `docs/architecture/update-and-release.md` §"Deploying a framework change in
  development" still says an agent's addon-root `@camstack/system` is "the
  node's only builtin infra" (D87); `server/backend/src/agent/main.ts` now
  loads builtins from the closure and skips that copy.
- `scripts/hub/hub.mjs` hard-codes one hub's LAN address in a tracked file.
- `packages/develop/skills/` (the public pack) still uses the old names
  (`add-addon`, `add-capability`, `sync-docs`); it is a separate, published
  projection and was not regenerated.

## Workflow entry point and ui:shots (2026-10-11)

Status: **implemented 2026-10-11.** No ADR: no architectural alternative was
rejected; the choices below are recorded here.

### `camstack-workflow`

One skill every change goes through: understand → design → plan → build (TDD)
→ verify → document → ship → report, each with a gate and the evidence it
needs, and a definition-of-done block at the end. It holds the WHAT for this
repository (gates, commands, evidence); the domain skills hold the details;
the superpowers process skills, when installed, hold the HOW. Ordering that
avoids a fight with superpowers: `superpowers:brainstorming` ends only in
`superpowers:writing-plans`, so `camstack-workflow` is loaded BEFORE
brainstorming (its gates shape the design) and consulted again at plan,
verify and done. Without superpowers (Cursor, Codex) the skill's inline steps
are the whole process.

Questions to the operator go through each harness's native prompt, verified
2026-10-11:

| Harness | Mechanism | Source |
| --- | --- | --- |
| Claude Code | `AskUserQuestion` (multiple choice, "Other" free text) | https://code.claude.com/docs/en/tools-reference#askuserquestion-tool-behavior |
| Cursor | `AskQuestion` ("Ask questions" agent tool), interactive UI for Plan-mode clarifying questions (Shift+Tab); in Agent mode it depends on the model — disabled for some, including when Auto routes to them | https://cursor.com/docs/agent/tools, https://cursor.com/docs/agent/plan-mode, https://cursor.com/changelog/2-1, https://forum.cursor.com/t/askquestion-is-unavailable-in-auto-mode/165683 |
| Codex | `request_user_input` in the Plan collaboration mode (2–4 options + a recommended default); default mode only with `default_mode_request_user_input = true` (0.106+) | https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md, https://github.com/openai/codex/issues/10384 |

Fallback everywhere: a numbered list with the recommendation marked, then stop.

Pointers (generated by `scripts/skills/gen-skill-pointers.ts`):

- the root skills table, first row;
- a `workflow-pointer` block first under the root "Working style" (new
  placement `under-heading` in `pointer-blocks.ts`; registry field `rootRule`);
- `.cursor/rules/camstack-workflow.mdc` with `alwaysApply: true` and a
  three-line body. Cursor's rule types (always / intelligent / globs / manual,
  https://cursor.com/docs/context/rules) leave "always" as the only one that
  reaches every request; Agent Skills are chosen by relevance and not always
  in context (https://cursor.com/docs/context/skills). The body therefore
  stays tiny and does not `@`-attach the skill file.

The root `AGENTS.md` ended 27 bytes SMALLER than before (two redundant
paragraphs trimmed): the added lines had pushed root + `addon-pipeline`
over Codex's 32 KiB cap.

### `npm run ui:shots`

`scripts/ui/shots/`: a Vite harness serving the real admin-ui source with
four modules swapped (backend/transport answer tRPC from fixture files, auth
is a signed-in admin, addon pages load from workspace source, no socket
watchdog), driven by Playwright. Per route × theme × viewport it records a
screenshot and measures document and `<main>` horizontal overflow, the
outermost elements crossing the viewport edge outside any scroll container,
and whether sticky / fixed elements stay on screen after a scroll; it writes
`report.md` + `report.json`, and `--compare` flags regressions against an
earlier run. Fixtures are one file per admin area (`fixtures/<area>.ts`,
contract in `_define.ts`; `shell.ts` always loaded). Specs:
`scripts/__tests__/ui-shots.spec.ts` (args, measurement on a fake DOM,
report) and `ui-shots.integration.spec.ts` (a real run; skipped without
Playwright's Chromium).

Choices: under `scripts/ui/` rather than `e2e/`, because `e2e/` boots a
real hub per suite and this needs none; Vite dev server rather than a
production build, because the stubs swap modules at resolve time and a cold
dev start is a few seconds.
