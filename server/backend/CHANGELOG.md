# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.770] - 2026-11-05

### Removed

- The hub no longer keeps a second settings store: create writes the instance record, and settings with no instance provider are dropped

## [1.2.769] - 2026-11-05

### Changed

- A finished appliance cycle's duration excludes the stop delay, and a short pulse after a cycle no longer extends it

### Fixed

- An agent-offline alert resolves when that agent is back online, and a system-restarting alert resolves when the restart completed or the node is back, even if the online event was dropped

## [1.2.768] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.767] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.766] - 2026-11-04

### Changed

- Reading the settings of a legacy integration row no instance record answers for now returns the row instead of an empty object.

## [1.2.765] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.764] - 2026-11-04

### Changed

- The hub can clear one integration's legacy settings rows and their keychain values for the addon that migrated them
- Clearing an integration's legacy rows deletes its keychain values first, so a failed delete is retried

## [1.2.763] - 2026-11-04

### Changed

- The migration ledger no longer shows an applied migration of a not-yet-loaded addon as skipped-newer, and no longer raises a false 'Database is newer' alert; the 'Runners degraded' alert resolves itself once the failed runners are running again

## [1.2.762] - 2026-11-04

### Changed

- Integrations page, wizard discovery word and test button follow what an addon's integration-instances provider describes (role, discovery)

## [1.2.761] - 2026-11-04

### Added

- The Alerts panel now warns, with a link to the Storage page, when a storage type an addon needs has no writable location (for example event media: no thumbnails or track photos are saved), and clears itself once one exists

### Changed

- device-export calls name their instance (listInstances; writes require instanceId) and broker connections are integration instances

### Fixed

- A boot where some addons fail to load no longer deletes the default storage locations of the types those addons declare (event media, recordings, artifacts); the failure is logged and the default is kept
- A hub whose storage defaults were removed by a failed addon load gets them back on the next boot, once every addon declaring a storage type is readable

## [1.2.759] - 2026-11-04

### Changed

- The Add flow of a connection list now offers a kind picker, sign-in or connect, a status label and restore under the old id when the provider supports them

## [1.2.758] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.757] - 2026-11-03

### Changed

- The data-plane gate writes the authenticated caller's username into x-camstack-user (client-supplied value dropped)

## [1.2.756] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.755] - 2026-11-03

### Changed

- Log destination reads can name the Loki destination to read from (several Loki destinations)

## [1.2.754] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.753] - 2026-11-03

### Changed

- The running-threshold proposal is reachable as a core-blocks query (admin, view access)

### Fixed

- An in-process addon's call to a system-only capability method no longer routes to the camera's driver by its device id

## [1.2.752] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.751] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.750] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.749] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.748] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.747] - 2026-11-03

### Changed

- The media-player routes include power and volume/channel steps

## [1.2.746] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.745] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.744] - 2026-11-02

### Changed

- An agent now verifies which addon a shared runner acts for, so a grouped addon's records and secrets are owned by the addon on agents too

## [1.2.743] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.742] - 2026-11-02

### Changed

- Integrations page lists an addon by its declared integrationRole; a dual entry (devices and service instances) is no longer hidden
- Generated capability routers include the pump-cycle capability

## [1.2.741] - 2026-11-02

### Changed

- The integration-instances capability gains setInstanceEnabled and an enabled field in every instance view

## [1.2.740] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.739] - 2026-11-02

### Changed

- Loki is configured on the Logging page again and no longer listed among integrations
- The generated smtp-provider router accepts an optional instanceId to address one SMTP relay

## [1.2.738] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.737] - 2026-11-02

### Fixed

- The Loki settings migration removes the moved keys from the table they are stored in, so Loki starts again after the update

## [1.2.736] - 2026-11-02

### Changed

- The Integrations page lists connection-only addons (a Loki connection) as integrations backed by a record

## [1.2.735] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.734] - 2026-11-02

### Changed

- Forgetting a cluster node now also removes the settings rows stored for that node

## [1.2.733] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.732] - 2026-11-02

### Changed

- New devices on the network are proposed on the Integrations page without a manual scan, and dismissed proposals stay dismissed across restarts
- The hub holds debug watches and pushes the interest to every node; a debug channel cannot be armed from the Levels page.

## [1.2.731] - 2026-11-02

### Changed

- Serves the new do-not-disturb capability for Echo devices.
- AI generate calls accept a per-call reasoning effort
- Heap ceiling and the hub RSS budget are now set per node under Cluster > node > General; CAMSTACK_HUB_HEAP_MB, CAMSTACK_AGENT_HEAP_MB and the retired secret and CORS variables are ignored, and only the heap ones are named in the boot log

