---
name: camstack-server-change
description: The general flow for a CamStack SERVER-SIDE change — anything in `server/backend`, `packages/system` (kernel + builtins), `packages/types`, `packages/sdk`, `packages/node-root`, the generated cap routers, or a manifest `placement` / `execution.group`. Covers how to test it, why the backend typecheck is not verification (use the real build), the `.d.ts` leak sweep, how it reaches a running node (dev deploy-server vs publish → applyServerUpdate → restart → verify), npm registry lag, and the CI rules (never dispatch Checks, the release tag). Use for "I changed the server", "is my framework fix live?", "No procedure found on path", "it typechecks but…".
---

# A server-side change, from edit to verified

The long-form reference is `docs/architecture/update-and-release.md` — read
its "Updating a node" and "Traps that cost a session" before your first ship.
CI mechanics live in `camstack-publish-ci`; node-side mechanics (images, the
backup before a swap) in `camstack-hub-image-deploy`. This skill is the spine
that tells you which of them you need.

## 1. Is it a server-side change? Three channels, three different "live"

| You changed | Reaches a node through | Needs |
| --- | --- | --- |
| `packages/addon-*/src` (not a builtin) | `<dataDir>/addons/` | `camstack deploy` — the `camstack-addon` skill |
| `server/backend`, `packages/system` (kernel AND builtins), `types`, `sdk`, a `*.cap.ts`, generated routers, manifest `placement` / `execution.group` | the `@camstack/server` closure in `<dataDir>/server-root/current` | publish (or dev `deploy-server`) → `applyServerUpdate` per node |
| the starter / entrypoint (`packages/node-root` starter code, heap flags, env, the `Dockerfile`) | the container IMAGE | a new image and a container RECREATE — `applyServerUpdate` never delivers it |

Two consequences people miss:

- **A framework change that runs INSIDE a forked addon** (a `system`/`types`
  helper the addon bundled — addons are self-contained) is not live after
  `applyServerUpdate` alone. Deploy that addon too.
- **`publish ≠ deployed ≠ live`.** A version on npm changes nothing on a node;
  `camstack deploy` moves an addon, never the framework; only
  `applyServerUpdate` moves the closure.

`packages/node-root` is `private` and absent from the closure: never import it
from code `main.ts` loads at runtime.

## 2. Test and build — what counts as evidence

```bash
npx vitest run <path/to/spec>                 # the spec you touched, fast
npm run test -w <package-path>                # the package
npm run typecheck                             # tsgo / TS 7 (D832), code + specs vs the pinned debt (D695): red only on something NEW; typecheck:tsc6 = reference
npm run build -w packages/types && npm run build -w packages/system   # then the consumers
npm run build                                 # everything (nx run-many)
```

- **The backend typecheck is not verification.** `npm run typecheck -w
  server/backend` resolves `@camstack/types` / `@camstack/system` from their
  BUILT `dist/`, so a signature you changed in source is invisible to it until
  you rebuild them. After touching `types` or `system`: build them first, then
  typecheck or build the consumers. tsup/vite builds do not type-check either —
  run the package's `typecheck` as well.
- **A green suite is not proof.** When you fix a gate, remove the fix and
  confirm the test fails. Twice here a fake supplied the value production
  forgot to fetch.
- **Specs run against real backends where it matters.** An in-memory store
  that auto-creates buckets hid a missing `declareCollection` the SQLite
  backend refuses; pin such paths with a spec on the real implementation.
- **Runtime targets are Node AND Electron.** Native modules have different
  ABIs; spawn children with `process.execPath`, never `node` by name (a
  packaged desktop runs under a bare `PATH`).
- **Guards:** run the ones that protect what you touched locally,
  `npx tsx scripts/check-<name>.ts` (the list with what each refuses is
  `docs/reference/guards.md`), plus `npm run docs:check`.

### The `.d.ts` leak sweep

A stray `.d.ts` in `packages/*/src` (a misconfigured `vite-plugin-dts` /
`tsup` emitting beside the source) SHADOWS the `.ts` sibling for the
resolver: symptoms look like routing bugs — "provider not available",
"method not found", a missing `$agent.registerNode`.

```bash
bash scripts/check-no-dts-in-src.sh          # fails on any non-ambient .d.ts; the ambient allowlist is in the script
```

Delete a leaked `.d.ts` only when a `.ts`/`.tsx` sibling of the same name
exists, then rebuild `types`, `system`, `sdk` and `ui-library`.

## 3. Get it onto a node

### Development — a hub running from this workspace

`npm run dev:full` watches everything; an edit under `server/backend/src` or a
framework package reboots the hub (~15–20 s) — batch edits.
`touch server/backend/src/main.ts` forces a reboot.

### Development — a remote hub, no npm publish

```bash
npm run build -w packages/cli                       # installed CLI often lacks --closure
# hub only:
node packages/cli/dist/cli.js deploy --closure -s <your-hub-url>
# hub + every online agent (same -n / --cluster as addon deploy):
node packages/cli/dist/cli.js deploy --closure -s <your-hub-url> --cluster
```

(`deploy-server` is a deprecated alias of `deploy --closure`. `-s` is the hub
URL; `--closure` selects the server package — they are not the same flag.)

