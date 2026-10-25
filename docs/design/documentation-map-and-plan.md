---
title: Mapping the whole system — the documentation census, the coverage matrix, and an index strategy that cannot rot
date: 2026-08-14
status: analysis + proposal. §3 and Section 0 of §4 were BUILT on 2026-08-14 (see the Section 0 note below); §4.3 sections 1-10 are still a plan.
---

# Mapping the whole system

The operator's ask, verbatim: *"serve capire come fare a mappare l'intero sistema
con almeno INDICI, per poi in futuro concentrarsi sulla vera documentazione
sezione per sezione."* [we need to work out how to map the whole system with at
least INDEXES, so that in the future we can concentrate on the real
documentation section by section.]

So this document answers three questions and nothing else:

1. **What documentation exists today**, by class and by freshness (§1).
2. **What the system actually consists of**, and which parts of it no document
   describes (§2). Measured, not guessed.
3. **How to index all of it so the index maintains itself** (§3), and in what
   order to write the real per-section documentation afterwards (§4).

It is a point-in-time analysis. It lives in `docs/design/` because that is where
this repository keeps documents that were true on their date — per
`docs/README.md`, that directory is *history, not documentation*. The numbers
below are dated 2026-08-14 and will rot. **That rot is the argument of §3**: the
matrix in §2 is exactly the kind of fact that must be generated, and the reason
it is hand-written here is that the generator does not exist yet.

---

## §1 — The census

### 1.1 Everything that is documentation, by class

Counts are `git ls-files`, 2026-08-14.

| Class | Where | Files | Generated? | Guarded? |
| --- | --- | --- | --- | --- |
| Generated reference | `docs/reference/` | 5 | yes, `scripts/docs-generate.ts` | CI fails on drift |
| Generated index | `docs/decisions/index.md` | 1 | yes, same script | CI fails on drift |
| Decision records | `docs/decisions/adr-*.md` | 141 | no (index is) | dead paths + `applies-to` |
| Architecture prose | `docs/architecture/` | 18 | no | dead paths + staleness ratchet |
| Design / point-in-time | `docs/design/` | 34 | no | dead paths (two are required reading) |
| Narrative history | (planning repo: sessions/) | 2 | no | dead paths | <!-- drift-ok: the diary moved to the private planning repo -->
| Entry + planning | `docs/README.md`, `roadmap.md`, `ideas.md`, `hosting.md` | 4 | no | dead paths |
| Frozen specs | (planning repo: superpowers) | 327 md | no | **excluded from every guard** |
| Frozen handovers | (planning repo: archive) | 118 | no | **excluded from every guard** |
| Repo rules | `CLAUDE.md` (root) + `camstack/CLAUDE.md` | 2 | no | dead paths |
| Package traps | 6 × `packages/*/CLAUDE.md` | 6 | no | dead paths |
| Package READMEs | `packages/sdk/README.md`, `packages/addon-provider-hikvision/README.md` | 2 | no | dead paths |
| Repo skills | `.claude/skills/` | 8 dirs | no | **nothing checks these** |

Two structural observations fall straight out of that table.

**The frozen tier is 445 files — three quarters of all documentation — and no
guard touches it.** That is the correct decision (`check-docs-drift.ts` excludes
(planning repo: archive) and (planning repo: superpowers) on purpose: their dead paths are accurate
history). But it means anything that *needs* to stay true and currently lives
there is unprotected. §2 finds one such case: the LLM / `addon-ai` design exists
only under (planning repo: superpowers), and `packages/addon-ai` has no live document at
all.

**`docs/README.md` says `superpowers/` holds "31 working specs and plans". It
holds 327 markdown files.** A count in prose is a derivable fact, and it rotted
by an order of magnitude. Same class of error the whole generated-reference tier
exists to prevent.

### 1.2 Freshness of the prose tier

`npm run docs:drift` at the start of this analysis, 2026-08-14: **19 documents
suspect**, 0 dead references across 245 checked docs. The dead-path guard is
doing its job perfectly. The freshness half was not.

The staleness ratchet in `.github/workflows/ci.yml` is pinned at
`--max-stale 3`. Eleven of the nineteen went suspect *that morning* — code under
their `applies-to` changed on 2026-08-14 — so the docs job was red, and the
ratchet, which is designed to only ever go down, sat six times below reality.

A verification pass running concurrently with this analysis brought the count to
**4** within the hour, which is the useful part of the observation: the ratchet
is not broken and the number is not hard to move. What it lacks is a *scheduled*
moment to move it. Left alone, a ratchet with no verification pass turns from a
signal into a blocker — the thing D19 was written to avoid. §4 gives verification
that moment, so the ceiling gets lowered honestly instead of raised.

