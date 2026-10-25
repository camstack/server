---
id: D479
title: A published package's `dependencies` carries only what its shipped `dist` requires at run time
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/addon-admin-ui/package.json
  - packages/ui-library/package.json
  - packages/addon-benchmark/package.json
  - packages/addon-pipeline/package.json
  - packages/addon-pipeline-orchestrator/package.json
  - packages/addon-auth/package.json
  - packages/addon-post-analysis/package.json
  - packages/addon-agent-ui/package.json
  - scripts/check-runtime-deps-reachable-from-dist.ts
---

## Context

D477 measured, on `agent-a`, that ~240 MB / ~11 000 files of every
node's closure install is a build-time browser toolchain declared as a
runtime `dependency`: `monaco-editor` (99 MB / 1 909 files, pulled in via
`@monaco-editor/react`'s required peer), `lucide-react` twice (88 MB / 7 276
files — `ui-library` pinned `^0.576`, `addon-admin-ui` pinned `^0.511`, so npm
could not dedupe), `hls.js` (32 MB), `@xyflow/react`, `react-dom`, `konva`,
`@xterm/*`, and `@types/qrcode`. `@camstack/server` depends on all eight addon
packages unconditionally, so an agent that never renders the admin UI installs
its whole toolchain on every update — and on a healthy `agent-a` (D477's
own before/after), the top three `reifyNode` timers were the two
`lucide-react` copies and `monaco-editor`, against a 41.6 s `reify:unpack`.
This record implements the fix D477 named but did not make.

**Everything below was verified against the BUILT `dist/`, not the source or
D477's own table** — D477 itself was a correction of six inherited numbers,
so its own claims got the same treatment before anything was moved:

- `addon-admin-ui`'s only server-side runtime entry is
  `dist/server/addon.js` (`src/server/addon.ts` — 31 lines: `node:path`,
  `node:url`, and `@camstack/types`, already a `peerDependency`). Grepping the
  built file for every bare `require`/`import`/dynamic `import()` finds
  **zero** of its 22 `dependencies` entries — not `@monaco-editor/react`, not
  `@camstack/sdk`, not `@camstack/ui-library`, not `react`. The 7.1 MB SPA
  bundle (`dist/assets/Build-*.js`) inlines all of it; the server half only
  serves those files as static assets.
- `ui-library`'s `dist/index.cjs` bare-requires exactly ten specifiers:
  `@camstack/sdk`, `@camstack/types`, `@tanstack/react-query`, `@trpc/client`,
  `@trpc/react-query`, `react`, `react-dom`, `react-dom/client`,
  `react/jsx-runtime`, and `zod` — all already `peerDependencies` except
  `zod`, which genuinely needs to stay a `dependency` (it is the one entry in
  `vite-lib.preset.ts`'s `FRAMEWORK_EXTERNALS` this package's `framework+ui`
  build mode does not bundle). `hls.js`, `lucide-react`, `qrcode.react`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, and
  `@module-federation/runtime` (confirmed fully inlined — its
  `@module-federation/sdk` transitive source is in the bundle, not a
  `require()` call) are bundled, matching D477's own read of
  `dist/hls-*.cjs` and `dist/icons/`.
- The same grep against `addon-benchmark`, `addon-pipeline`,
  `addon-pipeline-orchestrator`, `addon-auth`, `addon-post-analysis`, and
  `addon-agent-ui`'s built `dist/` finds no bare reference to `lucide-react`
  in any of them either — `vite-lib.preset.ts`'s `UI_EXTERNALS` never
  externalises it, so every one of these packages bundles its own copy the
  same way `ui-library` does. `addon-pipeline-orchestrator`, `addon-auth`,
  and `addon-agent-ui` already had it correctly in `devDependencies`, just at
  a stale, divergent version (`^0.511.0` / `^0.483.0` in `addon-agent-ui`'s
  case); `addon-benchmark`, `addon-pipeline`, and `addon-post-analysis` still
  had it in `dependencies`. Before this change, three distinct copies were
  live in this workspace's own `node_modules` at once — `0.511.0` hoisted at
  root, `0.576.0` nested under `ui-library`, `0.483.0` nested under
  `addon-agent-ui` — one more copy than D477's own table counted.
- `addon-agent-ui`'s server entry (`dist/addon.js`) bare-requires nothing
  from `@camstack/ui-library` either, and inlines `@camstack/types` the same
  way `addon-admin-ui` does — the identical pattern, one addon over.

**What did NOT move, and why.** `ui-library`'s `zod` (bare-required, proven
above). `addon-pipeline`'s `@camstack/system`, `mp4box`, `node-av`,
`opus-decoder`, `sharp`, `zod` and `addon-post-analysis`'s `@camstack/system`,
`sharp` were left alone without individually re-proving each — they were not
part of this record's target list and touching a media-decode addon's
dependency graph on unverified grounds is exactly the kind of change CLAUDE.md
warns against ("trace the real code path before proposing a fix").

