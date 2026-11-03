# Addon-level settings census (planning#327)

Status: census, no code moves. Companion to [D986](../decisions/adr-0986-addon-level-settings-are-retired-every-value-lives-in-its-owner-scope.md)
(where each value lives) and [D987](../decisions/adr-0987-a-migration-runs-at-boot-under-its-owner.md)
(how a value is moved). Taken on 2026-11-03 from `origin/main` (6f1f67e60) and from the shape of the live prod hub.

## What was counted

Every field an addon declares through `globalSettingsSchema()` (the form carried by
`addonSettings.getGlobalSettings`), plus the addon-level values stored beside it that the form does not
show: JSON blobs keyed by another entity's id, ledgers, one-shot flags. Display-only entries (info
banners, action buttons, sign-in rows) are not fields. The rows of an `editable-array` are counted as
ONE field, the array, and named in its note.

- Fields were extracted from the schema source with the TypeScript AST, so a key the form builds
  dynamically (`clusterModel.<step>`, `exportTo:<brokerId>`) is one row with the pattern.
- **Read where** is the first reader outside the schema declaration (specs, migrations and i18n skipped).
  `none` means no reader exists in the addon source: a dead candidate.
- **Live**: `addonSettings.getGlobalSettings` was read on the prod hub, keys and set/unset only. No value
  was printed. "At schema default" cannot be told from "never written" through that call, so it is shown
  as one bucket; `unset` is a field with no value at all.
- Counts differ from the 328 of the 2026-10-31 planning census because that one sized a different cut
  (it counted the per-device projections once per camera form and did not see the blobs). Use this table.
- A field not in the table is not stored at addon level. `provider-gree` and `provider-vesync` only build a
  manual-creation form (no addon-level hook). `auth-oidc`, `training-modal`, `waste-collections`,
  `export-google`, `provider-mqtt-ha` and `core-blocks` hold no stored field.

Scopes are D986's: **integration instance**, **cluster** (an owner cap's cluster setting, in the
`pipeline-orchestrator` for the pipeline), **fleet default** (device row, then default row, then schema),
**per-node**, **per-device**, **dead**. Two more rows exist only in the census: **state (stays)** is addon
STATE that D986 §2 lets stay in `addon-settings` under its own key and never renders; **other (yml)** is
the `system-config` form, which reads `config.yml`, not a settings row.

Two later decisions refine the destination column:

- **D996** makes a service instance (SMTP relay, Cloudflare account, MQTT broker, exporter account) a record of the
  `integration-instances` cap, not an `integration_settings` row. Those rows say `integration-instances record kind`.
  Device providers keep `integration_settings`.
- **D999** withdraws D986 §6 (the inbound-receiver builtin). SMTP intake is a broker kind (`smtp-inbound`,
  already shipped for Reolink as `provider-reolink/email-push-to-mailbox`); HTTP listeners stay on the addon's data
  plane. So Ecowitt `listenPort`/`listenHost` and Homematic `callbackHost`/`callbackPort` are plain instance
  fields, not routes.

Migration ids follow D987: `<owner>/<date>-<slug>`; `<d>` is the day the migration is written. A cluster or
fleet-default field keeps its row id, so it needs **no** migration: its change is the hook rename only.

## Counts per target scope

| Scope | Fields |
| --- | ---: |
| integration instance | 126 |
| per-node | 58 |
| cluster | 68 |
| fleet default | 95 |
| per-device | 9 |
| dead | 3 |
| state (stays) | 4 |
| other (yml) | 9 |
| **Total** | **372** |

Of the integration-instance rows, most are the connection forms of device providers (`buildConnectionFormSchema`):
the hook there is only a form carrier, the values are already stored per integration and the live hub holds no
global value for them. They need the hook removed, not a data move.

## Per addon

### `ai`

Package `packages/addon-ai`. Live prod hub: 2 fields shown: 0 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chatRetentionMaxAgeDays` | number | n | addon-ai/src/addon.ts:37 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `chatRetentionMaxCount` | number | n | addon-ai/src/addon.ts:38 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `alert-center`

Package `packages/system`. Live prod hub: 2 fields shown: 0 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `maxAlerts` | number | n | system/src/builtins/alerts/alerts.addon.ts:193 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `retentionDays` | number | n | system/src/builtins/alerts/alerts.addon.ts:194 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `audio-analyzer`

Package `packages/addon-pipeline`. Live prod hub: 2 fields shown: 0 unset, 1 at schema default, 1 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `probedBestAudioBackend` | text | n | addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:1054 | state (stays) | n | `addon-settings` own key, never rendered | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `audioBackend` | select | n | addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:937 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `audio-analyzer/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |

### `auth-webauthn`

Package `packages/addon-auth`. Live prod hub: 4 fields shown: 0 unset, 2 at schema default, 2 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rpName` | text | n | addon-auth/src/webauthn/auth-webauthn.addon.ts:73 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `rpID` | text | n | addon-auth/src/webauthn/auth-webauthn.addon.ts:71 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | derivable from the `publicEndpoint` role (follow-up, not a mover) |
| `origin` | text | n | addon-auth/src/oidc/auth-oidc.addon.ts:208 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | derivable from the `publicEndpoint` role (follow-up, not a mover) |
| `challengeTtlSec` | number | n | addon-auth/src/webauthn/auth-webauthn.addon.ts:77 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `camera-grid`

Package `packages/system`. Live prod hub: 1 fields shown: 0 unset, 0 at schema default, 1 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cameraGrids` | editable-array | n | system/src/builtins/camera-grid/addon.ts:92 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | operator-named list of grids: a records collection, not a form array |

### `cloudflare-tunnel`

Package `packages/addon-cloudflare`. Live prod hub: 10 fields shown: 2 unset, 5 at schema default, 3 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mode` | select | n | addon-cloudflare/src/tunnel/auto-start.ts:14 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `localHost` | addon-action-select | n | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:55 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `cloudflare-tunnel/<d>-local-origin-to-node` | the origin is a node fact (D986) |
| `customApiToken` | password | y | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:69 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` | secret moves under `integration/<id>` scope |
| `customZoneId` | addon-action-select | n | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:73 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `customHostname` | text | n | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:76 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `localPortMode` | select | n | addon-cloudflare/src/tunnel/cloudflare-actions.ts:67 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `cloudflare-tunnel/<d>-local-origin-to-node` | the origin is a node fact (D986) |
| `localPort` | number | n | addon-cloudflare/src/tunnel/cloudflare-actions.ts:68 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `cloudflare-tunnel/<d>-local-origin-to-node` | the origin is a node fact (D986) |
| `noTLSVerify` | boolean | n | addon-cloudflare/src/tunnel/cloudflare-api.ts:49 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `originServerName` | text | n | addon-cloudflare/src/tunnel/cloudflare-api.ts:53 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `httpHostHeader` | text | n | addon-cloudflare/src/tunnel/cloudflare-api.ts:51 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `debugLogging` | boolean | n | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:77 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |
| `protocol` | select | n | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:78 | integration instance | y (single value today) | `integration-instances` record kind (D996) | `cloudflare-tunnel/<d>-tunnel-account-to-integration` |  |

