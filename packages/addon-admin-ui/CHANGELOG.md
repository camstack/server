# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The hub device type is no longer offered in type pickers or device labels.

## [1.2.665] - 2026-11-14

### Changed

- A container's child reads as its part or primary; 'adopted' is said only under a hub, NVR or gateway

## [1.2.664] - 2026-11-13

### Changed

- A template action that names its devices is one Command field: the dialog picks the command and the devices together.

## [1.2.663] - 2026-11-13

### Changed

- Translations for the update card's install steps
- The device page draws a simple sensor in the shared device card, like every other card.

## [1.2.662] - 2026-11-13

### Changed

- The device command dialog uses the shared device picker, filtered to devices that offer the command.
- Table icons use a tooltip: a kind icon names the kind and its provider, a linked instance says who it sends through, and a second badge is hidden when it would repeat the same icon.

### Fixed

- The automation Device command dialog keeps its header and buttons fixed, scrolls each column on its own, and shows the command's parameters below the columns instead of over the device list
- English and Italian text for the new lock, alarm, humidifier, valve, siren, pet and weather device cards.
- English and Italian strings for the new device cards (button, update, script, automation, control, event, image, notifier, gateway)
- A cluster update explains a server install that stalled or hit its time limit.

## [1.2.661] - 2026-11-13

### Added

- Build → Templates now holds remote and automation templates: author them with inputs, create automations from a template by filling only its inputs, save an automation as a template, and convert a template automation to a free one.

### Changed

