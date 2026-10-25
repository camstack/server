# Entries census: every list of entries stored inside settings or a table

Status: read-only analysis, 2026-10-18. Code: `main` (1.2.589). Live: production hub
`https://<hub-ip>:4443`, read through `settingsStore.query/get` with a filter that printed
SHAPES ONLY (key names, types, lengths, `$secret` marker or raw). No secret value was read
into this analysis; `system-settings` was read as types only.
Inputs: `records-plan.md` (section 1, the per-table verdicts of section 2), D879 (raw-secret
census), D787 / D870 (secret trees, `secretStatePaths`), D865, D873, D857.

## 0. Answers first

- **80 list/map places catalogued** (sections 1-5). Of them: **18 operator-created entry
  lists inside settings blobs → G**; **5 table-backed lists also fit G** (integrations,
  notification targets, HA notification targets, LLM profiles, backup schedules); **5 legacy
  rows → X** (C10-C12, C14, N3); the rest are single values / flags (S), per-device or
  per-node maps (section 5), or tables that need their own kind (O / P).
- **The repo already has a generic entry, twice.** `integrations` + `integration_settings`
  (15 + 10 rows, schema-driven settings, secrets as keychain markers, the generic
  `IntegrationDetail` UI) and the `broker` cap (`getSettingsSchema` / `setSettings` /
  `remove` per id, rendered generically under Connectivity → Brokers). HA, Homematic,
  Matter and import-Alexa broker rows ALREADY carry an `integrationId`: every such
  connection is stored twice, once as an integration and once as a `brokers[]` row, and the
  credentials sit only in the raw `brokers[]` copy. The generic `entry` kind should be the
  integration model, generalised (any owner, any number of kinds per owner), not a third
  mechanism next to it.
- **Raw secrets D879 MISSED (live, verified by type):**
  1. `provider-dreame.brokers[0].connection.password` (and `username`): **RAW, non-empty**,
     in a LEGACY `addon-settings` row that no code reads any more. Dreame moved to
     integrations; `int_0009` holds the same password as a keychain MARKER. The old row was
     never cleaned, so the plaintext copy has outlived the migration (and is in every
     backup snapshot). The guard cannot see it: it scans code, and no code writes it.
  2. **Core-block settings bypass the keychain.** Block `01b86c71…` declares `password` as
     type `password` in its `settingsSchema`, yet the value is RAW in TWO places:
     `core-blocks:settings` (`values` JSON) and the mirror row
     `addon-settings` `core-block-01b86c71….password`. `block-settings-store.ts` has no
     secret tree at all, so EVERY password field any user script declares is plaintext.
  3. **Latent:** `waste-collections.sources[].argsJson` is a JSON string of free keys; the
     service catalog has `password`, `api_key`, `token`, `authorization` arguments. Raw by
     construction, invisible to a name-based guard (a string, not an object). Today's one
     source (`abfallnavi_de`: `service, ort, strasse, hausnummer`) holds none.
  4. **Latent, stale:** `provider-ecowitt.brokers[0].connection.password` (legacy row, empty
     today). `provider-gree.brokers` legacy row has no credential.
- **Network and identity hold few true entry lists.** Network is almost entirely single
  values and flags (one tunnel, one TURN, one tailnet, role picks over addresses). The only
  operator-created network list is `local-network.customAddresses` (empty today). Identity
  is already tables (users, tokens, sessions, passkeys, device and mesh certificates: all in
  plan Phase 6) plus ONE blob list, `auth-oidc.providers[]` (keychain-backed, D879 got it
  right). Certificates (D873) are files on disk, pairings (D857) are in memory: neither is
  an entry.

Legend for verdicts: **G** = generic entry record kind (name given) · **O** = own record kind
(not generic: reason) · **S** = stays a settings field (single value, flags, or per-device /
per-node config under D865) · **P** = already a table in the records plan (phase) ·
**X** = legacy leftover, delete by hand after verification (no boot purge).
Secret column: `M` = keychain marker today, `RAW` = plaintext today, `-` = none.

## 1. Network

