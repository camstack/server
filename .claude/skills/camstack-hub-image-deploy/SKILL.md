---
name: camstack-hub-image-deploy
description: Put a SERVER-SIDE change (server-backend, generated cap routers, @camstack/types/system/sdk, manifest placement) on a running CamStack hub or agent. The default path is publish → `serverManagement.applyServerUpdate` per node — NO Docker image. Covers the dev `deploy-server` channel, the backup before a swap, the traps that recur on every update, and the rare cases that DO need an image (a fresh container seed, the starter/entrypoint, the baked native set) including the dev overlay image. Use when a new cap method 404s on a node, a framework fix "is not live", or a container must be recreated.
---

# Server-side deploy to a running node

The whole flow (test → build → publish → apply → verify) is the
`camstack-server-change` skill; CI is `camstack-publish-ci`. This skill is the
node side: what `applyServerUpdate` does, what it cannot do, and the image
cases. Long form: `docs/architecture/update-and-release.md` §"Updating a node"
and `docs/architecture/deploying.md`. Host names, container names, SSH aliases
and paths of YOUR cluster belong in your local notes, not here — the commands
below use `<hub-url>`, `<container>` and `<nodeId>`.

## 0. TL;DR — no image for a normal change

The image tag is the **product** version (`intel-0.1.0`, `amd-0.1.0`, labelled
beta while the major is 0). `applyServerUpdate` takes the **npm** version of
`@camstack/server` (1.2.x). They are different numbers (D943). A server-side
change still does not need a new image.

A node runs `@camstack/server` (kernel, builtins, generated cap routers;
`types`/`system`/`sdk` ride along) from `<dataDir>/server-root/current`, put
there by `applyServerUpdate`. The image only provides the starter, the
entrypoint and the first-boot seed. So for any server-side change:

**Path A — release:**

```bash
gh workflow run "Publish Packages" --ref main -f bump=patch -f scope=affected -f include_dependents=false
# … wait for the run, note the version X.Y.Z (and see camstack-publish-ci on registry lag), then:
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate '{"version":"X.Y.Z"}'
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate '{"version":"X.Y.Z","nodeId":"<agentNodeId>"}'   # every agent, one by one
```

**Path B — dev, no npm publish:**

```bash
# preferred — same `deploy` verb as addons (--closure, not -s which is the hub URL)
node packages/cli/dist/cli.js deploy --closure -s <hub-url> --cluster
# hub only:  … deploy --closure -s <hub-url>
# one agent: … deploy --closure -s <hub-url> -n <agentNodeId>
# reuse upload: … deploy --closure -s <hub-url> --cluster --version 1.2.N-dev.<epoch>
```

(`deploy-server` is a deprecated alias of `deploy --closure`.) Full flow §0b.

Then deploy any changed ADDON too (`camstack deploy <addon>`) and verify (§1).
`camstack deploy packages/system` (or `types`) is REFUSED on a deployed hub —
the framework ships only as a server closure.

## 0b. Path B in full — `deploy --closure` (+ agent fan-out via API)

A `<base>-dev.<epoch>` version **never exists on npm**. Each node stages it
only from **local** tarballs at
`<dataDir>/server-root/dev-uploads/<version>/` (refusal reason
`dev-uploads-missing`). Upload is hub-side (`POST /api/server-upload`);
agents get the same layout via `POST /api/server-upload/propagate`
(`$agent.stageDevUploads`, hub-http pull — same pattern as addon deploy).

### B1 — Hub only (default)

```bash
npm run build -w packages/cli                         # installed CLI often lacks --closure
node packages/cli/dist/cli.js deploy --closure -s <hub-url>
# Note the version from the log: 1.2.N-dev.<epoch>
#
# If apply returns 403 Forbidden (a non-admin login): upload may still have
# succeeded — `camstack login <host>` as an admin once, then hub.mjs uses that
# session (refreshed automatically; --token-file is an explicit override only):
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate \
  '{"version":"<base>-dev.<epoch>"}'
# Timeout / 502 / 524 = restart in progress (success). Poll until runningVersion matches:
node scripts/hub/hub.mjs GET serverManagement.getServerPackageStatus '{}'
```