## [1.2.730] - 2026-11-01

### Added

- Serves the new fan-presets and timed-run capabilities (fan speed presets, heater and pump timed runs).

### Changed

- The API gains the timed-run methods (run for, cancel, status).

## [1.2.729] - 2026-11-01

### Changed

- config.yaml bootstrap.requiredAddons is ignored (with a warning); the first-boot addon set always comes from the server package
- Addons now always install from npm: the bootstrap.installSource key and the CAMSTACK_INSTALL_SOURCE variable are gone (a config.yaml still carrying the key boots with one warning); a workspace build reaches a node through camstack deploy.
- The external keychain master key is read from the fixed path /run/secrets/camstack-master-key (and .previous to rotate) — keychain.keyFile and keychain.previousKeyFile in config.yaml are retired and only log a warning
- Generated capability routers include device-runs.

## [1.2.728] - 2026-11-01

### Changed

- The hub serves userManagement.getAdminBootstrapStatus (admin-only: is the first-boot admin password still in use)

## [1.2.727] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.726] - 2026-11-01

### Changed

- Customize can now replace a device's native running state with an assigned source

## [1.2.725] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.724] - 2026-11-01

### Changed

- Pin werift to 0.22.9 in the server closure so a newer peer range cannot hoist a version the shipped patch does not apply to (fixes refused server updates)

## [1.2.723] - 2026-11-01

### Changed

- A browser viewer on an allowed origin can sign in again: the hub accepts the language header in cross-origin requests.
- An agent no longer spawns an addon whose package is older than the running server requires, and retries a crash-breaker-failed runner once when a reconcile installs a different version of its package

## [1.2.722] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.721] - 2026-11-01

### Changed

- Addons loaded in the hub process take the active server's packages ahead of an older copy left by the image (benchmark failed to load on 1.2.720).

## [1.2.720] - 2026-11-01

### Changed

- Addons loaded in the hub process resolve the framework again after a server update (1.2.719 left four addons failing with Cannot find module).

## [1.2.719] - 2026-11-01

### Changed

- The server now carries the framework (@camstack/server/system) and refuses an update whose declared minimum is not met
- HTTPS on or off is now the Serve HTTPS setting in Network > Local access (on by default); CAMSTACK_TLS_ENABLED is ignored and named in the boot log, the image healthcheck probes HTTPS then HTTP, and the hub reads one config.yaml through one loader

## [1.2.718] - 2026-11-01

### Changed

- Migration capability gains the owner-driven declare, start and finish calls for addon catalogues
- Allowed browser origins (CORS) are read live from the new auth.corsOrigins setting; config.yaml server.corsOrigins and CAMSTACK_CORS_ORIGINS are ignored with a boot warning
- A terminal (camstack login, the MCP setup tool) signs in by browser approval: begin and poll are public, approval needs a fresh sign-in.
- Terminal sign-in approval: audit lines, soft global cap and the requester's User-Agent and address shown to the approver

## [1.2.717] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.716] - 2026-10-31

### Changed

- Added the migrations capability router (hub-only, admin): ledger, pending, dry run, retry
- A pre-migration snapshot the operator restores is promoted over its database at the next start, before any runner opens it

## [1.2.715] - 2026-10-31

### Added

- A device can be powered by a smart switch linked in Customize, with manual power on, power off and force restart (switch off, wait, switch on).

## [1.2.714] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.713] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.712] - 2026-10-31

### Changed

- Integration wizard and settings page ask the addon for the form of the instance being configured

## [1.2.711] - 2026-10-31

### Changed

- Creating a second instance of a single-instance integration is refused with a typed conflict

## [1.2.710] - 2026-10-31

### Changed

- The schedulers capability is served over the API (list, create, update, delete, enable, preview, conflicts, status, traces)

## [1.2.709] - 2026-10-31

### Changed

- A wedged agent shutdown now ends with a self-SIGKILL so exit-time teardown cannot keep the process alive after an update.
- getSiteLocation also returns the site's IANA time zone

## [1.2.708] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.707] - 2026-10-31

### Changed

- Agents receive addon installs and updates again: the convergence dry run no longer blocks every reconcile and holds back only removals.

## [1.2.706] - 2026-10-31

### Changed

- The hub now owns every node's addon set: nodes converge to the hub's any-node addons and tracked agent-ui on connect, after a hub install or uninstall, and every 10 minutes (dry run until addons.convergence.dryRun is set to false); updating agent-ui from the hub now reaches every agent

## [1.2.705] - 2026-10-31

### Fixed

- A node agent stopped by a signal now shuts down within 15 seconds and logs what started it, instead of hanging while looking alive but deregistered

