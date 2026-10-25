---
title: CI build memory and the TypeScript 7 trial (2026-10-09)
last-verified: 2026-10-09
---

# CI build memory and the TypeScript 7 trial (2026-10-09)

> **Follow-up plan:** [`2026-10-09-ts7-transition-plan.md`](2026-10-09-ts7-transition-plan.md)
> is the phased, lowest-RAM TypeScript 7 transition built on these measurements
> (status: planned, not started). It corrects one claim below: Vite 8, Vitest 4
> and tsx do **not** load the TypeScript JS API. Only vite-plugin-dts, tsup's
> `dts`, ts-morph, nx's js plugin, typescript-eslint (viewer) and the repo's
> own AST/codegen scripts do.

On 2026-10-09 at 07:36 two CI runs started on the two runner containers of
agent-a (4-core N100, 16 GB, no swap, also hosting a CamStack agent).
Both reached "Build all packages" together; the host thrashed (load ~100,
182 MB free) and became unreachable. The runner-side mitigations (one runner, a
container memory limit) are another session's work. This record answers why a
single build is this heavy, what was changed in the build, and whether
TypeScript 7 (`tsgo`) can take over typechecking.

All numbers were measured on an M-series Mac (12 cores) in a clean worktree,
nx cache skipped. Peak RSS is `/usr/bin/time -l` (largest single process);
"summed RSS" samples `ps` every second over every process of the worktree. The
N100 is ~4× slower per task, so on it the long tasks overlap more, not less.

## 1. What the CI build runs

- `ci.yml` job `tests`, step "Build all packages": `npm run build` =
  `nx run-many -t build`, no `--parallel` and no `parallel` in `nx.json` → nx's
  default of **3** concurrent tasks. Job-level `NODE_OPTIONS=--max-old-space-size=8192`
  → every task may grow a heap to 8 GB.
- 55 projects. 34 are a bare `vite build` (Vite 8 / Rolldown, 0.2–0.7 GB, <1 s
  here). The heavy ones are whole TypeScript programs:

| package | build steps |
| --- | --- |
| types | `vite build` ×2, `tsc -p tsconfig.json --emitDeclarationOnly` |
| system | `vite build` with `vite-plugin-dts` (whole `src/**`) |
| ui-library | `vite build` with `vite-plugin-dts` |
| sdk | `vite build`, `tsc -p tsconfig.build.json` |
| server/backend | `tsc -p tsconfig.build.json` (emit), `tsup` |
| addon-admin-ui | `tsc --noEmit`, `vite build` ×2 |
| addon-agent-ui | `tsc --noEmit`, `vite build` ×2 |
| desktop | `tsc --noEmit -p tsconfig.main.json`, `tsup` |

No api-extractor, no `rollup-plugin-dts` (`rollupTypes: false`), no codegen in
`build`. There is no giant generated file: the largest `packages/types` source
is 3.8 k lines (`pipeline-analytics.cap.ts`); the barrel is 122 k lines total.

## 2. Per-target peak memory (before)

`NODE_OPTIONS=--max-old-space-size=8192`, dependencies already built.

| target / step | wall | peak RSS |
| --- | ---: | ---: |
| **admin-ui `tsc --noEmit`** | 29.7 s | **3 942 MB** |
| server `tsc -p tsconfig.build.json` | 10.2 s | 2 436 MB |
| system `vite build` + dts | 7.9 s | 2 135 MB |
| types `tsc --emitDeclarationOnly` | 9.5 s | 1 790 MB |
| ui-library `vite build` + dts | 8.3 s | 1 746 MB |
| desktop `tsc --noEmit` + tsup | 10.2 s | 1 733 MB |
| admin-ui `vite build` | 4.6 s | 1 415 MB |
| benchmark (tsup + vite) | 3.2 s | 1 014 MB |
| addon-pipeline `vite build` (widgets) | 2.0 s | 730 MB |
| agent-ui `tsc --noEmit` | 1.5 s | 588 MB |
| sdk `tsc` | 1.3 s | 509 MB |
| addon-pipeline `vite build` | 0.6 s | 508 MB |
| addon-export-hap `vite build` | 0.6 s | 472 MB |
| types `vite build` | 0.9 s | 333 MB |
| addon-provider-velux `vite build` (small addon) | 0.4 s | 262 MB |