Longest-suspect at the time of writing: `2026-08-03-storage-table-map.md` (11
days), `2026-07-30-detection-quality-plan.md`, `docs/hosting.md` (2026-07-26), <!-- drift-ok: moved to the private planning repo -->
`docs/ideas.md` (2026-07-26). The coverage matrix in §2.3 was measured against <!-- drift-ok: moved to the private planning repo -->
the *pre-pass* state; several of its ⚠️ rows are a verification pass, not a
rewrite, and some have already been closed. That the matrix aged inside a single
session is the argument of §3, not a flaw in it.

### 1.3 Things that are indices but are not in `docs/`

- **`scripts/gen-api-reference.ts`** produces the most detailed index this
  project has — every capability, every method, every resolved Zod input/output
  — and writes it to `~/.claude/skills/camstack-api-reference/references`, i.e.
  **outside the repository, on one machine**. Nothing in `package.json`,
  `.husky/pre-commit` or `.github/workflows/ci.yml` runs it. The capabilities it
  describes were last changed 2026-08-14; the output is not versioned, so its age
  is unknowable. A generator nobody runs is a generated doc with all of the rot
  and none of the guarantee.
- **`.claude/skills/camstack-server-api/SKILL.md`** was last committed <!-- drift-ok: merged into camstack-diagnose 2026-10-09 -->
  2026-04-22. `packages/types/src/capabilities/` changed 2026-08-14. Skills are
  documentation the agent reads before touching code, and nothing checks them.
- **`mkdocs.yml`** deliberately has no `nav:` block, deriving navigation from the
  directory tree. That is the right call and it is the existing precedent for
  everything §3 proposes: *the structure is derived, not typed*.

### 1.4 Documentation that describes code in other repositories

| Subject | Code | Documented in camstack-server? |
| --- | --- | --- |
| Viewer app | `camstack/` submodule (`github.com/camstack/viewer.git`), 642 files / ~102k lines | Partially — two scrub specs in `docs/design/` target it explicitly, plus `camstack/CLAUDE.md`. No page describes the app itself. |
| Home Assistant component | separate repo `homeassistant-component` (44 py / ~8.6k lines) | Yes — `docs/design/ecosystem-export-plan.md`, `docs/design/2026-08-08-ha-oauth-onboarding.md`, `docs/decisions/adr-0140.md` |
| Public user docs | separate repo `github.com/camstack/docs` | Named in `docs/README.md`, out of scope here |

### 1.5 Defects found during the census

Four, all small. **All four were closed on 2026-08-14** as the last step of
Section 0; they are recorded here as found, because the shape of each is the
argument for the guard that now catches it.

1. **`docs/decisions/adr-.md` is an empty tracked file** and it pollutes the <!-- drift-ok: the empty file this entry reports; deleted 2026-08-14 -->
   generated decision index with a broken row: `| adr | [adr-](adr-.md) |
   unknown | — |`. First row of the table, above D2.
2. **`docs/README.md` claims 31 superpowers files; there are 327.**
3. **`--max-stale 3` is below reality** — 19 at the start of this analysis, 4
   after a concurrent verification pass (§1.2). Still over the ceiling.
4. **`packages/kernel/` exists on disk with only `dist/` and `node_modules/` and <!-- drift-ok: the ghost directory this entry reports; removed 2026-08-14 -->
   is tracked by nothing.** A ghost directory. Anyone reading the tree — or an
   agent globbing for the kernel — finds compiled output and no source; the real
   kernel is `packages/system/src/kernel`. `check-docs-drift.ts` cannot catch
   this because it validates paths that *are* mentioned, not directories that
   mislead.

---

## §2 — The system map against the documentation map

### 2.1 How the system map was built

Three sources, in decreasing order of trust:

1. **The manifests.** 78 addon entries across 44 packages, 54 workspace
   packages, 149 `*.cap.ts` capability definitions. Already generated into
   `docs/reference/addons.md`, `docs/reference/packages.md`,
   `docs/reference/capabilities.md`. This is authoritative and free.
2. **The filesystem, bucketed into units.** Every package, expanded into
   `src/<subdir>` when the package exceeds 60 source files. 145 units, 2957
   non-test source files.
3. **The knowledge graph (`code-review-graph` MCP).** Tried and **rejected as a
   subsystem map.** Its 26 Leiden communities are token-named and test-dominated
   — the four largest are `tests-device` (1071), `tests-router` (914),
   `tests-session` (912), `moleculer-addon` (908), with cohesion 0.17–0.38. The
   graph is genuinely useful for `callers_of` / `get_impact_radius`; it does not
   know what a subsystem is. Recording this so the next session does not repeat
   the experiment. (It was also built at an older SHA than HEAD.)

The gap between (1) and any notion of *subsystem* is the whole problem: **no
artifact in this repository declares that "the detection pipeline" is a thing
spanning `addon-pipeline`, `addon-pipeline-orchestrator`, `types/src/pipeline`
and a Python inference pool.** That is the one fact §3 has to make explicit.

### 2.2 The measurement: who claims what

Every non-frozen document may declare `applies-to` globs in frontmatter. 172 do
(141 ADRs plus 31 architecture/design pages). Inverting that mapping over the 145
units gives a coverage map with no human judgement in it:

