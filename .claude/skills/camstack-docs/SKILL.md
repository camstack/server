---
name: camstack-docs
description: Keep CamStack's documentation true after any change — a new addon, a capability, a UI surface, a fix, a decision, a skill. Use at the END of every piece of work ("do the docs need updating?"), before writing an ADR, when a generated docs file conflicts in a rebase, when `npm run docs:check` is red, or when adding/editing a repo skill or an AGENTS.md. Says which docs exist, which are generated and must never be hand-edited, and how to regenerate them.
---

# Keeping the docs true (repository overlay)

The canonical PUBLIC text is `packages/develop/skills/camstack-docs.md` (shipped with `@camstack/develop`; `camstack develop skill camstack-docs`): the generic rules for any addon author. This file is the REPOSITORY-specific procedure on top of it (ADR ladder, `docs:check`, skill pointers, the public docs repo) and keeps none of the pack's headings. `scripts/check-skill-pack-sync.ts` enforces that.

The rule, from [D19](../../../docs/decisions/adr-0019.md): **anything derivable
from the repository is generated; anything else is prose and is guarded.** Your
job is only the prose. The map of every page is `docs/README.md`.

## 0. Workflow — run it at the end of every piece of work

1. **Regenerate** what your change feeds (§1). The pre-commit hook does most of
   it; run it yourself when the hook did not see the input (a schema file a
   cap imports, a UI library export, a skill).
2. **Decide the prose** with the ladder in §3 — stop at the first yes.
3. **Write it** in English (`scripts/check-docs-english.ts` refuses anything
   else under `docs/**`). Working notes live in the sibling planning repo.
4. **Check**: `npm run docs:check` green (§5).
5. **Paste the done-gate** (§7).

## 1. Never hand-edit these — regenerate them

| File | Derived from | Regenerate |
| --- | --- | --- |
| `docs/reference/packages.md`, `addons.md`, `capabilities.md`, `guards.md`, `storage.md` | manifests, `*.cap.ts`, `scripts/check-*` + workflows, `@durable` store constants | `npx tsx scripts/docs-generate.ts` |
| `docs/reference/subsystems.md`, `coverage.md` | `docs/subsystems.yaml` × the workspace × every doc's frontmatter | same |
| `docs/reference/api.md`, `api-schemas.md` | every `*.cap.ts`, Zod shapes resolved transitively | `npx tsx scripts/gen-api-reference.ts` |
| `docs/decisions/index.md` | each ADR's frontmatter | `npx tsx scripts/docs-generate.ts` |
| `docs/reference/ui-components.json` | the ui-library barrels + the need table | `npm run ui:catalogue` |
| skill pointers: the skills table and package blocks in `AGENTS.md`, `.cursor/rules/*.mdc` | `scripts/skills/lib/skill-registry.ts`, `ui-pointers.ts` | `npm run docs:pointers` |

`npm run docs:generate` runs the first three rows. They carry a DO-NOT-EDIT
banner; the pre-commit hook (`.husky/pre-commit`) regenerates and re-stages
them when a manifest, a `*.cap.ts`, an ADR or anything under
`packages/types/src` is in the commit; `docs:check` fails on drift. So a new
addon or capability documents itself — **do not** also describe it in prose
that a table already covers. Duplicated facts are what rotted the last docs.

**A generated file conflicts in a rebase or merge?** Never hand-merge it. Take
either side, then regenerate from the merged sources and stage the result:

```bash
git checkout --ours docs/reference/<file>     # during a REBASE "ours" is upstream; either side is fine
npm run docs:generate && npm run ui:catalogue && npm run docs:pointers
git add docs/reference docs/decisions/index.md AGENTS.md .cursor/rules
```

## 2. Which docs exist (hand-written)