### `console-logging`

Package `packages/system`. Live prod hub: 1 fields shown: 0 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `level` | select | n | system/src/builtins/console-logging/console-destination.ts:13 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `decoder-nodeav`

Package `packages/addon-decoder-nodeav`. Live prod hub: 2 fields shown: 0 unset, 1 at schema default, 1 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hwaccel` | select | n | addon-decoder-nodeav/src/addon/index.ts:47 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `probedBestHwaccel` | text | n | addon-decoder-nodeav/src/addon/index.ts:114 | state (stays) | n | `addon-settings` own key, never rendered | covered by `hub/<d>-node-rows-carry-nodeid` |  |

### `detection-pipeline`

Package `packages/addon-pipeline`. Live prod hub: 6 fields shown: 1 unset, 5 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `activeModelSubstitutions` | text | n | addon-pipeline/src/detection-pipeline/index.ts:186 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `batchMode` | select | n | addon-pipeline/src/pipeline-runner/node-bench/node-bench-wiring.ts:116 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `windowMs` | slider | n | addon-pipeline/src/pipeline-runner/face-parent-geometry.ts:133 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `maxBatchSize` | slider | n | addon-pipeline/src/pipeline-runner/index.ts:2322 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `concurrency` | slider | n | addon-pipeline/src/pipeline-runner/node-bench/node-bench-wiring.ts:115 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `numWorkers` | slider | n | addon-pipeline/src/pipeline-runner/node-bench/node-bench-wiring.ts:114 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |

### `device-history`

Package `packages/system`. Live prod hub: 4 fields shown: 4 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rawDays` | number | n | system/src/builtins/device-history/retention/retention.ts:31 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `fiveMinuteDays` | number | n | system/src/builtins/device-history/retention/retention.ts:32 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `hourDays` | number | n | system/src/builtins/device-history/retention/retention.ts:33 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `dayDays` | number | n | system/src/builtins/device-history/retention/retention.ts:35 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `embedding-encoder`

Package `packages/addon-post-analysis`. Live prod hub: 1 fields shown: 0 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `modelId` | text | n | addon-post-analysis/src/embedding-encoder/addon/model-requirements.ts:117 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `export-alexa`

Package `packages/addon-export-alexa`. Live prod hub: 7 fields shown: 1 unset, 4 at schema default, 2 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `linkedAccounts` | json blob (account -> link) | n | addon-export-alexa/src/link-status.ts:83 | state (stays) | y | `addon-settings` own key, never rendered | `export-alexa/<d>-ledgers-to-integration` | account/token ledger; moves with its integration instance |
| `tokens` | json blob (token id -> ingress token) | n | addon-export-alexa/src/link-status.ts:84 | state (stays) | y | `addon-settings` own key, never rendered | `export-alexa/<d>-ledgers-to-integration` | account/token ledger; moves with its integration instance |
| `skillMode` | select | n | addon-export-alexa/src/export-alexa.addon.ts:200 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `region` | select | n | addon-export-alexa/src/export-alexa.addon.ts:218 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `expectedAudience` | text | n | addon-export-alexa/src/http-server.ts:238 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `detectionSensors` | boolean | n | addon-export-alexa/src/export-alexa.addon.ts:278 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `objectDetection` | boolean | n | addon-export-alexa/src/handlers/discovery.ts:81 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `snapshots` | boolean | n | addon-export-alexa/src/handlers/discovery.ts:74 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |
| `enforceIngressToken` | boolean | n | addon-export-alexa/src/http-server.ts:130 | integration instance | y | `integration-instances` record kind (D996) | `export-alexa/<d>-settings-to-integration` |  |

### `export-hap`

Package `packages/addon-export-hap`. Live prod hub: 4 fields shown: 2 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bridgeName` | text | n | addon-export-hap/src/hap-export.addon.ts:386 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `fixedPin` | text | n | addon-export-hap/src/hap-export.addon.ts:387 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | is a credential, declared `text`: make it a `password` field (secret tree) |
| `interfaceName` | text | n | addon-export-hap/src/hap-export.addon.ts:388 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `export-hap/<d>-interface-name-per-node` | ADR names it an unmarked node field |
| `clipRetentionDays` | number | n | addon-export-hap/src/hap-export.addon.ts:204 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `google-services`

Package `packages/addon-google-services`. Live prod hub: 0 fields shown: 0 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clientId` | text | n | addon-google-services/src/google-types.ts:8 | integration instance | n | `integration-instances` record kind (D996) | none (already broker form) |  |
| `clientSecret` | password | y | addon-google-services/src/google-types.ts:9 | integration instance | n | `integration-instances` record kind (D996) | none (already broker form) |  |
| `fromAddress` | text | n | addon-google-services/src/google-gmail-smtp.ts:12 | integration instance | y | `integration-instances` record kind (D996) | `google-services/<d>-broker-fields-to-integration` |  |
| `fromName` | text | n | addon-google-services/src/google-gmail-smtp.ts:13 | integration instance | y | `integration-instances` record kind (D996) | `google-services/<d>-broker-fields-to-integration` |  |
| `calendarIds` | multiselect | n | addon-google-services/src/google-calendar-source.ts:170 | integration instance | y | `integration-instances` record kind (D996) | `google-services/<d>-broker-fields-to-integration` |  |

### `homeassistant-export`

Package `packages/addon-provider-homeassistant`. Live prod hub: 3 fields shown: 0 unset, 1 at schema default, 2 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `exportTo:<brokerId>` | boolean | n | addon-provider-homeassistant/src/ha-export/membership.ts:111 | integration instance | n | `integration_settings` (integrationId, key) | `homeassistant-export/<d>-per-broker-flags-to-integration` | brokerId-keyed key in a cluster row (D986 §2) |
| `mediaRole:<brokerId>` | select | n | addon-provider-homeassistant/src/ha-export/media-url.ts:40 | integration instance | n | `integration_settings` (integrationId, key) | `homeassistant-export/<d>-per-broker-flags-to-integration` | brokerId-keyed key in a cluster row (D986 §2) |
| `reconcileIntervalSec` | number | n | addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:198 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `import-alexa`

Package `packages/addon-import-alexa`. Live prod hub: 0 fields shown: 0 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `amazonDomain` | select | n | addon-import-alexa/src/speak/controller.ts:31 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `cookie` | password | y | addon-import-alexa/src/alexa-broker-provider.ts:32 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `refreshToken` | password | y | addon-import-alexa/src/alexa-broker-provider.ts:33 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-import-alexa/src/alexa-integration-manager.ts:271 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `local-network`

