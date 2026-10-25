---
title: TypeScript 7 transition plan — lowest possible RAM (2026-10-09)
last-verified: 2026-10-13
---

# TypeScript 7 transition plan — lowest possible RAM (2026-10-09)

**Status (2026-10-13): the transition is done; the reference is flipped.** P0
guardrails, P1 (tsgo `--checkers 1`, the `typescript-7` alias), P2 emit, P3
`isolatedDeclarations` for sdk / ui-library / system and P1v (the viewer's
`ts-check` on TypeScript 7) are in. On 2026-10-13 `--parity` showed identical
normalized error sets on every project; the operator accepted that in place of
the N = 10 Checks runs (Checks is on-demand and had not run since 2026-10-06).
`check-ci-baselines.ts` now defaults to tsgo and `--update` re-pins with it;
`npm run typecheck:tsc6` is the kept reference (not removed, contrary to the P4
sketch below). Decisions recorded as D832, D833 and D834. Still open by design:
upstream tracking (TS 7 JS API, typescript-eslint, ts-morph), and the P3
leftovers (incremental tsbuildinfo, barrel-split measurement), taken on touch.

**Goal, in priority order:**

1. The lowest peak RAM in CI and in local development.
2. Wall time.
3. Moving to TS 7 for its own sake.

A phase that makes the build faster but raises the peak is rejected.

**Inputs:**
- the measurements in
  [`2026-10-09-ci-build-memory-and-ts7.md`](2026-10-09-ci-build-memory-and-ts7.md),
  called "the CI-memory doc" below;
- the two 2026-10-09 commits "perf(ci): bound the build's memory" (CI `--parallel=2`, 4 GB step heap, the admin-ui gate on `.d.ts`) and "chore(ts): TS 7-ready tsconfigs and npm run typecheck:tsgo";
- the workflows, `nx.json`, every package script and tsconfig, and every user of the TypeScript JS API (inventoried in §1.4);
- the gap-filling measurements in §1.5.

Unless marked "N100", every number is from an M-series Mac. The CI-memory doc
explains why the Mac is a valid proxy for RSS but not for wall time (the N100
is about 4× slower per task). P0 replaces these proxies with numbers measured
on the runner itself.

---

## 1. Current state and constraints

### 1.1 The host and the budget

| | value |
| --- | --- |
| CI host | agent-a: N100, 4 cores, 16 GB RAM, **shared with a live CamStack agent** |
| runner | **one** self-hosted runner (label `<runner-host>`), container `memory.max` = **9 GB** |
| safety net | 6 GB zram (compressed swap). A safety net only: a build that lives in zram is a build that has already failed. |
| who else uses the runner | `ci.yml` (one job), `checks.yml` (three jobs: `static`, `docs`, `e2e`), and the viewer repo's `typecheck.yml` (same label). With one runner they serialize. |

**The per-step budget.** The container cap is 9 GB, but a cgroup counts the
page cache of `npm ci`, git and the nx cache as well. The plan therefore keeps
the **summed RSS of every step ≤ 6 GB** (a hard target) and aims for ≤ 4.5 GB.
That leaves ≥ 3 GB inside the cap for the cache, the nx daemon and npm.
Everything outside the cap (≈ 7 GB) belongs to the agent and the OS.

| CI step | today (N100 `mem-step`, peak tree RSS) | budget (hard) | target after the plan |
| --- | ---: | ---: | ---: |
| `npm ci` | **3.23–4.36 GB** across runs `37956999818` / `37961161324` / `37963593686` (largest proc ≤ 3.53 GB) | **4.5 GB** (was 2; raised to measured) | ≤ 1.5 GB |
| Build all packages (`--parallel=2`, 4 GB heap) | **4.02–4.19 GB** cold; warm cache **0.5 GB** (run `37963593686`) | 6 GB | **≤ 2.5 GB** |
| Test affected (nx `--parallel=1`, `VITEST_MAX_WORKERS=2`) | **3.52 GB** / wall **2721 s** (run `37963593686`; largest proc 1.34 GB) | 6 GB | **≤ 3.2 GB** |
| Checks: Build (no `--parallel`, 8 GB heap) | not yet measured on N100; Mac/CI-memory worst ≈ 5.35 GB | 6 GB | ≤ 2.5 GB |
| Checks: pinned-debt typecheck (`nx run-many -t typecheck`, default parallel 3, 8 GB) | not yet measured on N100; worst overlap admin-ui 3.85 + server 2.82 + types 2.21 ≈ **8.9 GB** | 6 GB | **≤ 3.0 GB** |
| Viewer `ts-check` (tsc 6) | 2.36 GB (§1.5, Mac) | 4 GB | ≤ 1.8 GB |

**N100 reads (2026-10-09).** Install's 2 GB budget was a guess — real tree
RSS sits at 3.2–4.4 GB, so the hard budget is now **4500 MB** (still a
warning, not `MEM_BUDGET_ENFORCE`). Build and test-affected are under 6 GB.
Container lifetime `memory.peak` stayed **7.46 GB** across these runs
(includes page cache). Checks rows still need an on-demand Checks dispatch.

The Checks typecheck row is still the one that can break the **9 GB
container** alone. With one runner the two workflows no longer overlap, but
the 8.9 GB worst case sits at the cap.

### 1.2 The dual install

TypeScript 7 (`typescript@7.0.2` on npm `latest`) is a Go binary with **no JS
API**. Every tool that imports `typescript` needs TS 6. The repository will
therefore carry two compilers for the whole transition:

| role | package | pinned version | used by |
| --- | --- | --- | --- |
| JS API and reference checker | `typescript` | `~6.0.3` (6.0.3 installed; 64 dedupes) | everything in §1.4, `npm run typecheck` (the reference and the only re-pin path) |
| native checker | `typescript-7` (npm alias → `typescript@7.0.2`) | `7.0.2` | `npm run typecheck:tsgo` via `node_modules/typescript-7/bin/tsc` (`--checkers 1`, `--parity`); P1 retired `@typescript/native-preview` |
| nested | `typescript@5.9.3` | via `@module-federation/dts-plugin@2.5.1` | admin-ui's MF plugin. `dts: false`, so it is not loaded during the build. |
| ts-morph's own copy | TypeScript 6.0.2 bundled in `@ts-morph/common` | via `ts-morph@28.0.0` | `scripts/generate-api-types.ts`. This copy is independent of the root `typescript`. |
| viewer (`camstack/`) | `typescript` | `~6.0.3` | `tsc --noEmit` in `ts-check`, plus `expo lint` (typescript-eslint parser) |