| Where | What goes there |
| --- | --- |
| `docs/architecture/*.md` | how a whole subsystem behaves — one page per subsystem, `last-verified` in frontmatter |
| `docs/decisions/adr-*.md` | one rule per record; numbering and rules in `docs/decisions/conventions.md`, template `docs/decisions/template.md` |
| `docs/ui/*.md` | UI build rules (the `camstack-ui` skills apply them) |
| `docs/addons/<package>.md` | a package's notes when its `AGENTS.md` would push root + package past Codex's 32 KiB; the `AGENTS.md` keeps the intro and a link |
| `../planning/sessions/` | the private diary: one file per month of what changed and what was learned; `sessions/sessions.md` is the index. Clone github.com/camstack/planning as a sibling of this checkout |
| `docs/design/*.md` | plans and analyses, dated; a plan records its own "implemented" status |
| planning repo `superpowers/`, `.superpowers/`, `archive/` | working specs, plans, reports and handovers. Not in this repository |
| `docs/benchmarks/*.md` | measured comparisons, dated |
| `docs/subsystems.yaml` | the ONLY hand-written index: the chapter list (§4) |
| `AGENTS.md` (root and per package) | rules and pointers, never facts; `CLAUDE.md` beside each is `@AGENTS.md` |
| `.claude/skills/<id>/SKILL.md` | procedures (§6) |

There is no internal docs site in this repository. The **public** user documentation is a separate repository,
`camstack/docs` (Next.js + fumadocs) — §8.

## 3. Decide what to write — stop at the first yes

Read a page with `search_knowledge`, then `read_section` on the returned id.
Do not open a whole architecture page.

**Did you learn something a future session would waste time rediscovering?**
→ `../planning/sessions/<YYYY-MM>.md` (`cat >>`, never the index). Include the wrong turns: a
wrong first diagnosis is the most valuable thing in that file, because it is the
only part not recoverable from the diff.

**Did you choose between real alternatives?** → an ADR (§3a).

**Did you change how a whole subsystem behaves?** → the matching
`docs/architecture/*.md`, and bump its `last-verified`. One more addon of an
existing kind is **not** this.

**Are there traps inside one package a future session will hit?** → that
package's `AGENTS.md`, short and specific — or its `docs/addons/<package>.md` when it has one (e.g. `docs/addons/addon-provider-reolink.md`).
Never inside a generated block.

**Is it a rule that should hold repo-wide?** → root `AGENTS.md`, one line,
pointing at the record. Mind the size: Codex reads at most 32 KiB of
`AGENTS.md` (root + nested, concatenated) and `docs:check` fails past it. And
prefer a guard: new guards go in `scripts/` and are wired into
`.github/workflows/checks.yml`; they then appear in `guards.md` on their own.

**Did you change what an ecosystem export publishes** (an Alexa interface, a
HomeKit service)? → the exporter's `AGENTS.md` endpoint table and its public
page; a new Alexa capability also adds its device to
`endpoint-shape-validation.spec.ts` (D769).

**Did you change the container contract** (an env var read, a port, a volume,
a device)? → mirror it by hand in the Unraid templates repository and the
public docs' Compose example (D717); nothing checks either.

