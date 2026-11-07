# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.611] - 2026-11-07

### Changed

- Local access, the Terminal configuration and the passkey relying-party card read their own scoped settings form instead of the retired addon-level one
- A device that a camera can link (a light, a sensor, a switch) now shows the cameras on its Customize tab, so you can tick which cameras link it without leaving the device.
- The passkey relying-party card says the addon did not answer when it is unreachable.
- The generic addon settings panels read and save the addon's scoped settings (per capability and scope) instead of the addon-level form; an addon that cannot be asked now says it is not available.
- A heater, fan or fountain composed on a plug gets a Running row in Customize with a Follow the device's switch toggle

## [1.2.610] - 2026-11-07

### Changed

- A system-event notification rule now picks any combination of when it starts, when it clears and on a schedule on one screen, with one switch for a notification per category and a Send the summary now test

## [1.2.609] - 2026-11-07

### Changed

- Customize threshold overrides gain a Samples field: consecutive readings needed before the state changes

## [1.2.608] - 2026-11-07

### Changed

- Customize change dialog: the source, the threshold fields and the proposal with Apply sit in one compact card, so editing an existing source works on a phone
- Backup texts no longer mention config.yaml; the key rotation hint names the mounted master key path

## [1.2.607] - 2026-11-07

### Changed

- Authentication, Settings and the first-login server name read and save the server name and sign-in policy through the system-config bootstrap form actions

## [1.2.606] - 2026-11-07

### Changed

- The placement board refreshes the scoped settings it reads after a save, no longer the retired addon-level query

## [1.2.605] - 2026-11-07

### Changed

- A Camera grids page lists, adds, switches and deletes grids
- The node roles tab saves through the scoped settings API; the placement board reads the same values.
- Terminals are now instances on the Terminal page: the list is kept as records, migrated in place with the same ids and cameras

## [1.2.604] - 2026-11-07

### Changed

- The cluster roles tab reads and writes the orchestrator cluster settings through the scoped settings API.

## [1.2.603] - 2026-11-07

### Changed

- Notification settings and the cluster recording, events and roles pickers use the scoped settings API

## [1.2.602] - 2026-11-07

### Changed

- Waste sources use the shared Calendars list, with a Fetch now button on each source row
- Notifications > Targets is the shared instances table (with the owner column and a test-send action); the bespoke target page and its dialog are gone, and Duplicate with them
- AI profiles use the shared instances table, with the model and provider parts in the edit dialog; the other AI pages read profiles from the instance model.
- Network → Mesh Networks is the shared instances list; the join, leave and log-in controls and the live status sit in the tailnet's editor
- The Storage page is the instance table: each location is a row with its capacity and state, edited in one dialog, with the forced delete as its own confirmed action
- Identity → Authentication lists the sign-in connections in the shared instances table
- The Calendars page gets a Fetch all now action in its header; the per-addon settings button is gone

## [1.2.601] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.600] - 2026-11-06

### Changed

- The new-integration form tests the draft through the integration's own Test (one test method for every integration)
- Customize lists a built device one row per field, grouped by capability, with the state of each source (to fill, bound, not answering, missing), clocks under Advanced, and a keyed item such as a filter as a small form
- Picking a source in Customize uses the shared device-to-value picker: devices and values that do not fit are no longer listed, and a transform plus a preview sit beside the pick
- Customize: Fill from device proposes a fitting value per field, and the picker offers only values whose unit fits (a minutes value is no longer offered for a percent level); fits as is / convertible wording
- Customize: a source in another unit than a consumable level (hours, minutes) is offered as convertible and the operator enters the scale; a battery percent fits as is
- Instances tables take row actions and an operator-typed id on create, and the Matter pairing code is a tab of the Add device modal

## [1.2.599] - 2026-11-06

### Changed

- Fountain wizard no longer asks for the drink counters; a consumables list the card cannot edit shows Custom instead of Unreadable
- The broker picker of an instance link honours a disabled field and offers an empty choice for an optional link
- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- The integration on/off toggle switches the instance through integration-instances

## [1.2.598] - 2026-11-06

### Changed

- The exported-devices list opens full page and a row click no longer leaves for the device; Add device rows lose the leading dash and name the container they sit in.

## [1.2.597] - 2026-11-06

### Changed