Other relevant pins: `vite` 8.0.16, `rolldown` 1.0.3, `vitest` 4.1.9, `tsx`
4.22.4, `tsup` 8.5.1, `vite-plugin-dts` 5.0.2 (a wrapper around
`unplugin-dts` 1.0.2), `nx` 23.0.0, Node 24.

### 1.3 What runs TypeScript programs today

| where | program | peak (Mac) | notes |
| --- | --- | ---: | --- |
| types `build` | `tsc -p tsconfig.json --emitDeclarationOnly` | 1.79 GB | 522 `.d.ts` |
| system `build` | `vite build` + `vite-plugin-dts` (whole `src/**`) | 2.14 GB | the plugin costs ~0.5 GB on top of plain tsc |
| ui-library `build` | `vite build` + `vite-plugin-dts` | 1.75 GB | |
| sdk `build` | `vite build && tsc -p tsconfig.build.json` | 0.51 GB | |
| server `build` | `tsc -p tsconfig.build.json` (**JS** emit, CommonJS) + `tsup` (one barrel) | 2.44 GB | |
| admin-ui `build` | `tsc --noEmit -p tsconfig.build.json` (gate, on `.d.ts`) + `vite build` ×2 | 2.27 GB | was 3.94 GB on sources before the 2026-10-09 CI memory bound |
| agent-ui `build` | `tsc --noEmit` (gate; `paths` → `ui-library/src`) | 0.59 GB | |
| desktop `build` | `tsc --noEmit -p tsconfig.main.json` (gate; `paths` → `types/src`, `node-root/src`) + `tsup` | **1.72 GB** | on the built `.d.ts`: **0.46 GB** (§1.5) |
| node-root / benchmark `build` | `tsup` with `dts` (rollup-plugin-dts, TS API) | small | |
| 55 × `typecheck` | `tsc --noEmit -p tsconfig.spec.json` (48), `tsc --noEmit` (6), admin-ui runs two programs (spec + server) | up to 3.85 GB (admin-ui) | 388 s summed |

### 1.4 Who needs the TypeScript JS API (this decides what stays on TS 6)

The search covered `from 'typescript'`, `require('typescript')`,
`import('typescript')` and `ts-morph` in the repository, and the same patterns
in the `dist/` of every build tool.

| consumer | API depth | phase that removes or isolates it |
| --- | --- | --- |
| `vite-plugin-dts` → `unplugin-dts` (system, ui-library) | full program, declaration emit | **P2**: replaced by `tsgo --emitDeclarationOnly` |
| `vite-plugin-dts` listed as a devDependency but **unused** in 7 addons (cloudflare, mqtt-broker, tailscale, export-google, export-alexa, smtp-nodemailer, export-hap), and the dead `emitDts` branch of `tools/build/vite-lib.preset.ts` (no package sets `emitDts`) | none at runtime | **P2**: delete |
| `tsup` `dts` (node-root `dts: true`, benchmark `dts: {…}`) | full program via rollup-plugin-dts | P2b: tsgo emit, or keep (small programs) |
| `scripts/generate-api-types.ts` (ts-morph `Project` + `getType()` on the **server** program) | **type checker** | stays on TS 6 (bundled 6.0.2) until a TS 7 API exists (§4.2) |
| AST-only scripts (`createSourceFile` / `forEachChild` / `is*`): `check-user-facing-decision-ids`, `check-no-raw-secret-read`, `check-secret-fields-declared`, `check-global-schema-declared`, `check-deps`, `check-collection-declarations`, `check-collection-cap-pin`, `scripts/ui/lib/ui-catalogue.ts` | parser only | stay on TS 6. Cheap (no program). Optional later: oxc-parser. |
| `scripts/check-specs-are-typechecked.ts` (`getParsedCommandLineOfConfigFile`) | tsconfig parsing | stays on TS 6 |
| nx 23 (`plugins/js/utils/typescript.js`, `register.js`) | module resolution for the project graph | stays: nx needs *a* `typescript` with a JS API |
| viewer `expo lint` (`@typescript-eslint/parser` via `eslint-config-expo`) | parser (no typed rules found) | stays on TS 6 until typescript-eslint supports TS 7 |
| **Vite 8, Vitest 4.1.9, tsx, Rolldown** | **none**: no reference to `typescript` in their `dist`. Vitest only shells out to `tsc` for its `--typecheck` mode, which this repo does not use. | not a blocker. **This corrects the CI-memory doc**, which listed Vite/Vitest as TS API users. |

**Conclusion.** `typescript@6` stays installed through P4. The goal is not to
remove it. The goal is that **no CI step builds a TS 6 type program**, except
the codegen check (`generate-api-types`) and, until parity is proven, the
reference typecheck.

### 1.5 Measurements added for this plan (Mac, 2026-10-09)

These fill gaps in the CI-memory doc. Each was run once, with dists built from
the current checkout. A few errors came from stale local dists. They are the
same for tsc and tsgo and do not affect any comparison.

