---
name: camstack-diagnose
description: Debug a RUNNING CamStack system (hub and agents) — something does not happen, happens on the wrong node, a notification never arrives, a cap answers "provider not available" or 404, a camera stalls, an update "did not take". Covers calling the hub's tRPC API (scripts/hub/hub.mjs, curl), the three log tiers and how long each remembers, enumerating nodes and providers, verifying WHERE work actually ran, the known error signatures, and the instrument-before-guessing discipline. Use before proposing any fix to live behaviour.
---

# Diagnosing a live CamStack system

The order matters: observe what is actually running, read the right log tier,
prove where the work ran, and only then form ONE hypothesis. Tracing the code
path before proposing a fix is a repo rule (root `AGENTS.md`, "Working style").
Architecture you will need: `docs/architecture/overview.md` (logging),
`docs/architecture/transport.md` (routing), `docs/architecture/update-and-release.md`
("why isn't my change running").

## 1. Workflow

1. **State the symptom per device and per node** ("camera 12 on the hub, since
   10:40 UTC"), never fleet-wide.
2. **Establish what is running** (§3): which nodes, which versions, which
   providers. Most "bugs" after a change are a stage that did not happen.
3. **Read the log tier that still holds the window** (§4).
4. **Prove where the work ran** (§5).
5. **Instrument before guessing** when two causes fit (§6). One hypothesis at
   a time; disprove it before taking the next.
6. **Verify a fix by behaviour** on the node, not by a version or a
   `success: true` (§7).

## 2. Calling the hub API

Everything is tRPC over HTTPS: `<hub-url>/trpc/<router>.<method>`, bearer token,
usually a self-signed certificate. Paths and shapes for every method:
`docs/reference/api.md` (generated). Cap `kebab-name` → router `camelName`
(`pipeline-orchestrator` → `pipelineOrchestrator.*`).

```bash
node scripts/hub/hub.mjs GET  capabilities.getCapability '{"name":"recording"}'
node scripts/hub/hub.mjs POST addons.restartAddon '{"addonId":"<id>"}'
node scripts/hub/hub.mjs GET  nodes.topology                 # all three: the `camstack login` session
```

`scripts/hub/hub.mjs` uses the SAME credential chain as the CLI and the
`camstack-ops` MCP (`packages/develop/src/hub`, D835): one token format, only the
permissions differ (admin = everything). **Run `camstack login <host>` once; every
tool uses that session** (`~/.camstack/<host>.json`, refreshed automatically, a 401
refreshes once and retries). `--token-file` is an explicit override only; no tool
looks for a token file of its own. It never logs in with a password and never turns TLS
off: trust a self-signed hub by saving its PEM to `~/.camstack/<host>.ca.pem`
(the error prints the command). The hub URL comes from `--server`,
`$CAMSTACK_HUB_URL`, the gitignored `scratchpad/.hub-url` (one line) or the
session. For reads, prefer the `camstack-ops` MCP tools (`hub_query`,
`topology`, `cap_providers`, `hub_logs`, `audit_tracks`). With curl:

```bash
curl -sk -H "Authorization: Bearer $TOKEN" \
  "<hub-url>/trpc/deviceManager.getBindings?input=$(python3 -c 'import urllib.parse,json;print(urllib.parse.quote(json.dumps({"json":{"deviceId":4}})))')"
curl -sk -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"json":{"addonId":"<id>"}}' "<hub-url>/trpc/addons.restartAddon"
```

- GET = query (`?input=` URL-encoded `{"json":…}`), POST = mutation (body
  `{"json":…}`). The prefix is `/trpc`, not `/api/trpc`.
- **An agent never logs in with a password, never creates a signed-in browser
  session and never proxies around the hub's origin check.** Use the token the
  operator provided; without one, ask. Read-only calls first.
- **Never open the live SQLite file** (sqlite3, `fs`, a backup tool) while
  CamStack runs — not even read-only; it has corrupted a production database.
  Ask through the API, or work on a snapshot (D328, D679).
- A patch-style mutation may REPLACE nested objects rather than merge them:
  read the object, send it back whole, check the response echoes it.

## 3. What is running

| Question | Ask | Note |
| --- | --- | --- |
| Which nodes exist? | `nodes.topology` | bare list; fields `id`, `isHub`, `isOnline`, `platform`; walks the cluster, 30–50 s — never in a hot path, and never trust a node list from memory |
| Which version does a node RUN? | `serverManagement.getServerPackageStatus {"nodeId"}` | `runningVersion` (loaded at boot) vs `installedVersion` vs `pendingVersion`; `restartRequired` |
| Is an update pending anywhere? | `serverManagement.checkServerUpdate {"nodeId"}` per node | cheap |
| Who provides a cap? | `capabilities.getCapability {"name"}` (0.15 s), `capabilities.listCapabilities` | two providers on a singleton is a bug; none = nobody registered |
| Which providers, on which nodes? | `addons.listCapabilityProviders {"capName"}` | a remote provider is keyed `<addonId>@<nodeId>`, a hub-local one bare |
| Which addons are installed on a node? | `nodes.getNodeAddons` | install state, not load state; `addons.list` can be a stale cache |
| What is bound to a device? | `deviceManager.getBindings {"deviceId"}` | the device page asks ONLY bound providers (D12) |

"Running" in a list is not evidence that code executes: an addon can be listed
while its init threw, and a cap can be declared while nobody registered it.
Call the cap.

### Comparing a runner's memory

Compare runners (before/after a change, one against another) by **RssAnon** or
**PSS** — `grep -E 'RssAnon|Pss' /proc/<pid>/status` / `smaps_rollup`, or
`process.memoryUsage().heapUsed` after two GCs for a load probe. **Never VmRSS.**
The shared `node` binary (~49 MB of `RssFile`) is paged in and out by the page
cache, so VmRSS moves by tens of MB with no real cost to the process and
inflates every runner by the same amount. A "saving" or a "leak" read off VmRSS
has been a file-cache artefact before; RssAnon is the process's own memory.

## 4. Logs — three tiers, three memories

| Tier | Holds | Ask |
| --- | --- | --- |
| RAM ring (`logs.query`, the admin log viewer) | the most recent lines per addon — minutes at best, seconds under a log storm | `logs.query {"tags":{"deviceId":"12"},"level":"warn","since":<ms>,"limit":500}` — tags filter, no text filter: grep client-side |
| Rotated files, `winston-logging` | `<nodeDataDir>/logs/camstack-YYYY-MM-DD.log`, JSON lines, retention in its addon settings; agent lines are forwarded to the hub | `grep '"deviceId":12' … \| grep '"level":"error"'` — read this before declaring history lost |
| Loki, `loki-logging` (opt-in) | what your Loki retains | LogQL on the labels configured in its addon settings |

- **Times are UTC** in logs; your shell probably is not. Convert before you
  compare.
- Agents forward their lines to the hub: grep the HUB's tiers for
  `[<nodeId>/<addon>]`; the agent's own stdout is quiet for forwarded lines.
- Every device line carries `tags: { deviceId }` (repo rule). A line you add
  must too.
- Which destination is on is the capability toggle under Data → Logging
  (`docs/architecture/overview.md` §"Logging").

## 5. Prove where the work ran

A `nodeId` in a result is the orchestrator's INTENDED target, not evidence.
Confirm with one of: the log line carrying that node's prefix; an artifact on
that node's disk; CPU on that node during the work. An explicit pin must win
over a same-named provider co-located with the caller — twice a pinned call was
served by a local sibling instead (`docs/architecture/transport.md`
§"Per-call node pinning"). A collection call naming a provider must be honoured
by all four dispatch layers (`docs/architecture/capabilities.md` §"Naming a
provider").

## 6. Instrument before guessing

- When a symptom has two or more possible causes, add the log line that tells
  them apart BEFORE changing behaviour. Log the success path too; log which
  early `return` fired on a hot path; log all gating booleans together. A
  component that logs only failures is indistinguishable from one never called.
- When a payload passes gate A and is gone before gate B, put a per-decision
  log on every link of the hand-off.
- Capture the real artifact — the API answer, the stored image, the stream —
  and LOOK at it. A test bench is not the browser, a fixture is not the camera.
- Make old and new code distinguishable (a changed log string) so you can tell
  which one ran.

## 7. Known signatures

| You see | It usually means | Next |
| --- | --- | --- |
| `No procedure found on path "<cap>.<m>"` | the node runs an older server closure | `camstack-server-change` |
| `method '<m>' not found on provider …` | the providing addon is stale | `camstack-addon` §7 |
| `Capability "<cap>" provider not available` | nobody registered it on that node (init threw, `per-node` mode, a deploy left it unregistered) | `getCapability`, then `addons.restartAddon` |
| a typed `CapRouteError` reason (`no-provider`, `node-offline`, …) | routing refused, and says why | read the reason; never retry blindly |
| `Services waiting is timed out` | code called a Moleculer action that only exists over UDS | route through the cap resolver |
| `event matched NO rule` (info) | a notification event arrived and no rule matched — the line names the rule and condition | fix the rule; silence from both this and `rule matched — enqueueing` means no event reached the notification center |
| `pipeline stats` with `frames=0` and `dropped>0` on every camera of one runner | that runner's inference is wedged | the runner, not the cameras |
| `Response for unknown request id` (steady) | an inference worker is BEHIND, not hung | load, not deadlock |
| `event loop stalled` | a synchronous block on that process; the line carries the cause | profile that process |
| `applyServerUpdate` timed out / 502 / 524 | the node is restarting — the success path | poll `getServerPackageStatus` |
| a restart "succeeded" | the API said so | prove it with a new PID / boot line |

Track and media complaints (no photo, wrong thumbnail, a track that ended too
soon) have their own procedure: the `audit-debug-tracks` skill.

## 8. Done-gate — paste it before proposing the fix

```
DIAGNOSIS — <symptom, device, node, window (UTC)>
running:     <nodes + runningVersion; providers of the caps involved>
evidence:    <log lines / API answers / artifacts, with tier and timestamps>
where:       <node the work actually ran on, and how that was proved>
hypothesis:  <one cause, and what would disprove it>
instrument:  <log lines added, or "not needed: evidence is direct">
verified:    <behaviour after the fix, observed on the node>
```