```
145 units · 2957 source files
 71 units claimed by at least one document   (2326 files, 79%)
 74 units claimed by nothing                  (631 files, 21%)
```

Restated: **half the units of this codebase are claimed by no document at all.**
By file count the picture is better (79% covered), because the claimed units are
the big ones — `pipeline-analytics` (182 files) is claimed by 25 documents,
`stream-broker` (123 files) by 18.

There is a second, subtler category the raw number hides: **units claimed only by
ADRs.** A decision record is normative and timeless — it says what rule holds and
why — but it never describes how a subsystem works, and by design it is never
edited after acceptance, so it carries no `last-verified` and can never be
*verified* against the code. 22 units are in this state, including the two
largest device providers:

| Unit | Files | Lines | Claimed only by |
| --- | --- | --- | --- |
| `packages/addon-provider-reolink` | 33 | 17.5k | `adr-0077` |
| `packages/addon-provider-hikvision` | 21 | 11.9k | `adr-0074`, `adr-0077` |
| `packages/addon-provider-dreame` | 36 | 6.6k | `adr-0100` |
| `server/backend/src/agent` | 16 | 4.2k | `adr-0087`, `adr-0107`, `adr-0129` |
| `packages/types/src/ffmpeg` | 8 | 2.7k | `adr-0069`, `adr-0080`, `adr-0084` |
| `server/backend/src/auth` + `packages/types/src/auth` | 4 | 0.5k | `adr-0103` |

### 2.3 The coverage matrix, by subsystem

Twenty-five subsystems. ✅ = a live page describes it and is fresh · ⚠️ = described
but stale, partial, or only inside a document about something else · ❌ = no live
document.

| # | Subsystem | Principal code | Doc coverage | State |
| --- | --- | --- | --- | --- |
| 1 | Kernel, addon lifecycle, boot | `packages/system/src/kernel` | `architecture/overview.md`, `architecture/addon-lifecycle.md` | ⚠️ both stale; **the boot contract is undocumented** (§4.1) |
| 2 | Transport & cross-node routing | `packages/system/src/kernel/transport` | `architecture/transport.md` + `design/transport-and-cross-node-routing.md` | ✅ verified 08-14 |
| 3 | Capability system & codegen | `packages/types/src/capabilities`, `scripts/codegen.ts` | `architecture/capabilities.md`, `reference/capabilities.md` | ⚠️ stale (08-08 vs 08-14) |
| 4 | Device model & providers | `packages/types/src/device` + 20 provider addons | `architecture/device-model.md` | ⚠️ model fresh; **17 of 20 providers claimed by nothing** |
| 5 | Decode & data planes | `packages/addon-pipeline/src/session-decode` | `architecture/data-planes.md`, `design/decode-path.md` | ⚠️ stale |
| 6 | Detection execution & inference | `packages/addon-pipeline/src/detection-pipeline`, `packages/addon-pipeline/python` | `architecture/detection-execution.md`, `architecture/inference-devices.md`, `architecture/object-detection.md` | ⚠️ `detection-execution.md` stale since 08-07 |
| 7 | Post-analysis: tracking & gate | `packages/addon-post-analysis/src/pipeline-analytics` | `architecture/post-analysis.md` | ⚠️ stale (08-08 vs 08-14), 182 files behind one page |
| 8 | Notification Center & rules | `packages/addon-post-analysis/src/notification-center` | `architecture/notifications.md` (1356 lines) | ✅ verified 08-14 |
| 9 | Occupancy | `notification-center/occupancy-*.ts` | inside `notifications.md`, `adr-0135`/`0136` | ⚠️ no page of its own |
| 10 | Timelapse | `notification-center/timelapse/` | `adr-0117`–`0119`, `adr-0139`, `notifications.md` | ⚠️ decisions only; **caused the 08-14 outage** |
| 11 | Artifacts & event media | `notification-center/artifact-*.ts`, `event-media/` | `design/event-media-production.md`, `adr-0139` | ⚠️ design doc has no `last-verified` |
| 12 | Track grouping | `notification-center/group/` | `design/track-grouping-analysis.md`, `adr-0143` | ✅ verified 08-14 |
| 13 | Face recognition & gallery | `pipeline-analytics/face-*`, `store/face-store.ts` | four `design/2026-06-18-face-*` plans | ⚠️ plans, not an architecture page; 2 months old |
| 14 | Plate recognition | `pipeline-analytics/plate-*` | mentions inside `post-analysis.md` | ⚠️ **no counterpart to the face plans** |
| 15 | Package detection | `pipeline/package-drop-detector.ts`, `package-zone-gate.ts` | `adr-0144`, `object-detection.md` | ⚠️ chain spans 3 packages, no doc draws it |
| 16 | Audio analysis | `addon-pipeline/src/audio-analyzer` (5 files, 1.6k) | `adr-0113`, `adr-0131` | ❌ unit claimed by nothing |
| 17 | Recorder, scrub, videoclips | `addon-pipeline/src/recorder` (63 files), `stream-broker/recorded` | 8 ADRs + 4 design docs | ⚠️ best-covered subsystem, but **no architecture page** |
| 18 | Stream broker & WebRTC | `addon-pipeline/src/stream-broker` (123 files, 47k lines) | `architecture/data-planes.md` + 17 ADRs | ⚠️ 47k lines behind a shared page |
| 19 | Zones & zone rules | `addon-pipeline-orchestrator/src/zone*`, `zone-analytics-provider.ts` | scattered across 5 docs | ⚠️ no doc owns zones |
| 20 | Storage, retention, backup | `system/src/builtins/{storage,backup}-orchestrator`, `sqlite-storage` | `design/2026-08-03-storage-table-map.md`, `reference/storage.md`, 8 ADRs | ⚠️ table map 11 days stale |
| 21 | Update, release, OTA, agent delivery | `server/backend/src/core/agent`, `packages/node-root` | `architecture/update-and-release.md` | ✅ verified 08-14 |
| 22 | Ecosystem exports (HAP / HA / Alexa) | `addon-export-hap`, `addon-export-alexa`, `provider-homeassistant/src/ha-export` | `design/ecosystem-export-plan.md` + 5 design docs + 12 ADRs | ⚠️ all stale; **`provider-homeassistant/src` and `/devices` (56 files) claimed by nothing** |
| 23 | Admin UI & ui-library | `addon-admin-ui/src`, `ui-library/src` | `architecture/ui.md` | ✅ verified 08-14 |
| 24 | Viewer app | `camstack/` submodule, 102k lines | two scrub specs + `camstack/CLAUDE.md` | ⚠️ no page describes the app |
| 25 | Automations, blocks, declared devices | `system/src/builtins/core-blocks`, `types/src/expression` | 3 design docs + `adr-0097`, `adr-0140` | ✅ recent, but plans not an architecture page |