| # | Owner | Where | Entry shape | Count | Secrets | Edited | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | `local-network` | addon-settings `customAddresses` | `{ url, label }` | 0 | - | Network → Addresses (`NetworkAddresses.tsx`, `AddressesCard`) | **G** `custom-address`. The role ticks stay settings (they point at detected AND custom addresses) |
| N2 | `local-network` | `allowedAddresses`, `appConnectionUrls`, `notificationTapUrl`, `publicEndpointUrl`, `internalUrl` | string lists / strings (role picks, interface allowlist) | 2 / 2 / 1 each | - | same page | **S** (flags over a derived palette, not entries) |
| N3 | `local-network` | `viewerBaseUrls`, `notificationBaseUrl` | old role-name keys (`address-book.ts` says "earlier role names") | 2 / 1 | - | none | **X** (still in the live DB) |
| N4 | `remote-access-orchestrator` | `enabledProviders` | string list | 2 | - | Network → Remote Access (IntegrationHub) | **S** (flags) |
| N5 | `cloudflare-tunnel` | `customTunnelToken`, `customApiToken`, `customHostname`, `customZoneName/Id`, `customDnsRecordId`, `customAccountId`, `customTunnelId`, `localPort`, `mode` | one tunnel | 1 | M (both tokens) | Remote Access, schema form | **S** (single). If several hostnames are ever needed → **G** `tunnel-route` |
| N6 | `cloudflare-turn` | `accountId`, `apiToken` | one account | 1 | M | Network → TURN Servers, schema form | **S** |
| N7 | `static-turn` | `urls` (comma text), `username`, `credential` | ONE server, a multi-URL text field | not installed on prod | `credential` is `password` type → keychain | TURN Servers, schema form | **S** today; **G** `turn-server` only if more than one server is wanted (the text list is a list in disguise) |
| N8 | `tailscale`, `tailscale-ingress` | `authKey`, `hostname`, `advertisedRoutes`, `advertisedTags` (text), ingress `mode`, `sourcePort`, `targetPath` | one tailnet / one ingress | not in prod addon-settings | `authKey` `password` → keychain | Mesh Networks / Remote Access | **S** |
| N9 | `pipeline-orchestrator` | `agentSettings` map by node id | `{ maxCameras, detectWeight, detect, decode, audio, ingest, reachableHost, color, inferenceDevices{…} }` | 4 nodes | - | Cluster / node pages | **S** (keyed by node, created by pairing, not by the operator). A later per-node record kind is possible; not generic |
| N10 | `system-config`, system-settings | `cluster.meshClearPort`, `cluster.meshCa`, `cluster.deviceCa` (public PEM), `server.name` | single | 1 | - (CA keys: files 0600 / keychain `DEVICE_CA_KEY_REF`) | Cluster | **S** |
| N11 | `export-alexa`, `export-google`, `homeassistant-export` | `publicHubUrl`, `detectedPublicHubUrl`, `advertisedBrokerUrl`, `availableEndpoints[]`, `publicBaseUrl` | single URLs | 1 each | - | exporter pages | **S**. Check against AGENTS "hub address is the local-network palette": these look like pre-D729 copies of a role |
| N12 | system | TLS: `camstack.crt/key`, `uploaded-ca.crt`, `camstack-ca.*`, `ca-replaced.json` (D873) | files in the TLS dir | 1 per node | key files owner-only | Identity → Certificates | not an entry (files; one served pair per node) |
| N13 | system | `agent_https_names` | `{ nodeId → names }` | 3 | - | Certificates | **P** (R, phase 4/6) |
| N14 | system | `mesh_node_certificates` | per node cert, fingerprint, validity | 22 | - (public) | Cluster → Agents | **P** (R+x, phase 6) |
| N15 | system | pairing offers (D857) | in-memory `Map` (`agent-pairing-routes.ts`, `hub-pairing.ts`) | - | six-digit code, never stored | Cluster → Agents | not persisted, no verdict |
| N16 | `pipeline-orchestrator` | `cluster-node-history` | node registry history | 4 | - | none | **P** (R, phase 4) |

## 2. Identity