- Instance pickers of settings forms use the broker picker (default pick, create in place) for broker links, and notification targets keep their first-broker default and device-based name
- Connectivity → Calendars is a list of calendar instances with an Add calendar action

## [1.2.596] - 2026-11-06

### Changed

- Add device: a candidate whose integration cannot create a device now says so, and a failed lookup shows its error, instead of an endless spinner.

## [1.2.595] - 2026-11-06

### Changed

- The Customize tab shows every extension slot a device hosts from the slot table, not from a camera check
- The Add device modal of an integration that adopts devices and can also scan the network now keeps its full adopt list and adds the network scan above it; a board found by both is listed once, and the modal waits for the scan answer before drawing either.
- Creating a broker from a picker or the wizard uses the same instance dialog as the function page
- Broker pickers (Matter commissioning, notification targets, broker create) offer only brokers that are on, configured and working, and keep the chosen one visible with its state.
- Update all nodes now updates the hub first and waits for it to run the new version before touching agents; if the hub step fails the agents are listed as not attempted.
- The Update all nodes hint now says the hub is updated first, then the agents.

## [1.2.594] - 2026-11-05

### Changed

- Add device hides the Enter parameters tab when the provider refuses manual creation for that integration

## [1.2.593] - 2026-11-05

### Changed

- The integration page has one Add device button: boards and devices found on the network, a scan scoped to the integration and the manual form live in one modal.
- Deleting a device in the Devices and integration tables shows a Removing… row until the removal has completed, and reports a failure with a toast


## [1.2.592] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.591] - 2026-11-05

### Changed

- Signing an existing account in again from its edit dialog now keeps the region already stored on it instead of falling back to the default

## [1.2.590] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.589] - 2026-11-05

### Changed

- Connection lists (Brokers, Exporters, Email, TURN, Remote Access, Logging, Training) show one row of provider pills with no All pill; Add moves to the page header

## [1.2.588] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [1.2.587] - 2026-11-05

### Changed

- An integration's configuration form is its instance record

## [1.2.586] - 2026-11-05

### Changed

- Device History tab shows an appliance's runs panel and run bands on the power chart (Italian strings added)

## [1.2.585] - 2026-11-04

### Changed

- Connectivity → Exporters is now one table like Email and Brokers, with a Devices column that opens the devices each export target publishes.

## [1.2.584] - 2026-11-04

### Changed

- The Customize tab is one table: linked actions are rows, lists show their items, and linked devices stay a separate table on cameras only.

## [1.2.583] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.582] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.581] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.580] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.579] - 2026-11-04

### Changed

- Exporter pages show and change exposure per export instance instead of every instance at once, with new strings for the instance states

## [1.2.578] - 2026-11-04

### Changed

- Broker connections (Home Assistant, Alexa, Matter, Google, MQTT, SMTP) are created and edited in the same instances dialog and table; the old broker manager is gone
- The device Customize tab is one table: event and extension rows show their last event or configured summary and source, and other fields and linked devices are rows of that table instead of blocks below it
- New Training providers page lists the cloud training accounts as an instances table, reached from the Training page's Providers tab
- Broker integration pages count their connections from the same list the table shows, and no longer repeat the Connections heading, the Activity panel or an empty Settings block

## [1.2.576] - 2026-11-04

### Changed

- Connection lists offer a kind picker on Add, an interactive sign-in or connect action, the provider's own status word and a restore under the old id, when the provider declares them

## [1.2.575] - 2026-11-04

### Changed

- Rebuilt against updated dependencies.

## [1.2.574] - 2026-11-03

### Changed

- System logs page: filter to the viewer app's own lines
- The alarm profile bar uses the surface background

## [1.2.573] - 2026-11-03

### Changed

- The remote grid shows an icon for every key, with its name as tooltip and accessible label, from the shared role vocabulary
- Customize tab: one sectioned table of every customization the device offers (value and source, edit and remove per row, a picker to add), a missing power-source title, and no more incompatible values in the source picker

## [1.2.572] - 2026-11-03

### Changed

- Logs → Destinations and the other connection lists are one table with provider filter pills, and a provider that allows several instances can always add another

## [1.2.571] - 2026-11-03

### Changed

- Customize running: the scalar dialog proposes a running threshold and dwells from the device's power history, with an Apply button; nothing is saved until Save.