Whole build, cold, nx default parallel (3), 8 GB heap: **100 s, summed RSS
p50 1.8 GB / p90 4.1 GB / max 4.7 GB**. The peak sample was admin-ui's tsc at
3.8 GB alone. Forcing the overlap the graph allows (admin-ui tsc + system dts +
desktop tsc started together): **5.35 GB summed**; sum of their peaks 7.7 GB.

### Heap ceiling vs RSS

| | 8192 | 4096 | 3072 | 2048 |
| --- | ---: | ---: | ---: | ---: |
| admin-ui tsc (sources) | 3 894 MB | 3 390 MB | **OOM** | **OOM** |
| server tsc | 2 442 MB | 2 437 MB | 2 191 MB | 2 053 MB |
| system vite + dts | 2 149 MB | 2 138 MB | 2 118 MB | 2 136 MB |

The heap flag is not what makes these big — they need the memory (admin-ui on
sources needs ~3.4 GB of heap). Lowering it only bounds the worst case.

### Top causes

1. **admin-ui's build gate re-typechecks three other packages from source.**
   `tsconfig.json` maps `@camstack/types`, `sdk` and `ui-library` to their
   `src/` via `paths`, so `tsc --noEmit` in `build` is a 3 185-file program
   (406 k lines of TS, 6.3 M instantiations, 3.4 GB "Memory used", 25 s check)
   — on every CI build, and again in the separate `typecheck` target. Against
   the built `.d.ts` (which `dependsOn: ^build` guarantees) it is 2 104 files,
   2.5 M instantiations, **2.4 GB / 15 s, same 0 errors**.
2. **One full TypeScript program per declaration-emitting package**: server
   tsc 2.4 GB, system `vite-plugin-dts` 2.1 GB (a plain `tsc
   --emitDeclarationOnly` of the same tree is 1.58 GB — the plugin costs
   ~0.5 GB on top), types 1.8 GB, ui-library 1.7 GB, desktop 1.7 GB. Each
   re-reads the `@camstack/types` declarations; none share work.
3. **3 tasks × 8 GB ceiling × 2 runners on one 16 GB host.** One build's
   worst overlap is ~7.7 GB of peaks; two builds at once ~15 GB, before the
   agent container and the OS. That is exactly the 07:36 failure.

Not causes: Vite/Rolldown bundling (≤0.7 GB for every addon), a giant
generated file, nx itself (~0.4 GB).

## 3. What changed

| change | file |
| --- | --- |
| CI build step: `npm run build -- --parallel=2`, step-level `NODE_OPTIONS=--max-old-space-size=4096` (tests keep the job-level 8 GB) | `.github/workflows/ci.yml` |
| admin-ui build gate typechecks against the built `.d.ts` (`tsconfig.build.json`, `paths: {}`); `typecheck` still checks sources | `packages/addon-admin-ui/{package.json,tsconfig.build.json}` |
| TS 7-compatible tsconfigs: `baseUrl` removed (8 files; the root `tsconfig.json` `paths` became `./packages/…`, because tsx rejects non-relative `paths` without a `baseUrl`), `moduleResolution: node` → `bundler` (server, desktop, nx-plugin). tsc 6 error counts unchanged; server, nx-plugin and desktop `dist` byte-identical | see §5 |
| `npm run typecheck:tsgo` + `@typescript/native-preview` devDependency | `scripts/typecheck-tsgo.ts`, `scripts/lib/tsgo-typecheck.ts` |

Before / after:

| | before | after |
| --- | ---: | ---: |
| admin-ui build gate | 3 942 MB, 29.7 s | **2 273 MB**, ~15–20 s |
| forced worst overlap | 5 350 MB (p3: admin-ui + system + desktop) | **3 857 MB** (p2: admin-ui + system) |
| full cold build, summed RSS max | 4 728 MB (p3, 8 GB) | **4 194 MB** (p2, 4 GB) |
| full cold build, p90 | 4 137 MB | 2 849 MB |
| full cold build, wall (Mac) | 100 s | 133 s (p2) / 117 s (p3) |

At `--parallel=2` the theoretical worst case is the two largest tasks the graph
lets coexist — admin-ui gate 2.3 GB + system dts 2.1 GB ≈ **4.5 GB + ~0.4 GB
nx**, which fits a 10 GB container with room for the test step's two vitest
threads. Expected cost on the N100: the build step's ~10 min cold becomes
~12–13 min; a warm runner is a cache read either way.

## 4. Further fixes (proposed, not done)

- **Emit declarations without `vite-plugin-dts`** for system / ui-library:
  `tsc --emitDeclarationOnly` (or tsgo, §6) after `vite build`, as types
  already does. −0.5 GB per package with tsc; −0.5 GB and −75 % wall with tsgo.
- **`isolatedDeclarations`** on types/system/sdk so declaration emit becomes a
  per-file transform (oxc/Rolldown can do it) with no type program at all.
  Requires explicit return types on every export — a large diff; the payoff is
  removing cause 2 entirely.
- **Typecheck out of `build`** in admin-ui / agent-ui / desktop: their `typecheck`
  target already exists. Kept for now because D704 made CI build+test only, so
  this gate is the one place a type error in the UI still fails CI.
- **Project references / `tsc --build`**: would share `.d.ts` between packages
  incrementally, but every package bundles with Vite and emits types in its own
  way; a migration, not a flag.

## 5. TypeScript 7 trial

`typescript@7.0.2` is now `latest` on npm and ships only a native binary
(`bin/tsc`, no JS API). `@typescript/native-preview` (`tsgo`) stopped at
`7.0.0-dev.20260707.2`. Both were measured; they agree within noise. tsgo is
installed as the devDependency because `typescript` must stay at 6 —
`vite-plugin-dts`, `tsup` and the Vite/Vitest toolchain load the TypeScript JS
API, which TS 7 does not have.

### Config blockers (fixed)

TS 7 removes `baseUrl` (TS5102) and `moduleResolution: node`/`node10` (TS5108).
Before the fix tsgo refused 8 of 55 projects: admin-ui, benchmark, model-studio,
osd-manager, training (`baseUrl: "."` next to `paths` — a no-op, since `paths`
resolve from the tsconfig), desktop, nx-plugin, server/backend. After the fix
tsc 6 still reports 0 errors in all eight and the three emitting builds produce
byte-identical `dist/`.

### Typecheck: wall and memory

`--noEmit -p <the project's typecheck config>`, 8 GB heap for tsc 6.

| project | tsc 6 | tsgo (default, 4 checkers) | tsgo `--checkers 2` | tsgo `--checkers 1` |
| --- | --- | --- | --- | --- |
| types | 17.1 s / 2 213 MB | 5.9 s / 3 616 MB | 10.1 s / 2 368 MB | 9.7 s / 1 691 MB |
| system | 14.2 s / 1 772 MB | 2.8 s / 1 975 MB | 5.1 s / 1 581 MB | — |
| server/backend | 18.0 s / 2 819 MB | 7.0 s / 4 922 MB | 6.3 s / 2 947 MB | 6.8 s / 1 744 MB |
| admin-ui (spec) | 45.4 s / 3 848 MB | 12.4 s / 5 373 MB | 12.2 s / 3 889 MB | 14.1 s / 2 947 MB |
| ui-library | 12.2 s / 1 131 MB | 1.7 s / 1 063 MB | 1.8 s / 932 MB | — |
| addon-pipeline | 15.2 s / 1 627 MB | 2.5 s / 1 569 MB | 2.9 s / 1 416 MB | — |
| **all 55 projects (sum)** | **388 s**, max 4.0 GB | 49 s, max 3.1 GB* | 48 s, max 2.4 GB* | |