Package `packages/system`. Live prod hub: 6 fields shown: 1 unset, 5 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `httpEnabled` | boolean | n | system/src/builtins/local-network/local-network.addon.ts:178 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |
| `httpPort` | number | n | system/src/builtins/local-network/local-network.addon.ts:180 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |
| `tlsEnabled` | boolean | n | system/src/builtins/local-network/local-network.addon.ts:186 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |
| `mdnsAdvertise` | boolean | n | system/src/builtins/local-network/local-network.addon.ts:204 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |
| `passiveDiscovery` | boolean | n | system/src/builtins/local-network/local-network.addon.ts:206 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |
| `localHostname` | text | n | system/src/builtins/local-network/local-network.addon.ts:188 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `local-network/<d>-lan-settings-per-node` |  |

### `matter-broker`

Package `packages/addon-matter-broker`. Live prod hub: 0 fields shown: 0 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `threadDataset` | password | y | addon-matter-broker/src/matter-integration-manager.ts:265 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `wifiSsid` | text | n | addon-matter-broker/src/matter-integration-manager.ts:266 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `wifiPassword` | password | y | addon-matter-broker/src/matter-integration-manager.ts:267 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `reconcileIntervalMs` | number | n | addon-matter-broker/src/matter-integration-manager.ts:248 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `metrics-native`

Package `packages/system`. Live prod hub: 3 fields shown: 0 unset, 3 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `samplingIntervalMs` | number | n | system/src/builtins/native-metrics/native-metrics.addon.ts:55 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `loadSeriesCadenceSec` | number | n | system/src/builtins/native-metrics/native-metrics.addon.ts:60 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `loadSeriesRetentionHours` | number | n | system/src/builtins/native-metrics/native-metrics.addon.ts:63 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `model-studio`

Package `packages/addon-model-studio`. Live prod hub: 1 fields shown: 1 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plusCatalogPlusApiKey` | password | y | addon-model-studio/src/ui/api.ts:805 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `mqtt-broker`

Package `packages/addon-mqtt-broker`. Live prod hub: 8 fields shown: 5 unset, 3 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `brokers` | editable-array | n | addon-mqtt-broker/src/retired-ciphertext.ts:102 | integration instance | n | `integration-instances` record kind (D996) | `mqtt-broker/<d>-brokers-to-integrations` | id-keyed list exploded to one integration per broker (D986 §2) |
| `embeddedEnabled` | boolean | n | addon-mqtt-broker/src/mqtt-broker.addon.ts:218 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddedPort` | number | n | addon-mqtt-broker/src/mqtt-broker.addon.ts:222 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddedAllowAnonymous` | boolean | n | addon-mqtt-broker/src/mqtt-broker.addon.ts:224 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddedUsername` | text | n | addon-mqtt-broker/src/mqtt-broker.addon.ts:226 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddedPassword` | password | y | addon-mqtt-broker/src/retired-ciphertext.ts:103 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddedClients` | editable-array | n | addon-mqtt-broker/src/mqtt-broker.addon.ts:229 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | username-keyed list: becomes a collection cap, not a form array |

### `osd-manager`