## [1.2.570] - 2026-11-03

### Changed

- A remote attached to a built media player now gives it the media-player commands, and the appliance and heater creation templates are removed.
- Debug layers: switches to turn off the outlines and the top layer, and the header's compositing styles

## [1.2.569] - 2026-11-03

### Changed

- The installed iPhone app no longer blurs the header under the status bar

## [1.2.568] - 2026-11-03

### Changed

- The debug-layers mode can be turned on from the menu, for the installed app

## [1.2.567] - 2026-11-03

### Changed

- Adopt devices: a candidate's model and id now sit under its name instead of shortening it
- Remote configure: selecting a button shows its own action in plain words (target device and command), with Test and Clear
- The remote used from a device no longer prints group names such as Numbers or Volume; they only appear in the layout editor
- Opening the admin with ?debugLayers=1 outlines and labels every layer near the top of the screen (fixed, sticky, blur, opacity) and shows the safe-area insets, to track down the blurred mobile top bar
- The remote used from a device no longer prints group names such as Numbers or Volume; they only appear in the layout editor
- The device hero no longer links to the remote layout editor (it stays on the Customize page)
- A built device's Customize tab now shows the same lists as a native device of its type, helper devices included; removing the last facet leaves the device naked instead of being refused.
- A sensor's page no longer repeats its own reading in a second Power line under the hero
- One creation dialog: a Device section creates a naked device (a heater with its plug, a media player with its commands when the source has them) and the appliance tile is gone; removing a composed device's last facet keeps the device

## [1.2.566] - 2026-11-03

### Changed

- Rebuilt against updated dependencies.

## [1.2.565] - 2026-11-03

### Changed

- Infrared TVs get a Remote button on the device page, a per-button command panel with Test in the remote editor, layout edit shortcuts, readable binding targets and Samsung BN59-01315 and Hisense ERF3 layouts
- Remote Access lists tunnels as records with a separate Start/Stop control per provider.
- Toasts over the top bar are no longer blurred on iPhone

## [1.2.564] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.563] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.562] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.561] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.560] - 2026-11-02

### Changed

- A notification target is no longer named after an optional discovered picker such as the email relay.
- Logs → Destinations and Connectivity → Email: every instance row gets its own on/off switch (an off row reads one neutral Off badge), a Restart action and the provider's Logs / Events under the list.
- TURN Servers lists every provider in one table with per-row switch, test, restart and activity
- The pet fountain composition preset has an optional pump cycle group and maintenance cadence groups

## [1.2.559] - 2026-11-02

## [1.2.558] - 2026-11-02

### Changed

- Export tables: new strings for the Integration filter and the bulk selection bar (English and Italian)
- A sensor notification rule can opt out of waking a sleeping battery camera for its linked picture
- Logs → Destinations and Connectivity → Email are one list of instances: add through a provider picker, edit, test and delete a relay or destination in a dialog.
- A notification target is no longer named after an optional discovered picker such as the email relay.
- Logs → Destinations and Connectivity → Email: every instance row gets its own on/off switch (an off row reads one neutral Off badge), a Restart action and the provider's Logs / Events under the list.

## [1.2.557] - 2026-11-02

### Changed

- Loki is configured on the Logging page again and no longer listed among integrations
- Connectivity → Email links to the Integrations page, where each SMTP relay is configured

## [1.2.556] - 2026-11-02

### Changed

- Connection integrations such as Loki are configured from the Integrations page, without a device list; the Logging page links to it

## [1.2.555] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.554] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.553] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.552] - 2026-11-02

### Changed

- The Integrations page shows a banner when new devices were found on the network, with Adopt and Dismiss
- Logs has a Watch tab: switch a debug channel on for chosen cameras for 10 minutes (renewed while the page is open, 60 minutes at most) and read it live.

## [1.2.551] - 2026-11-02

### Changed

- An addon page that needs a newer UI library than this admin UI provides now shows a clear message instead of failing to render.
- The AI profile editor hides the reasoning switch for a model that declares it cannot reason
- Actions ask for their variables before Run now, command options that depend on the device become a choice list, the detection editor uses the class taxonomy labels, and parked-object rules can require a minimum count
- Node page has a launch settings card for the heap ceiling and the hub RSS budget (takes effect on restart)
- System → Settings now holds your units and a read-only list of keyboard shortcuts (moved out of My access → Preferences, whose old link redirects there); the passkey relying-party settings moved to Identity → Authentication.

