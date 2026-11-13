# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Capability routers regenerated for the capability vocabulary now declared on each capability (no behaviour change)

## [1.2.856] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.
### Changed


## [1.2.855] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.

## [1.2.854] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.

## [1.2.853] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.

## [1.2.852] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.

## [1.2.851] - 2026-11-12

### Changed

- Rebuilt against updated dependencies.

## [1.2.850] - 2026-11-12

### Changed

- Actions and schedulers store command steps (vocabulary action plus target) and refuse, at save, a device that does not offer the action; the old raw cap-call step and its migration are gone.
- Saving an Action or a scheduler checks each named device against its own capability bindings before accepting a device command step
- A stored Action whose steps are still raw capability calls is no longer read: it is left out of the list and logged with its id and the reason, and it is converted by saving its name and new command steps under the same id (`actions.update`), or by building it again in the editor.
- Each export (Alexa, HomeKit, Google Home, Home Assistant) can give a device its own name: one 'Name on <instance>' field per export in the device's Export tab; renaming keeps the same device on the platform.
- The export name can be set in the same save that turns Expose on; several names in one save are all written or none; an old Alexa name is kept on every Alexa skill; deleting a skill, bridge, home or connection deletes its names.

## [1.2.849] - 2026-11-12

### Changed

- Addon migrations run in phases: a step whose predecessor belongs to a later phase of the same addon is deferred, never blocks the addon
- A cap with no status block keeps its own getStatus: a device whose power source is grafted by customize answers its power source status again, and a settled device command is announced on the event bus.

## [1.2.848] - 2026-11-12

### Changed

- A kind that declares its own role (an Alexa Echo target) is no longer treated as bringing devices because the addon's manifest says so; creating Echo targets works again
- A remote sends a stored native IR code verbatim to a transmitter that replays its format
### Changed

## [1.2.847] - 2026-11-12

### Changed

- Rebuilt against updated dependencies.

## [1.2.846] - 2026-11-12

### Changed

- The integration list includes a short product name when the catalog title is longer, so a new integration can be prefilled from it.

## [1.2.845] - 2026-11-12

### Changed

- Rebuilt against updated dependencies.

## [1.2.844] - 2026-11-12

### Changed

- A device's capability list no longer includes cluster-wide capabilities (broker, adoption, auth); exports such as Alexa see only the device's own.

## [1.2.843] - 2026-11-12

### Changed

- Rebuilt against updated dependencies.

## [1.2.842] - 2026-11-12

### Added

- An addon route can be declared per instance: the hub serves it at /addon/<addonId>/instances/<instanceId>/<path>, and the address without an instance stays the default one
- An account can be linked to one instance of an integration: /api/oauth2/authorize takes instance= beside integration=, and the link, its tokens and oauthVerifyAccessToken name the instance

## [1.2.841] - 2026-11-11

### Changed

- fan-control gains the setOscillationAxis route.

## [1.2.840] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.839] - 2026-11-11

### Added

- Automations and step conditions can gate on the time of day with a new 'time is' condition, read on the site clock.

### Changed

- New auth.deviceAccess answers, per device, whether the signed-in user may view and command it, decided by the same rules that enforce the command

## [1.2.838] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.837] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.836] - 2026-11-11

### Changed

- Log shutdown now waits for the rotating log file to close, so a stopping hub no longer leaves a late file open.

## [1.2.835] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.834] - 2026-11-11

### Changed

- Removed the retired device-discovery capability routes (deviceDiscovery.*) from the API.

## [1.2.833] - 2026-11-11

### Changed

- Switching an integration instance on or off while its addon is not running is refused with "<addon> is not running: start it first" instead of a generic provider error or a write routed elsewhere

## [1.2.832] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.831] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.830] - 2026-11-10

### Changed

- Device list rows served by hero-layout carry extra inline controls (climate, robots, media players)

## [1.2.829] - 2026-11-10

### Changed

- An agent that rediscovers its hub on the LAN now also refuses a revoked answer or one naming another hub id, and names a rejected candidate at most once per 15 minutes
- A paired agent keeps the hub address it paired with; one that has none finds its hub on the LAN by the hub's id, or reports it is unconfigured instead of crash-looping, and a paired agent's hub address can no longer be cleared
- A paired agent saves a rediscovered hub address only after that hub answers with the CA from pairing, and an older pairing records the hub id from that answer
- Pickers can now search devices by capability, location, integration and type with live readings, through the new deviceManager.search query
- Cluster update in one job on the hub: backup, the hub, each agent (verified, an agent back without capabilities fails), then addons — clusterUpdate.startClusterUpdate / getClusterUpdateJob, resumed across the hub's own restart
- Disabling a login method from the Authentication table now gates sign-in like the other auth capabilities
- The device meta mirror carries a container's declared primary-child preference

