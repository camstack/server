---
id: D784
title: An exporter's settings page is Connection, Features, Account link and one collapsed Troubleshooting, every action reports its outcome, and Alexa's Re-sync also removes what is no longer exposed
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/settings-schema.ts
  - packages/addon-export-alexa/src/custom-actions.ts
  - packages/addon-export-alexa/src/sync-engine.ts
  - packages/addon-export-alexa/src/remove-endpoints.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
  - packages/addon-export-alexa/src/setup-block.ts
  - packages/addon-export-alexa/src/export-alexa.addon.ts
  - packages/addon-export-google/src/export-google.addon.ts
  - packages/addon-export-google/src/custom-actions.ts
  - packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts
  - packages/types/src/interfaces/config-ui.ts
  - packages/ui-library/src/composites/config-form-field.tsx
---

## Context

The Alexa page was one flat section of twenty rows. Five of its buttons
(Refresh external addresses, Unlink, Rotate credential, Re-sync, Purge) were
plain `type: 'button'` fields: `ButtonField` discards the action's result and
has no catch, so a press said nothing, and a failure said nothing either. The
ingress-token rows showed in public mode, where turning on "Require ingress
token" refuses every directive: the public skill's Lambda is shared by all hubs
and sends one `HUB_INGRESS_TOKEN` (`lambda-template/index.js`, `hubHeaders`).

Two buttons overlapped and neither cleaned up the real leftovers. Re-sync pushed
the exposed devices and deleted only detection sensors a camera stopped
building. Purge sent a DeleteReport for ids typed into a textarea that had to
be SAVED first, then cleared the input and forgot the ids without checking that
anything was delivered (`purgeEndpoints` ignored the gateway's answer). The
leftovers themselves came from `SyncEngine.removeDevice`, which forgot a
device's ids even when its DeleteReport failed — after that, nothing on the hub
remembered the endpoint Alexa still showed.

## Decision

An exporter's global settings page has the sections **Connection**,
**Features**, **Account link** and one **Troubleshooting** section that is
`style: 'accordion'`, `defaultCollapsed: true`; tuning knobs go in a collapsed
**Advanced**. Every action is an `addon-action-button` with a `successMessage`,
and an action with nothing to do throws a sentence saying why, so the button
shows it. Credential and remote-side actions are `auth: 'admin'`. A row that
belongs to one mode is absent in the other mode, and a setting that cannot
apply in a mode is also ignored at runtime in that mode.

A one-shot argument is asked for by the button (`ConfigAddonActionButtonField.
prompt`, sent as `input[param]`), never kept in a saved field.

For Alexa, Re-sync and Purge become:

- **Re-sync** (`resyncDiscovery` → `SyncEngine.resync`): force-push every
  exposed device, then DeleteReport every device still tracked in
  `exportedEndpoints` but absent from `exposed`. Only the operator's persisted
  exposed list decides a deletion; what an exposed device fails to build is
  never deleted (D49, D767). A device's ids are forgotten only when every
  linked account accepted the delete — `removeDevice` follows the same rule, so
  a failed unexpose is retried by the next Re-sync.
- **Remove ids from Alexa** (`removeAlexaEndpoints`): for ids this hub no
  longer tracks. Fails unless every account accepted the delete, and only then
  drops the ids from the tracking map.

The external address is an `addon-action-select` over `listExternalAddresses`,
read live; the cached `availableEndpoints` list and its Refresh button are gone.

## Consequences

- The admin UI must carry the `prompt` support before "Remove ids…" can send
  ids; an older UI sends none and the action answers "No endpoint id given".
- `staleEndpointPurgeInput` and `availableEndpoints` are no longer config keys;
  old stored values are ignored by `resolveConfig`.
- Re-sync now deletes from Alexa. The deleted set is exactly the unexposed
  devices, so it can remove an endpoint an Alexa routine still uses — the
  same thing the unexpose itself was meant to do.
- The setup block no longer repeats the linked-account count, and shows the
  ingress token row only for a custom skill.

## Enforcement

- `addon-export-alexa/src/__tests__/settings-page-layout.spec.ts`: section
  order and collapse, no `type: 'button'`, a `successMessage` on every action,
  no ingress row or skill id in public mode, the prompt on Remove ids.
- `sync-engine.spec.ts` (`SyncEngine.resync`, `removeDevice` keeps failed ids),
  `remove-endpoints.spec.ts` (delivery counts, forget only on full delivery),
  `no-secret-on-read.spec.ts` (every action admin-only; ingress never enforced
  in public mode).
- `addon-export-google/src/__tests__/settings-page.spec.ts`,
  `addon-provider-homeassistant/src/ha-export/__tests__/settings-page.spec.ts`,
  `ui-library/.../config-form-action-prompt.test.tsx`.