## [1.2.550] - 2026-11-01

### Changed

- A fan's Customize tab has a Presets editor: name a preset, pick its steps on the fan and the devices beside it, or fill it from their current values.
- Fan presets: Use current values now proposes every switch and control beside the fan (oscillation, angle limits, fixed angles) as a ticked checklist, in the order a fan wants to be driven.
- The heater device page uses the new heater card and shows the timed run.

## [1.2.549] - 2026-11-01

### Changed

- Fixed the blurred, dimmed mobile top bar on the installed iPhone app.
- System → Secrets labels the external master key as the mounted key file (/run/secrets)
- Washer and dryer device pages show the appliance card instead of the generic hero

## [1.2.548] - 2026-11-01

### Changed

- System → Data has a read-only Migrations tab: every migration with its status, owner, level, body kind and a detail with all its metadata, error and dependencies
- Notification template editor: the timelapse caption offers {{device}} instead of {{camera}}

## [1.2.547] - 2026-11-01

### Changed

- Notify when on a sensor rule now reads starts/finishes, with an info tooltip saying what they mean for the selected sensor kinds

## [1.2.546] - 2026-11-01

### Changed

- Customize offers replacing a device's native running state with an assigned source

## [1.2.545] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.544] - 2026-11-01

### Changed

- The add-integration broker step and every broker picker now pre-select the first broker of the kind.
- Installed on an iPhone home screen, the admin UI top bar now sits on one solid band under the status bar instead of a translucent, blurred one
- The notifier creation dialog names each provider group by its friendly name instead of its id.
- The Adopt devices dialog shows each device's type under its name on a phone and keeps the selection column in view when a name is long.

## [1.2.543] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.542] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- The hub sign-in policy (session and access token lifetimes, trusted proxies, trusted networks, allowed browser origins) moves from System > Settings to Identity > Authentication

## [1.2.541] - 2026-11-01

### Changed

- Sign-in hides the passkey option when the desktop app has no platform authenticator, and the single sign-in completion page links back to sign-in when its window has no opener
- Secrets moved from System to a fourth tab of Data; old Secrets links keep working
- New /approve page to approve a terminal sign-in by its code, and a Pending terminal sign-ins card under Login sessions.
- The terminal sign-in approval page compares the requester's address with yours, marks the self-reported name unverified and states what is granted

## [1.2.540] - 2026-10-31

### Changed

- The device page shows the state of the linked power switch above the hero card
- The automation editor's run history now paints every condition row, block and step with its own result, showing observed and expected values in the row's unit, trigger values and step outcomes inside them; the Runs panel keeps a list and one summary line, and starts collapsed on narrow screens.

## [1.2.539] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.538] - 2026-10-31

### Changed

- A device with a linked power switch gets Power on, Power off and Force restart (power) in its menu

## [1.2.537] - 2026-10-31

### Changed

- Saving an integration's configuration now shows a pending button, a success toast and an error toast; the Integrations page shows a reconnecting notice (and polls) while a provider addon restarts instead of an error page

## [1.2.536] - 2026-10-31

### Changed

- Build page: a Schedulers tab to create and edit schedulers with profiles, a draggable day timeline, point editor and runs ledger
- Admin and addon pages use the library's form controls (Button, Input, Select, Textarea, Checkbox) instead of the browser's; no visible change beyond slightly tighter fields

## [1.2.535] - 2026-10-31

### Changed

- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.534] - 2026-10-31

### Changed

- Setting up an integration from a scan result remembers which discovered device it came from
- Customize offers the door contact on a lock that serves lock-control.

## [1.2.533] - 2026-10-31

### Changed

- New notification targets pre-select the first broker and name themselves '<notifier> — <device>' until you type a name

## [1.2.532] - 2026-10-31

### Changed