### 2.4 The true holes — subsystems with no live document at all

Ranked by risk, not by size. "Risk" = what it costs when the next session has to
work there blind.

| Rank | Subsystem | Code | Why it matters |
| --- | --- | --- | --- |
| 1 | **Auth, scopes, method tiers** | `packages/addon-auth` (14 files), `packages/system/src/auth` (7), `server/backend/src/auth` (3), `packages/types/src/generated/scope-presets.ts`, `method-access-map.ts` (1213 lines), `scripts/check-method-tiers.ts` | The term `scope preset` appears in **zero** architecture, design, decision or reference pages. There is a generated 1213-line access map and a CI guard enforcing tiers, and no prose says what a tier means. Security blast radius; the only subsystem where "guess and see" is unacceptable. |
| 2 | **Alerts / alert-center** | `packages/system/src/builtins/alerts` (3 files, 2.1k) | Documented nowhere outside two auto-generated registry rows. Small, but it is the surface an operator sees when something breaks. |
| 3 | **Remote access & networking** | `addon-cloudflare` (10), `addon-tailscale` (7), `system/src/builtins/remote-access-orchestrator` (3) — ~6k lines | No design doc, no ADR. `docs/hosting.md` does not mention either provider. This is how the hub is reachable from outside; nothing explains the model. | <!-- drift-ok: moved to the private planning repo -->
| 4 | **LLM / `addon-ai`** | `packages/addon-ai` (25 files, 5.1k) | Design exists **only** in (planning repo: superpowers), the unguarded frozen tier. Never promoted. |
| 5 | **Benchmark** | `packages/addon-benchmark` (35 files, 10k) | Largest single uncovered unit in the repo. |
| 6 | **Decoders** | `addon-decoder-nodeav` (16), `addon-decoder-ffmpeg` (18) — 8.3k | `design/decode-path.md` is required reading and describes the path, but neither decoder package is claimed by any glob. |
| 7 | **CLI & SDK** | `packages/cli` (15), `packages/sdk` (11) | The two surfaces external consumers touch. `packages/sdk/README.md` exists; nothing in `docs/` claims either. |
| 8 | **Model studio** | `packages/addon-model-studio` (16) | `design/model-studio-design.md` exists but declares no `applies-to`, so the coverage map cannot see it — a one-line fix. |
| 9 | **17 device providers** | `addon-provider-{homematic,import-alexa,amcrest,wyze,ecowitt,gree,unraid,unifi,vesync,rademacher,velux,onvif,…}` | Individually defensible (`device-model.md` describes the *pattern*), but nothing states that claim mechanically. §3.4 proposes how. |

---

## §3 — The index strategy

This is the deliverable the operator asked for. One rule governs it, and it is
already this repository's rule (D19): **anything derivable from the workspace is
generated; anything else is prose and is guarded.** So the design question is not
"what should the index say" but **"which single fact is not derivable?"**

