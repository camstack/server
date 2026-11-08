# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Device hero: the integration name is a chip, climate modes and fan speeds carry readable labels, and the scene caption names the mode and the fan
- The device hero model gains an end clock time, a timer tile, fan oscillation and mode, tank and volume tiles, and a valve caption

## [1.2.534] - 2026-11-09

### Changed

- A user's writes to their own notification targets are audit-logged
- A user's own notification targets are now integration instances scoped to the signed-in user; capability methods can declare caller-scoped access
- Integrations: update accepts enabled only for a fixed builtin (the hub's own switch, which works while its addon is down); any other row is switched through setInstanceEnabled, and a row whose addon did not answer is marked switchUnknown
- SMTP: the duplicate smtp-provider verify call is removed; test a relay from its instance (Test connection)
- integrations.delete is back: it deletes an integration from the hub side, so an addon that is installed but not running can still be removed.
- smtp-provider getStatus adds an optional verified flag (true, false, or absent while the relay has not sent).
- A provider's refusal of a caller (a user touching a target that is not theirs) answers FORBIDDEN instead of a server error.

### Removed

- addonSettings.getIntegrationFormSchema, BaseAddon.integrationFormSchema and IntegrationInstanceRef are removed; an instance form is integrationInstances.instanceFormSchema

## [1.2.533] - 2026-11-09

### Changed

- Removed the unused claimAction from the account-sign-in config field.
### Changed


## [1.2.532] - 2026-11-09

### Changed

- A calendar names the integration-instances record that owns it (calendar-source CalendarInfo.instanceId, passed through the calendars listing)
- Remote: an infrared source may leave its emitter out (the remote's default one is used), the power mode setting is gone, and the colour keys have one set of roles
### Changed


### Removed


## [1.2.531] - 2026-11-08

### Changed

- The integrations.create method is gone: every instance is created through integrationInstances.createInstance, and an addon seeds its own fixed integration with its seed field
- Removed the LegacyStorageLocationDefault schema (the retired isDefault key is migrated in the ledger)

## [1.2.530] - 2026-11-08

### Changed

- Device heroes now complete for locks, alarm panels, fans, vacuums, mowers, pet feeders and fountains, groups, automations and scripts: look, status line and controls
- Device heroes now read their own state for lights, covers, valves, humidifiers, alarm and motion sensors, doorbells, weather, updates and buttons instead of a generic power state
- Climate, thermostat, water-heater, heating-valve and sensor devices now carry their mode, setpoint, measured values, readings and controls in the device hero instead of showing an unknown state
- Climate and water-heater state now remembers the last mode the device ran (lastActiveMode), and climate, sensor and water-heater heroes get their own icon, tone and headline
- Capability definitions can name restoredStateFields, so a restored capability persists only those fields of its state.
- Enum sensors no longer persist a restore only because the timestamp flag changed
- Device heroes: a channel row for media players and IR TVs, light colour presets, and a value slider or picker for generic controls
- Device hero model: media-player shuffle/repeat/next/previous and progress, washing and dishwasher cycle rows, phase and started tiles, hero args with a dotted value path, update cap read-only

## [1.2.529] - 2026-11-08

### Changed

- Remote: Flipper .ir parsing and NEC, NECext and Samsung32 encoding for importing codes

## [1.2.528] - 2026-11-08

### Changed

- The device Customize tab reads a power-source or running-state row an earlier version stored (explicit dwell sample count, zero off-seconds) as the source link it is, instead of showing it as a custom formula.
- A remote source can be a raw infrared code (raw timings or Pronto hex) sent through a transmitter, next to digits and key sequences.
- A remote with one unreadable infrared source still opens: that source is left out and named, the rest loads.
- A composed device that binds a plain switch advertises it as the switch feature, so a viewer can offer a heater its on/off

## [1.2.527] - 2026-11-08

### Changed

- integration-instances: instanceFormSchema takes the wizard mode and discovery candidate, createInstance takes the originating candidate
- A declared integration can be given a name-only instance record that is seeded once and never overwritten
- Device hero: every device type now names an animated scene, and a batch read returns the list rows of many devices in one call

## [1.2.526] - 2026-11-08

### Changed

- New device-transitions capability and transition types: a device's changes can be recorded with who asked for them
- A device call can state why it is made (commandOrigin) so the transition audit can tell an action run or a scheduler from a plain addon call.
- Added the device hero model: a look per device type and role, fixed row layouts, and the hero-layout capability that serves it (nothing draws it yet)
- A remote declares its sources explicitly: digits sources (name and channel number) and sequence sources (name and bound steps), with a step delay
- Remote layouts can place a Sources key (source_select): a widget that opens the source picker; it can never be bound or used as a source step

## [1.2.525] - 2026-11-08

### Changed

- Media players now start the running-state power threshold with a 10 s start dwell, a 10 s stop dwell and one sample instead of 30 s / 3 min / 2 samples; other device types are unchanged
- integration-instances: describe().kinds and every instance's kind are required; a record provider with one kind stamps it.
- A provider whose kindOf names a kind its description does not declare is refused with the offending id

## [1.2.524] - 2026-11-08

### Changed

- The addon-level settings API is deleted: addons keep their values in cluster, node, device and instance scopes only (D986). getGlobalSettings, updateGlobalSettings, getIntegrationSettings, globalSettingsSchema and integrationSettingSections are removed.
- A device has an editable alias; device value templates (nunjucks) gain their vocabulary, and a stable id now resolves per addon

## [1.2.523] - 2026-11-08

### Changed

- A device can carry the timed-run feature, derived from the capabilities bound on it

## [1.2.522] - 2026-11-07

### Changed

- A heater or fan composed on a plug now counts as running while its own switch is on, and a timed-run device reports a configurable quick-run duration

## [1.2.521] - 2026-11-07

### Changed

- New {{sensor}} template variable for sensor rules: the name of the sensor the notification is about
- A settings surface can ask an addon which scoped settings it serves (addonSettings.listScopedSettings), so a generic mount no longer needs the global-settings form.

## [1.2.520] - 2026-11-07

### Changed

- A system-event notification rule can speak when a condition starts, when it clears and on a schedule, in any combination

## [1.2.519] - 2026-11-07

### Changed

- Scalar overrides expose the dwell sample count (the 4th dwell argument) as an editable default

## [1.2.518] - 2026-11-07

### Changed

- Doc comment on ConfigManager.getSection no longer refers to config.yaml

## [1.2.517] - 2026-11-07

### Changed

- Terminals are now instances on the Terminal page: the list is kept as records, migrated in place with the same ids and cameras

## [1.2.516] - 2026-11-07

### Changed

- Addons get a typed scoped settings API (cluster, per-node, device defaults, per-node state) beside the old global settings calls, which keep working.
- The addon test context accepts a writeAddonStore override.

## [1.2.515] - 2026-11-07

### Changed

- New addon.unsupported-version and addon.unsupported-resolved event categories for an addon running below the server's minimum.
- Storage location row switch: a draining location is never switched back to active by the switch.
- Notification targets are only the instances of notification-output: the target list/get/upsert/delete/enable methods are removed from the notification-output capability
- Integration instances can refuse a write with a readable reason (validateWrite)
- The llm capability drops listProfileKinds, listProfiles, upsertProfile, deleteProfile, testProfile and migrateRawSecrets; instance kinds may name provider widgets.
- mesh-network.testConnection is removed; the tailnet instance's Test is the connection check
- The storage capability drops upsertLocation, deleteLocation, testLocation, testConfig and listProviders; the location instances replace them
- The oidc-connections capability is removed; OpenID Connect providers are integration-instances of the login-method function

## [1.2.514] - 2026-11-06

### Changed

- Records errors are now recognised across copies of the types package, so an addon in a grouped runner can catch a conflict or refusal thrown by the host's records door.

## [1.2.513] - 2026-11-06

### Changed

- mqtt-broker no longer has testConnection; use integration-instances.testInstance.
- Removed the connection-test capability and integrations.testConnection; integration-instances.testInstance is the only connection test
- Notification targets are instances of the notification function: Telegram, Home Assistant, Alexa and the rest keep their ids, switches and secrets, and rules naming them keep dispatching

## [1.2.512] - 2026-11-06

### Changed

- Pet fountain: the tank is also a Water consumable derived from its level; the drink counters and Clear daily count are removed
- optionalLinkField declares an instance link that may stay empty
- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- Removed the deprecated broker-named in-use helpers; a delete refused for a linked instance is the one InstanceInUseError
- An instance's on/off switch is written only by setInstanceEnabled: saving an instance form can no longer flip it, and addons read it through one helper (isInstanceEnabled)
- An integration is switched on or off in one place, its record, for every kind of integration; a switch that was off in the old registry is carried over
- An integration whose switch could not be carried into its record now keeps its addon from starting (retry the migration, then restart) instead of coming up switched on
- An action run now has a 60-minute ceiling: a longer run is stopped and reported timed-out, and an action whose waits add up to more is refused when saved.
- The media-player status gains positionUpdatedAt, the time the playback position was read (null when the driver does not say).

## [1.2.511] - 2026-11-06

### Changed

- Notification templates: the {{graceMin}} variable is gone (a planned-update offline is now worded without a grace)
- addon-crash-loop notification templates can use {{cause}}
- A running-state power threshold now needs a second power sample above the threshold (dwell's new optional 4th argument minSamples), so one isolated standby reading no longer starts a run when the timer fires over the held value.

## [1.2.510] - 2026-11-06

### Changed

- An instance-select field can word its empty choice (noneLabel)
- linkFieldDescriptor takes required: false for an optional link
- Calendars are instance records linked to their account; a composed instances provider now reports the links of every kind

## [1.2.509] - 2026-11-06

### Changed

- Instances can now declare links to other instances (declareLinkKind, linkField, instance-select) and a delete of an instance that is still linked is refused with the users named

## [1.2.508] - 2026-11-06

### Changed

- Customize cardinalities, event shapes, apply authorities and stored link kinds are now one exported list each
- integration-instances kinds now name the function they serve (functionCap, role, canTest) and one provider can compose several record kinds
- The broker capability is now the message bus only (publish, subscribe, unsubscribe, getState, getBrokerConfig, getStatus); brokers are listed, created, edited, tested and removed as instances of their addon's integration-instances provider
- A broker listed through another addon's rows can be checked for users with fieldUserFinder
- A broker-backed service now binds to its broker through one shared primitive (broker link kind, form and users query); removing a broker still in use is refused with a typed error naming its users
- The integration role `both` is removed; an addon with a connection and device integrations declares the connection as a broker and its integration as `devices`
- pipelineAnalytics.getMediaLocationCensus: stored media rows and bytes per storage location, answered from indexes
- A stable, append-only migration API (MigrationApiV1) that addon migrations call, so an old migration keeps running after a version-jump upgrade
- Migrations: ctx.migrationApi, a stable append-only migration API (V1), and runMigrations(catalogue, bindPorts)
- Migration API V1 gains a devices namespace (scoped list, get, setIntegrationId)
- Adapters that bind a catalogue's ports over the migration API (secrets, records, integration rows, default integration)
- A migration log line is delivered in order and a refused delivery no longer surfaces as an unhandled rejection; runMigrations refuses a mixed array of bound and catalogue entries

## [1.2.507] - 2026-11-05

### Changed

- Add-Device asks the provider per integration: a Reolink Home Hub / NVR integration no longer offers a manual add by IP

## [1.2.506] - 2026-11-05

### Added

- A device provider can say which parameters a discovered device still needs, and receives the integration a device is added to.

### Changed

- Vendor login proxy: drop Subresource Integrity pins from proxied pages so rewritten scripts and styles are not refused

## [1.2.505] - 2026-11-05

### Changed

- An integration instance is reachable by its Integrations-page id as well as its record id, so the Config form shows and saves the stored record of an account whose record id differs

## [1.2.504] - 2026-11-05

### Changed

- Addon settings: the per-node keys, the secret tree and the restart check read the scoped schemas (cluster, node, fleet defaults) of the capabilities an addon declares.
- Addon settings: a form is served from the scoped schemas when an addon declares no global schema.
- Addon settings: a section answered by two capabilities is served once in the generic form.

## [1.2.503] - 2026-11-05

### Fixed

- Addon authors can import InstanceChange and statusInstanceOf, take fakeAddonContext from @camstack/types/testing (optional @trpc/client peer), and a device-export provider can omit the per-device settings methods.

## [1.2.502] - 2026-11-05

### Fixed

- Added a validated process time zone helper (an empty TZ no longer yields Etc/Unknown)

## [1.2.501] - 2026-11-05

### Removed

- The per-integration settings methods are removed; leftover rows are read only by the migration door

## [1.2.500] - 2026-11-05

### Changed

- An appliance run now ends at its last real active instant and a short anti-crease pulse no longer keeps a run alive; the running-threshold proposal ignores pulses, bounds pauses and reports pulses found

## [1.2.499] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.498] - 2026-11-04

### Changed

- Device addons whose integrations hold real settings move them into typed instance records through one shared migration (rows to record, secrets verified before the legacy rows are cleared)
- Entry record kinds can declare a larger body size for a kind that keeps device descriptions

## [1.2.497] - 2026-11-04

### Changed

- An addon that moves its legacy integration settings into a record can now ask the hub to clear the old rows and their keychain values
- Added the shared migrations for a device addon whose integrations hold no settings: integration rows to a name-only record, and claiming un-stamped devices to the default integration
- Added the device-claim migration alone and its hub ports, for an addon that moves its settings later
- The device claim gives a child its parent's integration, skips allocation reservations and reports what it could not resolve

## [1.2.496] - 2026-11-04

### Changed

- The migration ledger entry carries ownerNotLoaded for an applied row whose owner catalogue the answering process has not loaded
- An addon runs a phase of its migrations with runMigrations(whole, { only }) instead of declaring a filtered catalogue

## [1.2.495] - 2026-11-04

### Changed

- Integration instances state a role and a discovery in describe(); a record secret may sit in a map of the body; a migration helper moves an integration's legacy settings rows into its instance record

## [1.2.494] - 2026-11-04

### Added

- The kernel context lists every addon that declares storage locations, loaded or not (listStorageLocationDeclarers), so a failed load is not read as a removal

### Changed

- device-export: instanceId on reads (optional) and writes (required), listInstances, and the export-instance-unknown refusal
- The integration instance health hook receives the instance id
- Added flattenNestedRecords and flattenPortsOver, a D987 helper that moves a kind's nested connection object to flat top-level fields under the same ids, reading every secret back before the nested copy goes; makeInMemoryRecords exposes its spec keychain.
- Entry kinds can name retired secret paths, so a body that moved its secrets keeps its keychain refs released with the old shape

## [1.2.493] - 2026-11-04

### Changed

- Connection instances can now declare kinds, a sign-in or connect action, a status label, a last-checked time, an old-id restore and a provider-minted id (all optional)

## [1.2.492] - 2026-11-04

### Changed

- The client entry exports the remote-key vocabulary (role labels, legends and icons) so the viewer can show a symbol for every key

## [1.2.491] - 2026-11-03

### Changed

- Log tags gain source, user, platform, appVersion and clientSessionId; the data-plane gate names the authenticated caller in x-camstack-user
- FFmpeg encode plans can name -fps_mode explicitly; callers that do not are unchanged

## [1.2.490] - 2026-11-03

### Changed

- Every remote key role now has a name in English and Italian and an icon, shared by the admin and the viewer

## [1.2.489] - 2026-11-03

### Changed

- The log-destination capability can name a destination instance (instanceId) on read and describeRead

## [1.2.488] - 2026-11-03

### Changed

- The appliance and heater helper templates are gone: the helper kinds are the aggregators only, and a device type is a naked composed device grown through Customize.
- Running state: a pure proposal of the running threshold and dwells from a device's own power history, verified by replaying the real dwell expression

## [1.2.487] - 2026-11-03

### Changed

- The power-meter capability shows its reading as a hero line under every device's hero card
- A composed device may have no feature: a device can be created naked and gets its facets from Customize

## [1.2.486] - 2026-11-03

### Changed

- Clearing a list of rows that carry secrets (addon settings) now stores an empty list instead of the clear instruction

## [1.2.485] - 2026-11-03

### Changed

- A media player can step its volume and channel (volumeUp, volumeDown, channelUp, channelDown) and be turned on or off, and a composition may serve it through the remote
- A switch that never reported its state reads as unknown (on: null) instead of off; session-lost alerts gain a broker-unavailable reason
- The IR codec encodes a Samsung frame (data and bit count) into the pulse train a transmitter sends

## [1.2.484] - 2026-11-02

### Added

- New template variable {{changes}} for the combined alarm body: the sensors of the incident and what each did

## [1.2.483] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.482] - 2026-11-02

### Changed

- An addon blocked by its migrations now throws a typed AddonMigrationsBlockedError naming the migration ids.

## [1.2.481] - 2026-11-02

### Changed

- Notification rules: the template catalog now serves the default text of an appliance cycle finish, so editors can pre-fill and rebuild it

## [1.2.480] - 2026-11-02

### Changed

- Every integration instance carries its own on/off switch: IntegrationInstance.enabled and the integrationInstances.setInstanceEnabled method
- A discovered select field can declare noneLabel and missingLabel to be an optional picker.
- Adds the smtp-inbound broker schemas (settings, config, filter, message).
- Addon declarations can state integrationRole (devices, services or both) so a dual entry is listed on Integrations
- New board-key-source capability: where a device board's API encryption key can be read from.
- The pet fountain's pump on/off cycle moved to its own optional pump-cycle capability; maintenance cadences are consumables

## [1.2.479] - 2026-11-02

## [1.2.478] - 2026-11-02

### Changed

- Fix: the integration instances routes answer again; a public capability can no longer be left without a server route.
- A cover can declare cover-stoppable; a cover group offers stop only when every member has it.
- power-source: a device's own provider may call forceRestart as a bounded self-recovery (comment only).
- A notification rule's media policy gains wakeSleepingCamera, letting a sensor rule opt out of waking a sleeping battery camera for its linked still
- The snapshot capability documents force as a demand with a named principal, including a notification rule that allowed the wake
- A discovered select field can declare noneLabel and missingLabel to be an optional picker.
- Adds the smtp-inbound broker schemas (settings, config, filter, message).
- Every integration instance carries its own on/off switch: IntegrationInstance.enabled and the integrationInstances.setInstanceEnabled method

## [1.2.477] - 2026-11-02

### Changed

- The integration-instances capability is public and admin-gated, so a function page can edit a service connection
- smtp-provider sendEmail, verify and getStatus take an optional instanceId that picks one relay of a multi-relay provider

## [1.2.476] - 2026-11-02

### Changed

- Connection-holding addons can be integration instances: a new integration-instances capability and a shared record-backed helper

## [1.2.475] - 2026-11-02

### Changed

- A composed running state that uses a start/stop delay now keeps its last value across a hub restart instead of reading unknown until the delay passes

## [1.2.474] - 2026-11-02

### Changed

- Scoped addon settings: a capability provider can declare cluster, node and fleet-default schemas, and a device's settings resolve as device, fleet default, schema default with the source per field

## [1.2.473] - 2026-11-02

### Changed

- The debug emitter is exported from the light addon entry, so addon runners stay small

## [1.2.472] - 2026-11-02

### Changed

- Addons can emit device debug lines with ctx.debug, evaluated only while an operator watches that device; log channels carry a kind and system.debugWatch starts, renews and stops a watch.

## [1.2.471] - 2026-11-02

### Changed

- AI calls can override the profile's reasoning effort per call
- Model features carry a reasoning flag (null when the endpoint does not say)
- Stationary-present conditions accept a minimum count; the trigger variables of a condition are listed from one place
- New do-not-disturb capability: a read and write Do Not Disturb switch for speakers
- server-management launch overrides now carry the hub RSS budget (rssBudgetMb)

## [1.2.470] - 2026-11-01

### Changed

- fan-presets: capturePreset without steps proposes every sibling switch and control, ordered, with a review group per step.
- A plug-in heater is a new device type, and a new timed-run capability turns a heater or a pet fountain pump on for a set time and then off again.
- Entity drafting: schemas, vocabulary slice, prompt, validator and comparator for describing an automation, action, scheduler or composition in words.

## [1.2.469] - 2026-11-01

### Changed

- Power and energy can now be added to a device that has no native power meter (the optional reading is simply left out while its source is unavailable)
- A finished appliance cycle can name its duration and energy in a notification (new {{duration}} and {{energy}} variables)
- Removed the addons.installFromWorkspace, isWorkspaceAvailable and listWorkspacePackages methods; a workspace build reaches a node through camstack deploy.
- Keychain key source kinds config-file / previous-config-file are now mounted-file / previous-mounted-file
- Added the device-runs capability: a durable record of each washer, dryer and dishwasher cycle.
- Washer and dryer resolve to the new appliance control kind

## [1.2.468] - 2026-11-01

### Changed

- The migrations ledger rows carry their catalogued meta (description, body kind, store, dependsOn) as an optional field
- Notification templates: the {{camera}} variable is now {{device}} (the camera for a track, the appliance or sensor for a device event); the system text for an agent that went offline during an update declares {{graceMin}}
- New admin-only read userManagement.getAdminBootstrapStatus: whether an admin account still has the first-boot password, as one boolean

## [1.2.467] - 2026-11-01

### Changed

- The Notify when choices read When it starts and when it finishes, and a catalog says what start and finish mean for each sensor kind

## [1.2.466] - 2026-11-01

### Changed

- Customize can now replace a device's native running state with an assigned source such as a plug's power
- A Notification Center rule can now fire when an appliance starts or finishes (kind 'appliance-cycle' on any device with running-state)

## [1.2.465] - 2026-11-01

### Changed

- An appliance helper can name the smart plug that powers it, so a forced restart can cut and restore that plug

## [1.2.464] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [1.2.463] - 2026-11-01

### Changed

- Packages can declare the minimum versions they need (camstack.requires), with typed unmet-requirement reasons
- Rain-rate readings spelled mm/Hr or in/Hr by a weather station are now accepted instead of refused as an unknown unit
- Removed the unread logging, retention, storage, ffmpeg, providers and eventBus runtime defaults

## [1.2.462] - 2026-11-01

### Changed

- Addons can declare migrations (plan and procedure bodies) that run under the shared ledger, snapshot and rollback
- A terminal sign-in approval lands on the existing completion page (new cli-login outcome).

## [1.2.461] - 2026-10-31

### Changed

- A washer, dryer, dishwasher, pet fountain, fan, humidifier, climate or water heater can now be given a power source in Customize

## [1.2.460] - 2026-10-31

### Changed

- Added the migrations capability and the migration model (id, order, plan edits, ledger) behind boot-time migrations

## [1.2.459] - 2026-10-31

### Added

- A device can be powered by a smart switch linked in Customize, with manual power on, power off and force restart (switch off, wait, switch on).

## [1.2.458] - 2026-10-31

### Changed

- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.457] - 2026-10-31

### Changed

- A new integration remembers the discovered device it was set up from (originStableId), and the backend refuses a second instance of a single-instance addon
- A lock can link a door contact in Customize: while the door is open the lock reports the new door-open state.
- A lock's linked door contact is read from its stored customization by a shared helper

## [1.2.456] - 2026-10-31

### Changed

- Notification attachments named by a root-relative path are resolved against the hub's public address
- Schedulers: a scheduler's profiles hold edge, hold and release points on a day timeline, with the schedulers capability to author, preview and check them

## [1.2.455] - 2026-10-31

### Changed

- Notification verdicts carry the subject and reach the retrain listing (new optional verdict fields on retrain frames and tracks)
- An automation or notification step now names its devices as a target (named devices, or every device that offers an action, optionally in one room), and a stored step is read in that shape
- Schedules take a time spec: a clock time, a sun event (sunrise, sunset, dawn, dusk) with an offset, or a date; the site now reports its time zone

## [1.2.454] - 2026-10-31

### Changed

- Remote layout groups accept an optional size and hideTitle for dividers

## [1.2.453] - 2026-10-30

### Changed

- Terminal instances report nodeInCluster and updateInstance accepts targetNodeId to re-point an instance.
- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

## [1.2.452] - 2026-10-30

### Added

- Discovery modes: a device provider can declare how it is found on the network and classify the hits the scan engine returns; candidates can say they set up an integration or sit behind a gateway

### Changed

- An editable-array config field can now hold keychain secrets per row
- A discovered child device can name the gateway it sits behind (parentStableId)
- The vendor login proxy can keep a sign-in's vendor cookies server-side (serverCookieJar)
- Hub: a stale-data audit finds record kinds and settings keys an addon no longer declares, read-only, with an operator-triggered cleanup
- Automations are one 'when' tree: an event starts a run, states must hold at that instant, and a detection is a macro class with an optional label (dog, a known face, a plate); stored recipes convert on read, and step traces now show the arguments they sent.

## [1.2.451] - 2026-10-30

### Changed

- New Gateway device type for the physical bridge box of an integration (reboot and admin link allowed on it)
- Broker kinds can advertise several sign-in methods (signIn.methods: device-code, proxy)

## [1.2.450] - 2026-10-30

### Changed

- prepareRecipeUnits: the automation save boundary that stamps a unit on a bare quantity number, now shared by the admin editor and the public MCP

## [1.2.449] - 2026-10-30

### Changed

- Built-in remote components show icons on rocker, D-pad and media keys, and colour keys carry only their colour

## [1.2.448] - 2026-10-29

### Changed

- The node-restarting and node-updating events carry what is being updated, and both can be used in notification templates
- Remote templates gain section dividers, titled panels, button shapes and tones, and a palette of components (D-pad, rockers, keypad, colour keys, media row) that addons can extend

## [1.2.447] - 2026-10-29

### Changed

- Numbers tied to a physical quantity can be entered in a unit you pick: automation conditions and steps accept { value, unit }, converted to the stored unit, and a bare API number is accepted with a warning
- node-restarting and node-updating are offered in the served notification template catalog again

## [1.2.446] - 2026-10-29

### Changed

- The server-management capability reports the desktop app's version and update state and can ask it to install a downloaded update.

## [1.2.445] - 2026-10-29

### Added

- server-management can read and set a node's launch overrides

## [1.2.444] - 2026-10-29

### Added

- Device exporters can declare that they also expose actions and notification targets (device-export entity methods).
- A composed device of a new type can now be commanded: each method of its capability forwards to one method of a source device
- A pet fountain device type with a pet-fountain capability (water level, drinking totals, pump controls)
- A preset to build a pet fountain device from loose entities, with forwarded pump commands and a resettable filter

### Changed

- Node memory is nullable on the metrics and topology contracts: a failed read is unknown, not 0 or 100
- server-management gains getLaunchOverrides / setLaunchOverrides, the per-node heap-ceiling override

## [1.2.443] - 2026-10-29

### Added

- The vendor login proxy writes a names-only trace line per proxied sign-in request (parameter, form-field and cookie names, never values) to show where a sign-in loses a parameter
- Added the no_authorization_code reason to the OAuth result page codes
- Comments on the placement flags now say a role defaults on for every node

### Changed

- A node-removal-hook capability: addons are told when the operator forgets a cluster node

## [1.2.442] - 2026-10-29

### Changed

- A transcode of a local restream starts its first frame sooner (bounded input probe)

## [1.2.441] - 2026-10-29

### Added

- Streams re-encoded for Alexa, HomeKit and other live viewers start sooner because ffmpeg no longer probes the local restream for seconds first
- New ir-transmitter and remote capabilities for infrared control, and media-player status now says whether its state is reported or assumed
- Remote: a generic template collection, a remote Customize extension for media players, and media-player commands that run a bound IR/Actions binding first

### Changed

- Pet feeder: the status carries the last manual-feed portion so a client can start from it

## [1.2.440] - 2026-10-28

### Changed

- Agents advertise their display name over mDNS so a hub can show which machine is which

## [1.2.439] - 2026-10-28

### Changed

- An alert action can now run an addon's custom action as well as link to a page

## [1.2.438] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Pure IR/RF codecs: pulse-train and transmit-settings schemas, Pronto decoding and SmartIR media_player import.
- Added the ir-transmitter capability: send an infrared or RF pulse train with per-call settings.

## [1.2.437] - 2026-10-28

### Changed

- The vendor sign-in proxy keeps the vendor's session cookie when the vendor also deletes a same-named cookie on another domain
- An AI profile can turn the model's thinking off or set its effort

## [1.2.436] - 2026-10-28

### Changed

- Addon manifest entries can declare which Integrations block they belong to (integrationSection)
- A notifier can declare extra delivery parameters (type, options, default) and a rule target can carry them to it.
- Vendor sign-in proxy: form fields carrying a proxied address are sent back to the vendor with the vendor's own address
- A temperature or humidity group can include thermostats and climate devices, read from their current temperature/humidity

## [1.2.435] - 2026-10-28

### Changed

- Device value fields are named after their quantity (power, level, speed, signal...) instead of their unit; run the quantity-field migration after updating

## [1.2.434] - 2026-10-28

### Added

- Automations can start on a parked object appearing or leaving, filtered by camera, class and zone, and check whether one is present

## [1.2.433] - 2026-10-28

### Changed

- Unknown event kinds, state words and class names read as words instead of raw ids
- Automations can start on, and be conditioned by, a parked object (appeared or departed, with class and zone filters)

## [1.2.432] - 2026-10-28

### Changed

- The vendor login proxy is served on one shared vendor-login prefix that cannot shadow an addon's own routes
- Unknown event kinds and state words now read as a humanized label ("Delivery truck") instead of the raw id

## [1.2.431] - 2026-10-27

### Changed

- Addons can now offer a vendor sign-in that opens the vendor's login page through the hub and finishes on the CamStack result page.

## [1.2.430] - 2026-10-27

### Added

- Actions: declared list entries (action-source, actions caps), an action step for automations, and run traces kept in the hub ledger
- Automations gain detection and interval triggers, per-automation run modes (single, restart, queued, parallel, cooldown), condition reads from an in-memory mirror, and a ring of run traces

## [1.2.429] - 2026-10-27

### Added

- pet-feeder reports bowlFood, eating and supportsMarkRefilled

## [1.2.428] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.
- Cloud integrations raise one alert when their session is lost and clear it when it is back

## [1.2.427] - 2026-10-27

### Added

- CamStack Types: Shared types, interfaces, and model catalogs for the CamStack detection ecosystem.
