# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Devices page: Add device (opens an installed integration's add / scan / adopt flow) and Browse integrations; Addons page filters on integrations with ?kind=integration

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
