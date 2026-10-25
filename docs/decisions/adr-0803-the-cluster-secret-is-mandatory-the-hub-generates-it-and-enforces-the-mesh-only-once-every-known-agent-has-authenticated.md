---
id: D803
title: The cluster secret is mandatory — the hub generates it, and enforces the mesh only once every known agent has authenticated
status: superseded
superseded-by:
  - D857
date: 2026-10-09
supersedes: D797 (only "optional, starts empty, never generated" for the cluster secret)
applies-to:
---

> **Superseded by [D857](adr-0857-an-agents-identity-is-its-mesh-certificate-there-is-no-cluster-secret-and-a-pairing-is-confirmed-on-both-screens.md) on 2026-10-16.** There is no cluster secret to be mandatory, generated or enforced. The Context below is still the record of why it was built.

## Context

D802 makes every node prove the cluster secret. Under D797 the secret was
optional and started empty — and the live hub has none: agent-a and the
Mac desktop agent join without one. Turning the gate on at the upgrade would
split the cluster at the first restart; never turning it on would leave D802
decorative. The operator ruled (2026-10-09): the secret becomes mandatory and
generated, kept in the keychain (no secret via env), the operator copies it
into each agent, and only then does the hub refuse anyone.

## Decision

1. **Mandatory, generated.** When no `cluster.clusterSecret` marker is stored,
   `system-config` generates 32 random bytes (base64url) into the keychain
   (`secret://system/global/clusterSecret`, owner `system`) and writes the
   marker. If the keychain already holds a value under that ref (a settings
   row that read empty), it is re-adopted, never replaced. A locked keychain
   generates nothing (retried every 30 s); a marker whose value is lost is not
   regenerated (D797 `unknown`, the operator decides). Clearing the field is
   refused; saving a new value rotates it.
2. **Two modes**, `cluster.meshAuth` in System → Cluster:
   `transition` (a node that has not authenticated is tolerated, warned about,
   and listed as such) and `enforced` (refused). Generating a secret always
   sets `transition` — every existing agent must be given the new one. An
   unread setting means `transition`.
3. **Transition ends by itself** once EVERY agent the hub knows has completed
   the challenge–response since the hub started — known = the cluster-node
   history (offline nodes included) ∪ connected nodes ∪ nodes tolerated since
   boot — and only when the history store answered, the secret is readable,
   and 5 minutes have passed since boot. Checked after every join and once a
   minute. The operator can switch either way at any time.

## Consequences

- **The live rollout never splits.** Hub upgrade → secret generated,
  `transition` → agents keep working (warned) → the operator copies the secret
  into each agent (Reveal on System → Cluster; agent status page or desktop
  Setup) → each agent authenticates → the hub switches to `enforced` by itself.
- **A fresh hub** with no agents enforces 5 minutes after first boot; its first
  agent needs the secret from the start.
- **A node that is gone forever keeps the transition open** until it is
  forgotten on the Cluster page, or the operator switches to Enforced. A flood
  of fake node ids in `transition` can do the same (the tolerated set is capped
  at 256): the remedy is the same switch.
- **A keychain reset** (which clears the marker) generates a new secret and
  reopens `transition`; every agent then needs the new secret.
- The agent side is unchanged from D797: `agent.json` (0600) or the desktop
  setup window, never an environment variable.

## Enforcement

- `system-config-cluster-secret.spec.ts`: generated at first boot into the
  keychain with `transition`; never replaced at boot; a keychain value with an
  empty row is re-adopted; a clear is refused; the mode is settable and the
  hub's request switches it; the Cluster page lists each node's state.
- `cluster-secret-keeper.spec.ts`: generation, retry while locked, no
  regeneration of a lost value.
- `mesh-auto-enforce.spec.ts`: offline, connected and tolerated agents all
  hold the transition; an unanswered history and the boot grace never decide.
- `hub-mesh-guard.spec.ts`: the switch goes through the setting's owner only
  when every known agent has joined.
