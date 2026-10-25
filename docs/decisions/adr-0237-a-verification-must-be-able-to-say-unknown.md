---
id: D237
title: A verification must be able to say "unknown", distinctly from "clean"
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - server/backend/src/package-inventory.ts
---

## Context

On 2026-08-25 three separate verification mechanisms lied, in three different
directions, and each one cost hours or hid a real fault.

**It shouted on the healthy state.** The D45 inventory banner fired on every
boot, calling `/data/server-root/current/node_modules` — the copies the launcher
had just resolved and put on `NODE_PATH`, one line above — "UNEXPECTED — remove
it", and then declared the two baked seeds in conflict with each other. The
runtime's own sweep disagreed in the same boot: `single-copy cleanup — 0 copy(ies)
to remove`. Cause: `serverNodeModules` was `@camstack/server/node_modules`, the
NESTED tree; the closure the framework actually resolves from arrived only via
`NODE_PATH` and fell through to `unexpected`. A banner that fires on the healthy
state is a banner nobody reads on the broken one.

**It confirmed something false.** The desktop build printed `verified 6 bundled
addon copies carry their native prebuilds` while `find Resources/addons -name
"*.node"` returned **zero files** — electron-builder discards `node_modules` on
per-package `extraResources` entries, so the check had been passing against the
staging tree, not the artifact. The fix it was verifying (
2026-07-21) had never reached the bundle, and the message is why nobody noticed
for five weeks.

**It returned empty while the system was saturated.** `nodes.getCapUsageGraph`
is an admin API whose whole job is to show caller → provider → cap traffic.
Queried while the sqlite engine logged **39 717 calls a minute** to one
collection, it returned `[]`. Cause: one truthiness check — an observation whose
PROVIDER could not be resolved was dropped whole, caller included — and the
provider is never resolvable for a cross-process one, which is every forked
runner. The code said so (`resolve to null and are silently skipped … a
follow-up will fill the gap`) and the follow-up never came. An empty graph reads
as "no addon is calling anything".

What was tried first and did not work: reconstructing the missing attribution by
hand. `scopeOwnerOf` lifted the addon id out of the query filter — plausible,
shipped, and it attributed nothing, because those queries do not filter by id.
Then the cap-usage graph was repaired on the assumption it would name the caller
— and it structurally cannot, because `ctx.settings` resolves through
`readBlob`/`mergeBlob` in the kernel, not through a tRPC cap call. Two
mechanisms deduced from the shape of the code instead of from what actually
travels on the wire, and both were wrong.

## Decision

A verification, guard or diagnostic MUST be able to report **unknown** as a
value distinct from **clean**, and MUST derive its verdict from the artifact it
certifies rather than from the input it was built from.

Concretely: an observation whose secondary field cannot be resolved is recorded
with the unresolved half NAMED (`UNRESOLVED_PROVIDER_ADDON_ID`), never dropped;
a check that classifies paths consults the resolution the process actually
performed (`frameworkRoots`), not a subset of it; a build-time assertion counts
files in the produced bundle, not in the tree it was staged from. An empty
result from a diagnostic surface is a CLAIM — "nothing is happening" — and a
mechanism that cannot distinguish that claim from "I could not look" must not
make it.

## Consequences

This forbids the cheapest shape in each of the three failures: `if (resolved) {
emit(...) }`, a classifier fed one of the two live roots, and a success message
printed from the wrong directory. It costs a placeholder value and a slightly
noisier output — an unresolved provider now appears in the usage graph as an
explicit unknown rather than not at all, which is uglier and true.

It also constrains how these failures are diagnosed. When an existing mechanism
reports nothing, that is not evidence: the FIRST question is whether it is armed
on the path in question, and answering it means measuring what travels, not
reading what the code appears to do. Two attempts were burned on that in one day.

`scripts/check-silent-observation-drop.ts` ratchets the emit-guard shape so it
cannot come back unnoticed; it is a textual marker check, so it catches the
shape, not every instance of the idea.