| # | Owner | Where | Entry shape | Count | Secrets | Edited | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | `auth-oidc` | addon-settings `providers[]` | `{ id, displayName, icon, issuerUrl, clientId, clientSecret, redirectUri, scopes, usernameClaim, defaultRole }` | 1 | `clientSecret` **M** (`providers[id].clientSecret`) | Identity → Authentication (`OidcSettingsConnections.tsx`) | **G** `oidc-provider` |
| I2 | system | `users` | user, role, `passwordHash` | 2 | hashed | Identity → Users | **P** (R+x, phase 6). Not generic: the security root of login |
| I3 | system | `api_keys`, `scoped_tokens`, `admin_tokens`, `share_view_tokens` | token rows | 0 / 51 / 1 / 10 | hashed | Identity → Tokens & sessions (`Access.tsx`); share links from the viewer | **P** (R+x, phase 6). **O**: show-once tokens, per-request hash lookup; a generic editor must never re-render them |
| I4 | system | `login_sessions`, `login_session_cutoffs`, `oauth_sessions` | sessions | 83 / 1 / 2 | hashed | Tokens & sessions (revoke only) | **P** (phase 6), **O** (machine-created) |
| I5 | system, `auth-webauthn` | `device_credentials`, `user_passkeys`, `user_passkey_prefs`, `user_totp`, `user_external_identities` | per-user credentials | 5 / 1 / 0 / 0 / 1 | public keys; TOTP **M** (D878) | My access | **P** (phase 6), **O** (created by a ceremony, not a form) |
| I6 | `export-alexa` | `tokens[]` | `{ userId, accessToken, expiresAt, receivedAt, brokerUrl, brokerCredential }` | 1 | `accessToken`, `brokerCredential` **M** (`tokens[userId].*`) | none (OAuth link writes it) | **O** `alexa-link` keyed by user (machine-written; same family as I7) |
| I7 | `export-alexa`, `export-google` | `linkedAccounts[]` | `{ userId, username, linkedAt }` | 1 / 0 | - | exporter page (unlink) | **O** `linked-account`, one family with I6 |
| I8 | `google-services` | `oauthAccounts.accounts[]` | `{ id, refreshToken, accessToken, accessExpiresAt, accountEmail }` | 1 | **M** both | Connectivity → Google (OAuth flow) | **O** today; folds into the G entry of C5 as its OAuth-acquired secret fields |
| I9 | `export-hap` | `identity` | `{ username, pincode, uuid }` | 1 | `pincode` **M** | HomeKit page | **S** (single) |
| I10 | `auth-webauthn` | `rpID`, `origin` | single | 1 | - | Authentication | **S** |
| I11 | system | `keychain:secrets`, `keychain:keys` | - | 101 / 1 | the roots | System → Secrets | **P** (S, stays its own table) |

## 3. Connections: brokers, accounts, providers (the main generic-entry family)