### 3.1 The one fact that is not derivable

A subsystem is a human grouping. Nothing in the workspace says that decode,
inference, tracking and the confirmation gate are one story, or that
`addon-export-hap` and `provider-homeassistant/src/ha-export` are two halves of
"ecosystem export". Manifests know packages; capabilities know methods; the graph
knows call edges. **None of them knows chapters.**

Everything else in an index — which files a subsystem contains, which documents
claim it, when each was last verified, whether the code moved since — is
mechanical.

So: **curate the taxonomy, generate the index.**

### 3.2 The shape

```
docs/subsystems.yaml          ← CURATED. ~25 entries. The only hand-written index input.
      │
      ├─→ scripts/docs-generate.ts (new renderer)
      │        └─→ docs/reference/subsystems.md   ← GENERATED master index
      │        └─→ docs/reference/coverage.md     ← GENERATED unit×doc matrix
      │
      └─→ scripts/check-subsystem-map.ts (new guard)
               ├─ every glob resolves (no subsystem describing deleted code)
               ├─ every named owner-doc exists
               └─ every source file belongs to ≥1 subsystem  ← ratchet
```

One curated file. Two generated pages. One guard. `docs/README.md` stays
hand-written and gains a single link — it is the *start here* page, which is
judgement, not data.

A `docs/subsystems.yaml` entry, in full: <!-- drift-ok: file this document proposes; it does not exist yet -->

```yaml
- id: notification-center
  title: Notification Center — rules, outbox, occupancy, timelapse
  purpose: >
    Decides whether a track deserves to reach a human, and delivers it.
  owner-doc: docs/architecture/notifications.md
  globs:
    - packages/addon-post-analysis/src/notification-center/**
    - packages/types/src/notification/**
    - packages/addon-notifiers/src/**
```

`purpose` is the only free prose, and it is one sentence. Everything a reader
wants next — how many files, which documents claim it, how fresh each is, what
is uncovered — is computed.

### 3.3 The generated master index

`docs/reference/subsystems.md` renders one row per subsystem: <!-- drift-ok: file this document proposes; it does not exist yet -->

| Subsystem | Files | Documents that claim it | Freshest | Status |
| --- | --- | --- | --- | --- |
| Notification Center | 81 | `notifications.md`, +25 ADRs | 2026-08-14 | ✅ |
| Auth & scopes | 25 | — | — | ❌ |

plus, per subsystem, the list of globs that matched **no** claiming document —
i.e. the hole, named, at file granularity. That list is what §4 works through, and
it shrinks on its own as documents are written. Nobody edits it, ever.

`docs/reference/coverage.md` is the same data pivoted the other way: unit → the <!-- drift-ok: file this document proposes; it does not exist yet -->
documents claiming it → each one's `last-verified` → the last commit date under
that unit. It is the §2.2 table, regenerated on every commit instead of typed
once into a design doc that will be wrong next week.

### 3.4 One frontmatter decision the operator has to make

Today `applies-to` does two jobs at once: it *claims* code (this doc describes
these files) and it *arms staleness* (touch those files after `last-verified` and
the doc goes suspect). For a focused page that is exactly right.

It breaks for a page that legitimately describes a **class**.
`architecture/device-model.md` describes how every device provider works. Adding
`packages/addon-provider-*/**` to its `applies-to` would honestly close 17 holes
in §2.4 — and would also make that page permanently suspect, because one of
twenty providers changes almost every day. The ratchet would never come down and
the signal would be destroyed.

Two options:

- **(a) One key.** Widen `applies-to` and accept permanent suspicion on
  class-level pages. Zero new machinery; costs the freshness signal exactly where
  the ratchet is already struggling (§1.2).
- **(b) Two keys.** Add optional `covers:` — a coverage claim that feeds the
  index but never arms staleness. `applies-to` keeps meaning "I verified this
  against these files on `last-verified`". Costs ~15 lines in
  `check-docs-drift.ts` and one paragraph in the `sync-docs` skill.

**Recommendation: (b).** The two claims are genuinely different — "I describe
this" and "I checked this" — and collapsing them is what makes (a) corrosive.
This needs a decision record before it is built; it changes what a frontmatter
key means repo-wide.

### 3.5 The generator, specified

**File** — a new renderer inside `scripts/docs-generate.ts` would push that file
past 800 lines (it is 805 today), which the root `CLAUDE.md` forbids. So:
`scripts/lib/subsystem-map.ts` holds the logic, `docs-generate.ts` gains two <!-- drift-ok: file this document proposes; it does not exist yet -->
entries in its `build()` array.

**Reuse, do not re-implement.** `check-docs-drift.ts` already contains every
primitive needed, and they must be shared rather than copied: `parseFrontmatter`
(the deliberately-minimal YAML subset), `globToRegExp`, `repoFiles`,
`lastCommitDate`. Copying them is how the two halves of the docs system start
disagreeing about what a glob means.

**Input**

