# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The log ring refuses debug lines unless that device is being watched.
- HTTPS on or off is now the Serve HTTPS setting in Network > Local access (on by default, applies after a restart); CAMSTACK_TLS_ENABLED and the config.yaml keys mode, hub, agent, auth, tls and bootstrap.settingsStoreAddon/forceDisable are no longer read
- The crash breaker retries a runner it parked as failed once when the package version it hosts changes (one retry per new version)
- A washer or dryer helper with a power plug is restartable through the power-source link of its composed device
- local-auth answers userManagement.getAdminBootstrapStatus from the stored password hashes
- Customizing a device with an optional reading (power, energy) no longer fails validation; the composed reading is omitted when its source is lost
- device-history now records appliance runs (start, finish, energy) and survives restarts.
- Core blocks keeps a durable timed-run deadline per device, so a heater or pump left running is switched off even after a restart.
- The hub RSS budget can be set per node and wins over CAMSTACK_HUB_RSS_BUDGET_MB
- Node settings rows now carry their node id, forgetting a node removes its settings in one step, and a device's fleet-default settings resolve in one place for the hub and the runners
- Addon migrations of a grouped addon (Home Assistant export, Google export) are no longer refused at boot: the engine accepts the runner that hosts the owner, like the keychain
- The migration engine now accepts a grouped addon's catalogue from the runner that hosts it, read from the installed manifests, so Home Assistant export and Google export migrations are no longer refused at every boot
- A linked camera's still is no longer rejected as stale after a slow capture: the snapshot capture time is now when the frame arrived, not when the capture was queued
- Loki logging has a per-instance on/off switch on its destinations record; a Loki switched off at the old registry toggle is carried over to it
- Loki logging no longer switches itself off at boot: the retired enabled flag is only removed, and the registry-toggle migration now runs after registration under the right addon id
- Integration rows are keyed by the bare addon id (rows saved as addon:<id> are rewritten on boot), a tolerated migration failure raises a warning instead of a critical alert, and the camera grid asks for its own devices under the right id
- A migration converts stored pet-fountain core blocks to the split pump-cycle composition
- An addon blocked by its own migrations no longer takes the other addons of its runner down; it is logged as blocked and skipped, and a runner where nothing could start is parked as refused instead of crash-looping.
- An addon in a shared runner group (such as Cloudflare TURN in net-access) can save a secret field of its records, on the hub and on an agent: a record kind and its secret refs are always owned by the addon id, the hub or agent verifies which addon a grouped runner acts for, and a migration re-owns kinds an earlier build declared under the group id
- The records-owner migration no longer stops on a kind declared under both the group and the addon: when only one side holds rows the empty one is discarded, both empty keeps the addon's, and rows on both sides fail naming each side's row count and newest update
- A record kind that exists under both a runner group and its addon with rows on both now keeps the newer side and parks the older one as <kind>~superseded-<owner>, instead of failing the owner migration.
- An infrared TV is a real media player: plug power truth, volume and channel steps sent as repeated trains 150 ms apart, and a typed error for a button the remote lacks
- The LAN access settings (HTTP, HTTPS, mDNS, passive discovery, local hostname) are per-node settings, copied from the existing values
- Existing washer, dryer and heater helper devices are converted at boot to plain Customize running, power and power-source settings, keeping their threshold, dwell times and plugs.
- Appliance and heater helper compositions are no longer compiled; stored ones were already rewritten into Customize facets by the helper-to-customize migration.
- The snapshot wrapper logs, at info and on the camera, when a failed capture is answered with the cached frame
- A composed device (a dryer, washer or heater) now resumes its last running state after a hub restart instead of reporting unknown, so a cycle that ends right after a restart still notifies
- core-blocks can propose a running threshold and dwells from a device's own power history (read-only)
- Loki log destinations can now be several: every enabled destination receives the logs
- The sqlite registry can clear an integration's legacy settings rows and answer the keychain refs they held, for the rows-to-record migration
- Local network names its node-settings capability up front, so its per-node values resolve at boot.
- Alert center settings are declared on the cluster hook; the form and stored values are unchanged.
- Console logging level is declared on the cluster hook; the form and stored value are unchanged.
- Snapshot stale TTL is declared on the cluster hook; the form and stored value are unchanged.
- Device history retention settings are declared on the cluster hook; the form and stored values are unchanged.
- Native metrics sampling settings are declared on the cluster hook; the form and stored values are unchanged.
- Local network settings are declared only on the per-node settings hook; the form and stored values are unchanged.
- Adding or creating a device passes the integration it belongs to on to the provider.
- Migrations: the hub answers the migration API version on declareOwner and the facade over records, settings, secrets and legacy rows is built into every addon context
- Crash and refusal alerts name the core block or addon, and the crash-loop alert includes the last error.
- A composed pet fountain serves its tank as a Water consumable even without a maintenance entity
- A stored pet-fountain composition loses the drink counters and the Clear daily count forward on the next start
- The migration API reports each integration's stored switch so a disabled integration stays disabled
- A waited action call (an automation step) now lasts as long as the run instead of failing after 60 seconds; a run over 60 minutes is stopped and reported timed-out.
- Cap calls from forked addons now honour each method's declared timeout instead of a flat 60 s; the three bounds under 60 s are terminal-session.pullOutput (15 s), audio-analyzer.classify (30 s) and training-provider.validateCredentials (30 s).
- The media-player remote status carries positionUpdatedAt (null).
- Legacy integrations and storage_locations tables are dropped once their records hold the data
- Storage locations are now integration instances: the location form picks a provider, its credentials are kept per location in the keychain, and an existing location's credentials are moved over on start.
- Storage locations are managed only as instances: the storage upsert, delete, test and provider-list calls are gone; the instance form no longer carries the state, which the Storage page owns
- Log destination settings are per-node (existing values copied to every node on first boot); core-blocks settings are cluster scope
- Log level and retention are per-node settings: existing values are copied to every node known at upgrade, and a node that joins later starts at the default level and retention, not the old cluster-wide value
- Internal: autotrack and remote-access state is read and written through the typed state API under the same storage key; nothing changes for the operator.
- Camera grids are now instances on a Camera grids page: the list is kept as records, migrated in place with the same ids and cameras
- The addon-call plane carries listScopedSettings to forked addons.
- The quick-run length of a timed-run device (heater, pet fountain) is a per-device setting instead of a fixed 30 minutes
- A forked addon call for the deleted global settings methods is refused by name, and the addon service no longer exposes them.
- Device aliases (generated once, editable, unique) and a sandboxed device value-template renderer (nunjucks in a budgeted worker thread); the state mirror no longer mixes two addons that share a stable id
- A device owned by a forked worker now reports its alias in getDevice and listAll
- A settings call to an addon id its runner does not host now names the addons that runner does host, instead of a bare 'not loaded on this node'
- core-blocks now provides the read-only hero-layout capability, serving the device hero model
- The remote runs declared sources under a per-device lock with a bounded wait, resolves a source by name or channel number and refuses undeclared channels
- Hero layout provider serves the list rows of many devices in one call (getRowModels)
- Climate and water-heater runtime state keeps the last non-off mode on every provider write, so power-on can return to it
- Climate and water-heater power-on now remembers the last mode the device ran across a hub restart; the other readings are still re-read from the device.
- Fixed built-in integrations are seeded through integrationInstances.createInstance instead of integrations.create
- Storage locations are stamped with their mode and the retired default flag removed by a one-time migration, not at every boot
- A storage type with no enabled location is repaired at every boot, not only by the one-time migration