| question | result |
| --- | --- |
| Does tsgo have `--singleThreaded`? | **Yes** (`7.0.0-dev.20260707.2`). It **saves nothing** over `--checkers 1`: types 1 816 vs 1 845 MB, server 1 750 vs 1 755 MB, admin-ui (spec) 2 965 vs 2 920 MB, and it is slightly slower. Parsing in parallel does not cost RAM; the checkers do. → use `--checkers 1`, not `--singleThreaded`. |
| server **JS emit** with tsgo `--checkers 1` (`-p tsconfig.build.json`) | tsc 6: 12.9 s / **2 437 MB** → tsgo c1: 5.6 s / **1 582 MB**. 214 files, **byte-identical** (`diff -r` empty). tsgo c2: 6.3 s / 2 682 MB. |
| system `.d.ts` via tsgo c1 (`--emitDeclarationOnly`) | 3.0 s / **1 313 MB** (vite + dts today: 2 135 MB) |
| ui-library `.d.ts` via tsgo c1 | 1.8 s / **826 MB** (today 1 746 MB) |
| types `.d.ts` via tsgo c1 | 3.4 s / **1 461 MB** (tsc 6: 1 790 MB) |
| admin-ui build gate (`tsconfig.build.json`, on `.d.ts`) via tsgo c1 | 4.3 s / **1 641 MB** (tsc 6: 2 273 MB) |
| desktop build gate: `paths` → sources vs → built `.d.ts` | tsc 6: 7.5 s / **1 718 MB** → **1.0 s / 458 MB** on `.d.ts`, 0 errors both. tsgo c1: 1 142 MB → **209 MB**. |
| viewer `ts-check`'s `tsc --noEmit` | tsc 6: 15.4 s / 2 357 MB; tsgo default: 2.7 s / 2 200 MB; **tsgo c1: 5.6 s / 1 769 MB**; 0 errors in all three. No config blockers (`moduleResolution: bundler`, no `baseUrl`). |
| vitest worker count (server suite, `pool: 'forks'`, 299 spec files, 8 GB `NODE_OPTIONS`) | 1 worker: 357 s / **2 276 MB**; 2: 185 s / **3 110 MB**; 3: 143 s / **4 214 MB** (summed tree RSS) |
| **CI's vitest env is dead** | `ci.yml` sets `VITEST_MAX_THREADS=2` / `VITEST_MIN_THREADS=1`. **Vitest 4.1.9 reads neither** (it only reads `VITEST_MAX_WORKERS`). Its run-mode default is `availableParallelism() − 1` = **3 workers on the N100**. Each fork also inherits the job-level `--max-old-space-size=8192`. |
| `isolatedDeclarations` debt (tsgo `--isolatedDeclarations --declaration --noEmit`) | **types: 11 809 errors in 233 of 521 files** (10 241 × TS9013, i.e. inferred Zod schema consts); system: 178 in 59 files; ui-library: 212 in 152 files; sdk: 24 in 1 file |
| nx per-target `parallelism` | nx 23's project schema has `"parallelism": boolean` ("whether this target can be run in parallel with other tasks"). It is the task-level resource hint this plan needs; no custom scheduler is required. |

---

## 2. Phased migration

Overview (RAM is summed peak per step; "now" is the 9 GB-cap world after the 2026-10-09 CI memory bound):

| phase | what | build step peak | test step peak | Checks typecheck peak | effort |
| --- | --- | ---: | ---: | ---: | --- |
| now | | ≈ 4.9 GB worst | ≈ 4.2 GB+ | ≈ 8.9 GB worst | |
| **P0** guardrails | measure in CI; fix the dead vitest env; bound Checks | 4.9 | **≈ 3.1** | **≈ 3.9** (`--parallel=1`) | 1 d |
| **P1** typecheck → tsgo c1 | Checks, local, the build gates | **≈ 3.5** | 3.1 | **≈ 3.0** | 1.5 d + N runs |
| **P2** emit off the TS 6 API | `.d.ts` and server JS by tsgo; vite-plugin-dts gone | **≈ 2.4** (with `parallelism:false`) | 3.1 | 3.0 | 2–3 d |
| **P3** isolatedDeclarations (sdk, ui-library, system) + incremental | per-file `.d.ts`, tsbuildinfo | ≈ 2.0 | 3.1 | ≈ 3.0 (2.5 with the barrel split) | 5–6 d, spread out |
| **P4** retire TS 6 where possible; viewer | | — | — | — | ongoing |

### P0 — guardrails: measure in CI, then bound what is unbounded

**Scope.** Make RAM visible per step on the N100, fix the two settings that
silently allow more than intended, and give Checks the same bounds as CI. No
compiler change.

**Exact changes.**

1. `scripts/ci/mem-step.sh` (new): `mem-step.sh <label> <budget-MB> -- <cmd…>`. <!-- drift-ok: a file this plan creates -->
   - It runs the command under GNU `/usr/bin/time -v`, which gives the largest single process's max RSS. The runner image must provide the `time` package (verify it; install it in the image if missing).
   - A background sampler records once per second:
     - the cgroup's `memory.current` (`/sys/fs/cgroup/memory.current`, cgroup v2), which includes the page cache;
     - the summed RSS of the command's process tree (`ps`);
     - the command lines of the top 5 processes at the peak sample, which shows *which* nx tasks overlapped.
   - At the end it appends one row to `$GITHUB_STEP_SUMMARY`: label | wall | peak cgroup | peak tree RSS | largest process | top-5 at peak.
   - Budget assertion: when the peak tree RSS is over `<budget-MB>`, it emits `::warning::`. With `MEM_BUDGET_ENFORCE=1` it emits `::error::` and exits 1.
   - Also read `memory.peak`, which is the container lifetime peak: it gives one number per job.
2. `ci.yml`: wrap "Install dependencies", "Build all packages", both test steps and "Test repo scripts" with `mem-step.sh`. Budgets come from §1.1: build 6000, test 6000, install **4500** (raised from 2000 after N100 measurement).
3. `ci.yml` test steps: replace the dead `VITEST_MAX_THREADS: "2"` / `VITEST_MIN_THREADS: "1"` with **`VITEST_MAX_WORKERS: "2"`**. Measured on the server suite: 4.2 → 3.1 GB, 143 → 185 s (Mac).
   - Move `NODE_OPTIONS` from the job `env` to each step. Build keeps 4096. Tests get **3072** for now; P0's own measurements of the largest single fork then set the final value. tsx steps get 2048. tsgo ignores `NODE_OPTIONS`.