### B2 — Hub + agents (preferred)

```bash
# every online agent (enumerated via nodes.topology — never a remembered list):
node packages/cli/dist/cli.js deploy --closure -s <hub-url> --cluster
# or one agent:
node packages/cli/dist/cli.js deploy --closure -s <hub-url> -n <agentNodeId>
# reuse an upload already on the hub (no rebuild):
node packages/cli/dist/cli.js deploy --closure -s <hub-url> --cluster --version 1.2.N-dev.<epoch>
```

Flow per agent: hub packs `dev-uploads/<VER>/` → one-shot hub-http ticket →
`$agent.stageDevUploads` → `applyServerUpdate { version, nodeId }` → poll status.
(`-s` is always the hub URL; `--closure` selects the server package path.)

Manual equivalent (admin session):

```bash
VER=<base>-dev.<epoch>
node scripts/hub/hub.mjs GET nodes.topology
# for each online non-hub id:
curl -k -X POST "$HUB/api/server-upload/propagate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"version\":\"$VER\",\"nodeId\":\"$id\"}"
node scripts/hub/hub.mjs POST serverManagement.applyServerUpdate \
  "{\"version\":\"$VER\",\"nodeId\":\"$id\"}"
```

Still `dev-uploads-missing` after `--all` → propagate failed (agent offline,
hub-cluster URL unreachable from the agent, or hash mismatch). Check hub logs
for `server-upload propagate`.

**Bootstrap of this feature itself:** `$agent.stageDevUploads` and the
propagate route live in the server closure. The first time a cluster moves
onto a build that contains them, update the **hub** with
`deploy --closure`, then land that same version on agents once via host/volume
copy of `dev-uploads/<VER>/` + `applyServerUpdate` (or a published release via
Path A). After every agent runs that build, `--closure --cluster` / `-n` is
the only Path B path.

Emergency only (API down): copy the version directory onto the agent's
`server-root/dev-uploads/` by host/volume access — operator notes, not the
happy path.

### B3 — Addons after the closure

`deploy-server` does **not** replace addon packages under `<dataDir>/addons/`.
Deploy every changed addon to every node that needs it
(`camstack deploy <pkg>` / `-n <nodeId>`). ui-library changes ride
`addon-admin-ui` on the hub.

## 1. Verify

```bash
node scripts/hub/hub.mjs GET serverManagement.getServerPackageStatus '{}'               # runningVersion == target, restartRequired false
node scripts/hub/hub.mjs GET serverManagement.getServerPackageStatus '{"nodeId":"<id>"}' # per agent
node scripts/hub/hub.mjs POST <cap>.<newMethod> '{…}'                                    # routes — not "No procedure found on path"
```

## 2. What every update relearns

1. **A timeout / 502 / 524 on `applyServerUpdate` is SUCCESS.** The node
   restarts under the request. Do not retry; poll the status until
   `runningVersion` flips. `/health` answers 200 from the OLD process right
   after the call — wait for the version, not for health.
2. **There is no automatic rollback** (D17). Before a risky swap, copy
   `current/` aside on the node — e.g.
   `docker exec <container> cp -a /data/server-root/current /data/server-root/current.bak-<why>` —
   restore = move it back and restart. Or know the last good version and
   re-apply it.