| Source | Used for |
| --- | --- |
| `docs/subsystems.yaml` | the taxonomy: id, title, purpose, owner-doc, globs | <!-- drift-ok: file this document proposes; it does not exist yet -->
| `git ls-files --cached` | the file universe |
| frontmatter of every non-frozen `docs/**/*.md` | `applies-to` / `covers` / `last-verified` |
| `git log -1 --format=%cs -- <glob>` | last code change per subsystem |

**Output** — two files carrying the existing DO-NOT-EDIT banner:
`docs/reference/subsystems.md`, `docs/reference/coverage.md`. <!-- drift-ok: file this document proposes; it does not exist yet -->

**Algorithm**

1. Parse the taxonomy. Compile each glob with `globToRegExp`.
2. Assign every tracked source file to the subsystems whose globs match. A file
   may belong to more than one — that is legitimate (a cap definition belongs to
   both its feature and the capability system) and must not be forced unique.
3. Parse frontmatter for every candidate document; build `doc → matched files`.
4. Join on files: a document claims a subsystem when it claims ≥1 of its files.
5. Emit. Sort subsystems by the taxonomy's order (curated order is editorial and
   worth preserving), units by file count descending.

**Exclusions**, and they matter — the prototype behind §2.2 got this wrong twice
before the numbers meant anything: skip `__tests__`, `*.spec.*`, `*.test.*`,
`*.config.ts`, `dist/`, `node_modules/`, `.claude/worktrees/` <!-- drift-ok: an exclusion PATTERN — the directory exists only on a machine that made a worktree, and never in CI --> (a second checkout
of this repo inside itself, the same trap documented in `check-docs-drift.ts`),
and `packages/ui-library/.design-sync`.

**Failure modes to encode as guard failures, not silent output**

- a glob matching nothing → the subsystem outlived its code;
- an `owner-doc` that does not resolve;
- a source file in no subsystem → the taxonomy has a hole. **Ratchet, not hard
  fail**, with `--max-orphans <n>` pinned in CI exactly as `--max-stale` is.
  Starting value is whatever the first run reports; it only goes down.

**Tests** (`scripts/__tests__/subsystem-map.spec.ts`, against a fixture tree, not <!-- drift-ok: file this document proposes; it does not exist yet -->
the live repo):

1. a file matched by two subsystems appears under both;
2. a doc whose `applies-to` matches one file of a subsystem claims the whole
   subsystem;
3. a subsystem no document claims renders ❌ and contributes to the uncovered
   count;
4. `covers:` contributes coverage and does **not** contribute staleness;
5. a glob matching nothing fails the guard;
6. a source file in no subsystem increments the orphan count;
7. `--check` mode exits non-zero when the committed output differs.

Test 4 is the one that must be written first and watched fail — it is the whole
point of §3.4, and a fixture that pre-seeds the answer would hide it. (This repo
has shipped that exact mistake three times; (planning repo: sessions/sessions.md) names <!-- drift-ok: moved to the private planning repo -->
each.)

**Wiring**: `.husky/pre-commit` already regenerates and re-stages when a manifest
or `*.cap.ts` is staged — extend that trigger to `docs/subsystems.yaml` and to <!-- drift-ok: file this document proposes; it does not exist yet -->
any `docs/**/*.md` frontmatter change. CI gains
`npx tsx scripts/check-subsystem-map.ts --committed-only --max-orphans <n>`
next to the existing docs step. It then appears in `docs/reference/guards.md` by
itself, because that page is generated from `scripts/check-*` plus whether CI
runs them.

### 3.6 Why it was not implemented in this document

**Built on 2026-08-14.** What follows is the estimate as written, kept because it
was accurate: `scripts/lib/subsystem-map.ts` came in at ~430 lines including
renderers, the guard at ~110, the fixture tests at ~330. The three prerequisites
it names — a decision record, a measured baseline, a hook change — were all
required, and the `covers:` decision became D145. Two things the estimate did not
predict: `globToRegExp` compiled a trailing `**` to a single segment (harmless
while the only caller asked "does this match at ALL", silently fatal to a caller
that COUNTS matches), and the generated pages had to exclude git commit dates
entirely, because `docs-generate --check` runs in CI and a page carrying "when
did this code last change" drifts on every commit that touches any source file.



The brief said to implement it if it is under 100 lines. It is not — honest
estimate ~230 lines for `scripts/lib/subsystem-map.ts` plus ~90 for the guard <!-- drift-ok: file this document proposes; it does not exist yet -->
plus ~120 of fixture-based tests, and it cannot land alone: it needs the §3.4
decision recorded first, a `--max-orphans` baseline measured, and a pre-commit
hook change. Landing a half-considered generator that CI enforces would make
every future commit hostage to a taxonomy nobody agreed to.

What *was* built is a throwaway prototype of steps 1–5 of the algorithm, run
against the live repository; every number in §2.2 and §2.4 comes from it. The
design is validated; only the packaging is deferred.