4. `checks.yml` `static` and `e2e`: "Build all packages" → `npm run build -- --parallel=2` with step `NODE_OPTIONS=--max-old-space-size=4096`, the same as CI.
5. `scripts/check-ci-baselines.ts`: the typecheck run becomes `nx run-many -t typecheck --parallel=1` (today it uses nx's default of 3, each task with an 8 GB heap). Its `NODE_OPTIONS` drops from 8192 to 4096: admin-ui spec needs ~3.4 GB of heap on sources (the CI-memory doc's heap table).
   - Cost: Checks typecheck becomes serial, roughly 388 s on the Mac, which is ~20 min on the N100. P1 takes most of that back.
6. Wrap the Checks steps with `mem-step.sh` as well: build, codegen:check, guards and pinned-debt.

**Expected RAM / time.**
- Test step: ≈ 4.2 → ≈ 3.1 GB, and the server suite is ~30 % slower.
- Checks typecheck: ≈ 8.9 → ≈ 3.9 GB worst, about 2–3× slower until P1.
- Build: unchanged, but now measured.

**Validation gate.**
- Three consecutive CI runs (one push, one nightly full suite, one manual) and one Checks run produce the summary table.
- Every step is under its hard budget, and the measured numbers replace the Mac proxies in §1.1.
- Not a gate, but recorded: the nightly full-suite test step. This is the first time anyone will see the largest vitest suite's peak on the N100 (addon-pipeline has 722 spec files with `pool: 'forks'`).

**Rollback.** Revert the workflow lines. `mem-step.sh` is a transparent wrapper (exit code passthrough). With `MEM_BUDGET_ENFORCE` unset it never fails a run.

**Effort.** ~1 day, plus watching the first runs.

### P1 — typecheck on tsgo `--checkers 1`

**Scope.**
- All type *checking*: Checks' pinned-debt typecheck, local `npm run typecheck`, the viewer's `ts-check` (P1v, below) and the `--noEmit` build gates of admin-ui, agent-ui and desktop.
- Not emit.
- tsc 6 stays the baseline updater until parity is proven.

**Exact changes.**
1. **Choose the tsgo source** (decision D1). The recommendation is to replace `@typescript/native-preview` with an npm alias of the released compiler.
   - The alias: `"typescript-7": "npm:typescript@7.0.2"`.
   - The binary is called by path, `node_modules/typescript-7/bin/tsc`, because the alias's `.bin/tsc` would collide with TS 6's `tsc`.
   - `scripts/typecheck-tsgo.ts` (`TSGO_BIN`) and `scripts/lib/tsgo-typecheck.ts` (doc comment) follow.
   - Re-run the 55-project parity sweep once on 7.0.2: the CI-memory doc found `7.0.2` and the preview "agree within noise".
2. `scripts/typecheck-tsgo.ts`: default `TSGO_CHECKERS` **2 → 1**. It already runs projects sequentially (`spawnSync` loop), so its peak is the single largest program: admin-ui spec, ~2.95 GB.
   - Add **`--parity`**. It runs tsc 6 and tsgo per project and compares the **normalized error sets**, not the counts. The set entry is `file(line,col): TSxxxx`, with the message text dropped (the union-order difference, §4.1). Any difference fails.
3. `scripts/check-ci-baselines.ts`: add `--engine=tsgo|tsc` for the `typecheck` / `typecheck-specs` buckets. Default `tsc` while parity is being collected. `--update` stays `tsc`-only in P1.
4. `checks.yml` "Pinned-debt guard": for the parity window, run
   `npx tsx scripts/typecheck-tsgo.ts --parity` (grading **and** set comparison), then `check-ci-baselines.ts` for the remaining buckets (oxlint, format, double-cast).
   - After **N = 10** parity-clean Checks runs, plus the nightly runs if P1.6 is adopted, flip the default to `--engine=tsgo`.
   - Keep the `tsc` engine for `--update` until P4.
5. **Build gates.**
   - desktop `tsconfig.main.json`: `paths` → the built `.d.ts`, the same move admin-ui made in the 2026-10-09 CI memory bound. A new `tsconfig.build.json` with `paths: {}`; `dependsOn: ^build` already guarantees the dists. Measured: 1 718 → 458 MB (tsc 6). This change is **independent of TS 7** and can ship first.
   - agent-ui: same treatment (`paths` → `ui-library/src` today).
   - The three gates (admin-ui, agent-ui, desktop) swap `tsc` → `tsgo --checkers 1` in the `build` script. admin-ui: 2 273 → 1 641 MB.
6. **Typecheck out of `build`** (decision D3). Replace the three build gates with **one** CI step after the build: `npx tsx scripts/typecheck-tsgo.ts` over all 55 projects.
   - It runs sequentially, peaks at ~2.95 GB, takes ~90 s at c2 on the Mac, and should take ~5–7 min on the N100.
   - This step **is** the CI type gate that D704 kept inside `build`. It covers every package instead of three, and each program is built once instead of twice. admin-ui currently builds three: gate + spec + server.
   - With the step in place, the `tsc --noEmit` prefix is removed from the three `build` scripts.
7. Local: after the flip, `npm run typecheck` → tsgo (c1), and `npm run typecheck:tsc6` keeps the reference. `lint-staged` does not typecheck, so nothing changes there.

**P1v — the viewer, in its own repo (independent).** In `camstack/package.json`
`ts-check`, replace `tsc --noEmit` with `tsgo --checkers 1 --noEmit`.
- Measured: 15.4 s / 2.36 GB → 5.6 s / 1.77 GB, 0 errors in both, no tsconfig change needed.
- Keep `typescript@6` for `expo lint`.
- Same N-run parity rule. The viewer's `typecheck.yml` runs on the same runner label, so its saving counts toward the shared budget.

**Expected RAM / time.**

| | before | after |
| --- | ---: | ---: |
| Checks typecheck peak | 3.9 GB (after P0) | **≈ 3.0 GB** (admin-ui spec, c1) |
| Checks typecheck wall (Mac) | ~388 s serial tsc 6 | **~100 s** |
| admin-ui build gate | 2.27 GB | 1.64 GB, or gone (D3) |
| desktop build gate | 1.72 GB | 0.21–0.46 GB, or gone (D3) |
| CI build step worst | ≈ 4.9 GB | **≈ 3.5–4.5 GB**. server's tsc emit 2.44 GB is now the largest task; P2 removes it. |