It builds and packs the whole closure at `<base>-dev.<epoch>`, uploads it and
calls `applyServerUpdate` **on the hub**. With `--cluster` / `-n` it then
`POST /api/server-upload/propagate` + apply per agent (see
`camstack-hub-image-deploy` §0b). Promotion wait often reports a timeout across
the restart — verify with `getServerPackageStatus`, not the CLI exit code. A
non-admin login is refused on apply; `camstack login <host>` as an admin once (every
tool, `hub.mjs` included, uses that session and refreshes it) + POST. Reuse an upload without rebuild:
`deploy --closure --cluster --version <base>-dev.<epoch>`.

### Release — through CI

1. Push first (`git log --oneline origin/main..HEAD` must be empty) — the
   workflow builds `origin/main`, not your tree.
2. `Publish Packages` with `include_dependents=false`; a cap change adds
   `force_packages=@camstack/system,@camstack/server` (nx-affected misses
   `system` for a `types` edit). Details and the lockfile preflight:
   `camstack-publish-ci`.
3. **Registry lag is not failure.** Right after a publish `npm view <pkg>
   version` serves the previous version and installs 404 for minutes. Read
   what the run published from its log, then wait for the tarball:
   `curl -sI https://registry.npmjs.org/@camstack/server/-/server-<VER>.tgz | head -1`.
   Never publish again because of a stale `npm view`.
4. Check the closure pins your framework version:
   `npm view @camstack/server@<VER> dependencies` — a server published in an
   earlier run legitimately pins the older `system`/`types`.

### Apply — every node, one by one

```bash
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate '{"version":"<VER>"}'
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate '{"version":"<VER>","nodeId":"<agentId>"}'
```

(`scripts/hub/hub.mjs` is the repo's tRPC caller; see `camstack-diagnose` for
how it finds the hub and the token.)

- **A timeout, a 502 or a 524 is the SUCCESS path** — the node restarts under
  the request. Do not retry. A reply that did arrive says what happened in
  `outcome` (`staged` | `restart-scheduled` | `already-current` | `refused` |
  `failed`); `staged` means the OLD code is still answering.
- **Wait for the version, not for `/health`.** `/health` answers 200 from the
  old process right after `staged`. Poll
  `serverManagement.getServerPackageStatus` (with `{"nodeId":"…"}` per agent)
  until `runningVersion` is the target, `restartRequired` is `false` and
  `updateState` is `idle`.
- **Agents do not follow the hub.** Each node is applied by its own `nodeId`.
  Enumerate from the cluster, never from a list you remember:
  `serverManagement.checkServerUpdate {"nodeId":…}` per node is cheap;
  `nodes.topology` is the full list (fields `id`, `isHub`, `isOnline`,
  `platform`; it costs 30–50 s). `updateAvailable: false` on every enumerated
  node is the only proof the update is done. "Update all" in the Cluster UI
  does agents first, hub last.
- **No automatic rollback** (D17). Recovery is an explicit update to a known
  good version — so know which one that is before you start.

### The "+1 restart" and builtins

Builtins used to load from a `<dataDir>/addons/@camstack/system` copy that
`applyServerUpdate` did not refresh, so a second `serverManagement.restartServer`
was the habit. Both roles now load builtins from the closure
(`server/backend/src/core/addon/addon-registry.service.ts`,
`server/backend/src/agent/main.ts`) and skip that copy, so one apply is enough.
If a builtin still behaves like the old code: look for a stale
`@camstack/system` under the node's addons dir (the hub's hot-load rescan
still reads it; an agent falls back to it, and logs so, when its closure
cannot resolve the package), remove it, then one `restartServer` — and prove
it with §4, not with a version number.

## 4. Verify — behaviour, not version numbers

- Call the thing that was broken: the new method answers (not
  `No procedure found on path`), the new input field survives a round trip,
  the rule that used to be refused is accepted.
- **Toggle-verify**: set the value to the OPPOSITE of what it is and back.
  Reading back a value that was already there proves nothing.
- Make old and new code distinguishable (a changed log line in the same
  commit) and look for the new line in the node's logs.
- A version field is a claim about the closure, not about what a forked addon
  or a builtin actually executed.

## 5. CI rules

- **Never dispatch the `Checks` workflow** (`gh workflow run Checks`), and say
  so in every subagent brief. It is operator-only (D704); its full typecheck
  has taken a self-hosted runner node down. Run the guards you touched locally.
- **One CI run at a time, and wait for it.** The self-hosted runners share
  hardware with a live system; do not stack dispatches to "speed up".
- **The release tag never sits on a `[skip ci]` commit** — the publish
  workflow's version-bump commit is one. Tag an empty `chore: release vX.Y.Z`
  commit (`camstack-publish-ci` §2).
- **Tag only after npm has the version.** The release's `derive-version` job
  verifies the version exists on npm AND that `latest` equals it; a tag pushed
  before the publish landed fails there.
- CI on push only builds and tests (D704). Watch your run with
  `gh run list --limit 3` / `gh run watch <id>` and fix forward.

## 6. Done-gate — paste it before "done"

```
SERVER CHANGE DONE — <what>
channel:    <closure | image | closure + addon <name>>
tests:      <specs + result>; typecheck: <npm run typecheck result>
build:      <npm run build -w … (types/system first) — result>; dts sweep: <clean>
guards:     <npx tsx scripts/check-… results | none relevant>
shipped:    <not shipped | deploy-server <dev version> | published <VER> (run <id>)>
applied:    <node → runningVersion, per node, from getServerPackageStatus | n/a>
verified:   <the behavioural check and its answer | "not deployed">
docs:       camstack-docs gate — <files | none needed: reason>
```