| # | Owner | Where | Entry shape | Count | Secrets | Edited | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | system | `integrations` + `integration_settings` | `{ id int_NNNN, addon_id, name, enabled, info }` + `(integration_id, key) → value` | 15 + 10 | declared `password` fields **M** (live: dreame `password`, wyze `password`, `apiKey`) | Integrations → `IntegrationDetail` (generic, schema-driven) | **P** (R+x, phase 4). **This is the generic entry already**: generalise it rather than add a parallel kind |
| C2 | `provider-homeassistant` | addon-settings `brokers[]` | `{ id, name, auth{ kind, baseUrl, accessToken }, integrationId }` | 1 | `accessToken` **RAW** (D879 has it) | Connectivity → Brokers via `broker` cap `getSettingsSchema` / `setSettings` | **G** = fold into C1 (the integration `int_0019` exists and points back by `brokerId`) |
| C3 | `provider-homematic` | `brokers[]` | `{ id, name, connection{ host, enable*, username, password, callbackHost, callbackPort, tls }, integrationId }` | 1 | `password` **RAW** (D879 has it) | same | **G** = fold into C1 (`int_0020`) |
| C4 | `matter-broker` | `brokers[]` | `{ id, name, connection{ …threadDataset, wifiPassword }, integrationId }` | 0 on prod | **RAW** (D879) | same | **G** = fold into C1 |
| C5 | `google-services` | `brokers[]` | `{ id, name, clientId, clientSecret, calendarFilter, fromAddress, fromName }` | 1 | `clientSecret` **RAW** (D879) | Connectivity → Email / Calendars | **G** `google-account` (with I8 as its OAuth secret fields) |
| C6 | `import-alexa` | `brokers[]` | `{ id, name, connection{ cookie, refreshToken, macDms, … }, integrationId }` | 0 on prod | **RAW** (D879) | Connectivity → Brokers | **G** = fold into C1 |
| C7 | `mqtt-broker` | `brokers[]` (editable-array) | external broker `{ id, name, url, username, password, … }` | 0 on prod | `password` **M** (schema item field) | generic config form | **G** `mqtt-broker` |
| C8 | `mqtt-broker` | `embeddedClients[]` (editable-array) | `{ username, passwordHash }` | 0 | hashed | generic form | **G** `mqtt-client` |
| C9 | `mqtt-broker` | `embeddedAcl[]` (editable-array) | `{ username, topicPattern, access }` | 0 | - | generic form | **G** `mqtt-acl-rule` |
| C10 | `provider-dreame` | `brokers[]` | `{ id, name, connection{ username, password, region, pollIntervalMs } }` | 1 | **`password` RAW, non-empty. MISSED by D879** | none: no code reads it (`int_0009` replaced it) | **X**: delete the row after checking `int_0009` resolves (it holds the MARKER) |
| C11 | `provider-ecowitt` | `brokers[]` | `{ id, name, connection{ transport, host, port, password, … } }` | 1 | `password` raw field, empty today (MISSED, stale) | none | **X** (`int_0008` replaced it) |
| C12 | `provider-gree` | `brokers[]` | `{ id, name, connection{ broadcastAddr, timeoutMs, retries, encryption } }` | 1 | - | none | **X** (`int_0011`; Gree is now device-level) |
| C13 | `training-modal` | `entries[]` | `{ id, name, tokenId, tokenSecret, environment, gpuType, region, costCapUsd, maxRuntimeHours, failedDatasetGraceHours }` | 1 | `tokenSecret` **M** | Training → Providers dialog | **G** `training-account` |
| C14 | `training-modal` | top-level `tokenId`, `tokenSecret`, `environment`, `gpuType`, `region`, `costCapUsd`, … | the pre-`entries` single account | 1 set | `tokenSecret` null today | none | **X** (empty legacy keys) |
| C15 | `notifiers` | `notifiers:notification-targets` | `{ id, kind, name, config{…} }` | 5 | **RAW** `config` passwords; webhook `headers[]` editable-array rows (D879 has it) | Notifications → Targets (`NotificationTargets.tsx`, adapter descriptors) | **P** (R, phase 2) → **G** `notification-target` (secret keys per variant, D879 design) |
| C16 | `provider-homeassistant` | `ha-notification-targets` | `{ id, name, service, brokerId }` | 0 | - | same page | **P** (phase 2) → **G**, same kind family as C15 |
| C17 | `ai` | `ai:llm-profiles` | `{ id, name, provider, baseUrl, model, apiKey, … }` | 3 | `apiKey` **M** (D878) | AI → Profiles (`AiProfileEditor`) | **P** (R, phase 2) → **G** `llm-profile` fits (dedicated editor adds a model test) |
| C18 | `waste-collections` | `sources[]` | `{ id, label, module, argsJson, enabled }` | 1 | **argsJson can carry `password` / `api_key` / `token` / `authorization` RAW. MISSED by D879 (latent)** | Calendars → Waste (`WasteSettingsSources.tsx`) | **G** `waste-source`, but only after `argsJson` becomes typed per service (the catalog knows each service's fields; a free JSON string cannot declare a secret) |
| C19 | `smtp-nodemailer` | `host, port, secure, username, password, fromAddress, fromName` | one account | not installed on prod | `password` type → keychain | Connectivity → Email | **S** (single); **G** `smtp-account` if more than one relay is wanted |
| C20 | `loki-logging` | `url, tenantId, username, password, job, extraLabels, …` | one destination | 1 | `password` type → keychain; URL carries no userinfo (checked) | Logs → Destinations | **S** |
| C21 | system | `storage_locations` | `{ id, type, mode, config{…} }` | 7 | declared password fields **M** (D787) | System → Storage | **P** (R, phase 4), **O**: `mode` has ONE reader (D385) and drives eviction; not a plain entry |
| C22 | system | `backup_schedules`, `backup_destination_policies` | schedule rows; policy per location | 3 / 2 | - | System → Backup | **P** (R, phase 4). Schedules fit **G** `backup-schedule`; policies are keyed by location (**O**, a per-location setting) |
| C23 | `homeassistant-export` | `knownBrokers[]`, `membership` map, `exportTo:<brokerId>` | `{ id, name }` mirror of C2 | 1 | - | HA export page | **S** (derived mirror; goes away when C2 becomes an entry it can read through the cap) |

## 4. Other user-created lists

| # | Owner | Where | Entry shape | Count | Secrets | Edited | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | `device-manager` | `locations[]` (strings) + `locationZones` map + `locationIcons` map | a location IS its name string | 17 / 15 / 0 | - | Locations (`Locations.tsx`) | **G** `location` (`{ id, name, zone, icon, description }`). Today a rename rewrites every device row because the name is the key |
| U2 | `device-manager` | `siteZones` map | `{ label, icon }` | 4 | - | Locations → `SiteZonesPanel` | **G** `site-zone` (U1 references it by id) |
| U3 | `camera-grid` | `cameraGrids[]` (editable-array) | `{ id, name, enabled, cameraStableId, width, height, fps, cells[{ deviceId, source{x,y,w,h}, cell{x,y,w,h} }] }` | 1 | - | generic config form | **G** `camera-grid` (nested cells; each entry spawns a device, like C1) |
| U4 | `terminal` | `terminalInstances[]` | `{ id, cameraStableId, nodeId, profileId, profileLabel, name, enabled }` | 2 | - | System → Terminal | **G** `terminal-instance` (spawns a device) |
| U5 | `terminal` | `customProfiles[]` (editable-array) | `{ enabled, profileId, label, description, executable, … }` | not set on prod | - | generic form | **G** `terminal-profile` |
| U6 | `terminal` | `terminalCameraTombstones[]` | device stable ids | 5 | - | none | **O** (engine bookkeeping; a tombstone kind with TTL) |
| U7 | `osd-manager` | `this.state('namedTemplates')` | `{ id, name, bindings[{ alias, pick{ containerId, deviceId }, capName, valuePath, maxDecimals }], parser }` | 5 | - | OSD manager page | **G** `osd-template` |
| U8 | `osd-manager` | `boundDeviceIds` | number list | 4 | - | none | **S** (derived work index) |
| U9 | `model-studio` | `customModels[]` | `{ stepId, entry{ id, name, formats{…}, labels[41], classMap, group, … } }` | 1 | - (`plusCatalogPlusApiKey` separate, **M**) | Model Studio page | **O** `custom-model`: a large nested catalog document, validated by the model catalog, not a form |
| U10 | `pipeline-orchestrator` | per-device `zones[]` + `zoneRules` | `{ id, name, kind, polygon, color }` | 4 cameras | - | camera zone editor (polygons) | **S** (per-device config, D865). Device-scoped; a polygon editor is not a generic form |
| U11 | `device-manager` (recording onboard) | per-device `windows` (editable-array), `recorder.recordingConfig` | schedule windows | 32 cameras | - | camera recording settings | **S** (per-device, D865) |
| U12 | `device-manager` (security system device) | per-device `profiles[]`, `modeDelays[]`, `nonBlocking[]`, `secureOnArmOff[]` | `{ id, name, settings }`, `{ mode, exitDelaySec, entryDelaySec, … }`, `{ mode, deviceIds }` | 1 device | `navigationAccessCode` **M** | alarm device page | **S** (per-device, D865) |
| U13 | `device-manager` | per-device `_linkedDeviceIds`, `_linkedDeviceTrackedIds` | id lists | 18 / 3 | - | camera links (D356) | **S** |
| U14 | `notification-center` | `rules`, `rule-ai`, `summary-rules`, `timelapse-rules`, `calendar-events-rules`, `sequences`, `texts`, `snoozes` | rule documents | 19 / 0 / 1 / 3 / 1 / 0 / 1 / 0 | - | dedicated editors (rules, digests, timelapses, calendars) | **P** (R, phase 2/3), **O**: conditions, scopes and actions need their own editors and their own evaluator |
| U15 | `pipeline-analytics` | `scenes`, `identities`, `vehicles`, `retrain-collections`, `viewer-settings-snapshots` | operator-created documents | 0 / 6 / 0 / 3 / 1 | - | faces, plates, retrain, viewer | **P** (phase 2/5), **O** (each has samples / vectors / members) |
| U16 | system | `core_blocks` | `{ name, code, files, entry, settingsSchema, placement, … }` | 4 | - | Build → Scripts | **P** (R, phase 4), **O** (code documents, compiled) |
| U17 | system | `core-blocks:settings` + mirror `addon-settings core-block-<id>.*` | per-block values | 2 blocks | **`password` RAW in BOTH copies though the block schema says `password`. MISSED by D879** | Build → block settings (`ScriptSettingsPanel`) | **S**-like (per-block settings); must get the D870 secret tree like any addon store (and one copy, not two) |
| U18 | `google-services` | `calendarIds[]` | selected ids | 1 | - | Calendars | **S** (selection) |
| U19 | `benchmark` | `benchmarkHistory[]` | run results | 2 | - | Benchmark page | **O** (a ledger: R with `maxRows`, not an entry) |

## 5. Per-device and per-node maps inside addon blobs (not entries)

They look like lists but are keyed by an existing device or node and are written by the
system. None is a generic entry; most sit in tension with D865 ("per-device config lives
only in `ctx.settings.*DeviceStore`"):

| Owner | Key | Keyed by | Count | Verdict |
| --- | --- | --- | --- | --- |
| `export-alexa` | `exposed[]` `{ deviceId, exposedAt, settings }`, `exportedEndpoints`, `exportedSignatures`, `detectionClasses`, `accountVisibility` | device / account | 29 devices | **O** device-scoped `exposure` (D865 removal hook), one shape for every exporter |
| `export-hap` | `exposed[]` `{ deviceId, displayName, mapperKind, addedAt, childAccessoryUuids, settings }`, `exportSyncState` | device | 7 | same |
| `homeassistant-export` | `membership`, `exportTo:<broker>` | broker → device ids | 12 | same |
| `autotrack` | `cameras` | device | 1 | **S** → per-device store |
| `pipeline-orchestrator` | `cameraSettings` | device | 10 | **S** → per-device store |
| `stream-broker` | `deviceOverrides` | device | 7 | **S** → per-device store |
| `recorder` | `recordingPlacement` (`assignments`, `pins`, `volumeIds`, `defaultLocations`) | device:profile | 48 | **S** (one placement document; the planner reads it whole) |
| `device-manager` | `deviceBindings`, `field-claims-index`, `nextDeviceId`, backfill versions | device | 10 | engine state, **S** |
| `storage-orchestrator` | `storage-migration`, `storage-migration-history`, `storage-cleanup` (state) | job | 1 | **O** job record (R) |
| `detection-pipeline` | `_inferenceTimeoutLedger` | - | 1 | engine state |
| system-settings | `storage.locations` (paths), `providers` [] | - | 1 | **S** (runtime defaults, `bootstrap-config.ts`) |

## 6. What the generic entries UI would replace

Replaced outright (lists edited today by an `editable-array` in the generic config form or
by the `broker` cap's per-entry schema): C2-C4, C6 (Connectivity → Brokers), C7-C9 (MQTT
form), U3 (camera grids), U5 (terminal profiles), and the integration settings dialog (C1)
once it is the same component.

Replaced with a kind-specific add-on (a test button, an OAuth step, a catalog picker):
I1 OIDC providers (`OidcSettingsConnections.tsx`), C5 + I8 Google account (OAuth),
C13 Modal accounts (Providers dialog), C15/C16 notification targets
(`NotificationTargets.tsx`; test send), C17 LLM profiles (`AiProfileEditor`; test chat),
C18 waste sources (`WasteSettingsSources.tsx`; service catalog), U4 terminal instances
(`Terminal.tsx`), U7 OSD templates, U1/U2 locations and site zones (`Locations.tsx`,
`SiteZonesPanel`; these also need device assignment, which stays), N1 custom addresses
(the role ticks stay on the Addresses table), C22 backup schedules.

Not replaced: the identity tables (I2-I5: ceremonies, show-once tokens), NC rules and
pipeline-analytics documents (U14-U15), storage locations (C21), core blocks (U16), model
studio (U9), per-device configuration (U10-U13, section 5).

## 7. Recommended order of the findings (fix plan)

1. **C10 now, by hand** (no records needed): confirm `int_0009` resolves its password
   (the integration works), then delete `addon-settings` `provider-dreame.brokers`
   (and C11, C12, C14, N3 in the same pass) through `settingsStore.delete`, operator-run,
   counts first. Add these rows to D879 as "found raw in the DB, not in code" and note
   that the guard cannot see orphaned rows: a live check (`settingsStore.query` of
   addon-settings with a shape-only filter, as in this census) belongs in the records
   adoption dry run.
2. **U17 before records**: give `BlockSettingsStore` the secret tree of the block's
   `settingsSchema` (the D870 path every addon already has), drop the double copy
   (block values vs the addon-settings mirror), move the existing value with a verified
   operator migration (D878 shape). Add a `core-blocks` row to `RAW_UNTIL_RECORDS` if it
   waits.
3. **C18**: type `argsJson` per catalog service (the catalog already lists the fields) so
   a `password` / `api_key` argument is a declared secret; until then, a census row.
4. **Records phase 3**: fold C2-C4, C6 into the integration entry (C1) instead of
   migrating `brokers[]` as its own kind: the FK already exists both ways, and the
   integration already stores secrets as markers.
5. The generic `entry` kind = C1 generalised: `{ owner, kind, id, name, enabled, data }`
   with a Zod schema per kind, `.meta({ secret: true })` fields → markers (D879 design),
   an optional `spawnsDevice` flag (C1, U3, U4), and one admin component.
