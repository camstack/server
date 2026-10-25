---
id: D820
title: Node offline / back-online is announced by an instant rule, after a 60 s hold-off that swallows reconnect storms
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/liveness-holdoff.ts
  - packages/addon-post-analysis/src/notification-center/node-liveness-text.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - server/backend/src/core/agent/agent-liveness-event.ts
---

## Context

On 2026-10-09 the agent `agent-a` froze from memory thrash (~08:00–08:44
UTC) and the operator was told nothing. The events existed: the hub emits
`agent.offline` / `agent.online`, the notification centre turns them into
`node-offline` / `node-online` and the hub log shows them matching —
`rule matched — held for its scheduled state summary`, rule "Eventi di sistema —
sistema". That rule was the ONLY one naming the node kinds, and it is a
`summary` rule (11:59 and 19:59). A state summary reports what is STILL true, so
an outage that ended before noon never appears in it at all.

The obvious fix — an `instant` system rule — is not enough on its own. The same
morning the node's return flipped it offline/online every 2–6 s for twenty
minutes while the mesh re-authenticated it (~90 node events per 15 min in the
hub log). Node liveness had no hold-off (the device one, 5 min, explicitly
excluded nodes), so an instant rule would have paged for every flip that cleared
the per-direction cooldown.

## Decision

Node liveness goes through the same trailing hold-off as device liveness, with
its own delay of **60 s** (`NODE_LIVENESS_HOLDOFF_MS`): a flip is announced only
once the new state has held for 60 s, and a bounce back to the last announced
state is silence. The announcement carries the node's display name (read from
`nodes.directory` after the hold-off, the id when unknown), the reason Moleculer
gave for a disconnect (`connection-lost` / `shutdown`, from `$node.disconnected`'s
`unexpected`), and on a recovery the outage length counted from the first
departure (`{{offlineFor}}`). Operators get node alerts from an ordinary
`system`-family rule with `systemEventDelivery.mode = 'instant'` — no new rule
kind; both editors already author it.

## Consequences

- A node that is down for less than 60 s is never announced, instantly or in a
  summary of transitions — the state summary still lists a node that is down at
  summary time.
- A node that flaps without ever settling for 60 s is never announced while it
  flaps; the settled state is announced once it holds.
- A recovery from an offline state that was only SEEDED (hub restarted while the
  node was down) has no known start: it is announced with the plain body, no
  duration.
- `reason` and the server-side `nodeName` need a hub that emits them; an older
  hub gives the plain body and the directory name.

## Enforcement

`liveness-holdoff.spec.ts` (timing, bounce, settle) and
`node-liveness-holdoff.spec.ts` (wired: a storm notifies nothing, an outage is
announced once with name and reason, the recovery carries `offlineFor`);
`template-var-parity.spec.ts` pins `nodeName` / `offlineFor` against the
catalog; `agent-liveness-event.spec.ts` pins the hub payload.
