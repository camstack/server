---
id: D986
title: Addon-level settings are retired — every value lives in the scope its owner cap declares (integration, cluster, node, fleet default, device), in the existing settings tables
status: accepted
date: 2026-10-31
supersedes: D268 (already superseded), the integrationSettingSections forwarding of D269
applies-to:
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/addon/per-node-store.ts
  - packages/types/src/capabilities/addon-settings.cap.ts
  - packages/system/src/kernel/addon-settings-store.ts
  - packages/system/src/kernel/device-settings-store.ts
  - packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts
  - packages/addon-provider-reolink/src/email-push-*.ts
  - packages/addon-provider-reolink/src/baichuan-webhook-*.ts
  - packages/addon-admin-ui/src/components/settings/**
---

## Context

An addon has one settings form, `globalSettingsSchema()`. Its values live in `addon-settings` rows
`<addonId>.<field>`, `{ addonId, key, value }` (D870). The census found 328 fields and they mean five
different things: INTEGRATION 115, DEVICE-DEFAULT 88, CLUSTER 75, NODE 39 and OTHER 11. One form for
five meanings has produced every defect seen so far:

- **Values shared across instances.** provider-homeassistant is `instanceMode: multiple`, but
  `calendarIds`, ha-export `publicBaseUrl` and `reconcileIntervalSec` are one value for every HA broker.
  Google `calendarIds` / `fromAddress` / `fromName` are shared by every Google broker. smtp-nodemailer
  serves a collection cap from one blob, so there is exactly one relay.
- **Node facts stored for the whole cluster.** `perNode: true` scopes a key to `<key>@<nodeId>` inside
  the addon's rows (`per-node-store.ts`). Fields that never got the marker (local-network `httpPort`,
  tailscale client flags, cloudflare `localPort`, hap `interfaceName`) are one value for every node.
  The orchestrator keeps node-keyed maps (`agentSettings`, `nodeBindings`) and a device-keyed one
  (`cameraSettings`) as single JSON keys. Forgetting a node or deleting a device leaves those entries
  behind unless an addon remembers to clean them.
- **Fleet defaults with no owner.** post-analysis projects the same global schema into the per-camera
  form: the global value is the fleet default and the camera overrides it. That is a real layer, but
  only by convention. The orchestrator's `detectionMode`, fps and stream profiles work the same way.
- **One concept in three places.** The public hub URL is held by export-google `publicHubUrl`, by
  ha-export `publicBaseUrl`, and by the local-network palette (D729/D732).
- **A provider running a network service.** Reolink opens its own SMTP server (:2525) and an HTTP
  webhook (:9081). It picks the first RFC1918 NIC as the host it gives cameras, has no TLS, and uses
  one shared credential.

Forwarding was tried first. `integrationSettingSections()` / D268 showed sections of the same global
form on the integration page. It moved where a field is DRAWN, not where it is STORED, so the
multi-instance bug survived. D268 also had to refuse forwarding for account-mode integrations, to
avoid two writers.

### Operator answers (2026-10-31)
- Receiver host: `internal` role.
- SMTP STARTTLS and webhook path tokens: an endpoint SETTING (off by default); Reolink has trouble with TLS.
- nodelink-js: export the classifiers as pure functions, published by us.
- Standalone addons: inventory each one's current shape first; Alexa can be multi-instance (several brokers).

### Operator answers, round 2 (2026-10-31)

- Reolink batch ships now with its own carry-over; it is converted to the framework later.
- Migrations: a framework built BEFORE P2. The hub runs pending migrations at boot by itself (snapshot first, ordered, recorded). On failure: roll back, boot safe, report; dependents stay on the old shape. Scope from v1: hub settings DB and records, addon state (versioned hook), node/agent config, viewer, and an addon's own internal migrations that do not touch the framework. No hand-run scripts on the hub any more.
- Q5 Loki: an integration. In general every connection-holding addon becomes an integration; the Integrations page today only lists device-provider / device-adoption addons, so it must accept collection caps (log-destination, notifier, broker...).
- Q6 HA media address: per HA instance (palette role chosen per integration).
- Q7 Fleet defaults: changing one leaves device overrides; an explicit "Apply to all" with a dry-run count.
- Q8 ONVIF: one integration; each camera holds its own credentials. ONVIF NVR (several channels behind one endpoint) is an open idea, not in scope.
- Integrations page for non-device addons (2026-10-31): follow the OIDC structure. A `scope: 'system'`, `mode: 'collection'`, `internal` cap (like `login-method.cap.ts:131`) that every connection-holding addon provides (Loki, notifiers, brokers, exporters…): list its instances, the per-instance form schema, create / update / delete — the CRUD shape of `oidc-connections.cap.ts` (operator-chosen immutable id, `configured` flag, `formValues` with secrets as keychain views, patch keeps an omitted secret, `$secretClear`). The Integrations page reads that collection; no hand-written per-addon page, no `editable-array` in a global schema. Storage stays `integration_settings`.


## Decision

**No addon-level settings.** Every setting is declared by a capability its addon provides, in exactly
one scope, and is stored in one of the EXISTING settings tables:

| scope | declared by | table | row id | row data |
| --- | --- | --- | --- | --- |
| integration instance | `integrationSettingsSchema(instance)` (D985) | `integration_settings` (record kind `integration-settings`, index `integration_id`) | (integrationId, key) | unchanged; cascades on deleteIntegration |
| cluster | `clusterSettingsSchema(cap)` | `addon-settings` | `<addonId>.<field>` (unchanged) | `{ addonId, key, value }` (unchanged) |
| fleet default | `deviceDefaultsSchema(cap)` | `addon-settings` | `<addonId>.<field>` (unchanged) | unchanged |
| node | `nodeSettingsSchema(cap)` | `addon-settings` | `<addonId>.<field>@<nodeId>` (unchanged) | `{ addonId, key, value, nodeId }`: **`nodeId` is the only addition** |
| device override | the cap's device form (D14 / contribution) | `addon-device-settings` | `<addonId>:<deviceId>.<field>` (unchanged) | unchanged |

> **Note, 2026-11-04.** The "integration instance" row above is superseded by D1007: the instance configuration is a typed record of `integration-instances` (table `records`), keyed by the registry id, and `integration_settings` is dropped once the #416 baseline is empty.

1. **Keys.** The canonical collections are `(id TEXT PK, data TEXT NOT NULL)` key/value tables, so the
   one addition, `nodeId` in a node row's data, is a JSON field: no DDL change and no id rewrite. A
   rolled-back build reads every row with the meaning it already knew. Scoped reads stay primary-key
   prefix ranges (`prefix-range.ts`). Forgetting a node (`forgetClusterNode`, node tombstones) runs ONE
   central `deleteWhere({ where: { nodeId } })` on `addon-settings`. This is the node twin of D865's
   `clearDeviceSettings`. It is a rare operator action, so it needs no index (D447 covers scheduled
   aggregates only). The cluster, fleet-default and node schemas of one addon must declare disjoint
   keys.
2. **A value keyed by another entity's id lives in the store that owns that id.** Integration or broker
   id goes to `integration_settings`, device id to `addon-device-settings`, node id to node rows. A map
   keyed by an id inside one JSON key is forbidden. Addon STATE (durable-state secrets, ledgers, job
   records) may stay in `addon-settings` under its own key. It is not a setting and is never rendered.
3. **Fleet default resolution:** device row, then fleet-default row, then schema default. One kernel
   resolver serves both views, hub-main and the forked runner (D870). `readDeviceStore` keeps returning
   raw overrides. The derived device form (D14 / the contribution) marks every inherited field with its
   source and offers Reset. Reset removes the device row; an override equal to the default stays an
   override. The default level is edited on the cap's own page.
4. **Cluster** settings are rendered by the owner cap's page (precedents: D765 Cluster → Settings, D940
   orchestrator on Pipeline → Cluster, D245 the logging document). **Node** settings are rendered on the
   node's page, one card per cap (precedents: D765 #3 node page `perNode` only, D365 orchestrator
   agent settings).
5. **The public hub URL** comes from the local-network roles only (D729/D732/D734). Google reads
   `publicEndpoint`. The HA media base reads `internal`; each broker may choose `publicEndpoint` as an
   integration setting. No addon stores a URL.
6. **Inbound receivers are a hub builtin.** `builtin:inbound-receiver` provides
   `inbound-receiver` (singleton, hub placement) and calls `inbound-receiver-sink` (collection,
   internal) on the route owner.
   - Endpoints: `smtp` (default :2525) and `http` (default :9081), the same ports and the same address
     formats as Reolink today (`cam-<key>@<domain>`, `/webhook/<key>`). A listener binds only while at
     least one route of its kind exists.
   - A provider declares its full route set with `setRoutes({ kind, routes: [{ key, deviceId? ,
     integrationId? }] })`. The owner is the caller the transport stamped. Another owner's key is a
     typed `CONFLICT`. The answer is the camera target. Its host is the `internal` role, because
     cameras are LAN devices. `publicEndpoint` is never used: a tunnel does not carry SMTP. If there is
     no address, the answer is `null` with a reason naming the Network page.
   - The provider still writes the camera's configuration (Auto-configure). It fetches the SMTP AUTH
     password with `getRouteCredentials`, owner-only. The password stays in the keychain, owned by the
     builtin, scope `global` (D787).
   - Routes are removed when their device is deleted (`device-removal-hook`) and whenever a provider
     re-declares its set.
   - Classification stays in the provider. The sink receives a size-capped parsed message:
     `smtp { from, subject, text, attachments[meta] }` or `http { method, query, contentType, body }`.
7. **Guard.** `globalSettingsSchema`, `integrationSettingSections`, `getGlobalSettings` and
   `updateGlobalSettings` are removed. A guard refuses them anywhere in source.

A separate node store or a new scoped table was rejected: the existing rows already express every
scope, and a second authority over one fact is what D224 forbids. Folding `integration_settings` into
`addon-settings` was rejected too: it has its own index and cascade, the integration secret scope and
D985 build on it, and the move would carry secrets for no gain.

## Consequences

- The cost is a move per field for 328 fields. Values in `addon-settings` mostly do NOT move: cluster
  and fleet-default rows keep their ids. What moves:
  - INTEGRATION values of standalone or broker addons, to `integration_settings`;
  - id-keyed blobs, exploded into owner rows;
  - unmarked node fields, copied to every node that runs the addon;
  - Reolink's receiver keys, to the builtin.
- Every move is a boot step: idempotent, read back before deleting, and a failed read writes nothing.
  Old keys are purged one release later through `retired-settings-keys.ts`, so a rollback has its
  values for one release.
- The keychain secret tree is derived from the union of an addon's scoped schemas. Scopes: `global`
  (cluster and fleet default), `node/<id>`, `integration/<id>`. `check-global-schema-declared` is
  rewritten against the new hooks.
- The hub opens 2525 and 9081 (only while routes exist) instead of the Reolink process. The container
  contract docs (Unraid templates, Proxmox, Compose) are mirrored in the same change (D717). There is
  no image change (D822): `smtp-server` and `mailparser` are npm dependencies.
- The Reolink email and webhook classifiers must be callable as pure functions on a parsed message (a
  nodelink-js export).
- `AddonSettingsModal.tsx`, `NodeAddonsSettingsPanel.tsx`, `lib/settings-forwarding.ts` and the
  addon-level cap methods are removed. An older admin UI calling them gets the typed "no procedure"
  error and does not crash.

## Phases

The field-by-field census is [docs/design/2026-11-03-addon-settings-census.md](../design/2026-11-03-addon-settings-census.md)
(372 addon-level values, each with its scope, destination and D987 migration id). It supersedes the 328 count in
Context and carries the ordered mover plan: the node-row `nodeId` mover first, then dead keys, unmarked node fields,
the orchestrator's id-keyed blobs, shared-across-instance values, service instances (D996), and last the removal of
`globalSettingsSchema` and the guard. Movers 5 and 6 (the orchestrator's `nodeBindings`, `agentSettings` and
`cameraSettings` blobs) have landed: node rows and the per-device store, with the readers switched in the same change
and the old keys left for one release. Cluster and fleet-default fields keep their rows and need no mover. D999
replaces §6: receivers are not a builtin phase.

## Enforcement

- `scripts/check-no-global-settings-schema.ts` (new, wired in checks.yml): refuses `globalSettingsSchema`, <!-- drift-ok: new guard, lands with this decision -->
  `integrationSettingSections`, `getGlobalSettings` and `updateGlobalSettings` in non-test source. <!-- drift-ok: new guard, lands with this decision -->
- `scripts/check-scoped-settings-declared.ts` (new): every scoped schema names a cap the addon's manifest <!-- drift-ok: new guard, lands with this decision -->
  provides; the scopes of one addon declare disjoint keys; a schema key never contains `@`.
- `scripts/check-device-settings-standard.ts` extended: an addon-settings value that is a map keyed by a
  device, node or integration id is a finding unless it is allowlisted with a reason.
- Specs, each disarmed once and seen red:
  - `addon-settings-store` node rows carry `nodeId`; forgetting a node deletes them and nothing else.
  - The fleet-default resolver gives the order and the source per field.
  - HA / google / smtp two-instance marker specs: a value written on instance A is invisible on B.
  - `inbound-receiver` specs: no route means no listener; RCPT for an unknown key gets 550; delivery
    goes only to the owner; another owner's key is a CONFLICT; a `null` internal address gives a
    refusal with a reason.
  - Reolink migration spec: a legacy `MARK` port and password reach the builtin, a second run is a
    no-op, and a failed read writes nothing.
