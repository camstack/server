---
id: D484
title: A closure install carries its own Node and its own script permission — and our patches ask npm for neither
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/node-root/src/root-update-service.ts
  - packages/system/src/kernel/deps/npm-command.ts
  - server/backend/src/core/server-update/system-apply-closure-patches.ts
---

## Context

D478 made the `werift` patch reach production by shipping it inside
`@camstack/server` and applying it from that package's `postinstall`, inside the
staged closure. The reasoning was written down as: *"the closure install passes
no `--ignore-scripts`"*. That sentence was true and it was not the question.

The Mac-mini agent sat two versions behind for a day. The symptom named a patch:

```
staged closure did not apply its shipped patches: werift@0.22.9 … —
refusing to arm a swap into an unpatched closure
```

I twice told the operator this was undiagnosable without hands on the machine.
It was diagnosable from a terminal, and the homelab config had held an `ssh`
entry for that host the whole time.

Reproducing the staging install in a temp dir on that host — not reasoning about
it — found **two** independent faults, either of which alone breaks the closure:

1. **npm 12 blocks a dependency's install scripts by default.** The host had
   bootstrapped `npm@latest` in July and got 12.0.1, while hub and
   `agent-a` still ran npm 11. The install *succeeds*, exit 0, with a
   warning nobody reads:

   ```
   npm warn install-scripts 7 packages had install scripts blocked because they
   npm warn install-scripts   @camstack/server@1.2.277 (postinstall: …)
   npm warn install-scripts   better-sqlite3@12.11.1 (install: …)
   ```

   The applier was never at fault: run by hand in that same closure it reported
   `APPLIED werift@0.22.9` on three files.

2. **There is no `node` on PATH for the lifecycle scripts.** Downgrading the
   bootstrap to npm 11 did not fix it — it made the failure loud instead:

   ```
   npm error command sh -c node install/check.js
   npm error sh: node: command not found   (exit 127)
   ```

   A packaged desktop ships one bundled Node at an absolute path and runs with
   launchd's bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. npm runs lifecycle
   scripts through `sh -c`, and every one of them — `node-av`, `better-sqlite3`,
   `esbuild`, and our own postinstall — is spelled `node …`.

The second fault is the older one, and it explains a workaround already in the
tree: `ensureNativePrebuilds` exists to fetch a `better-sqlite3` prebuild "on a
toolchain-less packaged host". The host was never toolchain-less. It could not
find `node`.

npm 12 did not introduce the breakage. It made it silent, and silence is what
cost the day: a loud exit 127 would have named its own cause in one line.

## Decision

A closure install provides what its lifecycle scripts need, and our own patches
depend on none of it:

1. `runNpm` prepends `path.dirname(process.execPath)` to the child's `PATH`, so
   `node` in a lifecycle script means the Node that will load this closure.
   Prepended, not appended: the scripts of THIS closure must not run on some
   older Node that happens to sit earlier on PATH.
2. The staging manifest carries `allowScripts` naming every package whose
   install scripts must run (`CLOSURE_ALLOW_SCRIPTS`). This is not new policy —
   it is npm 11's behaviour written down, so that moving a node to npm 12 stops
   being a silent downgrade.
3. `stageClosure` runs the shipped patch applier **itself**, unconditionally,
   before the validator. Allow-listing is the right fix for `better-sqlite3` and
   `node-av`, which genuinely need npm to build something. It is the wrong fix
   for a patch of ours: making our patch depend on an npm policy is exactly the
   dependency D478 was written to remove.

The applier stays best-effort and `findUnappliedClosurePatches` stays
fail-closed. That pairing is what turned a silent miss into a refused update,
and it is the only reason this was ever visible at all.

## Consequences

- The fix cannot rescue the node that needs it. Staging is done by the RUNNING
  code, so a node stuck on a version without these changes stays stuck and needs
  a one-time manual unblock. This is the same asymmetry that let the unpatched
  closure in: the validator ships in the new code and first runs after the swap.
  Any future guard in this path inherits it, and the cost is one hands-on
  intervention per node per introduction.
- `CLOSURE_ALLOW_SCRIPTS` is a list, and a list rots. A dependency that starts
  needing an install script and is not named here will be blocked under npm 12
  and, if it is a native, refused by `findMissingNativePrebuilds` — loudly,
  which is the acceptable half of this tradeoff.
- Bootstrapping `npm@latest` means a host can silently acquire a different npm
  policy than its peers months after install. Left as-is deliberately: pinning
  moves the expiry date without removing it, and both fixes above hold across
  npm majors.

## Enforcement

`root-update-closure-scripts.spec.ts` stages a closure through an npm stub that
runs no lifecycle scripts — the npm-12 shape — and asserts the manifest carries
`allowScripts` and that the applier ran anyway. `npm-child-env.spec.ts` pins the
PATH construction, including the bare-PATH host and idempotence under nesting.
`system-apply-closure-patches.spec.ts` pins that the applier is the one the
closure SHIPPED, run from the package directory, and that a missing applier is a
no-op rather than a failure.

Not enforced by a guard: that `CLOSURE_ALLOW_SCRIPTS` still covers every package
with an install script. A guard would have to resolve the real dependency tree
at CI time, which is the install this is about.
