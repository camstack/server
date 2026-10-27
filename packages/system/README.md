# CamStack System

Core addon for CamStack — builtins, pipeline, process management, auth, logging, events.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/system` on npm.

## What it provides

- **Filesystem Storage** (`filesystem-storage`): Category: system.
  - Capabilities: `storage-provider`, `filesystem-browse`.
- **SQLite Settings** (`sqlite-settings`): The relational ENGINE behind the data door (SQLite WAL). Registers `data-store-provider`, an internal collection cap; the public `settings-store` door is owned by `storage-orchestrator`, which dispatches here. Callers never reach this addon directly — that is what makes the engine replaceable. It ALSO registers `vector-store` (sqlite-vec) from the same database file and the same open handle, `storage-admin` (list tables, drop one nothing owns) and `database-snapshot`: the verified copy of its database that the nightly backup archives in place of the live files, written by this runner on a thread over its own connection. Runs in its OWN process (`execution.isolate`) — `better-sqlite3` `Statement.run` does not belong on the event loop that serves the API. Category: system.
  - Capabilities: `data-store-provider`, `vector-store`, `database-snapshot`, `storage-admin`, `records`.
- **Winston Logging** (`winston-logging`): Category: system.
  - Capabilities: `log-destination`.
- **Console Logging** (`console-logging`): Category: system.
  - Capabilities: `log-destination`.
- **Loki Logging** (`loki-logging`): Opt-in log destination — batches this node's log entries and pushes them to a Grafana Loki instance via /loki/api/v1/push. Registered always, inert until enabled with a URL. Category: system.
  - Capabilities: `log-destination`.
- **Hub Log Forwarder** (`hub-forwarder`): Agent-only log destination — forwards every log entry to the hub via the cluster broker. Never runs on the hub itself (the hub already owns the log-receiver, registering hub-forwarder there would create a write→ingest→write feedback loop). Category: system.
  - Capabilities: `log-destination`.
- **Backup Orchestrator** (`backup-orchestrator`): System singleton that owns the schedule, builds the archive once, and fans it out to every enabled `backup-destination` provider (local, S3, rsync, …). In-process on hub root — aggregator over a cluster collection, no native deps. Category: system.
  - Capabilities: `backup`.
- **Storage Orchestrator** (`storage-orchestrator`): The single data door. Owns the consumer-facing `storage` cap for bytes — the `locationId → StorageLocation` map, `StorageLocationRef` resolution, dispatch to the matching `storage-provider` registrant (`filesystem-storage` today; SFTP / S3 / WebDAV plug in alongside) — AND the `settings-store` cap for rows, dispatching to the `data-store-provider` engine (`sqlite-settings` today; a vector engine plugs in alongside). Nothing reaches an engine except through this addon. Category: system.
  - Capabilities: `storage`, `storage-migration`, `settings-store`.
- **Keychain** (`keychain`): Hub-only store of every secret value. Settings blobs hold a marker; the value lives here, AES-256-GCM under a data key wrapped by a master key whose location is configuration (config.yaml `keychain.keyFile`, the desktop OS keychain, else the data-dir default). Registers `keychain` (internal, owner-checked against the transport-stamped caller) and `keychain-admin` (System → Secrets). Boots in the infrastructure pass, right after the settings door. Category: system.
  - Capabilities: `keychain`, `keychain-admin`.
- **Record Entries** (`record-entries`): The ONE admin surface for every list of user-created entries (notification targets, brokers, LLM profiles): any addon declares an entry kind with `defineEntryKind` and the entries UI lists, adds, edits and deletes it, with password fields derived from the schema (`.meta({ secret: true })`). Holds no data of its own: it acts for each entry's owner on the records door and the keychain, in-process on the hub. Category: system.
  - Capabilities: `record-entries`.
- **Native Metrics** (`metrics-native`): Category: system.
  - Capabilities: `metrics-provider`.
- **Device History** (`device-history`): Records numeric history of device values (capability history blocks and producer-declared series) with 5m/1h/1d rollups and retention. Category: system.
  - Capabilities: `device-removal-hook`, `device-history`.
- **Snapshot** (`snapshot`): Owns every camera's latest frame: the capture ladder (vendor native → ffmpeg keyframe grab off the stream-broker restream), the sharp resize, the courtesy frame for a camera that cannot answer, and the two HTTP planes the clients actually fetch bytes from. Runs in its OWN process (`execution.isolate`) — capture, transcode and byte caches do not belong on the event loop that serves the API. Category: system.
  - Capabilities: `snapshot`.
- **PTZ Autotrack (emulated)** (`autotrack`): Wrapper over the `ptz-autotrack` cap — follows a subject with self-terminating `ptz.move` pulses on cameras whose firmware has no autotrack, driven by the detection pipeline's tracked boxes. The operator binds it per camera, then uses the SAME autotrack switch a native camera has: the binding chooses the implementation, never a second toggle. It refuses to move without a readable `moveImpulseMs`, and while a firmware autotrack on the same camera reports armed. Runs IN-PROCESS: it spawns nothing, carries no frames and issues a command every few seconds at most. Category: system.
  - Capabilities: `ptz-autotrack`.
- **Alert Center** (`alert-center`): Category: system.
  - Capabilities: `alerts`.
- **Liveness Monitor** (`liveness-monitor`): Asserts that this node is actually working — it has devices, its cameras are online, and a camera that was recording has not silently stopped. Raises one persistent alert per fault and dismisses it on recovery. Exists because the hub once ran four hours with no devices and no recordings while every surface stayed quiet. Category: system.
- **System Config** (`system-config`): Exposes the cluster-wide yml-backed configuration sections (server, auth) via the three-level settings API. Hub-only. Category: system.
- **Calendars** (`calendars`): Hub-only singleton that aggregates `calendar-source` providers (Home Assistant and future addon sources) and exposes listCalendars / listEvents / importFromHomeAssistant. Category: system.
  - Capabilities: `calendars`.
- **Addon Pages Aggregator** (`addon-pages-aggregator`): Hub-only singleton that aggregates `addon-pages-source` (collection) providers and emits the public `addon-pages.listPages` surface with versioned bundleUrls. Category: system.
  - Capabilities: `addon-pages`.
- **Addon Widgets Aggregator** (`addon-widgets-aggregator`): Hub-only singleton that aggregates `addon-widgets-source` (collection) providers and emits the public `addon-widgets.listWidgets` surface with versioned bundleUrls. Category: system.
  - Capabilities: `addon-widgets`.
- **Device Manager** (`device-manager`): Hub-side singleton that unifies device persistence and management. Uses ctx.settings for storage — no direct SQLite access. Replaces device-persistence cap (Phase 2 will delete device-persistence once all consumers are migrated). Category: system.
  - Capabilities: `device-manager`, `device-state`, `device-extension`.
- **Local Auth** (`local-auth`): Built-in local username/password authentication. Implements the auth-provider capability as the default login path. OIDC and other providers can register alongside via the same capability. Category: system.
  - Capabilities: `auth-provider`, `user-management`, `device-credentials`.
- **Platform Probe (Native)** (`platform-probe`): Probes hardware and inference runtimes on the local node. Registers the `platform-probe` capability consumed by every inference addon on this node. Category: system.
  - Capabilities: `platform-probe`.
- **Local Network** (`local-network`): Enumerates the hub's network interfaces, classifies them (LAN / Wi-Fi / Docker / VPN / loopback), and ranks connection-endpoints for SDK clients. Hub-only — agents are not directly addressable. Category: system.
  - Capabilities: `local-network`.
- **Remote Access Orchestrator** (`remote-access-orchestrator`): Hub-only singleton facade over the network-access collection (Cloudflare Tunnel, ngrok, …). Surfaces a unified provider list to the admin UI's Remote Access page. Category: system.
  - Capabilities: `remote-access`.
- **Core Blocks** (`core-blocks`): Store and type-check user-authored TypeScript that owns devices with an addon's own ctx. Admin-only: a block is a plugin with no review step, so it is process-isolated when it runs. This slice stores and serves; execution is the runner. Category: system.
  - Capabilities: `core-blocks`.
- **Composer** (`composer`): Runs every DECLARATIVE composition (a core block whose source is `composition`): declares the composed device under the shared Blocks integration, registers its caps natively, and derives each field from other devices' state by `from` / expression — event-driven, no polling. Hub-only. Runs in its OWN runner (`execution.isolate` + `group: composer`): frame-free and low-crash, grouped with no device provider or data plane. Category: system.
  - Capabilities: `composer`.
- **Camera Grids** (`camera-grid`): Composite cameras: several cameras composed into one fixed picture and emitted as an ordinary camera — recorded, played back and bound like any other. The composition runs only while something is consuming it; object detection is switched off on a new grid because the cameras it is composed from are already analysed. Runs in its OWN process (`execution.isolate`): it spawns an ffmpeg per live composition and relays its bytes, and neither belongs on the event loop that serves the API. Category: system.
  - Capabilities: `camera-grid-layout`, `motion`.

## Requirements

- Filesystem Storage: default placement.
- SQLite Settings: default placement.
- Winston Logging: default placement.
- Console Logging: default placement.
- Loki Logging: default placement.
- Hub Log Forwarder: agent-only.
- Backup Orchestrator: default placement.
- Storage Orchestrator: default placement.
- Keychain: default placement.
- Record Entries: hub-only.
- Native Metrics: default placement.
- Device History: hub-only.
- Snapshot: default placement.
- PTZ Autotrack (emulated): default placement.
- Alert Center: default placement.
- Liveness Monitor: default placement.
- System Config: default placement.
- Calendars: default placement.
- Addon Pages Aggregator: default placement.
- Addon Widgets Aggregator: default placement.
- Device Manager: default placement.
- Local Auth: default placement.
- Platform Probe (Native): any-node.
- Local Network: default placement.
- Remote Access Orchestrator: default placement.
- Core Blocks: default placement.
- Composer: hub-only (runner group `composer`).
- Camera Grids: default placement.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/transport.md](https://github.com/camstack/server/blob/main/docs/architecture/transport.md)
- [docs/architecture/addon-lifecycle.md](https://github.com/camstack/server/blob/main/docs/architecture/addon-lifecycle.md)
- [docs/architecture/secrets-keychain.md](https://github.com/camstack/server/blob/main/docs/architecture/secrets-keychain.md)
- [docs/architecture/storage-files.md](https://github.com/camstack/server/blob/main/docs/architecture/storage-files.md)
- [packages/system/AGENTS.md](https://github.com/camstack/server/blob/main/packages/system/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