Package `packages/addon-osd-manager`. Live prod hub: 1 fields shown: 0 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tickSeconds` | number | n | addon-osd-manager/src/addon.ts:35 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `pipeline-analytics`

Package `packages/addon-post-analysis`. Live prod hub: 103 fields shown: 1 unset, 99 at schema default, 3 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `minTrackAge` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/events/event-emitter.ts:80 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `cooldownSec` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/events/event-emitter.ts:93 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minHits` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:29 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `stationaryThresholdSec` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker/state-analyzer.ts:27 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:39 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateMinConfidence` | slider | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:40 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateMinCropPx` | slider | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:41 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateTimeoutMs` | slider | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:42 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateMaxDeferralMs` | slider | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:43 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmationGateMaxAttempts` | slider | n | addon-post-analysis/src/pipeline-analytics/confirmation-gate-settings.ts:44 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `iouThreshold` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts:68 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `maxMissedMs` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/linker.ts:82 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minTrackAgeMs` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/events/event-emitter.ts:82 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `predictiveCoasting` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:32 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `classGating` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts:69 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `dedupEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:38 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `dedupSpawnIou` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts:72 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `personAnimalDedup` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:37 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `animalOverPersonMaxScore` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts:71 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `animalOverPersonIou` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:36 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `dropoutSkipEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/index.ts:6812 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `dropoutMaxSkipFrames` | number | n | addon-post-analysis/src/pipeline-analytics/index.ts:6813 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `classVotingEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:40 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `classVoteMinFraction` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:41 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `perClassMinScoreEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:42 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minScorePerson` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:74 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minScoreAnimal` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:76 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minScoreVehicle` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:78 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmBypassEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:46 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmBypassScore` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:47 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `byteTrackLowIouThreshold` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:97 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `lowScoreContinuationEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:48 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `lowScoreContinuationFloor` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-bench/synthetic.ts:129 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `trackingTape` | boolean | n | addon-post-analysis/src/pipeline-analytics/index.ts:6804 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minSpawnAreaEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/types.ts:44 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minSpawnAreaFracPerson` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:105 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minSpawnAreaFracAnimal` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:107 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minSpawnAreaFracVehicle` | number | n | addon-post-analysis/src/pipeline-analytics/tracking-settings.ts:109 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `classGroupAssoc` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts:70 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `zoneMembershipMinOverlap` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts:565 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `enabled (stationary-objects)` | boolean | n | addon-post-analysis/src/pipeline-analytics/index.ts:7469 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `suppressIou` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts:302 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `wakeAssocIou` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts:302 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `sessionStillnessWindowMs` | slider | n | addon-post-analysis/src/pipeline-analytics/stationary-settings.ts:34 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `entryTtlMs` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts:113 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `stillnessSpeedFracPerSec` | number | n | addon-post-analysis/src/pipeline-analytics/stillness-settings.ts:36 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `stillnessCalibrationNote` | text | n | addon-post-analysis/src/pipeline-analytics/stillness-settings.ts:48 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `postProcessingNodeId` | text | n | addon-post-analysis/src/pipeline-analytics/index.ts:2492 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `embeddingEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/index.ts:3088 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `debugMediaEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/periodic-media-plan.ts:33 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `motionMarkerQuietMs` | slider | n | addon-post-analysis/src/pipeline-analytics/media-settings.ts:45 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `snapshotIntervalMs` | slider | n | addon-post-analysis/src/pipeline-analytics/media-settings.ts:54 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `snapshotMovementThreshold` | slider | n | addon-post-analysis/src/pipeline-analytics/media-settings.ts:61 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `snapshotMaxIdleMs` | slider | n | addon-post-analysis/src/pipeline-analytics/media-settings.ts:65 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMetricsReportEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/boot/build-analytics-providers.ts:172 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMetricsReportThresholdDb` | slider | n | addon-post-analysis/src/pipeline-analytics/boot/build-analytics-providers.ts:175 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `batteryLowPercent` | number | n | addon-post-analysis/src/pipeline-analytics/boot/build-notification-center.ts:218 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `alertRenotifyMinutes` | number | n | addon-post-analysis/src/pipeline-analytics/boot/build-notification-center.ts:219 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `alertNotifyRecovery` | boolean | n | addon-post-analysis/src/pipeline-analytics/boot/build-notification-center.ts:220 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `retentionMode` | select | n | addon-post-analysis/src/pipeline-analytics/retention/retired-settings-purge.ts:123 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `trackRetentionDays` | number | n | addon-post-analysis/src/pipeline-analytics/retention/retired-settings-purge.ts:124 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `outboxDays` | number | n | addon-post-analysis/src/notification-center/prune-windows.ts:41 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `timelapseExportDays` | number | n | addon-post-analysis/src/notification-center/prune-windows.ts:43 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `artifactShelfDays` | number | n | addon-post-analysis/src/notification-center/prune-windows.ts:45 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `summaryMosaicDays` | number | n | addon-post-analysis/src/notification-center/prune-windows.ts:58 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `packageDropEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:295 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropPickupEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:538 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropEarlyPickupEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/index.ts:10088 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropMinFrames` | slider | n | addon-post-analysis/src/pipeline-analytics/index.ts:9985 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropDwellSec` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:360 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropMinBboxAreaFrac` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:391 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropMaxBboxAreaFrac` | slider | n | addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts:412 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `packageDropActivityWindowSec` | slider | n | addon-post-analysis/src/pipeline-analytics/index.ts:9987 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `classificationMinScore` | number | n | addon-post-analysis/src/pipeline-analytics/audio-classify-outcome.ts:19 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioAllowedClasses` | multiselect | n | addon-post-analysis/src/pipeline-analytics/audio-classify-outcome.ts:20 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioConfirmHits` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:32 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioConfirmWindowSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:34 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `levelDeviationDb` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:46 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `levelWindowSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:47 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `levelMaxWaitSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:48 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:60 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerBaselineSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:63 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMinDbfs` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:87 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMinDeviations` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:90 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMinDeviationDb` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:102 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMotionQuietSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:106 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerCooldownSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:108 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMaxPerHour` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:110 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioMarkerMaxPerDay` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:114 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioEpisodeEnabled` | boolean | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:127 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioEpisodeOpenHoldSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:129 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioEpisodeCloseGapSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:131 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `audioEpisodeCooldownSec` | number | n | addon-post-analysis/src/pipeline-analytics/audio-detection-settings.ts:142 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `enabled (face-recognition)` | boolean | n | addon-post-analysis/src/pipeline-analytics/face-settings.ts:150 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) | global-only field: the camera form strips it (`GLOBAL_ONLY_FIELDS`) |
| `similarityThreshold` | number | n | addon-post-analysis/src/pipeline-analytics/retention/retired-settings-purge.ts:251 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `margin` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts:40 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minFacePx` | number | n | addon-post-analysis/src/pipeline-analytics/face-settings.ts:60 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `recognitionMinFacePx` | number | n | addon-post-analysis/src/pipeline-analytics/face-settings.ts:71 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `minIdentitySamples` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts:48 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `confirmFrames` | number | n | addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts:299 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `maxEmbeddingMagnitude` | number | n | addon-post-analysis/src/pipeline-analytics/face-settings.ts:120 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `bufferMaxPerDevice` | number | n | addon-post-analysis/src/pipeline-analytics/retention/retention-sweep-runner.ts:385 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |
| `keepSourceFrames` | boolean | n | addon-post-analysis/src/pipeline-analytics/face-settings.ts:133 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | same schema feeds the camera form; camera overrides |

### `pipeline-orchestrator`

Package `packages/addon-pipeline-orchestrator`. Live prod hub: 22 fields shown: 0 unset, 18 at schema default, 4 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `nodeBindings` | json blob (node id -> bindings) | n | addon-pipeline-orchestrator/src/pipeline-settings-store.ts:207 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-orchestrator/2026-11-03-node-bindings-to-node-rows` | node-keyed JSON map exploded to node rows. LANDED: readers use `nodeBindings@<nodeId>`; the old key stays one release |
| `agentSettings` | json blob (node id -> settings) | n | addon-pipeline-orchestrator/src/pipeline-settings-store.ts:188 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-orchestrator/2026-11-03-agent-settings-to-node-rows` | node-keyed JSON map exploded to node rows. LANDED: readers use `agentSettings@<nodeId>`; the old key stays one release |
| `cameraSettings` | json blob (device id -> settings) | n | addon-pipeline-orchestrator/src/pipeline-resolver.ts:199 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | `pipeline-orchestrator/2026-11-03-camera-settings-to-device-rows` | device-keyed JSON map exploded to `addon-device-settings`. LANDED: readers use the device's `cameraSettings` field; the old key stays one release |
| `bindingsMigration_v1_done` | boolean flag | n | addon-pipeline-orchestrator/src/pipeline-settings-store.ts:245 | dead | n | purged via `retired-settings-keys.ts` | `pipeline-orchestrator/<d>-drop-bindings-migration-flag` | one-shot flag of an old carry-over; the ledger replaces it |
| `ingestNode` | node-select | n | addon-pipeline-orchestrator/src/ingest-owner.ts:4 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `audioNode` | node-select | n | addon-pipeline-orchestrator/src/ingest-owner.ts:5 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `motionNode` | node-select | n | addon-pipeline-orchestrator/src/node-topology.ts:62 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `sessionPlacement` | select | n | addon-pipeline-orchestrator/src/orchestrator-bootstrap.ts:278 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `fpsMinThreshold` | slider | n | addon-pipeline-orchestrator/src/load-shed-controller.ts:133 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nodeStressMode` | select | n | addon-pipeline-orchestrator/src/node-stress-controller.ts:152 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `fpsLowWindowMs` | slider | n | addon-pipeline-orchestrator/src/load-shed-controller.ts:137 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `clusterModel.<step>` | select | n | via constant `clusterModelSettingKey(step.st` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `clusterStep.<step>.<field>` | slider | n | via constant `clusterStepSettingKey(field.st` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `detailCropPaddingRatio` | slider | n | via constant `DETAIL_CROP_PADDING_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `detailCropSquare` | boolean | n | via constant `DETAIL_CROP_SQUARE_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `faceRescoreIntervalMinutes` | slider | n | via constant `FACE_RESCORE_INTERVAL_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeLeaseHoldFrames` | slider | n | via constant `NATIVE_LEASE_HOLD_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeTileBudgetMb` | slider | n | via constant `NATIVE_LEASE_TILE_BUDGET_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeSceneBudgetMb` | slider | n | via constant `NATIVE_LEASE_SCENE_BUDGET_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeLeaseBudgetMb` | slider | n | via constant `NATIVE_LEASE_BUDGET_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeLeaseActivityMs` | slider | n | via constant `NATIVE_LEASE_ACTIVITY_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `nativeLeaseAdmission` | select | n | via constant `NATIVE_LEASE_ADMISSION_KEY` | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `onDisconnect` | select | n | addon-pipeline-orchestrator/src/orchestrator-types.ts:97 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `pinnedOnDisconnect` | select | n | addon-pipeline-orchestrator/src/orchestrator-types.ts:98 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `onReconnect` | select | n | addon-pipeline-orchestrator/src/orchestrator-types.ts:99 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `motionStreamProfile` | select | n | addon-pipeline-orchestrator/src/device-detection-settings.ts:89 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `detectionMode` | select | n | addon-pipeline-orchestrator/src/pipeline-watchdog.ts:18 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `detectionStreamProfile` | select | n | addon-pipeline-orchestrator/src/device-detection-settings.ts:90 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `detectionFps` | slider | n | addon-pipeline-orchestrator/src/device-detection-settings.ts:92 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `activityDetectionFps` | slider | n | addon-pipeline-orchestrator/src/device-detection-settings.ts:94 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `audioMode` | select | n | addon-pipeline-orchestrator/src/pipeline-watchdog.ts:17 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `audioStreamPick` | select | n | addon-pipeline-orchestrator/src/orchestrator-bootstrap.ts:612 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |
| `pipelineNodeId` | select | n | addon-pipeline-orchestrator/src/index.ts:1285 | per-device | n | `addon-device-settings` `<addon>:<deviceId>.<field>` | none (re-declare only) | device form only; the fleet default is the schema default today (D986 §3) |

### `pipeline-runner`

Package `packages/addon-pipeline`. Live prod hub: 9 fields shown: 2 unset, 7 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `maxConcurrentInferences` | slider | n | addon-pipeline/src/pipeline-runner/frame-governor.ts:22 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `maxQueueDepth` | slider | n | addon-pipeline/src/pipeline-runner/index.ts:390 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `targetLoadPercent` | slider | n | addon-pipeline/src/pipeline-runner/frame-governor.ts:20 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `minThrottledFps` | slider | n | addon-pipeline/src/pipeline-runner/frame-governor.ts:21 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `maxConcurrentDecodeSpawns` | slider | n | addon-pipeline/src/pipeline-runner/index.ts:412 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `maxLiveDecodeWorkers` | slider | n | addon-pipeline/src/pipeline-runner/node-decode-limits-source.ts:14 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node twin of `decodeBudgetMb`/`decodeMaxLiveWorkers`; decide which survives |
| `nodeDecodeBudgetMb` | slider | n | addon-pipeline/src/pipeline-runner/index.ts:429 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `pipeline-runner/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node twin of `decodeBudgetMb`/`decodeMaxLiveWorkers`; decide which survives |
| `decodeBudgetMb` | slider | n | addon-pipeline/src/pipeline-runner/node-decode-limits-source.ts:13 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `decodeMaxLiveWorkers` | slider | n | addon-pipeline/src/pipeline-runner/index.ts:440 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |

### `provider-bosch`

Package `packages/addon-provider-bosch`. Live prod hub: 11 fields shown: 11 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `accountLabel` | text | n | addon-provider-bosch/src/home-connect/home-connect-account-status.ts:5 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `appliances` | textarea | n | addon-provider-bosch/src/home-connect/home-connect-gateway.ts:4 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `applianceSecrets` | password | y | addon-provider-bosch/src/home-connect/home-connect-account-status.ts:13 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `token` | password | y | addon-provider-bosch/src/shc/shc-client.ts:62 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `refresh` | password | y | addon-provider-bosch/src/shc/shc-adoption-provider.ts:146 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `gatewayCount` | number | n | addon-provider-bosch/src/homecom/homecom-sign-in.ts:28 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `username` | password | y | addon-provider-bosch/src/homecom/homecom-login.ts:60 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `gatewayId` | text | n | addon-provider-bosch/src/homecom/homecom-connection-test.ts:13 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `brand` | select | n | addon-provider-bosch/src/home-connect/home-connect-login.ts:218 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `region` | select | n | addon-provider-bosch/src/homecom/homecom-sign-in.ts:32 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `host` | text | n | addon-provider-bosch/src/shc/shc-client.ts:53 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `systemPassword` | password | y | addon-provider-bosch/src/shc/custom-actions.ts:17 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `sslCertificate` | password | y | addon-provider-bosch/src/shc/shc-client.ts:275 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `sslKey` | password | y | addon-provider-bosch/src/shc/shc-client.ts:276 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-dreame`

Package `packages/addon-provider-dreame`. Live prod hub: 4 fields shown: 2 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `username` | text | n | addon-provider-dreame/src/dreame-integration-manager.ts:271 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-dreame/src/dreame-integration-manager.ts:272 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `region` | select | n | addon-provider-dreame/src/dreame-integration-manager.ts:121 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-dreame/src/dreame-integration-manager.ts:274 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-dreo`

Package `packages/addon-provider-dreo`. Live prod hub: 3 fields shown: 2 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `email` | text | n | addon-provider-dreo/src/dreo-connection-test.ts:65 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-dreo/src/dreo-integration-manager.ts:238 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `region` | select | n | addon-provider-dreo/src/dreo-connection-test.ts:65 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-ecowitt`

Package `packages/addon-provider-ecowitt`. Live prod hub: 7 fields shown: 3 unset, 4 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `transport` | select | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:28 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) |  |
| `host` | text | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:36 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) |  |
| `port` | number | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:37 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) |  |
| `password` | password | y | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:38 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) |  |
| `pollIntervalMs` | number | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:39 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) |  |
| `listenPort` | number | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:46 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) | inbound HTTP listener: stays the addon data plane (D999), an instance field |
| `listenHost` | text | n | addon-provider-ecowitt/src/ecowitt-integration-manager.ts:47 | integration instance | n | `integration_settings` (integrationId, key) | none (hub gateway already moved) | inbound HTTP listener: stays the addon data plane (D999), an instance field |

### `provider-enpal`

Package `packages/addon-provider-enpal`. Live prod hub: not installed or no form on the prod hub.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-enpal/src/enpal-client.ts:51 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `source` | select | n | addon-provider-enpal/src/enpal-client.ts:26 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `token` | password | y | addon-provider-enpal/src/enpal-client.ts:95 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `org` | text | n | addon-provider-enpal/src/enpal-client.ts:98 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `bucket` | text | n | addon-provider-enpal/src/enpal-client.ts:101 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `influxPort` | number | n | addon-provider-enpal/src/enpal-client.ts:98 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pagePort` | number | n | addon-provider-enpal/src/enpal-client.ts:130 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-enpal/src/enpal-integration-manager.ts:79 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `invertBatteryPower` | boolean | n | addon-provider-enpal/src/enpal-catalog.ts:271 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-esphome`

Package `packages/addon-provider-esphome`. Live prod hub: 1 fields shown: 1 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `boards` | editable-array | n | addon-provider-esphome/src/esphome-integration-boards.ts:108 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-homeassistant`