\* sums from the pre-fix sweep, where the 8 blocked projects exited in <1 s;
after the fix the whole `npm run typecheck:tsgo` takes ~90 s with a 4.0 GB
peak (admin-ui).

tsgo is 3–8× faster. **It is not lighter by default**: its 4 parallel checkers
each keep their own checker state, so the big programs use 30–75 % MORE memory
than tsc 6. `--checkers 2` matches tsc 6's footprint at the same speed;
`--checkers 1` uses ~25–40 % less than tsc 6 and is still 2–3× faster.
`GOMEMLIMIT` does not help (it trades wall time for almost no RSS).

### Diagnostics

Identical error counts in all 55 projects (tsc 6 vs tsgo, before and after the
config fix): 0 everywhere except the pinned spec debt — addon-pipeline 323,
addon-post-analysis 630. The only textual difference is union member order in
messages (`"high" | "low" | "mid"` vs `"high" | "mid" | "low"`).

Pre-existing, not from this change: addon-post-analysis has 630 errors against
a pin of 629 — `retrain-collections.spec.ts(155,5)` TS2322, from 108389043
(2026-10-08). tsc 6 and tsgo both report it, so `npm run typecheck` is red on
main today as well.

### Declaration emit

| | tsc 6 | tsgo / TS 7.0.2 | tsgo `--checkers 1` |
| --- | --- | --- | --- |
| types `--emitDeclarationOnly` | 35.8 s / 1 794 MB | 7.3 s / 3 104 MB | 5.4 s / 1 501 MB |
| sdk | 1.7 s / 507 MB | 0.2 s / 250 MB | |
| system (tsc-style emit) | 18.0 s / 1 581 MB | 4.0 s / 1 579 MB (c2) | |
| ui-library | 12.6 s / 1 131 MB | 2.5 s / 958 MB (c2) | |

Same file set (522 `.d.ts` for types, 14 for sdk). sdk is byte-identical.
types differs in 226 files, all cosmetic: string-literal types keep the
source's single quotes (`'accessories'` vs `"accessories"`) and union/object
members are printed in a different, deterministic order. **Semantically
equivalent**: with the TS 7 `.d.ts` swapped into `packages/types/dist`, tsc 6
typechecks server (0), system (0), sdk (0), ui-library (0), admin-ui on dist
(0) and addon-pipeline (323, the pin) unchanged.

### Recommendation

The phased plan that carries this forward is
[`2026-10-09-ts7-transition-plan.md`](2026-10-09-ts7-transition-plan.md).

- **Adopt now (done)**: `npm run typecheck:tsgo` — each project's own
  `typecheck` script with `tsc` swapped for `tsgo --checkers 2`, graded
  against `scripts/ci-baseline.json` like `npm run typecheck`. Use it for local
  and pre-push checks. `npm run typecheck` (tsc 6) stays the reference and the
  only path that re-pins. lint-staged does not typecheck, so there is nothing
  to switch there.
- **Next**: move the on-demand Checks workflow's typecheck to tsgo with
  `--checkers 1` on the N100 (faster than tsc 6 and ~1 GB lighter on the
  largest program). A Checks-workflow edit; not done here.
- **Declaration emit**: technically ready (equivalent `.d.ts`, 5× faster), but
  not adopted — the published `.d.ts` would change textually in 226 files, and
  system/ui-library emit through `vite-plugin-dts`, which needs the TS 6 API.
  Do it together with the `vite-plugin-dts` removal in §4, with `--checkers 1`.
- **Not before TS 7 has a JS API**: replacing `typescript` itself — Vite,
  Vitest, tsup and vite-plugin-dts all import it.