3. **One copy of the framework.** Both roles load builtins from the closure
   and skip any `@camstack/system` under the node's addons dir — but the hub's
   hot-load rescan (`loadNewAddons`) still reads a stale copy there, and an
   agent falls back to it when the closure cannot resolve the package
   (`docs/architecture/update-and-release.md` §"Deploying a framework change
   in development"). After an update, compare:
   ```bash
   docker exec <container> sh -c 'cat /data/addons/@camstack/system/package.json 2>/dev/null | grep -m1 version || echo "ABSENT (correct)"'
   docker exec <container> sh -c 'grep -m1 version /data/server-root/current/node_modules/@camstack/system/package.json'
   ```
4. **A reported version is a claim about the closure**, not about what a
   builtin or a forked addon executed. Change a log string in the same commit
   and look for it in the node's logs; prove behaviour by toggling a value from
   its opposite state.
5. **A missing REQUIRED infra capability is skipped in silence** at boot when
   no addon provides it. A clean boot is not proof every infra cap is served —
   check `capabilities.getCapability` for the ones you need.
6. **Agents do not follow the hub.** Apply per `nodeId`; enumerate nodes from
   the cluster (`nodes.topology`, `checkServerUpdate` per node), never from a
   remembered list. On Path B use `deploy --closure --cluster` / `-n`
   (propagate then apply) — bare `applyServerUpdate` without uploads →
   `dev-uploads-missing`.
7. **Timezones.** Container logs are UTC.

## 3. Decision table — what does my change need?

| Change | Action |
| --- | --- |
| Addon `src` (provider logic, settings schema) | `camstack deploy <addon>` |
| An additive OUTPUT field on an existing cap method | `camstack deploy <addon>` (output passes through structurally) |
| A new INPUT field, a new method, a new cap | publish (`force_packages=@camstack/system,@camstack/server`) → `applyServerUpdate`, then deploy the addon |
| `server/backend`, `@camstack/system`, `@camstack/sdk` | publish → `applyServerUpdate` |
| Manifest `placement` / `execution.group` | publish → `applyServerUpdate` |
| The starter, the entrypoint (heap flags, env, user), `Dockerfile` | a new image AND a container recreate |
| The baked native set, a fresh host | a new image |
| ui-library used by the admin UI | `camstack deploy packages/addon-admin-ui` (it bundles the library) + a hard browser reload |

**Symptom of a skipped server update:** the addon deploys and its settings
schema updates, but the new method answers `No procedure found on path
"<cap>.<method>"` — the node still runs the old `ALL_CAPABILITY_DEFINITIONS`.

## 4. When you DO need an image

- **The image installs from npm**, not from your tree: the `Dockerfile`
  installs `@camstack/server@latest`. Your change must be published (and be
  `latest`) before the image builds, and the image LABEL (`intel-X.Y.Z`) is not
  proof of the baked version — read `/health` or `getServerPackageStatus`.
- **The starter runs from the image** (`/opt/…/@camstack/server/dist/starter.js`):
  code there changes only on a container recreate. The process command line
  names the seed path on every boot — the loaded version is the starter's
  `booting @camstack/server@X from …` line, not the path.
- **A recreate keeps `/data`** — cameras, database, tokens and the applied
  closure survive; a wipe of `/data` is a greenfield and destroys them.
- **A node on an old starter** that never acknowledges an update can be moved
  forward only by recreating its container from a current image; after that,
  `applyServerUpdate` works again.
- **A change to the container contract** (an env var read, a port, a volume, a
  device) is mirrored by hand in the platform templates and the public Compose
  example in the same piece of work (D717).
- **Desktop-app nodes** take server updates over the air like any other node
  (`applyServerUpdate` with their `nodeId`); reinstall the app only for a
  change to the Electron shell itself.

### Dev overlay image (no publish)

To try packed workspace packages inside a container without publishing:

```bash
./scripts/dev-pack.sh @camstack/server @camstack/types     # or --affected, or --all → dev-overlay/*.tgz
docker build -f Dockerfile.dev --build-arg BASE=<a published camstack image> -t camstack:dev-<tag> .
docker run --rm --entrypoint sh camstack:dev-<tag> -c 'grep -rl "<unique marker>" /opt/camstack-hub/node_modules/@camstack/server/dist || echo MISSING'
```

Run it with the same volumes and env as the container it replaces (keep
`/data`). It is for iteration only; a release is always published.

## Done-gate — paste it before "done"

```
NODE DEPLOY DONE — <change>
path:      <A release X.Y.Z | B deploy-server <dev version> | image <tag>>
dev-uploads: <hub only | propagate --all | propagate -n …>
backup:    <current.bak-… | known-good version X.Y.Z>
applied:   <nodeId → runningVersion, restartRequired, for EVERY enumerated node>
framework: <stale addons-dir @camstack/system: absent | removed>
addons:    <camstack deploy … per node, or none>
verified:  <the new method / behaviour, observed on the node>
```