### Removed

- Drop the legacy integration settings table once every owning addon's copy migration is applied

### Fixed

- Releasing a device from an integration now removes its child devices too; before, the parents went and their children stayed behind pointing at a deleted device.
- Addon runners no longer load the full schema bundle for the debug watch
- The network scan now finds mDNS devices on another VLAN: it joins the mDNS group on each link and asks as multicast, so an answer reflected by the router is heard.
- A call from an addon to a system-only method of a device capability (such as the snapshot state read) now reaches the capability's own wrapper instead of the camera's driver
- Restoring a device no longer reports that a control is already registered when a second reconcile starts before the first has finished.
- Notification text times no longer fail under a container with an empty TZ; they fall back to UTC
- Fix: a grouped addon's migrations (Home Assistant export) are no longer refused when they read the legacy rows of their sibling provider; the integrations runner starts again
- Selecting a remote source that is an infrared code sends it through its transmitter once and remembers it as the current source.

## [1.2.537] - 2026-11-01

### Changed

- The migration engine runs addon-owned catalogues and applies plan edits inside the per-migration transaction
- The hub's extra browser origins are now the Allowed browser origins setting under System > Settings > Authentication, applied on the next request without a restart; server.corsOrigins in config.yaml and CAMSTACK_CORS_ORIGINS are no longer read and are named in the boot log
- Login sessions record the new cli-approval sign-in method.

## [1.2.536] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.535] - 2026-10-31

### Changed

- Hub databases now migrate at boot under one ledger, with a safety snapshot before the first change, a rollback on failure and an Alert Center card with a Retry button

## [1.2.534] - 2026-10-31

### Added

- A device can be powered by a smart switch linked in Customize, with manual power on, power off and force restart (switch off, wait, switch on).

## [1.2.533] - 2026-10-31

### Changed

- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.532] - 2026-10-31

### Changed

- Network discovery no longer offers a device that already has its own integration
- A lock linked to a door contact refuses lock() while the door is open, naming the sensor; the device-call redirect now composes the remote and the lock gate.

## [1.2.531] - 2026-10-31

### Changed

- Schedulers run in the hub: one timer for every point, holds that keep a device state true until the next point, priorities between schedulers, and every outcome on the runs ledger

## [1.2.530] - 2026-10-31

### Changed

- Actions resolve a device-domain target when a step runs, and stored actions are rewritten to the target shape once at start