**Validation gate.**
- `typecheck-tsgo --parity`: identical normalized error sets in all 55 projects for N = 10 consecutive Checks runs.
- The tsgo grade equals the tsc grade against `ci-baseline.json` in every run.
- The desktop and agent-ui gates on `.d.ts` report the same 0 errors as on sources.
- Deliberately add a type error in a ui-library export, in a scratch branch run locally (never a dispatched workflow): it must fail the new CI typecheck step.

**Rollback.** `TSGO_CHECKERS`, `--engine=tsc` and the three `build` scripts
are one-line reverts. The tsc 6 path is never removed in P1.

**Effort.** ~1.5 days of work, then 1–2 weeks of parity collection, which
runs alongside P2.

### P2 — emit without the TS 6 API (remove vite-plugin-dts, move server emit)

**Scope.** Every `build` that builds a TS 6 program for *emit*: system and
ui-library (vite-plugin-dts), types (`tsc --emitDeclarationOnly`), sdk
(`tsc -p tsconfig.build.json`), and server (`tsc` JS emit).

**Exact changes.**
1. **system.**
   - `vite.config.ts` drops the `dts()` plugin and `vite-plugin-dts`.
   - New `tsconfig.dts.json`: `rootDir: src`, `outDir: dist`, `declaration: true`, `emitDeclarationOnly: true`, and the spec/test/`__tests__` excludes copied from the plugin's `exclude`.
   - `build`: `vite build && tsgo -p tsconfig.dts.json --checkers 1 && npm run copy:hook`.
   - The two steps run **sequentially inside the task**, so the task peak is max(vite ≤ 0.7, tsgo 1.31) GB, not their sum.
2. **ui-library.** The same, with `.tsx` included and the `theme/index` entry kept.
3. **types.** `build`'s `tsc -p tsconfig.json --emitDeclarationOnly` → `tsgo … --checkers 1`.
4. **sdk.** `tsc -p tsconfig.build.json` → `tsgo -p tsconfig.build.json --checkers 1`. The CI-memory doc found the output byte-identical.
5. **server.** `tsc -p tsconfig.build.json` → `tsgo -p tsconfig.build.json --checkers 1`. Measured today: **214 files byte-identical**, 2.44 → 1.58 GB, 12.9 → 5.6 s. `tsup` (the server-root barrel) is unchanged.
6. Delete the unused `vite-plugin-dts` devDependency from the 7 addons listed in §1.4, and the dead `emitDts` / `loadDtsPlugin` branch of `tools/build/vite-lib.preset.ts`.
7. **Heavy-task lane** (see §2.1): `"nx": { "targets": { "build": { "parallelism": false } } }` in the `package.json` of types, system, server, ui-library, admin-ui and desktop. The CI build can then go back to `--parallel=3` for the ~34 light Vite builds (≤ 0.7 GB each).
8. Optional (P2b): node-root (`tsup dts: true`) and benchmark (`tsup dts`) → `tsup --no-dts` + `tsgo --emitDeclarationOnly`. These are small programs, so do it only if P0 shows them in the top 5.

**Expected RAM / time.**

| task | before | after (tsgo c1) |
| --- | ---: | ---: |
| system build | 2.14 GB, 7.9 s | **1.31 GB**, ~3 s dts + vite |
| ui-library build | 1.75 GB, 8.3 s | **0.83 GB** |
| types build (dts) | 1.79 GB, 9.5 s (35.8 s cold) | **1.46 GB**, 3.4 s |
| server build | 2.44 GB, 12.9 s | **1.58 GB**, 5.6 s |
| sdk build | 0.51 GB | 0.25 GB |
| **CI build step worst** | ≈ 3.5–4.5 GB (after P1) | **≈ 2.4 GB**: one heavy task alone (≤ 1.64) + nx 0.4 + page cache. Three light tasks ≈ 2.1 GB + 0.4. |

**Validation gate.** Every step below must pass for every package before its
`build` script switches:
1. **Same file set** in `dist/**/*.d.ts` (522 for types, 14 for sdk; system and ui-library are counted on the first run).
2. **Byte diff.** sdk and server JS must be identical. For types, system and ui-library, every diff must be cosmetic: a small `scripts/dts-normalize.ts` (single → double quotes in string-literal types, sorted union and object members) must reduce the TS 6 and TS 7 outputs to identical text. The 226 cosmetic diffs in types are the expected case. <!-- drift-ok: a file this plan creates -->
3. **Downstream typecheck on the new `.d.ts`.** With the TS 7 dists swapped in, the full `typecheck` (tsc 6 *and* tsgo) is unchanged against `ci-baseline.json`: server 0, system 0, sdk 0, ui-library 0, admin-ui on dist 0, addon-pipeline 323 (the pin). The CI-memory doc already did this once for types.
4. **`npm run codegen:check` stays clean.** `generate-api-types.ts` expands the core routers with ts-morph's TS 6 checker *through `dist/*.d.ts`*. Union order in its output could follow the new declaration order (§4.2). If it drifts, the fix belongs in the generator (sort before printing), not in reverting P2.
5. `scripts/check-no-dts-in-src.sh` before and after the build, and the `check-addon-types-entry` / `check-export-coverage` guards.
6. The viewer's `ts-check` against a locally packed `@camstack/types` (`npm pack` → install into a scratch copy of the viewer): 0 errors. The viewer resolves `@camstack/types` from the **published** package, so this is the consumer the published text change reaches first.

**Rollback.** Per package: restore the `build` script (and the `dts()`
plugin for system / ui-library). Keep `vite-plugin-dts` in the root lockfile
until P4 so that a rollback needs no install.

**Effort.** 2–3 days: system and ui-library ~1 day, types/sdk/server ~0.5
day, the normalizer and diff tooling ~0.5 day, the heavy-lane config ~0.5 day.
Ship it at a release boundary, because the published `@camstack/types` text
changes (decision D4).