## [1.2.828] - 2026-11-10

### Changed

- A power-source link added through Customize no longer shadows the power-source status for device-scoped callers, so the Velux gateway power recovery sees the link

## [1.2.827] - 2026-11-10

### Changed

- The server exposes the OSD manager previewTemplate call and the thisDevice input of the device-template calls; getSourceCatalog is gone.
- Capability method signatures now mark optional cover, fan, climate, lock and media-player methods; bindings report implemented methods
- Device features are re-derived only from a provider whose node is online; an offline agent's cameras keep theirs

### Fixed

## [1.2.826] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.825] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.824] - 2026-11-10

### Changed

- Notification rules and buttons run existing Actions; the notification-centre sequence methods are gone

## [1.2.823] - 2026-11-09

### Changed

- Rebuilt against updated dependencies.

## [1.2.822] - 2026-11-09

### Changed

- An action step can carry an if condition and an else list, in actions, schedulers, fan presets and automations

## [1.2.821] - 2026-11-09

### Changed

- A heat-pump device type exposes its status and typed setters through the generated cap routers

## [1.2.820] - 2026-11-09

### Changed

- A viewer user manages only their own notification targets through integration-instances
- A fixed builtin whose addon is down reads as an unknown switch; the enabled / disabled event follows the instance record, not the registry flag
- A fixed builtin can be switched back on while its addon is down, and every switch emits the enabled / disabled event again
- Integrations: integrations.update refuses enabled for every row; the integration list reports an unanswered switch as unknown
- integrations.delete is back for an addon that is installed but not running; a fixed builtin can be switched while its addon is down.
- A provider's refusal of a caller answers FORBIDDEN (403) instead of a server error.

### Removed

- addonSettings.getIntegrationFormSchema is removed; the create form is integrationInstances.instanceFormSchema with no id

## [1.2.819] - 2026-11-09

### Changed

- Rebuilt against updated dependencies.
### Changed

## [1.2.818] - 2026-11-09

### Changed

- Rebuilt against updated dependencies.
### Changed

### Removed

## [1.2.817] - 2026-11-08

### Changed

- A fixed built-in integration (alarm panel, Blocks, Notification Center) now reports and switches on the registry flag in the instance list, not on a record that carries none
- One door to create an instance: integrationInstances.createInstance (a seed is accepted only from the addon it seeds); integrations.create removed

## [1.2.816] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.815] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.814] - 2026-11-08

### Changed

- Pressing Stop on a timed run now switches the device off, instead of only forgetting the timer

## [1.2.813] - 2026-11-08

### Changed