## [1.2.529] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.528] - 2026-10-31

### Changed

- The addon convergence dry-run switch is readable on a hub with an isolated settings engine.

## [1.2.527] - 2026-10-31

### Changed

- Cluster node history keeps per-node package tombstones so a removed addon stays off that node

## [1.2.526] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.525] - 2026-10-30

### Added

- One network scan for all providers: the local-network engine runs every provider's discovery once, and extra subnets can be saved to scan other VLANs

### Changed

- Network scan resends the multicast query three times over about 4.5 s and logs hits per subnet, so Wi-Fi boards that miss one query are found
- Hub: a stale-data audit finds record kinds and settings keys an addon no longer declares, read-only, with an operator-triggered cleanup

## [1.2.524] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.523] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.522] - 2026-10-29

### Changed

- The remote template editor's component palette is served by core-blocks through the new remote-layout-components capability

## [1.2.521] - 2026-10-29

### Changed

- Saving an internal Action converts a quantity argument entered in another unit (0.1 kg for a feed in grams) and reports a bare number as a warning

## [1.2.520] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.519] - 2026-10-29

### Changed

- Memory reclaim judges anonymous resident memory on Linux, and telemetry nobody listens to (including broker messages) no longer reaches a child process

## [1.2.518] - 2026-10-29

### Added

- macOS nodes report memory the way Activity Monitor does (app + wired + compressed) instead of total minus free pages
- A built composed device serves its methods by forwarding them to a source device, and a consumable item can reset through a forwarded button
- The pet-fountain capability reaches the kernel through the generated types
- Linux memory comes from MemAvailable; a failed memory read is reported as unknown instead of a made-up percentage

### Changed

- Memory reclaim now judges the stranded memory by anonymous resident pages on Linux, so file-backed SQLite mappings no longer trigger useless reclaim passes
- Heap-watch exports the agent-main label used by the agent root heartbeat
- A forked addon runner no longer sends high-frequency telemetry (pipeline traces, metrics snapshots) to the hub when nothing there listens, cutting event traffic
- The hub and agent boot line says who chose the heap ceiling (override, legacy env, computed or V8 default)
- The broker state mirror (broker.message) is no longer kept in the recent-events ring, so it stops evicting other events; live subscribers are unaffected

## [1.2.517] - 2026-10-29

### Added

- The Actions list answers at once when no addon provides actions, instead of waiting about 30 seconds.

### Changed

- deviceManager.updateConfig now refuses a key the device config does not own instead of answering success without writing
- Forgetting a cluster node records a durable tombstone so node-scoped data is cleaned up even if an owner was down
- A revoked mesh peer is refused and logged once per window, and the hub answers a signed membership query so a forgotten agent can reset itself.

## [1.2.516] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.515] - 2026-10-29

### Changed

- SmartIR code import, remote command engine and an assumed-state media player for infrared appliances
- Remote and templates are served by core-blocks; a device-call redirect gives a bound remote command precedence over the native media-player cap for every caller

## [1.2.514] - 2026-10-28

### Changed

- An agent tells its display name in its mDNS record and pairing hello

## [1.2.513] - 2026-10-28

### Changed

- The agent pairing status tells the local view whether a pairing lockout is in force

## [1.2.512] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.511] - 2026-10-28

### Fixed

- Pairing: the agent reveals its own code only after local confirmation; the confirm answer carries it

## [1.2.510] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Added the ir-transmitter capability and its error texts.

## [1.2.509] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.508] - 2026-10-28

### Changed

- The hub's registration ack now carries the hub's server version so agents can align to it.

## [1.2.507] - 2026-10-28

### Fixed

- An agent advertises itself on the network again, so the hub lists a new agent for pairing without typing its address

## [1.2.506] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.505] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.504] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.503] - 2026-10-28

### Changed

- A Hugging Face outage seen by model downloads now raises a critical alert on the hub and resolves it on the next successful download

## [1.2.502] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.501] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.500] - 2026-10-27

### Fixed

- Creating, editing and running an Action no longer fails with an internal error

## [1.2.499] - 2026-10-27

### Added

- Core blocks serve Actions: camera-linked permissions, run traces and automation cooldown now live in the hub runs ledger

### Fixed

- Creating, editing and running an Action no longer fails with an internal error

## [1.2.498] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.497] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

## [1.2.496] - 2026-10-27

### Added

- CamStack System: Core addon for CamStack — builtins, pipeline, process management, auth, logging, events.
- Provides the addons Filesystem Storage, SQLite Settings, Winston Logging, Console Logging, Loki Logging, Hub Log Forwarder, Backup Orchestrator, Storage Orchestrator, Keychain, Record Entries, Native Metrics, Device History, Snapshot, PTZ Autotrack (emulated), Alert Center, Liveness Monitor, System Config, Calendars, Addon Pages Aggregator, Addon Widgets Aggregator, Device Manager, Local Auth, Platform Probe (Native), Local Network, Remote Access Orchestrator, Core Blocks, Composer, Camera Grids.