### P3 — isolatedDeclarations where it is affordable; incremental where it is not

**Scope.**
- Remove the type *program* from declaration emit wherever exported types can be annotated: `isolatedDeclarations`. Emit then becomes a per-file transform with no checker.
- For `@camstack/types`, where that is not affordable, reduce the program's cost instead.

**Finding that shapes this phase.** `@camstack/types` has **11 809**
`isolatedDeclarations` errors in 233 files, 10 241 of them TS9013 ("expression
type can't be inferred"). They are the `export const xSchema = z.object(…)`
consts. The types *are* `z.infer` of those schemas by design: the API types are
Zod-derived, and hand-written twins rot silently. Annotating 10 k schema consts
would bring the hand-written twins back. **Do not apply isolatedDeclarations to
`@camstack/types`.**

**Rollout order** (smallest debt first; each step is its own commit):

| order | package | debt | after |
| --- | --- | --- | --- |
| 1 | sdk | 24 errors, 1 file | dts by a per-file transform |
| 2 | ui-library | 212 errors, 152 files (mostly component return types) | 0.83 GB → ~0.2 GB |
| 3 | system | 178 errors, 59 files | 1.31 GB → ~0.2–0.3 GB |
| — | types | 11 809 | stays program-based (P2's tsgo c1, 1.46 GB) |

**Exact changes per package.**
1. Add `"isolatedDeclarations": true` (with `declaration: true`) to its `tsconfig.json`. From then on, every typecheck (tsgo, P1) **enforces** the annotations, so the debt cannot grow back.
2. Fix the TS90xx errors by adding explicit return and export types.
3. Change the emitter from `tsgo --emitDeclarationOnly` to a per-file transform: `oxc-transform`'s `isolatedDeclaration()` in a ~50-line script, or the Rolldown dts plugin if it meets the same gate. This needs no program and no `typescript`.
4. Run the P2 validation gate again (same file set, normalized diff, downstream typecheck, codegen:check).

**`@camstack/types` instead.**
- **Barrel split** (§3). Programs that only need the cap surface should import a narrower entry (`addon`, `node`, `client`, `enums` already exist), so they load fewer of the 522 `.d.ts`. Measure the effect per consumer in P0 data before investing.
- **Incremental typecheck/emit** (`tsgo --incremental` / `composite` + project references, `tsgo --build`).
  - The nx cache already skips an unchanged package entirely, so incremental helps only when a package *did* change. It saves check time on the unchanged files, but the program is still parsed and bound, so the RAM saving is small.
  - **Adopt for local dev first.** Put the `.tsbuildinfo` under `node_modules/.cache/tsgo/<project>`; it pays off on repeated local runs.
  - In CI, add `*.tsbuildinfo` to the nx `outputs` of `typecheck` only if P0 data shows typecheck re-runs on small diffs dominating.
  - **Project references across the workspace** (one `tsgo --build` over every package) is *not* recommended. Every package bundles with Vite and the nx graph already orders them; references would be a second build graph to keep in sync.

**Expected RAM.** The build step's worst task becomes server (1.58 GB) or
types (1.46 GB), which are the floor for this design. Build step ≈ 2.0 GB with
the heavy lane.

**Validation gate.** The P2 gate per package, plus: tsgo with
`isolatedDeclarations` reports 0 TS90xx errors in the package, which keeps the
debt at zero.

**Rollback.** Per package: drop the flag and go back to P2's tsgo emit. The
annotations stay; they are harmless.

**Effort.** sdk 0.5 d; ui-library ~2 d; system ~2 d; emitter script 0.5 d;
barrel-split measurement 0.5 d. These can be spread out and done on touch.

### P4 — retire TS 6 where possible; track upstream; finish the viewer

- **Flip the reference.** After P1's parity window and a release cycle on tsgo:
  - `check-ci-baselines.ts --update` re-pins with tsgo;
  - `npm run typecheck:tsc6` is removed;
  - `typescript@6` stays only as a JS-API library.
- **Track upstream, re-evaluated at each TS 7.x release:**
  - the TS 7 JS/IPC API (the native API that ts-morph, typescript-eslint and unplugin-dts would move to);
  - `typescript-eslint` TS 7 support, for the viewer's `expo lint`;
  - ts-morph releases on TS 7, for `generate-api-types`;
  - nx's js plugin resolution;
  - `@module-federation/dts-plugin` (its nested TS 5.9.3; `dts: false` here).
  - Vite and Vitest need nothing (§1.4).
- **AST-only guard scripts** (8 scripts + `ui-catalogue.ts`): leave them on TS 6. They are parser-only, use little RAM, and run in Checks.
- **Remove** `vite-plugin-dts` from the lockfile once P2 has held through one release.
- **Viewer:** after P1v, nothing remains except `expo lint`'s parser. Metro and Babel strip types and never load `typescript` (§4.4).

### 2.1 Task ordering: heavy tasks never overlap

- **Build.** nx 23's per-target `"parallelism": false` (in the `nx` block of each heavy package's `package.json`, or via the nx-plugin's inferred targets) makes a heavy task run **alone**, while light tasks keep running up to `--parallel`.
  - Heavy set: types, system, server, ui-library, admin-ui, desktop, and benchmark if P0 shows it near 1 GB.
  - With the heavy lane, CI can use `--parallel=3`. The worst case becomes max(one heavy task, three light tasks) instead of the sum of two heavy ones.
  - Without it, keep `--parallel=2`.
  - Measure the wall-time cost in P0/P2: the heavy tasks are mostly on the critical path anyway (types → system → server → admin-ui).
- **Typecheck.** Always sequential: `typecheck-tsgo.ts` loops, and `check-ci-baselines` uses `--parallel=1` (P0).
- **Test.** `--parallel=1` (as today) × `VITEST_MAX_WORKERS=2`.
- **One program per project, once.** After P1 (D3), the only type programs in a CI job are:
  - the emit programs in `build` (types, server, plus system / ui-library until P3);
  - the single typecheck step.
  - admin-ui's three programs (gate + spec + server) become two (spec + server), both inside the typecheck step.

---

## 3. RAM-saving checklist

| # | measure | expected saving | where | phase |
| --- | --- | --- | --- | --- |
| 1 | `tsgo --checkers 1` instead of tsc 6 | −25–40 % per program (admin-ui spec 3.85 → 2.95 GB; server 2.82 → 1.76; types 2.21 → 1.69). **Never** tsgo's default of 4 checkers, which uses +30–75 % *more* than tsc 6. | every tsgo call | P1/P2 |
| 2 | `--singleThreaded` | **none** measured (±2 % vs c1). Do not use. | — | — |
| 3 | `paths` to built `.d.ts`, not sibling `src/` | admin-ui gate −1.7 GB (done); **desktop gate −1.26 GB**; agent-ui small. The root `tsconfig.json` still maps 21 entries to `src`; it is for editors and tsx and is not used by package builds. Keep it that way. | build gates | P1 (desktop: before TS 7) |
| 4 | `skipLibCheck` | already `true` in `tsconfig.base.json`, server, and the viewer (expo base). Saving already taken; keep it (a guard could assert it). | all | — |
| 5 | split the `@camstack/types` barrel (root vs `client`/`addon`/`node`/`enums`) | unmeasured; likely 0.3–0.8 GB for programs that import the root but use the cap surface only. The viewer already enforces `/client`. | consumers of the root entry | P3 (measure first) |
| 6 | `isolatedDeclarations` | removes the dts program: system −1.1 GB, ui-library −0.6 GB, sdk −0.2 GB. **Not for types** (11 809 Zod-inferred errors). | sdk, ui-library, system | P3 |
| 7 | incremental + `.tsbuildinfo` | mostly time; RAM saving small (still parse + bind). Local dev first. | local typecheck; CI only if P0 data shows it | P3 |
| 8 | nx heavy lane (`parallelism: false`) + `--parallel=3` for light tasks | build worst case from the *sum* of two heavy tasks to the *max* of one: ≈ −1.5 GB after P2 | CI and Checks build | P2 |
| 9 | `NODE_OPTIONS` per step, not job-wide | bounds the worst case; vitest forks stop inheriting an 8 GB ceiling. Tests 3072 until P0 measures the largest fork. | ci.yml, checks.yml | P0 |
| 10 | `VITEST_MAX_WORKERS=2` (replaces the dead `VITEST_MAX_THREADS`) | server suite 4.2 → 3.1 GB (+30 % wall); 1 worker = 2.3 GB at 2.5× wall, kept as a fallback | CI test steps | P0 |
| 11 | vitest `pool` / `isolate` | `forks` already in server, addon-pipeline and addon-post-analysis. `isolate: false` cuts per-file module reloads but changes test semantics; **only** per package, with its suite green twice, and never for the forks-isolated suites (open handles) | per package `vitest.config.ts` | after P0 data |
| 12 | no build/typecheck run twice | admin-ui: three programs → two; desktop / agent-ui gates removed; Checks `e2e` job rebuilds but hits the shared nx cache (verify the hit in P0) | build scripts, Checks | P1 (D3) |
| 13 | Checks typecheck `--parallel=1` | 8.9 → 3.9 GB worst (tsc 6), → 3.0 (tsgo) | `check-ci-baselines.ts` | P0 |
| 14 | `GOMEMLIMIT` / `GOMAXPROCS` | `GOMEMLIMIT`: no effect (CI-memory doc). `GOMAXPROCS` is a CPU lever (leaving cores to the live agent), not a RAM lever. Use it only if P0 shows the agent starved. | — | only if measured |
| 15 | zram | the safety net, never the plan: no budget in this document counts it | host | — |
| 16 | remove dead `vite-plugin-dts` deps and the preset's `emitDts` branch | install size, not peak RAM | 7 addons, `tools/build` | P2 |

---

## 4. Risks and mitigations

### 4.1 TS 7 behaviour differences

- **Union order in messages** (`"high" | "low" | "mid"` vs `"high" | "mid" | "low"`). It affects message text only. The parity check (P1) compares `file(line,col): code` sets, never message text. `ci-baseline.json` pins counts per file, so it is unaffected.
- **`.d.ts` text** (quote style, member order). 226 cosmetic files in types. Mitigation: the P2 normalizer, the downstream typecheck gate, and release-boundary timing (D4).
- **Config removals** (`baseUrl`, `moduleResolution: node`). Already fixed by the TS 7-ready tsconfig change (2026-10-09). A new package copied from an old template could reintroduce them, so P1's tsgo typecheck rejects them (TS5102/TS5108) on the first run. That makes it its own guard.
- **A real divergence** (an error that only one compiler reports). The parity window exists for this. If one appears, report it upstream and pin the affected project to tsc 6 in `typecheck-tsgo.ts` (per-project override) rather than blocking the phase.

### 4.2 Codegen that depends on the TS API

- `generate-api-types.ts` uses ts-morph's bundled TS 6.0.2 checker on the **server** program, reading `@camstack/types` / `system` through their `dist/*.d.ts`. After P2 those dists are TS 7-emitted, and its printed types may change order.
  - Mitigation: `codegen:check` is a P2 gate. If the output drifts, sort in the generator.
  - It stays on TS 6 until ts-morph ships on a TS 7 API. It runs in Checks only, so its RAM is outside the CI job.
- The AST-only guard scripts are unaffected by TS 7 (they never see a TS 7 artifact).

### 4.3 Editor / IDE

- VS Code and Cursor use the workspace `typescript` (TS 6) for the language service. After P1, CI checks with TS 7 while the editor shows TS 6.
- Parity makes the difference theoretical, but a developer could see a green editor and a red CI (or the reverse) on a real divergence.
- Mitigations:
  1. keep the editor on TS 6 (the default; no change needed);
  2. optionally, the "TypeScript (Native Preview)" extension for speed — personal choice, not required;
  3. `npm run typecheck` (tsgo after the flip) is the local truth before pushing.
- Editor RAM: the TS 6 language server on the whole workspace is its own multi-GB process. That is outside CI, but it competes on a dev machine running the hub. This plan does not change it.

### 4.4 Metro / Babel and the viewer

- Metro bundles with Babel (`@babel/preset-typescript` via Expo), which strips types and never loads `typescript`. TS 7 cannot break the viewer's bundle.
- The only TS consumers in the viewer are `tsc --noEmit` (→ tsgo in P1v) and `expo lint`'s typescript-eslint parser (stays on TS 6, §1.4).
- The viewer moves **separately**: it is its own repo with its own CI, has no tsconfig blockers, and was measured clean.
- Ship order: viewer P1v after the server's P1 parity window has started, so a TS 7 regression is diagnosed in one place at a time.

### 4.5 Operational risks

- **Wall time.** P0's `VITEST_MAX_WORKERS=2` and serial Checks typecheck make runs slower before P1 makes them faster. Mitigation: ship P0 and P1 close together. The CI test step timeout (90 min) has headroom; watch the nightly full suite.
- **tsgo source freeze.** `@typescript/native-preview` stopped at `20260707.2`; D1 moves to the released `typescript@7`. The npm-alias binary must be called by path; a `.bin/tsc` collision would silently run the wrong compiler, so `typecheck-tsgo.ts` asserts `--version` starts with `7.`.
- **cgroup accounting.** `memory.current` includes the page cache; `mem-step.sh` records the tree RSS separately, so a large cache is not mistaken for a leak.

---

## 5. Decision points for the operator

| id | decision | recommendation |
| --- | --- | --- |
| D1 | tsgo source: keep `@typescript/native-preview@7.0.0-dev.20260707.2` (frozen) or move to `typescript@7.0.2` as an npm alias | **Alias the released 7.0.x**, binary called by path, version asserted. |
| D2 | When `npm run typecheck` and the Checks grade switch to tsgo, and whether tsgo may re-pin `ci-baseline.json` | Grade with tsgo after **10** parity-clean Checks runs; re-pin with tsgo from P4 (one release later). |
| D3 | Move type checking **out of `build`** into one CI typecheck step (`typecheck-tsgo`, all 55 projects, c1, sequential) | **Yes.** It is cheaper (one program per project), covers every package instead of three, and it is the single source of truth. It amends D704's "CI = build + test" by adding exactly one step. **ADR-worthy.** |
| D4 | Accept TS 7-emitted `.d.ts` (226 cosmetic diffs in `@camstack/types`) in published packages | **Yes, at a release boundary**, after the P2 gate. |
| D5 | `isolatedDeclarations` scope | **sdk, ui-library, system: yes. `@camstack/types`: no** (Zod-inferred by design). **ADR-worthy** (an authoring rule for exported APIs). |
| D6 | Budget enforcement | `::warning::` for 10 runs after P0, then **fail** on breach (`MEM_BUDGET_ENFORCE=1`). |
| D7 | Re-enabling the second runner | Only when §6's gate holds: CI and Checks jobs each at p100 ≤ 4.5 GB over 10 runs. Then two runner containers, each with `memory.max` = **6 GB**. |
| D8 | Viewer moves separately (P1v) | **Yes**, after the server's P1 parity window has started; `typescript@6` stays for `expo lint`. |
| D9 | Editor TypeScript | Stay on TS 6 (workspace version); the native-preview extension is optional. |
| D10 | vitest fallback if 2 workers is still too heavy on the nightly full suite | `VITEST_MAX_WORKERS=1` for the nightly only (2.3 GB, 2.5× slower), not for pushes. |

**ADR-worthy (do not write yet):**
- **(a)** TS 7 as the type authority, with the dual-install policy (TS 6 only as a JS-API library), covering D1, D2 and D9;
- **(b)** type checking as its own CI step, out of `build` (D3, amends D704);
- **(c)** `isolatedDeclarations` for the framework packages except `@camstack/types` (D5).

---

## 6. Success metrics

Measured by P0's `mem-step.sh` on the N100. "Peak" is the summed process-tree
RSS per step, and per job via `memory.peak`.

| metric | today | target after P1 | target after P2/P3 |
| --- | ---: | ---: | ---: |
| CI job peak (cgroup lifetime) | **7.46 GB** (`memory.peak`, runs `37956999818`/`37963593686`) | **≤ 4.5 GB** tree steps | **≤ 3.5 GB** |
| CI build step peak | **4.02–4.19 GB** tree cold (N100) | ≤ 4.5 GB | **≤ 2.5 GB** |
| CI install step peak | **3.23–4.36 GB** tree (N100); budget now 4.5 GB | ≤ 4.5 GB | ≤ 1.5 GB |
| CI test-affected peak | **3.52 GB** tree / **45 min** wall (N100, run `37963593686`) | ≤ 3.2 GB | ≤ 3.2 GB |
| Checks `static` job peak | ≈ 8.9 GB worst (typecheck) | **≤ 4.0 GB** | ≤ 3.5 GB |
| Largest single TypeScript process anywhere in CI | 3.85 GB (admin-ui tsc spec) | ≤ 3.0 GB | ≤ 3.0 GB |
| CI cold build wall (N100) | ~12–13 min (p2) | ≤ 12 min | **≤ 9 min** |
| Checks typecheck wall (N100) | ~20 min serial tsc 6 (after P0) | **≤ 7 min** | ≤ 7 min |
| Viewer ts-check | 2.36 GB / 15 s (Mac) | ≤ 1.8 GB | — |

**Re-enabling the second runner (D7).** Two runner containers, each capped at
**6 GB**, can coexist with the live agent when both of these hold:
- every CI and Checks job's p100 job peak is ≤ 4.5 GB over 10 consecutive runs (1.5 GB of margin under each container's cap);
- the sum of two concurrent job peaks (≤ 9 GB) still leaves ≥ 7 GB for the agent and the OS without touching zram.

After P2 the expected job peak is ≈ 3.5 GB, so two concurrent jobs total
≈ 7 GB.