- Creating an instance that brings devices now writes the integration row, applies the connection-test gate (a kind that declares its own test is tested by it; a create without a kind takes the provider's default kind) and rolls back on failure; deleting one removes its devices, row and announces it
- The Blocks and Notification Center integrations now keep an instance record, and a fixed builtin keeps its on/off switch in the registry
- Generated cap routers gain heroLayout.getRowModels

## [1.2.812] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.811] - 2026-11-08

### Changed

- The device hero capability (hero-layout) is exposed on the API
- The remote runs declared sources under a per-device lock, resolves a source by name or channel number and refuses undeclared channels; custom buttons are no longer sources
- Device history keeps a ledger of device transitions (who changed what, and the outcome) with its own retention, default 365 days, in the same Retention settings.
- Device commands are observed where the caller is known (hub API, forked addon, in-process addon) for the device transition audit.
- The hub now audits device commands and the state changes they cause: a command is matched to the device's own report within 30 s, or recorded as unconfirmed or failed
- Device transition audit: command arguments are redacted at any depth (pin, otp, code, key included) and a chatty device field writes one row per 10 s

## [1.2.810] - 2026-11-08

### Changed

- Every integration provider declares its kinds and stamps a kind on its instances; the storage orchestrator no longer carries a dead legacy keychain scope constant.

## [1.2.809] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.808] - 2026-11-08

### Changed

- An infrared TV (media-player with a remote) now publishes its assumed power state as its own state, so the hero no longer shows State unknown and the power button is enabled

## [1.2.807] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.806] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.805] - 2026-11-08

### Changed

- The addon-settings routes for the global and integration settings reads and the global write are removed; a forked call naming them is refused.
- The device-manager router exposes setAlias for device aliases

## [1.2.804] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.803] - 2026-11-07

### Changed

- A timed-run device exposes its quick-run duration and lets an admin set it

## [1.2.802] - 2026-11-07

### Changed

- addonSettings.listScopedSettings lists the scoped settings an addon serves, in process and for forked addons.

## [1.2.801] - 2026-11-07

### Changed

- System-event notification rules can combine start, clear and scheduled-summary delivery

## [1.2.800] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.799] - 2026-11-07

### Changed

- The bootstrap config is the environment (CAMSTACK_PORT, CAMSTACK_HOST, CAMSTACK_DATA); config.yaml is no longer read, a leftover file with different values is still applied for this release with a warning naming the variable to set

## [1.2.798] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.797] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.796] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.795] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.794] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.793] - 2026-11-07

### Changed

- Terminals are now instances: the Terminal cap's instance methods are retired in favour of the shared instance records

## [1.2.792] - 2026-11-07

### Changed

- Loki logging retires its old enabled flag through a one-time ledger migration; local-network keeps its allowlist and address book through durable state handles.

## [1.2.791] - 2026-11-07

### Changed

- The addon-settings capability answers scoped settings reads and writes for in-process and forked addons.
- A non-admin cannot read secrets through the scoped settings read, and its schema text is localized like the global one

## [1.2.790] - 2026-11-07

### Changed

- A grouped addon on an agent (for example the pipeline runner) is now recognised by the hub from its first call, so its migrations are no longer refused with "no caller identity" at boot.
- An addon running below the version the server requires now always starts, and raises an alert naming the installed and required versions until its package is updated.
- Storage locations are now integration instances, with credentials kept per location in the keychain.

## [1.2.789] - 2026-11-06

### Changed

- Settings rows stored as a bare value (such as an empty brokers list) are rewritten into the standard form at boot, so the Google services cleanup migration can finally apply

## [1.2.788] - 2026-11-06

### Changed

- An addon held back until its package is updated after a server update is no longer reported as failed to initialize.
- A held-back addon is retried quietly until its package is current, without a failure alert.

## [1.2.787] - 2026-11-06

### Changed

- Integration creation is gated by the instance test; integrations.testConnection is removed

## [1.2.786] - 2026-11-06

### Changed

- Pet fountain tRPC routes lose the drink counters and the Clear daily count call
- The integrations list shows the on/off state of the instance itself; integrations.update no longer switches ordinary integrations

## [1.2.785] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.784] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.783] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.782] - 2026-11-06

### Changed

- The hub refuses to delete an instance that another instance still links to, and lists what uses it

## [1.2.781] - 2026-11-06

### Changed

- A runner that hosts its own provider of a collection capability no longer answers a call pinned to another addon, which left the Home Assistant export target Unconfigured
- A forked addon asking a collection capability's list method with an explicit addonId now gets only that addon's rows, not every provider's, so the Home Assistant export no longer mistakes another integration's account for its broker

## [1.2.780] - 2026-11-06

### Changed

- A provider's instances can be listed per section (the kinds that name a function), and an integration is listed for its devices as soon as one of its kinds brings devices
- The broker routes drop list, get, add, remove, test and settings: a broker is an instance served by integration-instances
- Generated tRPC router exposes pipelineAnalytics.getMediaLocationCensus (admin read)
- The hub no longer spawns an addon whose package is older than the running server requires; it is held back and logged until the required-addon update lands
- After a server update the hub brings every addon below the server's required minimum current on boot, even with auto-update off; a failure raises an alert and boot continues
- A delivery to an agent is held when its addon minimum is above what the node holds, naming both versions
- Addon uploads, first-boot installs and registry updates now read the package's requirements and refuse or hold a version the node cannot run, naming both versions; an unreadable requirements document is a refusal
- First boot installs the newest addon version the running server can host when latest needs a newer server, reads requirements through the same registry and npmrc auth as the install, and raises an alert for an addon it had to hold back.
- A held addon install raises an alert and resolves it once a later boot installs the package
- Migrations: in-process builtins get ctx.migrationApi

## [1.2.779] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.778] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.777] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.776] - 2026-11-05

### Changed

- Deleting a device from the UI now also stops the instance running inside its addon worker (no zombie timers, no stale 'already adopted'); accessories of a hub-child camera inherit the hub's integration

## [1.2.775] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.774] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.773] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.772] - 2026-11-05

### Fixed

- A container with an empty TZ no longer reports the invalid zone Etc/Unknown: the site location falls back to UTC and the starter ignores an empty TZ

## [1.2.771] - 2026-11-05

### Fixed

- Updating one addon in a shared runner no longer skips the restart when another member of that runner was restarted moments earlier, so the new code actually loads.

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
