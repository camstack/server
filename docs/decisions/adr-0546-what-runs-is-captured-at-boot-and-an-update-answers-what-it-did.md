---
id: D546
title: What RUNS is a fact the process captured at boot, and an update answers what it DID
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/node-root/src/root-update-service.ts
  - packages/node-root/src/__tests__/root-update-truthful-status.spec.ts
  - packages/types/src/capabilities/server-management.cap.ts
  - packages/addon-admin-ui/src/lib/cluster-update-all.ts
  - packages/addon-admin-ui/src/components/cluster/tabs/NodeServerManagementSection.tsx
---

## Context

On the evening of 2026-09-19 three faults in the server-update surface hid each
other and cost hours.

1. `serverManagement.checkServerUpdate {nodeId: hub}` answered
   `runningVersion: 1.2.352`, and every framework change that day was declared
   live off that number. The number was implemented as
   `readPackageVersion(<running copy>/package.json)` — a **disk read on every
   call**. The copy it reads is the copy a swap replaces, so the field's own
   docblock ("the code the running process ACTUALLY loaded") described a fact
   the implementation could not keep: the moment `current/` moves under a live
   process, the number follows the disk and the process keeps running the old
   code. The process knows what it loaded; nothing asked it.
2. `applyServerUpdate` stages and the main process takes the closure at the
   next restart — the log line says so (`root package update staged —
   restarting to apply`). The caller receives `{accepted: true, restarting:
   true}` and a prose message. `getServerPackageStatus` carries
   `pendingVersion`; `checkServerUpdate` — the call an operator makes to ask
   "what is live?" — carried nothing about a pending restart at all.
3. At 21:04:38Z the staging install of 1.2.353 died on `npm error code
   ECONNRESET`. The engine answered `accepted: false` with the error in
   `message` — the same `accepted: false` it answers for "already running" and
   "already staged", where nothing is wrong. One boolean, two meanings, and the
   difference lived in prose. A transient registry reset is normal; being
   unable to SEE it is the defect.

The measurement itself carried a fourth lesson: hub-main's `/proc/7/cmdline`
names `/opt/camstack-hub/…/dist/starter.js` on every boot — the baked starter —
and the seed's `package.json` beside it carries the IMAGE version (1.2.338).
That path is not what the process loaded; the launcher's `resolved
@camstack/system@… from /data/server-root/current` line is. Reading a version
off the cmdline path diagnosed a hub running 1.2.352 as a version behind.

Alternatives considered and rejected:

- **Keep the disk read and only add `pendingVersion` to the check result.** The
  number would still mean "on disk" while being labelled "running"; the next
  swap-under-a-live-process would lie again. The meaning had to move, not the
  neighbours.
- **Make `applyServerUpdate` block until the restart completes and answer
  "running".** On the hub the process dies in apply; on an agent the forward
  would time out against a reboot. The call cannot honestly say "running"; it
  can say "staged, restart pending", which is what it now says.
- **Store `restartRequired` as a flag.** A stored flag is a second authority
  that goes stale; derived on every read from the three facts it summarises it
  cannot disagree with them.
- **No retry on the staging install — report and stop.** Reporting is the fix
  for fault 3, and it stays. But the install is idempotent (a fresh
  `.staging-*` per attempt, a failed one removed), a registry reset fails in
  seconds, and "Update all nodes" walks the fleet once — one `ECONNRESET`
  leaves one node behind with nothing to do but ask again by hand. Rejected in
  favour of a BOUNDED retry.
- **An unbounded or long retry.** A registry that is down must surface as a
  failure in under a minute, not hold the caller against the 16-minute forward
  timeout. Three attempts, ~20 s of waiting, and only for npm's own network
  error vocabulary; a validator refusal or a 404 is final on the first try.

## Decision

**`runningVersion` is captured once, at construction, from the package.json of
the copy the code was loaded from, and never re-read.** The starter swaps
`current/` before loading the entry and nothing else may move it, so that read
describes what is in memory; a later disk that disagrees is reported through a
new `installedVersion` (what `current/` holds now, `data-root` boots only),
never folded into `runningVersion`. `restartRequired` is derived on every read
— `pendingVersion` set, or installed ≠ running — and every surface that answers
a version question carries it: `getServerPackageStatus` and
`checkServerUpdate` both. A staged version is a restart away, not "an update
available": `updateAvailable` is false for it.

**An action answers what it DID.** `ServerUpdateActionResult` carries
`outcome` — `staged` | `restart-scheduled` | `already-current` | `refused` |
`failed` — plus a stable `reason` and, for `failed`, the `error` verbatim.
`accepted` stays for skew and is never the discriminant again. A staging
install that fails on a transient npm network error is retried under
`STAGING_ATTEMPTS`, every attempt logged with its ordinal, and the final
failure logged at ERROR with the attempt count before it is returned.

## Consequences

- Three optional fields on the status payload and two on the check result;
  three on the action result. Optional so an older provider's payload still
  parses; a client reads `outcome` when present and the boolean otherwise.
- The Admin UI shows "restart required" and the installed-on-disk version when
  it differs from the running one, and renders a `failed` outcome red, apart
  from an amber refusal. "Update all nodes" files `failed` as failed, not as
  refused.
- The `message` of a `staged` result now states which version keeps running
  until the restart completes.
- A node that boots from the baked seed reports no `installedVersion`: the
  starter judged `current/` unloadable there, and a version read from it would
  claim "runs after restart" about code that will not.
- What this forbids: re-reading the running copy's package.json anywhere in the
  engine; a new `accepted:false` branch without an `outcome`; a retry on a
  failure whose message is not npm's network vocabulary.

## Enforcement

`packages/node-root/src/__tests__/root-update-truthful-status.spec.ts`, verified
by removal: with the lazy disk read put back, "does not follow a package.json
rewritten on disk after boot" fails and the other sixteen pass.

| removed | fails |
| --- | --- |
| the captured `loadedVersion` (disk read back) | "does not follow a package.json rewritten on disk after boot" |
| `installedVersion` / `restartRequired` on status | "reports a data-root copy that differs from the running code…" |
| `pendingVersion` on the check result | "names the staged version and says a restart is required" |
| `latestVersion !== pendingVersion` in `isUpdateAvailable` | the same test's `updateAvailable: false` |
| `outcome` on the failure branch | "failed: a staging install that died carries the npm output as `error`…" |
| the retry loop | "lands on the second attempt after one ECONNRESET, and says so" |
| the bound | "gives up after the bound and reports the failure with the attempt count" |
| the transient classifier | "does not retry a failure that would answer the same every time" |

UI: `NodeServerManagementOutcome.spec.tsx` ("renders a staging FAILURE as an
error", "says a restart is required when the copy on disk is not the code
running") and `cluster-update-all.spec.ts` ("files a staging install that DIED
as failed").