Package `packages/addon-provider-homeassistant`. Live prod hub: 0 fields shown: 0 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `brokers` | json list (broker id -> connection) | n | addon-provider-homeassistant/src/ha-board-key-source.ts:57 | integration instance | n | `integration_settings` (integrationId, key) | none: already `integration_settings` |  |
| `calendarIds` | multiselect | n | addon-provider-homeassistant/src/ha-calendar-source.ts:220 | integration instance | y | `integration_settings` (integrationId, key) | `provider-homeassistant/<d>-calendar-ids-to-integration` |  |
| `authKind` | select | n | addon-provider-homeassistant/src/ha-broker-settings-schema.ts:30 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `baseUrl` | text | n | addon-provider-homeassistant/src/ha-board-key-source.ts:37 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `accessToken` | password | y | addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:2545 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `supervisorToken` | password | y | addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:2535 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-homematic`

Package `packages/addon-provider-homematic`. Live prod hub: 10 fields shown: 4 unset, 6 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-homematic/src/homematic-integration-manager.ts:212 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `enableHmipRf` | boolean | n | addon-provider-homematic/src/config.ts:24 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `enableBidcosRf` | boolean | n | addon-provider-homematic/src/config.ts:25 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `enableGroups` | boolean | n | addon-provider-homematic/src/config.ts:26 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `enableBidcosWired` | boolean | n | addon-provider-homematic/src/config.ts:30 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `callbackHost` | text | n | addon-provider-homematic/src/config.ts:36 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) | inbound XML-RPC callback listener: addon data plane (D999), an instance field |
| `callbackPort` | number | n | addon-provider-homematic/src/config.ts:43 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) | inbound XML-RPC callback listener: addon data plane (D999), an instance field |
| `username` | text | n | addon-provider-homematic/src/homematic-integration-manager.ts:251 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-homematic/src/homematic-connection-test.ts:54 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `tls` | boolean | n | addon-provider-homematic/src/homematic-integration-manager.ts:213 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-onvif`

Package `packages/addon-provider-onvif`. Live prod hub: 2 fields shown: 2 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `defaultUsername` | text | n | none | dead | n | purged via `retired-settings-keys.ts` | `provider-onvif/<d>-drop-default-credentials` | no reader anywhere, live value unset; each camera holds its own credentials (D986 Q8) |
| `defaultPassword` | password | y | none | dead | n | purged via `retired-settings-keys.ts` | `provider-onvif/<d>-drop-default-credentials` | no reader anywhere, live value unset; each camera holds its own credentials (D986 Q8) |

### `provider-petkit`

Package `packages/addon-provider-petkit`. Live prod hub: 5 fields shown: 3 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `email` | text | n | addon-provider-petkit/src/config.ts:41 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-petkit/src/config.ts:42 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `region` | select | n | addon-provider-petkit/src/petkit-integration-manager.ts:138 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `timezone` | text | n | addon-provider-petkit/src/config.ts:44 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-petkit/src/config.ts:48 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-rademacher`

Package `packages/addon-provider-rademacher`. Live prod hub: 4 fields shown: 3 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-rademacher/src/rademacher-connection-test.ts:23 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-rademacher/src/rademacher-connection-test.ts:24 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-rademacher/src/rademacher-integration-manager.ts:274 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `basePath` | text | n | addon-provider-rademacher/src/rademacher-connection-test.ts:25 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-reolink`

Package `packages/addon-provider-reolink`. Live prod hub: 1 fields shown: 0 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clipCatalogRefreshMinutes` | number | n | addon-provider-reolink/src/reolink-camera.ts:1960 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | camera override resolves through `resolveClipCatalogRefreshMinutes` |
| `clipCatalogForcedWake` | boolean | n | addon-provider-reolink/src/reolink-camera.ts:1965 | fleet default | n | `addon-settings` `<addon>.<field>` (default row) | none (re-declare only) | camera override resolves through `resolveClipCatalogRefreshMinutes` |

### `provider-tuya`

Package `packages/addon-provider-tuya`. Live prod hub: 4 fields shown: 2 unset, 2 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `accessId` | text | n | addon-provider-tuya/src/config.ts:28 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `accessSecret` | password | y | addon-provider-tuya/src/config.ts:29 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `region` | select | n | addon-provider-tuya/src/tuya-integration-manager.ts:143 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `discoveryTimeoutMs` | number | n | addon-provider-tuya/src/tuya-integration-manager.ts:172 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-unifi`

Package `packages/addon-provider-unifi`. Live prod hub: 8 fields shown: 5 unset, 3 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-unifi/src/unifi-integration-manager.ts:144 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `port` | number | n | addon-provider-unifi/src/unifi-integration-manager.ts:145 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `apiKey` | password | y | addon-provider-unifi/src/unifi-integration-manager.ts:146 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `username` | text | n | addon-provider-unifi/src/unifi-integration-manager.ts:147 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-unifi/src/unifi-integration-manager.ts:148 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `site` | text | n | addon-provider-unifi/src/unifi-integration-manager.ts:149 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `allowSelfSigned` | boolean | n | addon-provider-unifi/src/unifi-integration-manager.ts:150 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-unifi/src/unifi-integration-manager.ts:226 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-unraid`

Package `packages/addon-provider-unraid`. Live prod hub: 6 fields shown: 2 unset, 4 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-unraid/src/unraid-integration-manager.ts:119 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `port` | number | n | addon-provider-unraid/src/unraid-integration-manager.ts:120 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `https` | boolean | n | addon-provider-unraid/src/unraid-integration-manager.ts:121 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `allowSelfSigned` | boolean | n | addon-provider-unraid/src/unraid-integration-manager.ts:123 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `apiKey` | password | y | addon-provider-unraid/src/unraid-integration-manager.ts:122 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `pollIntervalMs` | number | n | addon-provider-unraid/src/unraid-integration-manager.ts:196 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-velux`

Package `packages/addon-provider-velux`. Live prod hub: 2 fields shown: 2 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-provider-velux/src/velux-connection-test.ts:20 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-velux/src/velux-connection-test.ts:20 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `provider-wyze`

Package `packages/addon-provider-wyze`. Live prod hub: 4 fields shown: 4 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `email` | text | n | addon-provider-wyze/src/wyze-connection-test.ts:32 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `password` | password | y | addon-provider-wyze/src/wyze-connection-test.ts:32 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `apiKey` | password | y | addon-provider-wyze/src/wyze-connection-test.ts:44 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |
| `apiId` | text | n | addon-provider-wyze/src/wyze-connection-test.ts:45 | integration instance | n | `integration_settings` (integrationId, key) | none (already per integration) |  |

