# Rename layer 2 — what `dominevo.ts` leaves on purpose

Layer 1 (`scripts/rename/dominevo.ts`) renames what a person or the package
manager sees. Layer 2 is everything **persisted, or on the wire between running
nodes**: renaming one of these is a coordinated change across a live cluster
(data migration, or all nodes flipping at once), so it is inventoried here and
not rewritten. Counts are what remains after the codemod; run
`npx tsx scripts/rename/dominevo.ts --dry-run` to see them again.

| Identifier | Where it lives | Persisted / on the wire where | Proposed new name | Count |
| --- | --- | --- | --- | --- |
| `CAMSTACK_*` env vars (`CAMSTACK_ROLE`, `CAMSTACK_DATA`, `CAMSTACK_RUNNER_ID`, `CAMSTACK_PARENT_NODE_ID` …) | server, system, agent, desktop, Dockerfile, CI | container contract (Unraid templates, Proxmox script, Compose), runner fork env | `DOMINEVO_*` | 1927 |
| `camstack.db`, `camstack.crt`, `camstack.key`, `camstack-ca.crt` | storage, tls | SQLite file on every hub, issued certificate files | `dominevo.*` | 314 |
| `~/.camstack`, `.camstack-location`, `/opt/camstack-hub`, `camstack-data`, `/run/secrets/camstack-master-key` | CLI session, agent, Docker | CLI login session, install dirs, mounted secrets | `~/.dominevo`, … | 195 |
| Data dir / Electron `userData` | desktop `productName` (layer 1 renames it) | `~/Library/Application Support/CamStack` etc.: the desktop data moves with the product name | migrate or accept a fresh install | n/a |
| Addon ids = package names (`@camstack/addon-*` → `@dominevo/addon-*`) | everywhere (layer 1 renames the scope) | addon ids key the settings store (`<addonId>:addon-devices`), bindings, `<dataDir>/addons/@camstack/<addon>` | follows the scope; existing data of a node is NOT migrated | all |
| Event topics `camstack.evt.*` | `kernel/moleculer/event-bus.ts` (`EVENT_TOPIC_PREFIX`) | Moleculer events between nodes | `dominevo.evt.*` | 88 |
| Moleculer service names / node ids `camstack-hub`, `camstack-agent` | kernel, agent | mesh transport between nodes | `dominevo-hub`, `dominevo-agent` | ~55 files |
| Mesh certificate subjects `CamStack Local CA`, `Mesh CA`, `Device CA`, `/O=CamStack` | `system/src/tls`, mesh, bosch | issued certificates, trust stores (protected token in the codemod) | `Dominevo …` with a re-issue | 20 |
| HTTP headers `X-CamStack-Ingress`, `X-CamStack-Broker`, `x-camstack-reason(-code)`, `x-camstack-lang`, `x-camstack-share-devices`, `x-camstack-disposition` | Alexa Lambda, hub HTTP, tRPC client | wire between the deployed Lambda / viewer and the hub (protected token) | `x-dominevo-*`, all peers together | 181 |
| Cookie and storage keys `camstack_session`, `camstack_admin_token`, `camstack_admin_refresh`, `camstack_sso_state`, `camstack_app_confirm` … | auth, admin-ui, viewer | signed-in browsers and apps | `dominevo_*` (forces a re-login) | 261 |
| `package.json` `camstack` manifest key (`camstack.addons`, `.requires`, `.runtimeDependencies`, `.nativeDependencies`) | read in ~25 places (loader, CLI, guards, CI scripts, UI) | every published addon tarball | `dominevo` — not one loader, so not done here | 105 |
| URL scheme `camstack://`, `camstack.dev://` | viewer app, auth callback, enroll QR | installed apps; the hub now EMITS `dominevo://` and still ACCEPTS `camstack://` | retire `camstack://` when the old app is gone | 140 |
| `/viewer/camstack/` mount, `/api/camstack/p/`, `/camstack` | hub static + AASA component | bookmarks, universal links, app-site association | `/viewer/dominevo/` | 97 |
| mDNS type `_camstack._tcp` | discovery | LAN advertisements | `_dominevo._tcp` | 18 |
| SQLite tables / collections owned `camstack*` | storage declarations | the live DB | per owner | see `docs/reference/storage.md` |
| Keychain owners and `secret://` markers | `camstack-secrets` | the keychain on every node | unchanged names; owners are addon ids (follow the scope) | n/a |
| Bundle ids `com.apocaliss92.camstack(.dev)`, `com.camstack.app` (desktop `appId`) | AASA, assetlinks, electron-builder | app stores, OS install identity | `app.dominevo.*` (AASA already lists `app.dominevo.viewer`) | 20 |
| External domains `camstack.zentik.app`, `camstack-docs.zentik.app` | notification app link, docs links | DNS owned outside the repo | `dominevo.*` once registered | 165 |
| Hugging Face org `camstack/camstack-models`, `camstack-trainer`, `camstack-bench-clips`, `hf/camstack-models` | model catalog, trainer | model downloads | DONE 2026-11-28: `Dominevo/dominevo-models`, `Dominevo/dominevo-trainer`, `Dominevo/dominevo-bench-clips`, `hf/dominevo-*` | 180 |
| Tooling names: `.claude/skills/camstack-*`, MCP `camstack-dev` / `camstack-ops`, `camstack-skills-pointer` markers, git submodule path `camstack/` | `.claude`, `.cursor`, `.gitmodules` | operator tooling and the viewer submodule path | follow the viewer repo rename | many |
| Code identifiers `ICamstackAddon`, `CamstackError`, `__camstackTypes`, `mapHaEntityToCamStack` … | `types`, `sdk`, `system`, MF globals | the SDK API of third-party addons; module-federation globals between host and remote pages | `IDominevoAddon`, … in a separate API-breaking pass | ~400 |
| Docker local tags `camstack-server:<tag>` | build scripts | local images | `dominevo-server` | 12 |
