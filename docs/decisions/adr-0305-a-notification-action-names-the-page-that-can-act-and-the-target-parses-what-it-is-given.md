---
id: D305
title: "A notification action names the page that can ACT on the event, and the target parses what it is given"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts
  - packages/addon-post-analysis/src/notification-center/default-tap-url.ts
  - packages/addon-admin-ui/src/lib/node-url-selection.ts
  - packages/addon-admin-ui/src/hooks/useNodeUrlSelection.ts
  - packages/addon-admin-ui/src/components/device/tabs/active-device-tab.ts
  - scripts/check-notification-tap-targets.ts
---

## Context

A detection notification has tapped through to the viewer's camera page since
2026-08-18 (D1 of the click-actions design). A **system** event got no tap URL
at all, on the reasoning written into `default-tap-url.ts`: "a system-event rule
about a package update has nowhere useful to go". That was wrong in the only way
that matters — it does have somewhere to go: the page where the operator applies
the update. Until now the operator read "aggiornamento disponibile su
agent-a" on a phone and then went and found the page by hand.

The first draft of this change sent **both** update kinds to `/system/addons`,
which is what the request said. Reading the page settled it the other way:
`Addons.tsx` hides every framework package *and* the node root package
(`FRAMEWORK_PACKAGE_NAMES`, "managed from the Server management surface"), so an
operator sent there for a `server-update-available` would find a list that
cannot contain the thing he tapped. The node's own update/restart lives in the
Cluster page's node card (`NodeServerManagementSection`). A link to a page that
renders fine and simply does not have the thing on it is the worst of the three
failure modes, because nothing looks broken.

The second thing reading found: `/system/addons?node=…` would have been a
parameter nobody parsed. The Cluster page put its selection in `?node=` on
2026-08-28; the Addons page kept its in `useState` and additionally built its
own node list from a second `nodes.topology` poll while the picker beside it
rendered `useClusterNodes` — two lists on one page, and a selection resolved
against the one the operator was not looking at.

## Decision

A notification action names the page that can **act** on the event, and every
parameter it carries is one the target already parses.

1. The mapping is one pure module (`system-event-tap-url.ts`), reached only
   through `defaultTapUrl`, which stays the single owner of "where a tap
   lands". Addon updates → `/system/addons?node=`; a node's own
   (`@camstack/server`) update → `/system/cluster?node=`; a camera that stopped
   → `/devices/<id>?tab=stream-broker`. A kind with no page an operator must
   visit gets **no** link.
2. Everything the link needs is **frozen on the outbox row** at intake — kind,
   deviceId, deviceType, nodeId. Nothing is joined at delivery, so a row that
   drains days late still names the right subject, and no cap mount composes
   addon output with backend state.
3. `?node=` is one contract (`lib/node-url-selection.ts`), shared by both admin
   pages: same parameter name, same ordering, same verdict for an id that names
   nothing — fall back to the default node **and say so**. A silent fallback is
   what turns a stale link into an operator reading the hub's list believing it
   is the agent's.
4. The standard node selector is `NodePicker` (`@camstack/ui-library`), on
   breadth of use — seven call sites across four packages against the Cluster
   page's one. The Cluster page's `NodeSelector` is **not** folded into it: its
   chips carry the per-node fleet answer (status, CPU, memory) and an offline
   node must stay selectable there, whereas `NodePicker` disables one correctly
   because every one of its consumers queries the node it names. What the two
   share is the URL contract, and that is what was unified.

## Consequences

- A destination cannot be added by editing a string: the route, the query
  param, the tab id and the device type each live in another package, and the
  guard below fails the build when they stop agreeing.
- The Addons page lost its 10-second topology poll; it now reads the same
  event-driven `useClusterNodes` the picker renders.
- `NcOutboxPayload.subject.systemEvent` gained `deviceType`. The intake already
  stamped it and the enqueue already spread it, so live rows carry it — this
  widened the type to read it back, with no migration.
- A stale action never 404s: the admin UI is a SPA, a deleted device renders
  "Device not found", a `?tab=` the device does not have falls through to
  Overview without rewriting the URL, and an already-applied update renders "up
  to date".
- What this forbids: a link whose scoping the target ignores, and a second
  owner of the tap decision.

## Enforcement

`scripts/check-notification-tap-targets.ts` (CI) calls the real mapping and
asserts every minted path against the routes `App.tsx` declares, the `?node=`
spelling the admin pages parse, the `stream-broker` id in `WELL_KNOWN_TABS` and
`DeviceType.Camera`. Read-side tests assert the pages actually resolve the
parameter — `Addons.spec.tsx` ("the node in the URL is the node on screen"),
`Cluster.spec.tsx`, `active-device-tab.spec.ts`, `node-url-selection.spec.ts` —
and `dispatcher-system-tap.spec.ts` pins that the frozen row fields are the ones
handed to the mapping.