### `recorder`

Package `packages/addon-pipeline`. Live prod hub: 2 fields shown: 1 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `recordingNodeId` | text | n | addon-pipeline/src/recorder/addon/index.ts:233 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `recordingHubHostname` | text | n | addon-pipeline/src/recorder/addon/index.ts:235 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `smtp-nodemailer`

Package `packages/addon-smtp-nodemailer`. Live prod hub: 7 fields shown: 7 unset, 0 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `host` | text | n | addon-smtp-nodemailer/src/smtp.addon.ts:83 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `port` | number | n | addon-smtp-nodemailer/src/smtp.addon.ts:84 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `secure` | boolean | n | addon-smtp-nodemailer/src/smtp.addon.ts:85 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `username` | text | n | addon-smtp-nodemailer/src/smtp.addon.ts:86 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `password` | password | y | addon-smtp-nodemailer/src/inbound-broker.ts:579 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `fromAddress` | text | n | addon-smtp-nodemailer/src/relay-pool.ts:197 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |
| `fromName` | text | n | addon-smtp-nodemailer/src/smtp.addon.ts:89 | integration instance | y (one relay today) | `integration-instances` record kind (D996) | `smtp-nodemailer/<d>-relay-to-integration` |  |

### `snapshot`

Package `packages/system`. Live prod hub: 1 fields shown: 0 unset, 1 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `staleTtlMs` | number | n | system/src/builtins/snapshot/snapshot.addon.ts:265 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `stream-broker`

Package `packages/addon-pipeline`. Live prod hub: 6 fields shown: 1 unset, 5 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `defaultPreBufferSec` | number | n | addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts:1774 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `rtspPort` | number | n | addon-pipeline/src/stream-broker/addon.ts:118 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `stream-broker/<d>-unmarked-node-fields-per-node` | unmarked today: one value for every node |
| `hwaccel` | select | n | addon-pipeline/src/pipeline-runner/index.ts:4928 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `binaryPath` | text | n | addon-pipeline/src/audio-analyzer/audio-pipeline.ts:243 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `joinBurstMaxSpanMs` | number | n | addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts:209 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |
| `catalogReconcileIntervalSec` | number | n | addon-pipeline/src/stream-broker/addon.ts:125 | cluster | n | `addon-settings` `<addon>.<field>` | none (re-declare only) |  |

### `system-config`

Package `packages/system`. Live prod hub: 9 fields shown: 2 unset, 2 at schema default, 5 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `name` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `port` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `host` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `dataPath` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `tokenExpiry` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `accessTokenExpiry` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `trustedProxies` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `trustedNetworks` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |
| `corsOrigins` | text | n | system/src/builtins/system-config/system-config.addon.ts:585 | other (yml) | n | yml (bootstrap), not a settings row | none (yml, bootstrap) | read by the addon getGlobalSettings from config.yml; not an addon-settings row |

### `tailscale-client`