**A repo-wide run of the guard this record adds (below) surfaced 50 more
candidates across 22 more packages** — most strikingly `zod` in eleven
self-contained-mode addons (`addon-ai`, `addon-cloudflare`,
`addon-decoder-ffmpeg`, `addon-decoder-nodeav`, `addon-export-alexa`,
`addon-export-google`, `addon-export-hap`, `addon-pipeline`,
`addon-post-analysis`, `addon-provider-onvif`, `addon-smtp-nodemailer`) and
twelve entries in `@camstack/system` itself (`moleculer`, `tar`, `js-yaml`,
`jsonwebtoken`, `bcryptjs`, `croner`, `otplib`, `sqlite-vec`,
`systeminformation`, `@msgpack/msgpack`, `superjson`, `@camstack/sdk`). This
is very likely the same pattern repeating — `vite-lib.preset.ts`'s
`SELF_CONTAINED_EXTERNALS` does not externalise `zod`, so a self-contained
addon bundles its own copy by design (documented there: independence from the
hub's schema instance across server upgrades) — but every one of those 50
entries is UNVERIFIED beyond "the scan found no bare reference," not audited
package by package against its `dist/`, and explicitly out of scope here. They
are recorded in `scripts/runtime-deps-baseline.json` as exemptions so the new
guard passes without either silently absorbing them into "fixed" or masking
them from the next person who looks.

## Decision

A workspace package whose `files` field ships a built `dist` declares in
`dependencies` only what a grep of that BUILT `dist` — not the source, not the
author's intent — actually `require`s or `import`s at runtime. Everything
else its build pulls in (bundler, framework, icon set, editor, player, or a
workspace framework package whose code is inlined rather than resolved) moves
to `devDependencies`. Where the same bundled-dependency needs to exist in more
than one package's `devDependencies` (as `lucide-react` does across seven
packages here), every copy is pinned to the same range — `^0.576.0`, the
newest of the three ranges this repo had in play, already proven to build
clean in `ui-library` before this change — so a workspace install nests at
most one copy instead of two or three.

## Consequences

- Measured end-to-end: packed the eight changed packages as real tarballs and
  ran `npm install --omit=dev` of `@camstack/server@1.2.276` twice from the
  real npm registry — once unmodified, once with `overrides` substituting
  the eight local tarballs at the same version — into empty scratch
  directories. **Before: 726 MB / 29 525 files. After: 476 MB / 16 789
  files.** A 250 MB, 12 736-file reduction — larger than D477's ~240 MB / ~11
  000 estimate because this also removed `@camstack/sdk` and
  `@camstack/ui-library` from `addon-admin-ui` and `addon-agent-ui` (both
  already shipped as direct dependencies of `@camstack/server` itself, so
  removing them from the addons is a pure closure-size win with no
  behavioural change) and closed the third `lucide-react` copy D477's table
  had not counted. `monaco-editor`, both `lucide-react` copies, `hls.js`, and
  `@xyflow/react` are confirmed absent from the "after" tree; `zod` (the one
  genuine runtime dependency touched) is confirmed still present.
- `npm run build` for all eight packages, `npm run typecheck`,
  `npm run codegen:check`, `npm run check-deps`, and `npm run docs:check` are
  all green on this change. `npm run test` (`nx run-many -t test`) is green
  except the two pre-existing reds this record inherited rather than caused —
  `addon-pipeline-orchestrator`'s `camera-status-cap.spec.ts` unhandled
  rejection (reproduces identically in isolation, unrelated to any package.json
  edit: a deliberately-unresolved `TIMEOUT branch` test) and a `ffmpeg-run-once:
  timed out` in `addon-pipeline`'s `segment-demux.spec.ts` (passes in 939 ms in
  isolation; failed only under this session's own concurrent full-build +
  two-scratch-install load — a timing flake in the same family CLAUDE.md
  already names, just a different file than the one named there).
- Moving a dependency to `devDependencies` moves the burden onto the build,
  same as D477 already flagged: a package published without its `dist` built
  now fails at a consumer's `import`, not at install. `scripts/publish.sh`
  always runs `nx run-many -t build --exclude=@camstack/server` before
  `npm publish` for every package, so this is already covered — no
  `prepublishOnly` hook was added.
- **Enforcement.** `scripts/check-runtime-deps-reachable-from-dist.ts` scans
  every non-private `packages/*` workspace package whose `files` ships a
  built `dist`, and for each `dependencies` entry, greps every `.js`/`.cjs`/
  `.mjs` file under that `dist/` for a literal bare reference. No match and no
  baseline exemption fails the build. Wired into `.github/workflows/ci.yml`'s
  guards loop (`docs/reference/guards.md` regenerated). Disarm-verified:
  re-adding `monaco-editor` to `addon-admin-ui`'s `dependencies` makes the
  guard fail with that exact package and dependency named; removing the
  addition restores a clean pass.
- It is a literal string scan, not a bundler-accurate resolver — documented
  in the script's own "Honest limits" section. A dependency reached only
  through a fully dynamic, computed specifier would read as a false
  violation; none of the packages this record touched do that (verified by
  hand, not by the scanner, for every dependency actually moved). The 50
  entries in `scripts/runtime-deps-baseline.json` are exactly this
  uncertainty made visible rather than swept into either "fixed" or
  "ignored": a ratchet, same shape as `check-closure-shipped-deps.ts`'s
  `closure-deps-baseline.json` — a new entry needs a reviewed reason, a stale
  one fails the build until removed.
- `@camstack/server` still depends unconditionally on `addon-admin-ui` and
  every other addon package (D477 already named this; unchanged here) — an
  agent still installs addons it will never run. Making the closure
  role-aware remains a separate, larger piece of work.
- The `zod`-in-self-contained-addons pattern flagged above is the most likely
  next instance of this exact defect, at a scale (eleven addons plus
  `@camstack/system`) that deserves its own dedicated, package-by-package
  pass rather than a batch move made on this record's evidence.

## Enforcement

`scripts/check-runtime-deps-reachable-from-dist.ts`, run in CI after
`npm run build` (dist must be fresh) and before the docs checks, in
`.github/workflows/ci.yml`'s guards loop. Ratchet file:
`scripts/runtime-deps-baseline.json`.