- Devices page: Add device (opens an installed integration's add / scan / adopt flow) and Browse integrations; Addons page filters on integrations with ?kind=integration
- The action and notification editors read the new step target

## [1.2.531] - 2026-10-31

### Changed

- Remote template editor: slim separators with size and hide-label options, undo/redo (Cmd/Ctrl+Z), and the Add component window stays open after adding

## [1.2.530] - 2026-10-31

### Changed

- Admin UI is now hub-only: it is removed from agents that still carry it

## [1.2.529] - 2026-10-31

### Changed

- Terminal page: one table of every terminal across nodes with a New terminal dialog; nodes without Terminal show as not installed
- The adoption list now nests devices under their gateway and shows the model and device id next to same-named rows.

## [1.2.528] - 2026-10-30

### Changed

- Terminal page: node picker on instance edit, a clear 'node not in cluster' state, and loading/unknown states instead of 'no instances'.
- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone
- Detection pipeline device tab is one tab bar: Steps, Zones, Object detection, Tracking, Motion, Stationary, Audio, Cluster; ?sub= names the tab

## [1.2.527] - 2026-10-30

### Changed

- Scan network lists each integration's devices with gateway children nested, lets you tick several devices to add at once, and edits the extra networks to scan; the integration form gets a Scan button that fills it.
- A failed integration create no longer shows its error in the next provider you pick, the network scan shows devices the provider already matched as Already added, and the broker sign-in defaults to the device code
- Automations: the list is a table with trigger and last run, save closes the editor with a toast, New automation no longer closes itself, and each run shows its values
- Automations: the editor has one When tree of nested all/any/not blocks mixing events and states; a detection row picks a class and an optional label (species, known face, plate); the Runs panel shows what each step sent
- Collapsible headers in forms and the script/automation log toggles use the shared larger chevron
- Add integration, Adopt devices and Add device dialogs are now standard dialogs: Escape closes them and they follow the shared sizing

## [1.2.526] - 2026-10-30

### Changed

- Gateway device type label translations
- Broker sign-in offers a choice between device code (recommended) and guided login when the broker kind supports both

## [1.2.525] - 2026-10-30

### Changed

- Automation editor: the unit save boundary now comes from the shared prepareRecipeUnits, behaviour unchanged

## [1.2.524] - 2026-10-30

### Changed

- Remote templates: add ready-made components (power, D-pad with OK, rockers, keypad, colour keys) from a palette, drag keys and groups on the grid, and see button shapes, colours and group frames; app icons use their brand colour.
- Automation conditions and action quantities (a bowl weight, a feed portion) are now typed in a unit you pick, such as grams or ounces, and saved with that unit

## [1.2.523] - 2026-10-29

### Changed

- The built-in Samsung classic and Hisense remote presets are rebuilt from the new components, with section dividers

## [1.2.522] - 2026-10-29

### Added

- The remote template editor offers six built-in starting points (Samsung classic, Hisense VIDAA, Samsung Smart, LG Magic, Google TV, Apple TV) and app buttons with real brand icons

## [1.2.521] - 2026-10-29

### Changed

- The automation editor keeps the unit a person picked on a condition or step value
- The pet feeder card shows the bowl weight with its unit (22 g, or oz in imperial).

## [1.2.520] - 2026-10-29

### Changed

- The Automations table scrolls sideways on a phone instead of squeezing every column.

## [1.2.519] - 2026-10-29

### Changed

- The node page shows the desktop app version and can install its downloaded update.

## [1.2.518] - 2026-10-29

### Added

- A built device's commands can be edited, and a pet fountain can be created from a preset

## [1.2.517] - 2026-10-29

### Added

- A pet fountain device page uses the new hero card

### Changed

- Cluster page shows a node's memory as unknown when it could not be read
- A built device's methods are wired to other devices in a Commands card, and a Pet fountain preset creates a fountain from its entities.

## [1.2.516] - 2026-10-29

### Changed

- The sign-in result page explains a sign-in that finished without granting access (no_authorization_code)

## [1.2.515] - 2026-10-29

### Added

- A helper's Customize tab shows a summary and edits it in the helper dialog instead of an inline step flow

### Changed

- The helper member picker shows the value fields of every selected device, not only the last one
- The cluster pages show an unset node role (detect, audio, ingest) as on, matching the orchestrator

## [1.2.514] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.513] - 2026-10-29

### Added

- Media players get a Remote control card in Customize: pick a layout template, bind each button to a device command, import a SmartIR file, and test a saved command
- New System > Templates page to create, edit, duplicate and delete reusable layouts, with a touch-friendly remote button grid editor
- The Device details list of a container shows its children without the container's name, and the primary-child picker does the same.
- My access has a Preferences tab where each user picks temperature in °C or °F and metric or imperial for other measurements; the choice follows the account on every device

## [1.2.512] - 2026-10-29

### Added

- The helper creation dialog uses the full screen height; the member list scrolls instead of being cut short

### Changed

- The Actions tab shows an empty state with a create button when there are no actions, and an error instead of an endless loading message when the list cannot be read
- Creating a helper waits for the new device to appear, keeps both save buttons disabled while saving so a second click cannot create a duplicate, and a retry reuses the helper already created

## [1.2.511] - 2026-10-28

### Changed

- Agents found on the network shows a Name column

## [1.2.510] - 2026-10-28

### Changed

- An alert whose action runs a command now shows a button that runs it in place
- A finished alert no longer shows its run-action button

## [1.2.509] - 2026-10-28

### Fixed

- An agent whose pairing was left open can be resumed from Agents found on the network

## [1.2.508] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery

## [1.2.507] - 2026-10-28

### Changed

- The AI profile editor can turn the model's thinking off or set its effort

## [1.2.506] - 2026-10-28

### Changed

- Build: one New composed device entry with Group, Calculation and Advanced sections (a sum is now an aggregation of a readings group), and a Built as badge on every composed device.

## [1.2.505] - 2026-10-28

### Changed

- Integrations page places an integration in System or Providers from the addon's declared integrationSection, falling back to the framework-package rule
- The notification rule editor shows delivery options (such as Echo mode and volume) when a selected target supports them.
- The New Integration dialog shows the integrations like the Integrations page: bigger icons, up to three columns, Providers and System
- Integrations are listed alphabetically by name, on the page and in the New Integration dialog
- Build-your-self picks devices with the common device selector everywhere, and the helper member picker lists only compatible devices
- A temperature or humidity group can include thermostats and climate devices, read from their current temperature/humidity
- ⌘F / Ctrl+F jumps to the page's search field instead of the browser's find

## [1.2.504] - 2026-10-28

### Changed

- Integrations page splits integrations into Providers and System blocks in both the grid and the table; grid cards drop the id line and the chevron

## [1.2.503] - 2026-10-28

### Changed

- Device pages, history and helper forms read device values by their quantity name (power, level, speed) after the field rename

## [1.2.502] - 2026-10-28

### Added

- The Build page now has an Actions tab to create, run and trace actions, automations edit detection, parked-object and interval blocks with a run mode and a Runs panel, and a camera's Customize tab can link actions to it.

## [1.2.501] - 2026-10-28

### Changed

- The automation editor shows parked-object, detection and interval triggers and the parked-object condition read-only instead of dropping them

## [1.2.500] - 2026-10-28

### Changed

- AI profile editor: opening a saved profile loads its models and features automatically, and typing a listed model id applies that model's features.

## [1.2.499] - 2026-10-28

### Changed

- The AI runtimes table has a Feature column and a translated state chip, red when stopped
- Automations using the parked-object trigger or condition open read-only in the editor instead of breaking it

## [1.2.498] - 2026-10-28

### Changed

- A sign-in step that gets a non-JSON answer now names the step and HTTP status instead of a browser parse error
- AI Runtimes table: the Features column is now Feature, a stopped runtime reads Stopped (Fermo) in red, and Apple is capitalised.

## [1.2.497] - 2026-10-27

### Changed

- The broker sign-in dialog opens the provider's login page on the hub's own address and no longer warns about LAN-only links.

## [1.2.496] - 2026-10-27

### Fixed

- The broker sign-in panel shows the sign-in link, says to open it from the hub's network, and warns when this page cannot reach it

## [1.2.495] - 2026-10-27

### Fixed

- The device page's save bar appears only after you change something, and the page background fills the whole screen on phones

## [1.2.494] - 2026-10-27

### Changed

- Addon names follow the shorter product names; a page that never loads or a route that throws stays a message inside the shell; a page whose addon is absent is greyed in the nav and reads as not installed.

### Fixed

- The pet feeder card no longer repeats the desiccant; the Save footer shows only after a change; device pages fill the phone screen

## [1.2.492] - 2026-10-27

### Added

- Admin UI: Admin UI — Vite frontend build and server-side addon.
- Provides the addon Admin UI.