**Did the backlog move?** → the planning board (https://github.com/orgs/camstack/projects/1) in the same piece of work.

### 3a. When a change needs an ADR, and how to write one

Write one when you chose between real alternatives, when you are about to
change or work around an existing rule (supersede it — never quietly bypass
it), or when a reviewer would otherwise ask "why not X?". A choice with no
rejected alternative is not a decision; do not manufacture one.

1. Next free number: `next_adr_number` (the adr files in `docs/decisions/`, not
   `docs/decisions/index.md`).
   Two parallel sessions taking the same number is caught by
   `scripts/check-decision-ids-unique.ts` — rebase on `origin/main` before
   numbering.
2. Copy `docs/decisions/template.md` to `adr-NNNN-<rule-as-a-slug>.md`; set
   `id: DNNNN`, `status`, `date`, `applies-to`.
3. State it as a rule someone could violate; the Context must contain the
   **failure**; fill in Enforcement even when it is "review only".
4. Never edit an accepted record. Supersede it (`supersedes: DNN`) and set the
   old one's status to `superseded`.

The index regenerates on commit.

## 4. Frontmatter: `applies-to` vs `covers` (D145)

- **`applies-to:`** — "I verified this page against these files on
  `last-verified`." Claims coverage AND arms the staleness ratchet.
- **`covers:`** — "this page describes these files." Claims coverage, arms
  nothing. Only for a page describing a CLASS many units implement
  (`architecture/device-model.md` covers `packages/addon-provider-*/**`). Not an
  escape hatch for a page you would rather not verify.

A glob matching nothing fails `docs:check`. A source file in no chapter is a
ratchet (`scripts/check-subsystem-map.ts`, `--max-orphans` pinned at 0): touch
`docs/subsystems.yaml` when you add a subsystem, not when you add a file to one.

Staleness (`last-verified` older than its subject's last commit) is
**reported, never failed**. Read the warning; do not treat it as a blocker.

## 5. Verify (repo)

```bash
npm run docs:check      # generated files current, no dead repo paths, subsystem map, skill pointers, UI catalogue
npm run docs:drift      # the prose half alone, faster
```

Every repo path a doc mentions must resolve — `file.ts:123` line numbers
included — in `docs/**`, every `AGENTS.md`/`README.md`, and `.claude/skills/**`.
A deliberate dead path (a record describing something removed) gets
`<!-- drift-ok: why -->` on its line. The guard treats a file that declares
itself "generated by" a script path as generated and skips it whole — never
write that phrase in prose.

## 6. Skills and pointers

A repo skill is `.claude/skills/<id>/SKILL.md`, frontmatter `name: <id>`
(Cursor requires name = folder) and a `description` naming its triggers.
Claude Code and Cursor discover it; Codex does not read `.claude/skills`, so it
finds a skill only through the generated `AGENTS.md` pointers. Adding or
renaming one:

1. Write the skill: trigger description, numbered workflow, done-gate,
   verified paths only, links into `docs/` instead of copies.
2. Add its entry to `scripts/skills/lib/skill-registry.ts` (root-table cell,
   package targets, Cursor rule globs, long-form docs).
3. `npm run docs:pointers`, then `npm run docs:check` — the check fails on an
   unregistered skill, a name/folder mismatch, a dead doc or glob, a stale
   pointer, or an `AGENTS.md` chain over 32 KiB.
4. Do not add `.agents/skills/` copies: Cursor would list every skill twice.

No secrets, tokens, internal IPs, hostnames or personal accounts in a skill —
the repository may be public. Write "your hub URL" / "see your local config".

## 7. The done-gate — paste it before "done"

```
DOCS DONE — <change>
generated:  <regenerated files, or "hook covered it">
prose:      <files touched, or "none needed: <reason from the §3 ladder>">
adr:        <adr-NNNN-… | "none: no rejected alternative">
planning:   <board issue moved/added | "no backlog change">
docs:check: <output tail — green>
```

## 8. Did you change what a PUBLIC page describes?

The public site is the `camstack/docs` repository (a local clone usually sits
next to this one, pages under `content/docs/**.mdx`). Its pages carry the same
`applies-to:` / `covers:` / `last-verified:` frontmatter, with globs relative to
THIS repo (`camstack/…` is the viewer) — [D751](../../../docs/decisions/adr-0751-a-public-docs-page-claims-the-server-code-it-describes-and-its-staleness-is-a-reminder.md).
At the end of the work:

```bash
npm run docs:public-stale     # public pages describing code that changed since they were verified
```

It is a **reminder** (exit 0; `--strict` to fail). For each page listed:

- [ ] read it against the code; fix what is wrong (operator-facing wording — no
      decision ids, no "previously"; the docs repo's `check:text` refuses them);
- [ ] bump `last-verified` only after that read;
- [ ] a new public page names precise files in `applies-to:`;
- [ ] in the docs repo, `npm run build` and `npm run types:check`, commit there
      with explicit paths.

## Do not (repo)

- Restate a generated table in prose, or edit inside a generated block.
- Leave a doc comment describing behaviour you deleted — an orphaned comment
  describing the right design reads as verification and has hidden live bugs
  here three times.
- Add an architecture page for one addon, or an ADR with no alternative.