### 3.7 Indices that could be generated and are not

Ordered by value. All are derivable today.

1. **The API index.** `scripts/gen-api-reference.ts` already produces it and
   writes it outside the repo (§1.3). Redirecting its output into
   `docs/reference/api.md` and adding it to `docs:check` is the single <!-- drift-ok: file this document proposes; it does not exist yet -->
   highest-value, lowest-effort index change available.
2. **Events.** Every `EventCategory` member and its emitters — derivable, and
   the repo already forbids hand-rolled `camstack.evt.*` topics, so the
   generated list would be complete by construction.
3. **Settings.** `docs-generate.ts` already reads the settings backend to build
   `docs/reference/storage.md`; the key catalogue is one renderer away.
4. **Collections.** `scripts/check-collection-declarations.ts` already
   enumerates them to enforce declaration.
5. **Device kinds.** `scripts/generate-provider-kind-map.ts` already builds the
   map; nothing renders it for a human.

### 3.8 What stays hand-written, permanently

`docs/README.md` (which page to open, and when — judgement), the architecture
pages, the decision records, (planning repo: sessions/sessions.md), and the one-sentence <!-- drift-ok: moved to the private planning repo -->
`purpose` per subsystem. Everything else in the index tier is a join over data
the repository already holds.

---

## §4 — The section-by-section plan

### 4.1 How the order was chosen

Three signals, multiplied:

- **Operational value** — does an operator or an agent get stuck here?
- **Staleness** — from `npm run docs:drift` (§1.2).
- **Incident frequency** — counted from (planning repo: sessions/sessions.md) headings for <!-- drift-ok: moved to the private planning repo -->
  2026-08-01 → 2026-08-14. This is the strongest predictor available, because
  every entry in that file is a session that cost real time.

The incident count over those fourteen days:

| Area | Incidents | Documentation state at the time |
| --- | --- | --- |
| Notification Center / post-analysis | ~12 | page fresh, but **boot contract undocumented** |
| Ecosystem exports (HAP / HA / Alexa) | ~10 | design docs, all stale |
| Admin UI / switches / responsiveness | ~8 | page fresh |
| Snapshot & media | ~7 | 3 design docs, fresh |
| Detection & pipeline chain | ~6 | pages stale since 08-07/08-08 |
| Recorder & scrub | ~5 | ADRs only, no architecture page |
| Storage & retention | ~4 | table map 11 days stale |
| Transport / capability registration | ~4 | page fresh |
| Auth & scopes | 0 observed | **nothing** |

The 2026-08-14 timelapse outage is the sharpest data point in the file and it
sets the shape of section 1. Eight capabilities left the cluster because a
scheduler rendered video inside `initialize()`. Nothing was wrong with
`notifications.md` — it was verified that day. **The rule that was missing was
never in any document**: what may and may not run inside `initialize()`, and that
the blast radius of blocking it is every capability the addon declares. A doc can
be perfectly fresh and still not contain the sentence that would have prevented
the outage.

That is the calibration for every section below: **a section is done when the
invariants a failure would violate are written down, not when the prose reads
nicely.**

### 4.2 Section 0 — the index itself (prerequisite)

Everything else is easier once the map exists, and the map tells you when you are
finished.

| Step | Effort |
| --- | --- |
| Decision record for §3.4 (`covers:` vs widening `applies-to`) | 1h |
| `docs/subsystems.yaml` — 25 entries, seeded from §2.3 | 2h | <!-- drift-ok: file this document proposes; it does not exist yet -->
| `scripts/lib/subsystem-map.ts` + renderers + fixture tests | 4h | <!-- drift-ok: file this document proposes; it does not exist yet -->
| `scripts/check-subsystem-map.ts` + `--max-orphans` baseline + CI wiring | 2h | <!-- drift-ok: file this document proposes; it does not exist yet -->
| Redirect `gen-api-reference.ts` into `docs/reference/api.md`, add to `docs:check` (§3.7) | 1h | <!-- drift-ok: file this document proposes; it does not exist yet -->
| Fix the four §1.5 defects | 30m |

**Done when**: `npm run docs:check` regenerates both index pages, CI enforces
both ratchets, and a new addon appears in the master index with no human editing
a list.

**Done, 2026-08-14.** The taxonomy is `docs/subsystems.yaml` (29 entries), the
pages are `docs/reference/subsystems.md` and `docs/reference/coverage.md`, the
guard is `scripts/check-subsystem-map.ts`, and both ratchets are pinned at 0
(`--max-stale 0`, `--max-orphans 0`). The API index of §3.7 now generates into
`docs/reference/api.md`. Three subsystems render ❌ with no document at all —
audio analysis, remote access, and the LLM addon — which are §2.4 ranks 3, 4 and
one half of 16.

### 4.3 The ordered plan

