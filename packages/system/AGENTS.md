# packages/system — the kernel

`@camstack/system` is the kernel and the builtins. It absorbed the former
`packages/kernel` and `packages/core` <!-- drift-ok: naming absorbed packages -->,
so anything referring to those is stale.

Host-provided: addons do **not** bundle this, they resolve it from the running
closure ([D15](../../docs/decisions/adr-0015.md)). Which means a change here
reaches a node only through a root-package install, never `camstack deploy` in
production — see `docs/architecture/update-and-release.md`.

## Skills for this package

<!-- camstack-skills-pointer:begin — written by `npx tsx scripts/skills/gen-skill-pointers.ts`; edit the generator, not this block -->
Follow the skill; do not reconstruct the procedure (any agent can open the file):

- A new or changed `*.cap.ts`; picking a provider → `camstack-capability` (`.claude/skills/camstack-capability/SKILL.md`)
- A change to `server/backend`, `system`, `types` or `sdk`: test, build, ship → `camstack-server-change` (`.claude/skills/camstack-server-change/SKILL.md`)
- A password / token / key, or a credential for a child process → `camstack-secrets` (`.claude/skills/camstack-secrets/SKILL.md`)
<!-- camstack-skills-pointer:end -->

## Layout

| Directory | What |
| --- | --- |
| `src/kernel/` | capability registry, addon loader, transport, Moleculer, supervision |
| `src/kernel/transport/` | UDS plane: `LocalChildRegistry`/`LocalChildClient`, `CapRouteResolver`, cap protocol |
| `src/kernel/moleculer/` | inter-node plane: `addon-runner`, `crash-supervisor`, event bus, cap forwarding |
| `src/builtins/` | storage, settings, logging, snapshot, device-manager, backup |
| `src/auth/`, `src/http/`, `src/tls/` | request plumbing |
| `src/process/`, `src/python/` | subprocess management, Python inference pool |

## Before editing

- `kernel/transport/**` or `kernel/moleculer/**` → read
  `docs/design/transport-and-cross-node-routing.md`. **Required.** It exists to
  spare you a multi-hour re-investigation.
- Anything registry-shaped → `docs/architecture/capabilities.md`.
- Anything lifecycle-shaped → `docs/architecture/addon-lifecycle.md`.

## Rules with teeth here

- **`HubNodeRegistry` is the single authority.** No shadow map, no pull cache, no
  hydrate-on-reconnect layer. ([D3](../../docs/decisions/adr-0003.md))
- **Never re-implement discovery or liveness.** `$node.connected` /
  `$node.disconnected` and `broker.waitForServices` exist. A timer added to wait
  for readiness is a bug even when it works.
- **Topic strings only inside `kernel/moleculer/event-bus.ts`.** Guarded by
  `scripts/check-event-bus-usage.ts`. ([D11](../../docs/decisions/adr-0011.md))
- **`resolveRunnerId` is the only grouping resolver**, and both spawn paths must
  call it. ([D2](../../docs/decisions/adr-0002.md))
- **Per-device aggregation walks bindings**, never the global capability list —
  `src/builtins/device-manager/device-aggregation.ts`.
  ([D12](../../docs/decisions/adr-0012.md))
- **`better-sqlite3` lives in this package's own `node_modules`**, which is why
  `@camstack/system` is an addon-bundle external rather than inlined.
- **Never install this package under `/data/addons/@camstack/system`.** A
  leftover copy there silently wins over the published closure.
- **`deleteLocation` occupancy is the class subtree**
  (`location-occupancy.ts`, D327) — not a `readdir` of a shared recordings
  root. Keep `STORAGE_CLASS_SUBTREES` in sync with `DISCARD_SUBTREES` in the
  recorder / pipeline-analytics addons.
- **A repoint touches only its class subtree, under one claim per physical
  root.** `LocationRepointer` (`location-repointer.ts`) copies/deletes what
  `classifyPath` calls its own, and a mover (`storageMigration.moverClearance`)
  and a repoint on overlapping roots refuse each other — `homekitClips` once
  deleted `eventMedia`'s files on a shared root.
- **The live sqlite file is the sqlite-settings bind** (D328). sqlite3 only
  with CamStack stopped, against the path `docker inspect` names.
- **A backup never copies the live database files.** `createArchive` asks the
  `owner` (→ `database-snapshot`) which databases it owns and for their
  snapshot, and archives `<db>.backup-snapshot`; a live database nobody owns,
  or a failed snapshot, builds NO archive (an archive without the database
  would prune one with it). The boot restore renames the snapshot back and
  drops the stale sidecars (D693). A `.backup-snapshot*` the run did not ask
  for is never archived.