## [1.2.704] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.703] - 2026-10-30

### Added

- The hub exposes the network scan engine, saved scan subnets and discovery-mode classification calls

### Changed

- Integration settings accept an owner-only skipRestart so an addon can save its own settings without a respawn
- An updated addon shows its new manifest (icon, name, capabilities) without restarting the hub
- A staged addon update that fails to swap now fails its update task instead of reporting it done
- Hub: settings dispatch can ask an addon which keys it still declares and remove a stale one

## [1.2.702] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.701] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.700] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.699] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.698] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.697] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.696] - 2026-10-29

### Changed

- A node now announces a desktop-app self-update and a container booting on a new image as a node update notification, and node-restarting/node-updating can be picked in notification templates

## [1.2.695] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.694] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.693] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.692] - 2026-10-29

### Changed

- A node inside the desktop app reports the app version and update state to the hub, and the hub can trigger install and restart.

## [1.2.691] - 2026-10-29

### Changed

- An unpaired agent now shows its real memory on its own page instead of unknown.

## [1.2.690] - 2026-10-29

### Changed

- The agent reports its memory, reclaims stranded pages and gets a heap ceiling sized to the host; a node's launch parameters (heap ceiling, allocator) come from the server and can be overridden per node from the hub

## [1.2.689] - 2026-10-29

### Added

- A node's free memory comes from the metrics provider instead of os.freemem(), which undercounts on macOS
- device-export gains optional methods to list, expose and unexpose actions and notification targets beside devices.
- Forget node now works on an online node too: its certificates are revoked, its connection is cut and calls pinned to it fail at once.
- Generated routers for the pet-fountain capability
- Agents report their own process memory in the topology (the core process showed 0), and an unreadable memory shows as unknown

### Changed

- The agent now reports its own [mem] agent-main heartbeat and reclaims stranded memory, as the hub does
- The hub tells its addon runners which telemetry categories anyone consumes, so unused ones stop crossing the process boundary
- Node launch parameters (heap ceiling, allocator env) are decided by a closure module, with a per-node override and a source line in the boot log
- A node's heap-ceiling override can be read and set through server-management (applies at the next restart)

## [1.2.688] - 2026-10-29

### Changed

- Forgetting a node now clears its per-node capability overrides and tells every node-removal-hook owner
- Forgetting an offline node now revokes its mesh certificates, so it can no longer rejoin by itself; a revoked agent learns it was removed and resets to unpaired.

## [1.2.687] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.686] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.685] - 2026-10-29

### Added

- Generated routers for the new ir-transmitter and remote capabilities
- The remote and template capabilities are routed, and a bound remote command is honoured on cross-node calls

## [1.2.684] - 2026-10-29

### Changed

- A form posted through an addon's data plane (a vendor sign-in page) reaches the addon unchanged instead of re-encoded as JSON

## [1.2.683] - 2026-10-28

### Changed

- Agents found on the network lists each agent's name

## [1.2.682] - 2026-10-28

### Changed

- A freshly paired or re-registered agent node now receives every any-node addon installed on the hub, at the hub version
- A fresh agent is named after its short host name and architecture, and the hub offers agents its internal address instead of the public endpoint

## [1.2.681] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.680] - 2026-10-28

### Fixed

- A desktop or container agent renamed from its own page now shows the new name on the hub right away, even when the rename was made while it was pairing

## [1.2.679] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Added the ir-transmitter capability routes.

## [1.2.678] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.677] - 2026-10-28

### Changed

- An agent now keeps its own server closure current: unpaired it follows the npm latest, paired it follows the hub's version, checked at boot and every 6 hours (turn off with CAMSTACK_AGENT_SELF_UPDATE=off).

## [1.2.676] - 2026-10-28

### Fixed

- An agent advertises itself on the network again, so the hub lists a new agent for pairing without typing its address
- An unpaired agent no longer crash-loops: it stays up to be paired and starts its addons once pairing completes

## [1.2.675] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.674] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.673] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.672] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.671] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.670] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.669] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.668] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.667] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.666] - 2026-10-28

### Changed

- The hub raises a critical alert when npm or Hugging Face stays unreachable, and resolves it on the next success

## [1.2.665] - 2026-10-28

### Changed

- A shared events link can open a track's detail page, and shared links now use the operator's colour palette
- The hub raises a critical alert when npm cannot be reached (addon and server updates are paused) and resolves it when the registry answers again

## [1.2.664] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.663] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.662] - 2026-10-27

### Added

- The hub serves Actions: list, run, stop, run traces and camera links

## [1.2.661] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.660] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

## [1.2.658] - 2026-10-27

### Added

- CamStack Server (@camstack/server).