| # | Section | Deliverable | Est. | Signal |
| --- | --- | --- | --- | --- |
| 1 | Post-analysis, NC & the boot contract | verify `post-analysis.md`; add a boot/scheduler-contract section to `addon-lifecycle.md` | 6h | 12 incidents |
| 2 | Detection & pipeline chain | verify `detection-execution.md` + `data-planes.md`; new page for the package chain across 3 packages | 6h | 6 incidents, both pages stale |
| 3 | **Auth, scopes & method tiers** | new `docs/architecture/auth.md` | 5h | the largest ❌, security blast radius | <!-- drift-ok: file this document proposes; it does not exist yet -->
| 4 | Ecosystem exports | verify the 5 stale export docs; claim `provider-homeassistant/src` (56 files) | 5h | 10 incidents |
| 5 | Recorder, scrub & recorded playback | new architecture page consolidating 8 ADRs + 4 design docs | 5h | 33k lines, no page |
| 6 | Storage, retention & backup | verify the table map; fold in the retention sweeps | 4h | 4 incidents |
| 7 | Stream broker & WebRTC | split out of `data-planes.md` | 4h | 47k lines behind a shared page |
| 8 | Small ❌s: alerts, remote access, LLM, decoders, CLI/SDK | one short page each, or promote from `superpowers/` | 4h | §2.4 ranks 2–7 |
| 9 | Device providers as a class | make `device-model.md`'s class claim mechanical (§3.4) | 2h | 17 units |
| 10 | Viewer & the HA component | one page each on the contract, not the internals | 3h | cross-repo |

### 4.4 The first three, in detail

**Section 1 — Post-analysis, the Notification Center, and the boot contract.**

- Verify `architecture/post-analysis.md` against `pipeline-analytics/**` (182
  files, page last verified 08-08 against code changed 08-14). Every claim gets
  checked against the code or deleted.
- Add to `architecture/addon-lifecycle.md` the section the 08-14 outage proves is
  missing: `initialize()` is on the critical path of the entire capability graph;
  the manifest is appended only *after* it returns; anything that renders,
  fetches or polls belongs on the tick after `start()` returns. Name
  `startInitWatchdog` as the detector and say what it deliberately does not do.
- Give `occupancy` and `timelapse` each a named home. Today both live inside a
  1356-line page and inside ADRs; §2.3 rows 9 and 10.
- **Done when**: every statement is traceable to a file that exists,
  `last-verified` is bumped on both pages, and the stale count drops by two.

**Section 2 — Detection and the pipeline chain.**

- Verify `detection-execution.md` (stale since 08-07) and `data-planes.md`
  (08-08).
- New page for the package-detection chain, which spans
  `packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts`,
  `packages/addon-pipeline-orchestrator/src/package-zone-gate.ts` and
  `packages/addon-pipeline/src/pipeline-runner/package-zone-proximity.ts`. Three
  packages, two incidents, no document draws the line between them — exactly the
  shape of failure that costs a whole session.
- **Done when**: the chain is drawn end to end and each hop names its file.

**Section 3 — Auth, scopes and method tiers.**

The largest genuine hole, and the only one where guessing is dangerous. A new
`docs/architecture/auth.md` covering: what a scope preset is and where <!-- drift-ok: file this document proposes; it does not exist yet -->
`packages/types/src/generated/scope-presets.ts` comes from; what a method tier
means and what `scripts/check-method-tiers.ts` refuses; how the 1213-line
`method-access-map.ts` is produced and consumed; the three auth providers in
`packages/addon-auth`; and where `packages/system/src/auth` sits relative to
`server/backend/src/auth`.

- **Done when**: someone can add an authenticated endpoint without reading
  source, and `applies-to` covers all four auth units so the page goes suspect
  when any of them moves.

### 4.5 The done criterion, repo-wide

For every section:

1. every repo path resolves (`npm run docs:drift` already enforces this);
2. every claim was checked against the code in this pass, or deleted — an
   unverified sentence that reads as verification is worse than no sentence;
3. `applies-to` names the code actually described, so the page can go suspect
   later;
4. `last-verified` is bumped, and `--max-stale` in `.github/workflows/ci.yml` is
   **lowered** by the number of documents the pass verified. The ratchet only
   goes down; a pass that does not lower it did not verify anything.

---

## Open questions for the operator

1. **§3.4** — `covers:` as a second frontmatter key, or widen `applies-to` and
   lose the freshness signal on class-level pages? This blocks section 0.
2. **The frozen tier.** 445 unguarded files, and at least one live design (LLM /
   `addon-ai`) is trapped there. Promote case by case as sections reach them, or
   sweep (planning repo: superpowers) once for anything still true?
3. **Section 3 priority.** Auth has *zero* recorded incidents and the worst
   coverage. Ordered third on blast radius rather than observed pain — move it
   up, or down?
4. **`--max-stale`.** It is 3; reality was 19 and is 4 after one pass. Re-pin it
   to the post-pass number as the new ceiling and lower it per verified section —
   or leave it at 3 and treat the next red build as the trigger for a pass?