Package `packages/addon-tailscale`. Live prod hub: not installed or no form on the prod hub.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `clientMode` | select | n | addon-tailscale/src/client/tailscale.addon.ts:89 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `hostname` | text | n | addon-tailscale/src/ingress/tailscale-ingress.addon.ts:83 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `acceptRoutes` | boolean | n | addon-tailscale/src/client/tailscale.addon.ts:60 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `advertisedRoutes` | text | n | addon-tailscale/src/client/tailscale.addon.ts:65 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `advertisedTags` | text | n | addon-tailscale/src/client/tailscale.addon.ts:67 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `acceptDns` | boolean | n | addon-tailscale/src/client/tailscale.addon.ts:62 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `exitNodeId` | text | n | addon-tailscale/src/client/tailscale.addon.ts:69 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `shieldsUp` | boolean | n | addon-tailscale/src/client/tailscale.addon.ts:73 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `ssh` | boolean | n | addon-tailscale/src/client/tailscale.addon.ts:75 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |
| `authKey` | password | y | addon-tailscale/src/ingress/tailscale-cli.ts:236 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-client/<d>-settings-per-node` | client flags are node facts (D986) |

### `tailscale-ingress`

Package `packages/addon-tailscale`. Live prod hub: not installed or no form on the prod hub.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mode` | select | n | addon-tailscale/src/ingress/tailscale-ingress.addon.ts:55 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-ingress/<d>-settings-per-node` | client flags are node facts (D986) |
| `sourcePort` | number | n | addon-tailscale/src/ingress/tailscale-ingress.addon.ts:57 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-ingress/<d>-settings-per-node` | client flags are node facts (D986) |
| `targetPath` | text | n | addon-tailscale/src/ingress/tailscale-ingress.addon.ts:59 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-ingress/<d>-settings-per-node` | client flags are node facts (D986) |
| `upstreamScheme` | select | n | addon-tailscale/src/ingress/tailscale-ingress.addon.ts:67 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | `tailscale-ingress/<d>-settings-per-node` | client flags are node facts (D986) |

### `terminal`

Package `packages/addon-terminal`. Live prod hub: 13 fields shown: 4 unset, 9 at schema default, 0 set to something else.

| Key | Type | Secret | Read at | Target scope | Shared across instances | Destination (D986/D996) | D987 migration | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `maxSessions` | number | n | addon-terminal/src/terminal-session-manager.ts:105 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `btmEnabled` | boolean | n | addon-terminal/src/profiles.ts:77 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `btmPath` | text | n | addon-terminal/src/profiles.ts:76 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `btmArgs` | tags | n | addon-terminal/src/profiles.ts:78 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `topEnabled` | boolean | n | addon-terminal/src/profiles.ts:79 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `topPath` | text | n | addon-terminal/src/profiles.ts:80 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `topArgs` | tags | n | addon-terminal/src/profiles.ts:81 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `glancesEnabled` | boolean | n | addon-terminal/src/profiles.ts:82 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `glancesPath` | text | n | addon-terminal/src/profiles.ts:83 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `glancesArgs` | tags | n | addon-terminal/src/profiles.ts:84 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `allowShell` | boolean | n | addon-terminal/src/profiles.ts:88 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `shellPath` | text | n | addon-terminal/src/profiles.ts:89 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |
| `customProfiles` | editable-array | n | addon-terminal/src/profiles.ts:90 | per-node | n | `addon-settings` `<addon>.<field>@<nodeId>` + `nodeId` | covered by `hub/<d>-node-rows-carry-nodeid` |  |

## Inbound receivers an addon runs

Inventory for the receivers question of planning#327 (2026-10-31 comment), as D999 settled it:

| Addon | Receiver | Today | Target |
| --- | --- | --- | --- |
| `provider-reolink` | SMTP :2525, HTTP webhook :9081 | already moved: `provider-reolink/email-push-to-mailbox`, `provider-reolink/drop-webhook-intake-settings` | SMTP is the `smtp-inbound` broker kind (D999); HTTP is the addon data plane |
| `provider-ecowitt` | HTTP listener (`listenPort` 4199, `listenHost`) | two instance fields | stay instance fields (addon data plane) |
| `provider-homematic` | XML-RPC callback (`callbackHost`, `callbackPort` 2128) | two instance fields | stay instance fields; the host should read the `internal` role |
| `export-alexa` | ingress token endpoint | `enforceIngressToken`, a `tokens` blob | instance field; tokens are state of the instance |

## Values the form does not show

| Key | Owner | Shape | Why it matters |
| --- | --- | --- | --- |
| `nodeBindings`, `agentSettings` | `pipeline-orchestrator` | one JSON key, map keyed by node id | forgetting a node leaves the entry behind; D986 §2 forbids the shape |
| `cameraSettings` | `pipeline-orchestrator` | one JSON key, map keyed by device id | same for a deleted device; belongs to `addon-device-settings` |
| `bindingsMigration_v1_done` | `pipeline-orchestrator` | boolean flag of an old carry-over | the D987 ledger replaces it: dead |
| `linkedAccounts`, `tokens` | `export-alexa` | ledgers keyed by account and token id | state; travels with the instance |
| `brokers` | `provider-homeassistant` | list of broker connections | already `integration_settings`; the addon-level copy is the carry-over to check |
| `system-config` (9 keys) | `system-config` | `config.yml` sections | bootstrap config read before any store exists; out of scope for the movers |

## Findings that change the plan

- **Dead:** three keys have no reader. `provider-onvif` `defaultUsername` and `defaultPassword` (no reader in the
  repository, both unset on the prod hub; the password is a secret, so the purge must clear the keychain entry) and the
  orchestrator `bindingsMigration_v1_done` flag.
- **One cluster field is a credential declared as text:** `export-hap` `fixedPin`.
- **Twin keys:** `pipeline-runner` declares `nodeDecodeBudgetMb`/`maxLiveDecodeWorkers` (unmarked) and
  `decodeBudgetMb`/`decodeMaxLiveWorkers` (`perNode`). Both have readers; one pair must be chosen before the node
  mover, or the copy carries both.
- **The `perNode: true` rows already match the target shape** (`<key>@<nodeId>`); they only lack `nodeId` in the row
  data, so one hub mover covers `decoder-nodeav`, `detection-pipeline`, `audio-analyzer` (probe state), `pipeline-runner`,
  `stream-broker` and `terminal`.
- **Tailscale and Cloudflare were not installed or not configured on the prod hub**: their rows are classified from
  the schema and the reader, with no live evidence.
- **Fleet defaults need no data move.** `pipeline-analytics` (95 fields) and the Reolink clip refresh keep their
  `<addonId>.<field>` rows. What they need is the resolver (D986 §3) and the hook rename.

## Ordered mover plan

Each mover is one D987 migration, idempotent, read back before it deletes, and the old key is purged one release
later through `retired-settings-keys.ts` (D986 consequences). Lowest risk first; each step needs only the ones above it.

| # | Migration id | Moves | Why this position |
| ---: | --- | --- | --- |
| 1 | `hub/<d>-node-rows-carry-nodeid` | adds `nodeId` to every `<key>@<nodeId>` row of `addon-settings` (23 fields and 2 probe states over 6 addons) | **First.** Additive JSON field, no id rewrite, no reader changes; a rolled-back build reads the rows as before. It unlocks the central `deleteWhere({ nodeId })` on node forget, which every later node mover relies on |
| 2 | `provider-onvif/<d>-drop-default-credentials` | deletes two unread keys and one keychain secret | nothing reads them; live values are unset |
| 3 | `pipeline-orchestrator/<d>-drop-bindings-migration-flag` | deletes one flag | the ledger replaced it |
| 4 | `<owner>/<d>-unmarked-node-fields-per-node` for `pipeline-runner`, `stream-broker`, `audio-analyzer`; `local-network/<d>-lan-settings-per-node`; `export-hap/<d>-interface-name-per-node`; `cloudflare-tunnel/<d>-local-origin-to-node`; `tailscale-client/<d>-settings-per-node`; `tailscale-ingress/<d>-settings-per-node` | copies a cluster-wide value to a node row for every node that runs the addon (33 fields); the old row stays for a release | needs 1; a copy, not a delete, and one owner per migration. Choose the runner twin keys first |
| 5 | `pipeline-orchestrator/<d>-node-bindings-to-node-rows`, then `-agent-settings-to-node-rows` | explodes two node-keyed JSON maps into node rows | needs 1 and 4; the orchestrator places work, so its owner boot order matters (D987 `dependsOn`). **Landed** (planning#327 M3): ids `2026-11-03-node-bindings-to-node-rows`, `-agent-settings-to-node-rows`; `onFailure: block-owner`; the three old keys are added to `retired-settings-keys.ts` one release after this ships |
| 6 | `pipeline-orchestrator/<d>-camera-settings-to-device-rows` | explodes the device-keyed map into `addon-device-settings`, a tombstone-driven cleanup afterwards (D865) | needs 5 so the orchestrator boots from one shape at a time. **Landed** with 5 (`2026-11-03-camera-settings-to-device-rows`, `dependsOn` the agent mover); the tombstone cleanup is the device-removal hook, which already clears the device store |
| 7 | `homeassistant-export/<d>-per-broker-flags-to-integration`, `provider-homeassistant/<d>-calendar-ids-to-integration`, `google-services/<d>-broker-fields-to-integration` | moves broker-keyed and shared-across-brokers values to each instance (`calendarIds`, `fromAddress`, `fromName`, `exportTo`, `mediaRole`) | the multi-instance bug of D986; a shared value is copied to every instance, so it is the first mover that can change what an operator sees |
| 8 | `smtp-nodemailer/<d>-relay-to-integration`, `mqtt-broker/<d>-brokers-to-integrations`, `export-alexa/<d>-settings-to-integration` and `-ledgers-to-integration` | moves a service instance to a D996 `integration-instances` record; secrets change keychain scope | needs the D996 cap on each owner; secret moves are procedures, never plans |
| 9 | `cloudflare-tunnel/<d>-tunnel-account-to-integration` | account fields and the API token to a D996 record | last of the moves: it holds the remote-access path, and a failed move would cut the tunnel; keep `onFailure: block-owner` |
| 10 | Hook removal and guard | no data: delete `globalSettingsSchema` from each carrier, then land `check-no-global-settings-schema` | after every mover has run on the hub; the connection-form carriers (96 integration rows) need only this |

Fleet defaults, cluster fields and `system-config` have no mover.

**First mover: `hub/<d>-node-rows-carry-nodeid`.**