- Add target lists every kind with its icon and opens the form on the one you pick; email's Send with offers Create new for a Google account or SMTP relay; the editor sends a test with the unsaved values
- Notification targets: the test button reads Send test message and says it delivers a real message to the destination typed; each row shows a small badge of the instance it links to (an email target's Google account or SMTP relay), named on hover; a relay a target still names by its old pin counts as in use
- Labels for the new Energy system device type
- The Energy system device shows its energy-flow card on the device page

## [1.2.660] - 2026-11-13

### Added

- The device card History view has Italian and English labels for actuations
- The automation editor offers a heat-pump circuit as a list of the circuits the heat pump reports

## [1.2.658] - 2026-11-13

## [1.2.657] - 2026-11-13

### Changed

- A button's card shows the notice its events share, such as a hint that the controller does not send these presses yet

## [1.2.656] - 2026-11-13

### Changed

- Device page, search, locations and helper templates use the device's role icon, and the Locations tables now draw the shared type icons too (a hub is a network glyph, a climate device a thermometer); the device header and the Locations rows no longer say Online, only Offline

## [1.2.655] - 2026-11-13

### Changed

- Customize offers the switch role On/off light (switch-light) for a relay that drives a lamp
- The light group's member picker offers relays whose role is switch-light.

## [1.2.654] - 2026-11-12

### Changed

- The device card page opened by the viewer draws the card bare on a transparent page, so the viewer's sheet frames it
- The heat-pump and water-heater device pages show the new device card.

## [1.2.653] - 2026-11-12

### Changed

- A device command step reads as one sentence with a Change button; the device modal picks it by device or by action, lists only the commands every picked device offers, and asks the command's settings before Confirm
- A selected remote button no longer pops the command picker: an unfinished binding shows a Choose row, and a call the vocabulary cannot name stays read-only until Change
- Strings for the sensor card's state corner and for a control that could not be set (English and Italian)

## [1.2.652] - 2026-11-12

### Changed

- A cover's Customize role selector offers the cover kinds (blind, shutter, awning, curtain, garage, gate, door, window)
- The Kind column of an instances table shows the provider icon when the addon declares one.

## [1.2.651] - 2026-11-12

### Changed

- Creating an integration whose kind brings devices leaves the id to the hub, so it is no longer refused
- The remote editor gets a Learn button for IR transmitters that can learn a code
### Changed

## [1.2.650] - 2026-11-12

### Changed

- On the device page, a media player with a known volume sets it with a slider; an unknown level, or volume up and down only, keeps the minus and plus buttons
- A notification rule shows how many seconds to group its notifications.

## [1.2.649] - 2026-11-12

### Changed

- The device page shows the new card for washers, dryers, dishwashers, media players, robot vacuums and lawn mowers
- The device page keeps a dishwasher's options, delayed start and care reminders under the card
- A new integration is prefilled "<provider> - Home" (editable), including one found on the network.
- Testing a new instance of a provider with several kinds (an Alexa Echo) tests the kind being created; the many-choice hint line is gone

## [1.2.648] - 2026-11-12

### Changed

- Rebuilt against updated dependencies.
### Added

## [1.2.647] - 2026-11-12

### Changed

- Automation editor: a 'A button or device fires' row picks the device, then the button and the event it declares

## [1.2.646] - 2026-11-12

### Added

- The automation editor offers "Stop the run", "Set variables" and "Continue if this step fails"; a failed step the run passed over is shown red in the run trace
- Automations: a Choose step in the action list, with branches read top to bottom and an optional Otherwise list; a run shows which branch ran and its steps
- Automations: a Wait until step in the action list (condition, timeout, what to do when it runs out); a "started by" row inside a stop condition, a Choose branch or a Wait until now gives the trigger rows their ids
- Automation editor: an "At the same time" step runs up to five commands, actions or waits together; each one has its own row in the run trace
- Automation editor: a Repeat step (a count, while/until a condition under a maximum, or once for each device); the run shows how many rounds ran and why the loop ended
- Automations: inside a repeat over devices, a command step can run on the device of each round and offers the commands all the listed devices share
- Automations: block steps (choose, repeat, at the same time, wait until) can be placed inside a branch or a repeat, one level deep; the run view shows their steps
- Automation editor: a 'A button or device fires' row picks the device, then the button and the event it declares
- A notification rule on a button or remote offers the events that device declares, under their readable names

### Changed

- Token view links, Log watch and the automation device fields (event source, command target, scene cameras) use the device search picker
- The page of an event device (a remote, a button) lists each button with its labelled presses, and the last event names its button
- The device page and the device embed show the new cover, light, fan and heater cards

## [1.2.645] - 2026-11-11

### Changed

- Customize: the role of a provider-spawned accessory device (e.g. a Home Assistant cover) is now editable, like its name.
- Customize offers the heater and fan roles on a switch and the climate roles (thermostat, AC, floor, radiator, heater, heat pump circuit) on a climate device; a composed heater can no longer be created, a switch with the heater role replaces it.
- Customize labels for the fan-control card and its oscillation-axes section.
- The fan preset editor sets speed, preset mode, direction and each oscillation axis directly, and Customize lists a fan’s axis links under their own section with readable titles.

## [1.2.644] - 2026-11-11

### Added

- Automation editor: a 'Time is' condition with its window (clock time or sun event with an offset) and weekdays; a sun-based window is refused at save when the site has no location.
- Automation editor: the "Started by" condition picks among the automation's own trigger rows, in the rules and in a step's condition
- Automation editor: a step argument can insert the device, the old value and the new value of a "device becomes" trigger

### Changed

- The shared device card follows the signed-in user's real device permission instead of assuming admin; inside the viewer it drops its duplicate name and is centred at a readable width on desktop
- The shared device card asks the hub whether the signed-in user may command THIS device (instead of assuming admin) and disables its controls with the reason when not; inside the viewer it drops its duplicate name and is centred at a readable width on desktop
- The "Started by" condition is offered only inside an automation, not in a standalone action list or a scheduler

## [1.2.643] - 2026-11-11

### Changed

- Automation editor: each WHEN block draws its rows on a coloured rail of its own, so sibling and nested blocks are told apart; move arrows at an edge stay disabled and say why; the Ungroup button is gone.

## [1.2.642] - 2026-11-11

### Changed

- Device page and embedded device view show the new device card for plugs and climate devices
- Adding a target, relay or log destination opens the New Integration dialog with provider icons; ticking several Echoes creates one Alexa target per Echo in one confirm.

## [1.2.641] - 2026-11-11

### Changed

- Automation row types take their name and description from one catalogue; the type list shows the same wording everywhere.
- Automation editor: Add row, a row's new Change type control and a step's Only if open a searchable condition picker; events are shown disabled, with the reason, where they cannot be used.

## [1.2.640] - 2026-11-11

### Changed

- An integration's page says "<addon> is not running: start it first" under its On/Off switch when the switch is refused because the addon is down
- The device page offers a History tab only when the device has recorded history; a gateway no longer opens an empty one

## [1.2.639] - 2026-11-11

### Changed

- System → Terminal is one table: the Nodes card and the legacy-cameras list are gone; a node without Terminal is offered disabled, with the reason, and legacy cameras are adopted with one button
- The On/Off switch of an instance whose addon is not running is disabled and says "<addon> is not running: start it first"
- System → Terminal: the page header explains what a terminal is for, and the table no longer repeats a title

### Removed

- Removed the Hub device hero and the Hub discovery panel on the device Overview tab; Hub devices are retired

## [1.2.638] - 2026-11-11

### Changed

- System → Settings no longer repeats sign-in and connection settings that already live on their own page.

## [1.2.637] - 2026-11-11

### Changed

- New chrome-less /embed/device/<id> page that draws one device's card through the signed-in session
- Automation editor: a hold control (for N s, held or stable ± tolerance) on device and expression conditions, and a Becomes picker with thresholds and ranges
- A running fixed builtin switches through the one instance switch; the hub flag is written directly only while its addon is down

## [1.2.636] - 2026-11-10

### Changed

- Summary, timelapse and calendar-events editors now have per-target settings (text, priority, picture, schedule) like the notification rule editor

## [1.2.635] - 2026-11-10

### Changed

- Device fields in settings forms use the new device → value picker, with search, filters and live readings
- Nodes and Addons follow the hub cluster-update job (preview, confirm, step list) instead of updating each node from the browser.
- The notification rule editor's per-target panel offers the notifier's own priority levels, the picture kind and a no-buttons switch.
- The device page and its hero follow the child a container declares as its primary
- Admin UI: Authentication, Connectivity, Remote Access and TURN Servers each show one provider table (Remote Access tunnel state and Start/Stop are in the rows; the Calendars legend links to Connectivity instead of repeating the source switch)
- The device page and its hero follow the child a container declares as its primary
- The device hero card drops the Power, Supply and cover rows: the scene is the on/off, commands sit beside the animation, and history, consumables and the power source are buttons at the card foot

## [1.2.634] - 2026-11-10

### Changed

- The rule editor opens each selected target to its own texts, priority, schedule and options, and shows only the fields the selected targets can deliver, naming the targets that drop each one.

## [1.2.633] - 2026-11-10

### Changed

- Notification texts (the shipped-sentence catalog) stay plain text with their variable chips: the device-value picker only appears where the hub renders device values
- The mosaic caption and the timelapse preview caption stay plain text with their variable chips: no device-value picker where the hub fills variables only
- Automation editor: rows and blocks in WHEN and IF move up and down, nested blocks collapse to a one-line summary, the Ungroup button is labelled, and the per-block warnings inside the tree are gone: a WHEN that cannot run is still explained beside the disabled Save, and a step's IF that can never be true now shows one non-blocking note under its tree.

## [1.2.632] - 2026-11-10

### Changed

- Free-text action arguments and notification texts take device values: pick a device and a field to insert it, see it as a chip, and get the hub's verdict under the field; the expression box of an automation condition now autocompletes the names it binds

## [1.2.631] - 2026-11-10

### Changed

- Notification rules and buttons now pick an existing Action instead of authoring steps; the notification Sequences tab is gone (a rule's steps move to Actions automatically).
- A rule can open a new Action that already presses the alarm panel

## [1.2.630] - 2026-11-09

### Changed

- The device page passes the device type when it resolves which child a container stands for

## [1.2.629] - 2026-11-09

### Changed

- An action step has an Only if toggle with the automation condition editor and an Otherwise list

## [1.2.628] - 2026-11-09

### Changed

- The device page draws its hero from the hero model: an animated scene, state and power chips and the controls of the device's own caps; devices the model does not cover yet keep the previous hero.
- The device page draws its hero from the hero model (layout A), live through the device state, dropping the duplicated power strip
- The device detail hero, History and runs are one props-only module (DeviceDetailModule) that the admin page mounts directly
- Device hero card: countdown with Stop and run again for a timed run, speed dial for a fan, end clock time on appliances
- Device hero: an AC no longer repeats its power in a second row, and a device with only tiles or facts is drawn by the hero
- The heat pump card lists every circuit with its own label, a power row with the instantaneous COP, and a System group of mode selectors

## [1.2.627] - 2026-11-09

### Changed

- The add-integration wizard reads its create form from the one instance door
- An unknown integration switch is no longer drawn green; a fixed builtin switches without its addon
- Integration page: Config opens the shared instance editor (name, test connection, sign-in) instead of a second form
- Integration page: a fixed builtin switches like every other integration, and a switch the addon could not answer shows Unknown instead of a stale on/off
- An integration whose addon is not running can be deleted, and a fixed builtin can be switched on while its addon is down.

## [1.2.626] - 2026-11-09

### Changed

- The account sign-in paste hint asks for the address the browser stopped on, or only its code
## [1.2.625] - 2026-11-09

### Changed

- The Calendars page lists every imported calendar with an on/off switch, so a calendar can be switched off and back on without leaving the page

### Fixed

- Calendars page joins calendars to their switch by the owning record, no longer shows an enabled waste calendar twice, and says when the switches could not be loaded
- Remote: edit the layout inside the remote modal, one colour-keys set with optional letters, Samsung layout with source and app rows, and a default-emitter choice for infrared sources

## [1.2.624] - 2026-11-08

### Changed

- The new-integration wizard creates through the one instance door, so the hub gates the create on the connection test and the discovery candidate is kept on the integration
- Deleting an integration on its page goes through the one instance door

## [1.2.623] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.622] - 2026-11-08

### Changed

- Remote customize: browse the Flipper-IRDB library and import a remote's buttons

## [1.2.621] - 2026-11-08

### Changed

- Customize tab: a Power source or Running row shows which device it reads, is edited through a pencil, and the formula editor opens on the stored source instead of null; the table fills a phone's width.
- Remote control: the Customize row's pencil opens the layout editor directly; a selected button shows what it does, its transmitter and its code (infrared timings or the capability call) with a copy button; a source can be an infrared code.

## [1.2.620] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.619] - 2026-11-08

### Changed

- The Remote button shows a remote-control icon.

## [1.2.618] - 2026-11-08

### Changed

- The Remote editor has a Sources section: declare channel numbers and button sequences (from bound buttons only), reorder them, and set the pause between steps; mistakes show next to the field.
- The remote shows a Sources key that opens a picker of the declared channels and inputs; a remote with no sources hides it

## [1.2.617] - 2026-11-08

### Changed

- Editing an integration no longer sends its on/off switch as a form value.
- A notification target's owner shows the user name instead of an id.
- The Settings page shows the server settings form on a hub without addons.
- The storage Add dialog is titled and named after the kind it adds, the default name follows the kind you pick until you type your own, and only the selected provider's section shows.
- The calendars tab no longer shows 'No calendar sources installed' under a populated list, the storage Add dialog is named after the kind it adds, the Settings page shows the server settings form on a hub without addons, and a notification target's owner shows the user name instead of an id.
- The Customize running-state form pre-fills a media player's power threshold with its own faster dwell defaults

## [1.2.616] - 2026-11-08

### Changed

- Removed the unused 'assumed' media player labels from the translations.

## [1.2.615] - 2026-11-08

### Changed

- Notification rules: the delivery settings now live in the Notification section.
- Timed run: Stop and Restart labels (en, it).

## [1.2.614] - 2026-11-08

### Changed

- The addon settings panel reads and writes through the scoped settings only; the integration surface and the settings forwarding are gone.
- Automation expression bindings to a device now carry the owning addon, so two addons sharing a stable id no longer resolve to the wrong device.

## [1.2.613] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.612] - 2026-11-07

### Changed

- A heater, fan or fountain composed on a plug gets a Running row in Customize with a Follow the device's switch toggle

## [1.2.611] - 2026-11-07

### Changed

- Local access, the Terminal configuration and the passkey relying-party card read their own scoped settings form instead of the retired addon-level one
- A device that a camera can link (a light, a sensor, a switch) now shows the cameras on its Customize tab, so you can tick which cameras link it without leaving the device.
- The passkey relying-party card says the addon did not answer when it is unreachable.
- The generic addon settings panels read and save the addon's scoped settings (per capability and scope) instead of the addon-level form; an addon that cannot be asked now says it is not available.

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
